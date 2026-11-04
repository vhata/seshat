import type { StoredInstallation } from "../shared/installations";
import type { CheckAttempt, PullRequestRecord, RepositoryRecord, RepositoryRefreshResult, SyncFailureReason } from "../shared/overview/protocol";
import { coalesceFacts, factObserved, type DeliveryFact, type PrMark, type ReducedDelivery } from "../shared/overview/webhook-marks";
import { GithubPrReader, type HeadCommitDate, type RateLimit, type ReadMeta, type ReaderContinuation } from "../worker/github-pr-reader";
import { readReviewerPermission, type PermissionCacheEntry } from "../worker/github-permissions";
import { GitHubRepositoryListing } from "../worker/github-repositories";
import { readRepositoryCi, type RepositoryCiContinuation } from "../worker/github-repository-ci";
import type { RepositoryCiIssue } from "../shared/overview/repository-ci";
import type { OverviewStore } from "./overview-store";
import type { RepositorySelection } from "./repository-selection";
import { RepositoryDiscoveryStore } from "./repository-discovery-store";
import type { MonitoringStatus, SchedulerStatus } from "../shared/monitoring";
import { reportGithubFailure } from "../worker/github-http";

const KEY = "overview-sync-work-v1";
const MINUTE = 60_000;
const RETRIES = [5_000, 15_000, 30_000] as const;
interface PendingMark extends PrMark { due: number; queuedAt?: number; firstRead: number | null; retry: number; revision: number; mergeability: boolean; check?: CheckAttempt; repositoryOwnerAccountId?: number; refreshCheck?: CheckAttempt }
interface PendingSha { installationId: number; repositoryId: number; sha: string; facts: DeliveryFact[]; expires: number }
interface TrackedCheck { scope: "repository" | "pr"; key: string; attempt: CheckAttempt }
interface PendingRefresh { id: number; due: number; revision: number; queuedAt?: number; checks?: TrackedCheck[] }
interface ReadProgress { installationId: number; generation: number; ids: string[]; revisions: [string, number][]; continuation: ReaderContinuation | null; checks?: TrackedCheck[]; startedAt?: number }
interface PendingCi {
  repositoryId: number; installationId: number; ownerAccountId: number; fullName: string;
  due: number; queuedAt: number; revision: number; retry: number; check: CheckAttempt;
  continuation: RepositoryCiContinuation | null;
  visibleOnly: boolean;
}
interface Sweep {
  generation: number;
  startedAt: number;
  retry: number;
  installations: number[];
  installationIndex: number;
  stage: "listing" | "count" | "read";
  ids: string[];
  continuation: ReaderContinuation | null;
  unreadable: number[];
  reason: SyncFailureReason;
  checks?: TrackedCheck[];
  readStartedAt?: number;
}
interface State {
  marks: PendingMark[];
  shas: PendingSha[];
  refresh: PendingRefresh[];
  refreshGenerations: Record<number, number>;
  observationGenerations: Record<number, number>;
  guard: number | null;
  guardQueuedAt?: number | null;
  activeSince?: number | null;
  lastEventFailureAt?: number | null;
  nextSweep: number | null;
  lastCatchup: number | null;
  sweep: Sweep | null;
  reread: ReadProgress | null;
  permissions: PermissionCacheEntry[];
  headDates: HeadCommitDate[];
  rates: { installationId: number; rate: RateLimit }[];
  ci?: PendingCi[];
  lastJobWasCi?: boolean;
}
interface Context {
  ownerId?: number;
  storage: DurableObjectStorage;
  store: OverviewStore;
  selection: RepositorySelection | null;
  installations(): readonly StoredInstallation[];
  /** Current visible reports come from hibernating socket attachments. */
  visible(now: number): boolean;
  guard(now: number): Promise<boolean>;
  publish(now: number): Promise<void>;
}
class SyncReadError extends Error {
  constructor(readonly reason: SyncFailureReason) { super(reason); }
}
function readFailure(meta: ReadMeta): SyncFailureReason {
  return meta.issues.some((issue) => issue.reason === "rate-limited") ? "rate-limited" : "github-unavailable";
}
function initial(): State {
  return { marks: [], shas: [], refresh: [], refreshGenerations: {}, observationGenerations: {}, guard: null, nextSweep: null, lastCatchup: null, sweep: null, reread: null, permissions: [], headDates: [], rates: [] };
}

/** All scheduling progress is JSON-safe private data; credentials stay in selection.tokens. */
export class OverviewSync {
  private readonly state: State;
  private running = false;
  private publishingStatus = false;
  constructor(private readonly context: Context) {
    const row = context.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", KEY).toArray()[0];
    this.state = row ? JSON.parse(row.value) as State : initial();
    this.state.refreshGenerations ??= {};
    this.state.observationGenerations ??= {};
    this.state.activeSince ??= null;
    this.state.ci ??= [];
  }

  private save(): void {
    const value = JSON.stringify(this.state);
    const before = this.context.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", KEY).toArray()[0];
    if (before?.value !== value) this.context.storage.sql.exec("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", KEY, value);
  }
  private accepted(id: number): boolean { return this.context.installations().some((installation) => installation.id === id && installation.status === "accepted"); }

  private markScope(mark: PendingMark): "repository" | "pr" { return mark.nodeId.startsWith("repository:") ? "repository" : "pr"; }
  private markKey(mark: PendingMark): string { return this.markScope(mark) === "repository" ? String(mark.repositoryId) : mark.nodeId; }
  private markRepository(mark: PendingMark): RepositoryRecord | undefined {
    const repository = this.context.store.repository(mark.repositoryId);
    return repository?.monitored && repository.installationId === mark.installationId
      && (mark.repositoryOwnerAccountId === undefined || mark.repositoryOwnerAccountId === repository.ownerAccountId) ? repository : undefined;
  }
  private track(checks: TrackedCheck[], scope: TrackedCheck["scope"], key: string, now: number, result: "queued" | "running" = "running"): CheckAttempt {
    const previous = checks.find((check) => check.scope === scope && check.key === key);
    if (previous) return previous.attempt;
    const attempt = this.context.store.beginCheck(scope, key, now, result);
    checks.push({ scope, key, attempt });
    return attempt;
  }
  private interruptChecks(checks: readonly TrackedCheck[] | undefined): void {
    for (const check of checks ?? []) this.context.store.finishCheck(check.scope, check.key, check.attempt, "interrupted");
  }
  private abandonReread(progress: ReadProgress, now: number): void {
    this.interruptChecks(progress.checks);
    for (const mark of this.state.marks.filter((mark) => progress.ids.includes(mark.nodeId) && this.accepted(mark.installationId) && this.markRepository(mark))) {
      const owned = progress.checks?.find((check) => check.scope === this.markScope(mark) && check.key === this.markKey(mark));
      // A newer event owns its own queued evidence; only repair tokens this
      // canceled batch interrupted while the same work remains scheduled.
      if (owned && mark.check?.id === owned.attempt.id) {
        mark.check = this.context.store.beginCheck(this.markScope(mark), this.markKey(mark), now, "queued");
      }
    }
    this.state.reread = null;
  }
  private queueSweepChecks(sweep: Sweep, now: number): void {
    sweep.checks ??= [];
    for (const repository of this.context.store.repositories()) {
      if (repository.monitored && sweep.installations.includes(repository.installationId)) {
        this.track(sweep.checks, "repository", String(repository.id), now, "queued");
      }
    }
  }

  /** Reads scheduler evidence without changing visibility or requesting GitHub. */
  monitoringStatus(now: number): MonitoringStatus {
    const sync = this.context.store.syncStatus();
    const attempt = sync.latestAttempt;
    const queued = [
      ...(this.state.guard === null ? [] : [this.state.guardQueuedAt ?? this.state.guard]),
      ...this.state.refresh.map((job) => job.queuedAt ?? job.due),
      ...this.state.marks.map((mark) => mark.queuedAt ?? mark.due),
      ...this.state.ci!.filter((job) => this.ciRepository(job)).map((job) => job.queuedAt),
    ];
    const failure = this.state.lastEventFailureAt ?? null;
    return {
      version: 1, serverTime: now,
      activeSince: this.context.visible(now) ? this.state.activeSince ?? now : null,
      sync: {
        lastSuccessfulSweepAt: sync.lastSuccessfulSweepAt,
        latestAttempt: attempt === null ? null : {
          startedAt: attempt.startedAt, result: attempt.result,
          ...(attempt.result === "failed" ? { reason: attempt.reason } : {}),
        },
        intervalMs: sync.intervalMs, slowedByRateLimit: sync.slowedByRateLimit,
      },
      oldestPendingAt: queued.length ? Math.min(...queued) : null,
      lastEventFailureAt: failure !== null && (sync.lastSuccessfulSweepAt ?? -Infinity) < failure ? failure : null,
      githubRateLimited: this.state.rates.some(({ installationId, rate }) => this.accepted(installationId)
        && ((rate.retryAt ?? 0) > now || rate.resetAt > now && rate.limit !== undefined && rate.remaining < rate.limit / 10)),
      cloudflareCapacity: "unknown",
    };
  }

  /** Observe the current scheduler without normalizing, saving or rearming it. */
  schedulerStatus(): Omit<SchedulerStatus, "alarmAt"> {
    const sweep = this.state.sweep;
    const reread = this.state.reread;
    return {
      running: this.running,
      nextSweepAt: this.state.nextSweep,
      sweep: sweep === null ? null : {
        phase: sweep.stage, startedAt: sweep.startedAt, retry: sweep.retry,
      },
      rereadActive: reread !== null,
      rereadCachedResponseCount: reread?.continuation?.responses.length ?? 0,
      rereadSelectedItemCount: reread?.ids.length ?? 0,
      pending: {
        guard: this.state.guard === null ? 0 : 1,
        refresh: this.state.refresh.length,
        marks: this.state.marks.length,
      },
      selectionConfigured: this.context.selection !== null,
    };
  }

  /** The acknowledgement follows this durable write. No GitHub call occurs here. */
  async receive(delivery: ReducedDelivery, now: number): Promise<boolean> {
    if (delivery.guard) {
      this.state.guard = Math.min(this.state.guard ?? now, now);
      this.state.guardQueuedAt ??= now;
    }
    if (!this.accepted(delivery.installationId)) {
      // A brand-new installation still needs its guard; no repository/PR data is accepted.
      if (delivery.guard) this.save();
      await this.rearm(now);
      return false;
    }
    if (delivery.repositoryCi === undefined || delivery.refresh || delivery.marks.length > 0 || delivery.sha) this.invalidateReads(delivery.installationId);
    const metadata = delivery.repository;
    if (metadata) {
      const previous = this.context.store.repository(metadata.id, delivery.installationId);
      const discovery = new RepositoryDiscoveryStore(this.context.storage);
      if (previous && (metadata.transferred || metadata.ownerId !== null && metadata.ownerId !== previous.ownerAccountId)) {
        discovery.forgetMonitoringOverride(metadata.id);
        // A delayed destination-installation delivery may arrive after its
        // owner has already chosen to mute. Only a changed or unknown owner
        // invalidates that owner's preference.
        if (metadata.ownerId === null || metadata.ownerId !== previous.ownerAccountId) discovery.forgetRepositoryMute(metadata.id);
      } else if (metadata.transferred) {
        // A delayed old-installation delivery must preserve a choice already
        // made for the destination owner, even if its row is currently absent.
        if (metadata.ownerId !== null) {
          discovery.monitoringOverride(metadata.id, metadata.ownerId);
          discovery.repositoryMuted(metadata.id, metadata.ownerId);
        } else {
          const oldOwner = this.context.installations().find((installation) => installation.id === delivery.installationId)!.accountId;
          discovery.forgetMonitoringOverride(metadata.id, oldOwner);
          discovery.forgetRepositoryMute(metadata.id, oldOwner);
        }
      }
      if (!previous && !metadata.deleted && !delivery.refresh) this.refresh(delivery.installationId, now);
      if (previous) {
        if (metadata.deleted) this.context.store.removeRepository(previous.id);
        else this.context.store.putRepository({ ...previous, visibility: metadata.visibility, visibilityReportedAt: now,
          ...(metadata.transferred || metadata.ownerId !== null && metadata.ownerId !== previous.ownerAccountId
            ? { monitored: false, monitorOverride: null, muted: metadata.ownerId === previous.ownerAccountId && previous.muted === true, ownerAccountId: metadata.ownerId ?? previous.ownerAccountId } : {}),
        });
      }
    }
    if (delivery.refresh) this.refresh(delivery.installationId, now);
    if (delivery.repositoryCi !== undefined) {
      const repository = this.context.store.repository(delivery.repositoryCi, delivery.installationId);
      if (repository?.monitored) this.queueCi(repository, now + 2_000, true);
    }
    for (const mark of delivery.marks) this.mark(mark, now + 2_000, false, now);
    if (delivery.sha) {
      const sha = delivery.sha;
      const matching = this.context.store.pullRequests(sha.repositoryId).filter((pr) => pr.headSha === sha.value);
      for (const pr of matching) this.mark({ nodeId: pr.nodeId, repositoryId: pr.repositoryId, installationId: delivery.installationId, facts: sha.facts }, now + 2_000, false, now);
      if (matching.length === 0) {
        const previous = this.state.shas.find((pending) => pending.installationId === delivery.installationId && pending.repositoryId === sha.repositoryId && pending.sha === sha.value);
        if (previous) { previous.facts = coalesceFacts(previous.facts, sha.facts); previous.expires = now + MINUTE; }
        else this.state.shas.push({ installationId: delivery.installationId, repositoryId: sha.repositoryId, sha: sha.value, facts: sha.facts, expires: now + MINUTE });
      }
    }
    this.save();
    await this.context.publish(now);
    await this.rearm(now);
    return true;
  }

  requestGuard(now: number): void {
    this.state.guard = Math.min(this.state.guard ?? now, now);
    this.state.guardQueuedAt ??= now;
    this.save();
  }
  discoveryChanged(id: number, now: number): void {
    this.invalidateReads(id);
    for (const repository of this.context.store.repositories(id)) if (repository.monitored) { this.queueRepositoryRead(repository, now); this.queueCi(repository, now); }
    this.save();
  }

  /** A manual request owns a token, while its reads use the ordinary queue. */
  async refreshRepository(repositoryId: number, ownerAccountId: number, now: number): Promise<RepositoryRefreshResult> {
    const repository = this.context.store.repository(repositoryId);
    if (!repository) return { ok: false, reason: "not-found" };
    if (!this.context.selection || !repository.monitored || repository.ownerAccountId !== ownerAccountId
      || repository.ownerPermission === "none" || !this.accepted(repository.installationId)) return { ok: false, reason: "not-allowed" };
    const existing = this.state.marks.find((mark) => mark.nodeId === `repository:${repository.nodeId}`
      && mark.installationId === repository.installationId && this.markRepository(mark));
    if (existing?.refreshCheck) {
      const attempt = this.context.store.checkStatus("repository-refresh", String(repositoryId)).latestAttempt;
      if (attempt?.id === existing.refreshCheck.id && (attempt.result === "queued" || attempt.result === "running")) {
        await this.rearm(now);
        return { ok: true, attempt };
      }
    }
    // A read already in flight predates this request. Restart it through the
    // same observation guard used by newer deliveries, never accept its replay.
    this.invalidateReads(repository.installationId);
    this.queueRepositoryRead(repository, now);
    const mark = this.state.marks.find((entry) => entry.nodeId === `repository:${repository.nodeId}`
      && entry.installationId === repository.installationId)!;
    mark.firstRead = null;
    mark.retry = 0;
    const attempt = this.context.store.beginCheck("repository-refresh", String(repositoryId), now);
    mark.refreshCheck = attempt;
    this.save();
    await this.rearm(now);
    await this.context.publish(now);
    return { ok: true, attempt };
  }

  /** Repository/settings changes schedule discovery without making a hidden page visible. */
  refresh(id: number, now: number, invalidate = true): void {
    this.invalidateReads(id);
    if (invalidate) this.context.selection?.discardRefreshProgress(id);
    const revision = (this.state.refreshGenerations[id] ?? 0) + 1;
    this.state.refreshGenerations[id] = revision;
    const existing = this.state.refresh.find((entry) => entry.id === id);
    const job = existing ?? { id, due: now, revision, queuedAt: now };
    if (existing) { existing.due = Math.min(existing.due, now); existing.revision = revision; this.interruptChecks(existing.checks); }
    else this.state.refresh.push(job);
    job.checks = [];
    for (const repository of this.context.store.repositories(id).filter((repo) => repo.monitored)) this.track(job.checks, "repository", String(repository.id), now, "queued");
    this.save();
  }

  private generation(id: number): number { return this.state.observationGenerations[id] ?? 0; }
  private invalidateReads(id: number): void {
    this.state.observationGenerations[id] = this.generation(id) + 1;
  }

  /** Drop cached work before it can restrict scheduling to missing/stale marks. */
  private normalizeReread(now: number): boolean {
    const progress = this.state.reread;
    if (progress && (!this.accepted(progress.installationId)
      || progress.generation !== this.generation(progress.installationId)
      || progress.ids.length === 0
      || progress.ids.some((id) => !this.state.marks.some((mark) => mark.nodeId === id
        && mark.installationId === progress.installationId && this.markRepository(mark))))) {
      this.abandonReread(progress, now);
      return true;
    }
    return false;
  }

  private mark(mark: PrMark, due: number, mergeability = false, queuedAt = due): void {
    const repository = this.context.store.repository(mark.repositoryId);
    if (repository && (!repository.monitored || repository.installationId !== mark.installationId)) return;
    let previous = this.state.marks.find((pending) => pending.nodeId === mark.nodeId && pending.installationId === mark.installationId);
    if (previous && repository && previous.repositoryOwnerAccountId !== undefined && previous.repositoryOwnerAccountId !== repository.ownerAccountId) {
      this.removeMark(previous); previous = undefined;
    }
    if (previous) {
      previous.facts = coalesceFacts(previous.facts, mark.facts);
      previous.due = Math.min(previous.due, due);
      previous.revision++;
      previous.mergeability ||= mergeability;
      if (mark.facts.length > 0) { previous.firstRead = null; previous.retry = 0; }
    } else this.state.marks.push({ ...mark, due, queuedAt, firstRead: null, retry: 0, revision: 0, mergeability, ...(repository ? { repositoryOwnerAccountId: repository.ownerAccountId } : {}) });
    const queued = previous ?? this.state.marks[this.state.marks.length - 1]!;
    if (repository && (!previous || mark.facts.length > 0)) queued.check = this.context.store.beginCheck(this.markScope(queued), this.markKey(queued), queuedAt, "queued");
  }

  /** Called for visibility, overdue and retry-now messages. Client clocks are never used. */
  async visibility(now: number, retry: boolean): Promise<void> {
    if (this.context.visible(now)) {
      const last = this.context.store.syncStatus().lastSuccessfulSweepAt;
      const eligible = this.state.lastCatchup === null || now - this.state.lastCatchup >= MINUTE;
      if (!this.state.sweep && eligible && (retry || last === null || now - last > 2 * MINUTE)) {
        this.state.lastCatchup = now;
        this.state.nextSweep = now;
      } else if (this.state.nextSweep === null) this.state.nextSweep = this.state.sweep ? now : Math.max(now, (last ?? now) + this.interval(now));
    } else this.state.nextSweep = null;
    this.save();
    await this.rearm(now);
  }

  /** Ordinary requests repair missing or idle stale alarms without dropping jobs. */
  async rearm(now: number): Promise<void> {
    if (this.normalizeReread(now)) this.save();
    const obsoleteCi = this.state.ci!.filter((job) => !this.ciRepository(job));
    if (obsoleteCi.length > 0) {
      for (const job of obsoleteCi) this.context.store.finishCheck("repository-ci", String(job.repositoryId), job.check, "interrupted");
      this.state.ci = this.state.ci!.filter((job) => !obsoleteCi.includes(job));
      this.save();
    }
    const active = this.context.visible(now);
    const activeSince = active ? this.state.activeSince ?? now : null;
    if (this.state.activeSince !== activeSince) {
      this.state.activeSince = activeSince;
      this.save();
    }
    // Upgrade old persisted jobs once; retries must not reset their age.
    let upgraded = false;
    if (this.state.guard !== null && this.state.guardQueuedAt == null) {
      this.state.guardQueuedAt = this.state.guard; upgraded = true;
    }
    for (const job of [...this.state.refresh, ...this.state.marks]) {
      if (job.queuedAt === undefined) { job.queuedAt = job.due; upgraded = true; }
    }
    if (upgraded) this.save();
    if (!active && (this.state.sweep !== null || this.state.nextSweep !== null)) {
      // A resumed sweep must not replay cached facts from a quiet interval.
      const interruptedInstallation = this.state.sweep?.installations[this.state.sweep.installationIndex];
      this.interruptChecks(this.state.sweep?.checks);
      if (interruptedInstallation !== undefined && this.state.sweep?.stage === "listing") this.context.selection?.discardRefreshProgress(interruptedInstallation);
      this.state.sweep = null;
      this.state.nextSweep = null;
      this.save();
    }
    if (!active && this.state.ci!.some((job) => job.visibleOnly)) {
      for (const job of this.state.ci!.filter((entry) => entry.visibleOnly)) this.context.store.finishCheck("repository-ci", String(job.repositoryId), job.check, "interrupted");
      this.state.ci = this.state.ci!.filter((job) => !job.visibleOnly);
      this.save();
    }
    if (this.state.rates.length > 0) {
      const sync = this.context.store.syncStatus();
      const intervalMs = this.interval(now);
      if (intervalMs !== sync.intervalMs) {
        this.rescheduleInterval(sync.intervalMs, intervalMs);
        this.context.store.putSyncStatus({ ...sync, intervalMs, slowedByRateLimit: intervalMs > 2 * MINUTE });
        this.save();
        if (!this.publishingStatus) {
          this.publishingStatus = true;
          try { await this.context.publish(now); }
          finally { this.publishingStatus = false; }
        }
      }
    }
    const times = [this.state.guard, ...this.state.refresh.map((job) => job.due), ...this.state.marks.filter((mark) => this.markRepository(mark)).map((mark) => mark.due), ...this.state.shas.map((sha) => sha.expires),
      ...this.state.ci!.filter((job) => this.ciRepository(job)).map((job) => job.due)];
    if (active && !this.state.reread) {
      if (this.state.sweep) times.push(this.state.nextSweep ?? now);
      else times.push(this.state.nextSweep);
    }
    const finite = times.filter((time): time is number => time !== null);
    const current = await this.context.storage.getAlarm();
    if (finite.length === 0) {
      if (current !== null) await this.context.storage.deleteAlarm();
      return;
    }
    const due = Math.max(now, Math.min(...finite));
    // A stored past alarm may have exhausted runtime retries. Keep fresh
    // overdue alarms and running work intact, but do not retain one forever.
    const stale = current !== null && now - current > 5 * MINUTE && !this.running;
    if (current === null || current > due || stale) await this.context.storage.setAlarm(due);
  }

  /** One bounded operation per alarm, including at most one token-mint allowance. */
  async alarm(now: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    let activeJob: string | null = null;
    let activeRefreshId: number | null = null;
    try {
      this.state.shas = this.state.shas.filter((sha) => sha.expires > now && this.accepted(sha.installationId));
      this.state.marks = this.state.marks.filter((mark) => {
        const keep = this.accepted(mark.installationId) && (this.markRepository(mark)
          || mark.repositoryOwnerAccountId === undefined && !this.context.store.repository(mark.repositoryId)
            && this.state.refresh.some((job) => job.id === mark.installationId));
        if (!keep && mark.refreshCheck) this.context.store.finishCheck("repository-refresh", String(mark.repositoryId), mark.refreshCheck, "interrupted");
        return keep;
      });
      this.normalizeReread(now);
      this.state.ci = this.state.ci!.filter((job) => Boolean(this.ciRepository(job)));
      const ci = this.state.ci.reduce<PendingCi | null>((first, job) => first === null || job.due < first.due ? job : first, null);
      const earliestRefresh = this.state.refresh.reduce<{ id: number; due: number; revision: number } | null>((first, job) => first === null || job.due < first.due ? job : first, null);
      const readMarks = this.state.marks.filter((mark) => this.markRepository(mark) && (!this.state.reread || this.state.reread.ids.includes(mark.nodeId)));
      const rereadDue = Math.min(...readMarks.map((mark) => mark.due));
      const jobs = [
        { kind: "guard", due: this.state.guard ?? Infinity },
        { kind: "refresh", due: earliestRefresh?.due ?? Infinity },
        { kind: "reread", due: rereadDue },
        // Finish a continued event read before starting another reader that
        // would invalidate it. Ordinary marks retain oldest-deadline fairness.
        { kind: "sweep", due: !this.state.reread && this.context.visible(now) ? this.state.nextSweep ?? Infinity : Infinity },
        { kind: "ci", due: ci?.due ?? Infinity },
      ].sort((left, right) => left.due - right.due);
      // A large repository CI backlog may have an older common deadline than
      // the next PR phase. Alternate classes whenever ordinary work is due.
      const job = (this.state.lastJobWasCi ? jobs.find((entry) => entry.kind !== "ci" && entry.due <= now) : null) ?? jobs[0]!;
      if (job.due <= now) {
        this.state.lastJobWasCi = job.kind === "ci";
        activeJob = job.kind;
        if (job.kind === "guard") {
          this.state.guard = null;
          if (await this.context.guard(now)) {
            this.state.guardQueuedAt = null;
            for (const installation of this.context.installations()) if (installation.status === "accepted") this.refresh(installation.id, now);
          } else this.state.guard = now + 15_000;
        } else if (job.kind === "refresh") { activeRefreshId = earliestRefresh!.id; await this.refreshRepositories(activeRefreshId, now); }
        else if (job.kind === "reread") await this.reread(now);
        else if (job.kind === "ci") await this.readCi(ci!, now);
        else await this.sweep(now);
      }
    } catch (error) {
      if (!(error instanceof SyncReadError)) reportGithubFailure("sync-unexpected", "unexpected");
      const failedRead = this.state.reread;
      const readStillCurrent = failedRead !== null && this.accepted(failedRead.installationId)
        && failedRead.generation === this.generation(failedRead.installationId)
        && failedRead.ids.every((id) => this.state.marks.some((mark) => mark.nodeId === id && this.markRepository(mark)));
      if (activeJob === "reread" && this.state.reread && !readStillCurrent) this.abandonReread(this.state.reread, now);
      else if (activeJob === "reread" && this.state.reread) {
        for (const check of this.state.reread.checks ?? []) this.context.store.finishCheck(check.scope, check.key, check.attempt, readStillCurrent ? "failed" : "interrupted", readStillCurrent ? error instanceof SyncReadError ? error.reason : "github-unavailable" : undefined);
        this.state.reread = null;
      }
      if (activeJob === "sweep" && this.state.sweep) {
        const sweep = this.state.sweep;
        const installationId = sweep.installations[sweep.installationIndex];
        if (!this.currentSweep(sweep)) {
          // Losing the last visible observer cancels work, including errors
          // arriving after its network response was no longer authoritative.
        } else if (installationId !== undefined && sweep.stage !== "listing" && sweep.generation !== this.generation(installationId)) {
          this.interruptChecks(sweep.checks);
          this.state.nextSweep = now + 1;
        } else await this.failSweep(now, error instanceof SyncReadError ? error.reason : "github-unavailable", []);
      }
      if (activeJob === "reread" && readStillCurrent) for (const mark of this.state.marks) {
        if (failedRead!.revisions.some(([nodeId, revision]) => nodeId === mark.nodeId && revision === mark.revision)) this.retryMark(mark, now, error instanceof SyncReadError ? error.reason : "github-unavailable");
      }
      if (activeJob === "refresh") for (const job of this.state.refresh) if (job.id === activeRefreshId) {
        for (const check of job.checks ?? []) this.context.store.finishCheck(check.scope, check.key, check.attempt, "failed", "github-unavailable");
        job.checks = undefined;
        job.due = now + 15_000;
      }
      if (activeJob === "guard" && this.state.guard !== null && this.state.guard <= now) this.state.guard = now + 15_000;
      await this.context.publish(now);
    } finally {
      this.running = false;
      this.save();
      await this.rearm(now);
    }
  }

  private ciRepository(job: PendingCi): RepositoryRecord | undefined {
    const repository = this.context.store.repository(job.repositoryId, job.installationId);
    return this.accepted(job.installationId) && repository?.monitored && repository.ownerAccountId === job.ownerAccountId
      && repository.fullName === job.fullName
      && this.context.store.checkStatus("repository-ci", String(job.repositoryId)).latestAttempt?.id === job.check.id ? repository : undefined;
  }

  private ciWait(installationId: number, now: number): number {
    return Math.max(now, ...this.state.rates.filter((entry) => entry.installationId === installationId)
      .map(({ rate }) => Math.max(rate.retryAt ?? 0, rate.remaining === 0 ? rate.resetAt : 0)));
  }

  /** Visible sweeps coalesce with event/manual work instead of resetting it. */
  private queueCi(repository: RepositoryRecord, now: number, invalidate = false, visibleOnly = false): void {
    if (!this.context.ownerId || !this.context.selection || !repository.monitored || !this.accepted(repository.installationId)) return;
    const existing = this.state.ci!.find((job) => job.repositoryId === repository.id && this.ciRepository(job));
    if (existing) {
      existing.visibleOnly &&= visibleOnly;
      if (invalidate) {
        existing.revision++;
        existing.continuation = null;
        existing.retry = 0;
        existing.queuedAt = now;
        existing.check = this.context.store.beginCheck("repository-ci", String(repository.id), now);
        existing.due = this.ciWait(repository.installationId, Math.min(existing.due, now));
      }
      return;
    }
    this.state.ci = this.state.ci!.filter((job) => job.repositoryId !== repository.id);
    this.state.ci.push({ repositoryId: repository.id, installationId: repository.installationId,
      ownerAccountId: repository.ownerAccountId, fullName: repository.fullName, due: this.ciWait(repository.installationId, now), queuedAt: now,
      revision: 0, retry: 0, check: this.context.store.beginCheck("repository-ci", String(repository.id), now), continuation: null, visibleOnly });
  }

  private failCi(job: PendingCi, issue: RepositoryCiIssue, now: number, retryAt?: number, defaultBranch?: string | null): void {
    const repository = this.ciRepository(job);
    if (!repository) return;
    let before = this.context.store.repositoryCi(repository.id)[0]!;
    if (defaultBranch !== undefined && defaultBranch !== before.defaultBranch) {
      // Last-good evidence and freshness from a different branch cannot be
      // reused as proof about the newly configured default branch.
      this.context.store.clearRepositoryCi(repository.id);
      job.check = this.context.store.beginCheck("repository-ci", String(repository.id), job.check.startedAt, "running");
      before = this.context.store.repositoryCi(repository.id)[0]!;
    }
    this.context.store.putRepositoryCi(repository, { ...before, defaultBranch: defaultBranch === undefined ? before.defaultBranch : defaultBranch }, job.check, issue);
    this.context.store.finishCheck("repository-ci", String(repository.id), job.check, "failed", issue === "rate-limited" ? "rate-limited" : "github-unavailable");
    job.continuation = null;
    if (issue === "rate-limited") {
      const deadline = Math.max(now + 1, retryAt ?? now + MINUTE);
      this.updateRate(job.installationId, { remaining: 1, cost: 0, resetAt: deadline, retryAt: deadline });
      job.due = this.ciWait(job.installationId, deadline);
    } else if (issue === "github-unavailable" && job.retry < RETRIES.length) job.due = now + RETRIES[job.retry++]!;
    else this.state.ci = this.state.ci!.filter((entry) => entry !== job);
  }

  private async readCi(job: PendingCi, now: number): Promise<void> {
    const repository = this.ciRepository(job);
    if (!repository || !this.context.selection || !this.context.ownerId) return;
    const wait = this.ciWait(job.installationId, now);
    if (wait > now) { job.due = wait; return; }
    const latest = this.context.store.checkStatus("repository-ci", String(repository.id)).latestAttempt;
    if (latest?.result === "failed" || latest?.result === "interrupted") job.check = this.context.store.beginCheck("repository-ci", String(repository.id), now, "running");
    else this.context.store.runCheck("repository-ci", String(repository.id), job.check);
    const revision = job.revision;
    const current = () => this.state.ci!.includes(job) && job.revision === revision && Boolean(this.ciRepository(job))
      && (!job.visibleOnly || this.context.visible(Date.now()));
    // Save the observation token before any network request or continuation.
    this.save();
    try {
      const authorization = await this.context.selection.tokens.get(job.installationId, now);
      if (!current()) return;
      if (!authorization.ok) {
        this.failCi(job, authorization.reason === "rate-limited" ? "rate-limited"
          : authorization.reason === "installation-removed" || authorization.reason === "installation-suspended" ? "permission-required" : "github-unavailable", now,
          authorization.reason === "rate-limited" ? authorization.retryAt : undefined);
        await this.context.publish(now); return;
      }
      let ownerLogin: string | null = null;
      if (repository.ownerAccountId !== this.context.ownerId) {
        const login = await new GitHubRepositoryListing().readOwnerLogin(authorization.token, this.context.ownerId);
        if (!current()) return;
        if (!login.ok) { this.failCi(job, login.reason, now, login.retryAt); await this.context.publish(now); return; }
        ownerLogin = login.login;
        const access = await readReviewerPermission(authorization.token, repository, { id: this.context.ownerId, login: ownerLogin });
        if (!current()) return;
        if (!access.ok || !access.entry || access.entry.permission === "none") {
          if (access.ok && access.entry?.permission === "none") {
            this.context.store.clearRepositoryCi(repository.id);
            job.check = this.context.store.beginCheck("repository-ci", String(repository.id), now, "running");
          }
          this.failCi(job, access.reason === "rate-limited" ? "rate-limited"
            : access.ok && access.entry?.permission === "none" ? "permission-required" : "github-unavailable", now, access.retryAt);
          await this.context.publish(now); return;
        }
      }
      const result = await readRepositoryCi(authorization.token, repository, {
        // Reserve one mint, owner login and two permission calls: <=40 total.
        requestLimit: 35, continuation: job.continuation, previous: this.context.store.repositoryCi(repository.id)[0], shouldContinue: current, now,
      });
      if (!current()) return;
      if (result.kind === "continuation") {
        job.continuation = result.continuation;
        job.due = now + 1;
      } else if (result.kind === "failed") this.failCi(job, result.issue, now, result.retryAt, result.defaultBranch);
      else {
        if (ownerLogin !== null) {
          // A long logical read may span several alarms. Reauthorize before
          // publishing the result; do not expose old facts after access loss.
          const access = await readReviewerPermission(authorization.token, repository, { id: this.context.ownerId, login: ownerLogin });
          if (!current()) return;
          if (!access.ok || !access.entry || access.entry.permission === "none") {
            if (access.ok && access.entry?.permission === "none") {
              this.context.store.clearRepositoryCi(repository.id);
              job.check = this.context.store.beginCheck("repository-ci", String(repository.id), now, "running");
            }
            this.failCi(job, access.reason === "rate-limited" ? "rate-limited"
              : access.ok && access.entry?.permission === "none" ? "permission-required" : "github-unavailable", now, access.retryAt);
            await this.context.publish(now); return;
          }
        }
        let previous = this.context.store.repositoryCi(repository.id)[0]!;
        if (previous.defaultBranch !== null && previous.defaultBranch !== result.data.defaultBranch) {
          this.context.store.clearRepositoryCi(repository.id);
          job.check = this.context.store.beginCheck("repository-ci", String(repository.id), job.check.startedAt, "running");
          previous = this.context.store.repositoryCi(repository.id)[0]!;
        }
        if (result.data.coverage === "incomplete") {
          const streams = new Map(previous.streams.map((stream) => [`${stream.workflowId}:${stream.trigger}`, stream]));
          for (const stream of result.data.streams) {
            const key = `${stream.workflowId}:${stream.trigger}`;
            streams.set(key, { ...stream, completed: stream.completed ?? streams.get(key)?.completed ?? null });
          }
          this.context.store.putRepositoryCi(repository, { ...result.data, streams: [...streams.values()] }, job.check, "history-limited");
          this.context.store.finishCheck("repository-ci", String(repository.id), job.check, "failed", "github-unavailable");
        } else {
          this.context.store.putRepositoryCi(repository, result.data, job.check);
          this.context.store.finishCheck("repository-ci", String(repository.id), job.check, "success");
        }
        this.state.ci = this.state.ci!.filter((entry) => entry !== job);
      }
      await this.context.publish(now);
    } catch {
      if (current()) { this.failCi(job, "github-unavailable", now); await this.context.publish(now); }
    }
  }

  private interval(now: number): number {
    return this.state.rates.some(({ rate }) => rate.resetAt > now && rate.limit !== undefined && rate.remaining < rate.limit / 10) ? 4 * MINUTE : 2 * MINUTE;
  }
  private updateRate(id: number, incoming: RateLimit): void {
    const previous = this.state.rates.find((entry) => entry.installationId === id)?.rate;
    // A continuation can replay an older GraphQL response after a newer
    // event read. Never replenish its budget from that cached sample.
    const sample = previous && previous.resetAt > incoming.resetAt ? previous
      : previous && previous.resetAt === incoming.resetAt ? { ...incoming,
        remaining: Math.min(previous.remaining, incoming.remaining),
        ...(previous.limit === undefined && incoming.limit === undefined ? {} : { limit: Math.max(previous.limit ?? 0, incoming.limit ?? 0) }),
      } : incoming;
    // HTTP secondary throttles can expire before a healthy primary window.
    // Preserve both observations instead of discarding the earlier deadline
    // or treating a one-minute throttle as an hour-long primary exhaustion.
    const retryAt = Math.max(previous?.retryAt ?? 0, incoming.retryAt ?? 0);
    const rate = retryAt > 0 ? { ...sample, retryAt } : sample;
    this.state.rates = this.state.rates.filter((entry) => entry.installationId !== id);
    this.state.rates.push({ installationId: id, rate });
  }
  private updateMeta(id: number, meta: ReadMeta, now: number): void {
    if (meta.rateLimit) this.updateRate(id, meta.rateLimit);
    const permissions = new Map(this.state.permissions.map((entry) => [`${entry.repositoryId}:${entry.accountId}`, entry]));
    for (const entry of meta.permissionCache) permissions.set(`${entry.repositoryId}:${entry.accountId}`, entry);
    this.state.permissions = [...permissions.values()];
    const dates = new Map(this.state.headDates.map((entry) => [`${entry.repositoryId}:${entry.headSha}`, entry]));
    for (const entry of meta.headCommitDates) dates.set(`${entry.repositoryId}:${entry.headSha}`, entry);
    // Keep only dates referenced by current PRs or this continuation.
    const heads = new Set(this.context.store.pullRequests().map((pr) => `${pr.repositoryId}:${pr.headSha}`));
    for (const entry of meta.headCommitDates) heads.add(`${entry.repositoryId}:${entry.headSha}`);
    this.state.headDates = [...dates.entries()].filter(([key]) => heads.has(key)).map(([, value]) => value);
    const sync = this.context.store.syncStatus();
    const intervalMs = this.interval(now);
    this.rescheduleInterval(sync.intervalMs, intervalMs);
    this.context.store.putSyncStatus({ ...sync, intervalMs, slowedByRateLimit: intervalMs > 2 * MINUTE });
  }
  private rescheduleInterval(previous: number, interval: number): void {
    const last = this.context.store.syncStatus().lastSuccessfulSweepAt;
    if (!this.state.sweep && last !== null && this.state.nextSweep === last + previous) this.state.nextSweep = last + interval;
  }
  private async reader(id: number, now: number, continuation: ReaderContinuation | null, sweep: boolean, shouldContinue?: () => boolean, manualRepositoryIds?: readonly number[]): Promise<GithubPrReader | null> {
    if (!this.accepted(id) || !this.context.selection) return null;
    if (manualRepositoryIds && !this.context.ownerId) throw new SyncReadError("github-unavailable");
    if (manualRepositoryIds && this.state.rates.some((entry) => entry.installationId === id
      && (entry.rate.remaining === 0 && entry.rate.resetAt > now || (entry.rate.retryAt ?? 0) > now))) throw new SyncReadError("rate-limited");
    const token = await this.context.selection.tokens.get(id, now);
    if (!token.ok) {
      if (manualRepositoryIds && token.reason === "rate-limited") {
        const retryAt = token.retryAt ?? now + MINUTE;
        this.updateRate(id, { remaining: 0, resetAt: retryAt, retryAt, cost: 0 });
      }
      throw new SyncReadError(token.reason === "rate-limited" || token.reason === "installation-suspended" || token.reason === "installation-removed" ? token.reason : "github-unavailable");
    }
    return new GithubPrReader(token.token, { requestLimit: 40, refreshPermissions: sweep, verifyMergeability: sweep,
      permissionCache: this.state.permissions, headCommitDates: this.state.headDates, continuation, shouldContinue,
      ...(manualRepositoryIds ? { repositoryAccess: { ownerId: this.context.ownerId!, repositoryOwners: this.context.store.repositories(id)
        .filter((repository) => manualRepositoryIds.includes(repository.id)).map((repository) => ({ repositoryId: repository.id, ownerAccountId: repository.ownerAccountId })) } } : {}),
    });
  }
  private async refreshRepositories(id: number, now: number): Promise<void> {
    const job = this.state.refresh.find((entry) => entry.id === id)!;
    const revision = job.revision;
    job.checks ??= [];
    for (const repository of this.context.store.repositories(id).filter((repo) => repo.monitored)) {
      const attempt = this.track(job.checks, "repository", String(repository.id), now);
      this.context.store.runCheck("repository", String(repository.id), attempt);
    }
    this.save();
    const checks = job.checks;
    let result: Awaited<ReturnType<RepositorySelection["refreshInstallation"]>> | undefined;
    try { result = await this.context.selection?.refreshInstallation(id, now, 25, () => job.revision === revision); }
    catch (error) {
      if (job.revision === revision) throw error;
      this.interruptChecks(checks);
      this.context.selection?.discardRefreshProgress(id);
      job.due = now + 1;
      return;
    }
    if (job.revision !== revision) {
      this.context.selection?.discardRefreshProgress(id);
      job.due = now + 1;
      return;
    }
    if (result && !result.ok && result.reason === "continuation") { job.due = now + 1; return; }
    this.state.refresh = this.state.refresh.filter((entry) => entry !== job);
    if (result?.ok) {
      // A listing event also discovers new PRs while every overview is hidden.
      for (const repository of this.context.store.repositories(id).filter((repo) => repo.monitored)) {
        // Read as a miniature sweep, separately from the visibility-gated sweep.
        this.queueRepositoryRead(repository, now);
        this.queueCi(repository, now);
      }
      this.interruptChecks(checks);
    } else if (this.accepted(id)) {
      for (const check of checks) this.context.store.finishCheck(check.scope, check.key, check.attempt, "failed", result && !result.ok ? result.reason : "github-unavailable");
      job.checks = undefined;
      job.due = now + 15_000;
      this.state.refresh.push(job);
    }
  }

  private queueRepositoryRead(repository: RepositoryRecord, now: number): void {
    // A repository mark is represented separately from PR IDs because new PRs
    // cannot be named until the authoritative listing is read.
    const key = `repository:${repository.nodeId}`;
    this.mark({ nodeId: key, repositoryId: repository.id, installationId: repository.installationId, facts: [] }, now);
  }

  private async reread(now: number): Promise<void> {
    const first = this.state.reread ? this.state.marks.find((mark) => mark.nodeId === this.state.reread!.ids[0] && this.markRepository(mark)) : this.state.marks.find((mark) => mark.due <= now && this.markRepository(mark));
    if (!first) { this.state.reread = null; return; }
    const repositoryRead = first.nodeId.startsWith("repository:");
    const selected = this.state.reread
      ? this.state.marks.filter((mark) => this.state.reread!.ids.includes(mark.nodeId))
      : this.state.marks.filter((mark) => this.markRepository(mark) && mark.installationId === first.installationId && mark.due <= now && mark.nodeId.startsWith("repository:") === repositoryRead
        && Boolean(mark.refreshCheck) === Boolean(first.refreshCheck)).slice(0, first.refreshCheck ? 1 : 10);
    if (selected.length === 0) { this.state.reread = null; return; }
    const revisions = new Map(this.state.reread?.revisions ?? selected.map((mark): [string, number] => [mark.nodeId, mark.revision]));
    const installationId = first.installationId;
    // A queued event may only become due after an older sweep has begun.
    // Starting its fresh read also supersedes those earlier observations.
    if (!this.state.reread) this.invalidateReads(installationId);
    const generation = this.generation(installationId);
    const current = () => this.accepted(installationId) && this.generation(installationId) === generation && selected.every((mark) => this.markRepository(mark));
    const progress: ReadProgress = this.state.reread ?? {
      installationId, generation, ids: selected.map((mark) => mark.nodeId), revisions: [...revisions],
      continuation: null, checks: [], startedAt: now,
    };
    progress.checks ??= [];
    // Old persisted continuations have no observation start. Their original
    // queue time is a conservative bound, never the time of the replay.
    if (progress.startedAt === undefined && selected.some((mark) => mark.queuedAt === undefined)) {
      progress.continuation = null;
      progress.startedAt = now;
    } else progress.startedAt ??= Math.min(...selected.map((mark) => mark.queuedAt ?? mark.due));
    for (const mark of selected) {
      mark.repositoryOwnerAccountId ??= this.markRepository(mark)!.ownerAccountId;
      mark.check = this.track(progress.checks, this.markScope(mark), this.markKey(mark), progress.startedAt);
      this.context.store.runCheck(this.markScope(mark), this.markKey(mark), mark.check);
      if (mark.refreshCheck) this.context.store.runCheck("repository-refresh", String(mark.repositoryId), mark.refreshCheck);
      if (repositoryRead) {
        for (const pr of this.context.store.pullRequests(mark.repositoryId)) this.track(progress.checks, "pr", pr.nodeId, progress.startedAt);
      }
    }
    this.state.reread = progress;
    this.save();
    if (selected.some((mark) => mark.refreshCheck)) await this.context.publish(now);
    const abandon = () => this.abandonReread(progress, now);
    if (!current()) { abandon(); return; }
    let reader: GithubPrReader | null;
    const manualRepositoryIds = selected.filter((mark) => mark.refreshCheck).map((mark) => mark.repositoryId);
    try { reader = await this.reader(installationId, now, progress.continuation, manualRepositoryIds.length > 0, current, manualRepositoryIds.length > 0 ? manualRepositoryIds : undefined); }
    catch (error) {
      if (!current()) { abandon(); return; }
      if (!(error instanceof SyncReadError)) throw error;
      for (const check of progress.checks) this.context.store.finishCheck(check.scope, check.key, check.attempt, "failed", error.reason);
      for (const mark of selected) this.retryMark(mark, now, error.reason);
      this.state.reread = null;
      await this.context.publish(now);
      return;
    }
    if (!current()) { abandon(); return; }
    if (!reader) {
      for (const check of progress.checks) this.context.store.finishCheck(check.scope, check.key, check.attempt, "failed", "github-unavailable");
      for (const mark of selected) this.retryMark(mark, now);
      this.state.reread = null;
      await this.context.publish(now);
      return;
    }
    if (repositoryRead) {
      const result = await reader.readRepositories(selected.map((mark) => mark.nodeId.slice("repository:".length)));
      if (!current()) { abandon(); return; }
      this.updateMeta(first.installationId, result, now);
      for (const repository of result.repositories) this.applyRepository(repository, first.installationId, now, progress.checks, progress.startedAt, result.issues);
      if (result.continuation) progress.continuation = result.continuation;
      else {
        this.state.reread = null;
        for (const mark of selected) {
          const complete = result.repositories.some((repository) => repository.repositoryId === mark.repositoryId && repository.complete);
          if (complete && revisions.get(mark.nodeId) === mark.revision) {
            this.context.store.finishCheck(this.markScope(mark), this.markKey(mark), mark.check!, "success");
            if (mark.refreshCheck) this.context.store.finishCheck("repository-refresh", String(mark.repositoryId), mark.refreshCheck, "success");
            this.removeMark(mark);
          } else this.retryMark(mark, now, readFailure(result));
          if (!complete) {
            for (const pr of this.context.store.pullRequests(mark.repositoryId)) {
              const attempt = progress.checks.find((check) => check.scope === "pr" && check.key === pr.nodeId)?.attempt;
              if (attempt) this.context.store.finishCheck("pr", pr.nodeId, attempt, "failed", readFailure(result));
            }
          }
        }
      }
    } else {
      const result = await reader.rereadPrs(selected.map((mark) => mark.nodeId));
      if (!current()) { abandon(); return; }
      this.updateMeta(first.installationId, result, now);
      if (result.continuation) progress.continuation = result.continuation;
      else this.state.reread = null;
      for (const mark of selected) {
        const attempt = progress.checks.find((check) => check.scope === "pr" && check.key === mark.nodeId)!.attempt;
        const node = result.nodes.find((node) => (node.kind === "open" ? node.pr.nodeId : node.nodeId) === mark.nodeId);
        const previous = this.context.store.pullRequest(mark.nodeId, mark.repositoryId);
        if (node && node.kind !== "unavailable") {
          const checked = !result.issues.some((issue) => issue.nodeId === mark.nodeId);
          if (checked) this.context.store.recordCheckSuccess("pr", mark.nodeId, attempt);
          if (node.kind === "open") this.applyPr(node.pr, first.installationId, node.visibility ?? "private", now);
          else this.context.store.removePullRequest(node.nodeId);
          mark.facts = mark.facts.filter((fact) => !factObserved(fact, node, previous));
          mark.mergeability = node.kind === "open" && node.pr.mergeable === "unknown";
          if (!result.continuation) {
            if (mark.facts.length === 0 && !mark.mergeability && checked && revisions.get(mark.nodeId) === mark.revision) {
              this.context.store.finishCheck("pr", mark.nodeId, attempt, "success");
              this.removeMark(mark);
            } else this.retryMark(mark, now, readFailure(result), attempt, checked);
          }
        } else if (!result.continuation) this.retryMark(mark, now, readFailure(result), attempt);
      }
    }
    if (this.state.reread) for (const mark of selected) mark.due = now + 1;
    await this.context.publish(now);
  }
  private removeMark(mark: PendingMark): void { this.state.marks = this.state.marks.filter((pending) => pending !== mark); }
  private retryMark(mark: PendingMark, now: number, reason: SyncFailureReason = "github-unavailable", attempt = mark.check, readSucceeded = false): void {
    mark.firstRead ??= now;
    const offset = RETRIES[mark.retry];
    // A complete API read can still be waiting for webhook facts or GitHub's
    // mergeability computation. Keep that successful observation and pending
    // status; an actual read failure or exhausted retry budget is terminal.
    if (attempt && (!readSucceeded || offset === undefined)) this.context.store.finishCheck(this.markScope(mark), this.markKey(mark), attempt, "failed", reason);
    if (offset === undefined) {
      if (mark.refreshCheck) this.context.store.finishCheck("repository-refresh", String(mark.repositoryId), mark.refreshCheck, "failed", reason);
      this.state.lastEventFailureAt = now; this.removeMark(mark); return;
    }
    mark.retry++;
    mark.due = Math.max(now + 1, mark.firstRead + offset);
    if (mark.refreshCheck && reason === "rate-limited") {
      const rate = this.state.rates.find((entry) => entry.installationId === mark.installationId)?.rate;
      if (rate) mark.due = Math.max(mark.due, rate.remaining === 0 ? rate.resetAt : 0, rate.retryAt ?? 0);
    }
  }
  private applyPr(pr: PullRequestRecord, installationId: number, visibility: RepositoryRecord["visibility"], now: number): void {
    if (!this.accepted(installationId)) return;
    const repository = this.context.store.repository(pr.repositoryId, installationId);
    if (!repository || !repository.monitored) return;
    if (repository.ownerAccountId !== pr.repository.ownerAccountId) {
      const discovery = new RepositoryDiscoveryStore(this.context.storage);
      discovery.forgetMonitoringOverride(repository.id);
      discovery.forgetRepositoryMute(repository.id);
      this.context.store.putRepository({ ...repository, monitored: false, monitorOverride: null, muted: false, ownerAccountId: pr.repository.ownerAccountId, visibility, listedAt: now, visibilityReportedAt: now });
      this.refresh(installationId, now);
      return;
    }
    this.context.store.putRepository({ ...repository, fullName: pr.repository.fullName, visibility, listedAt: now, visibilityReportedAt: now });
    this.context.store.putPullRequest(pr);
    const shas = this.state.shas.filter((sha) => sha.installationId === installationId && sha.repositoryId === pr.repositoryId && sha.sha === pr.headSha && sha.expires > now);
    for (const sha of shas) this.mark({ nodeId: pr.nodeId, repositoryId: pr.repositoryId, installationId, facts: sha.facts }, now + 2_000, false, now);
    this.state.shas = this.state.shas.filter((sha) => !shas.includes(sha));
    if (pr.mergeable === "unknown") this.mark({ nodeId: pr.nodeId, repositoryId: pr.repositoryId, installationId, facts: [] }, now + 5_000, true, now);
  }
  private applyRepository(repository: { repositoryId: number; visibility: RepositoryRecord["visibility"]; complete: boolean; prs: readonly PullRequestRecord[] }, installationId: number, now: number, checks: TrackedCheck[], startedAt: number, issues: readonly { nodeId: string; reason: string }[]): void {
    if (!this.accepted(installationId)) return;
    const before = this.context.store.repository(repository.repositoryId, installationId);
    if (!before?.monitored) return;
    this.context.store.putRepository({ ...before, visibility: repository.visibility, listedAt: now, visibilityReportedAt: now });
    for (const pr of repository.prs) {
      const attempt = this.track(checks, "pr", pr.nodeId, startedAt);
      const issue = issues.find((issue) => issue.nodeId === pr.nodeId);
      if (!issue) this.context.store.finishCheck("pr", pr.nodeId, attempt, "success");
      else this.context.store.finishCheck("pr", pr.nodeId, attempt, "failed", issue.reason === "rate-limited" ? "rate-limited" : "github-unavailable");
      this.applyPr(pr, installationId, repository.visibility, now);
      // A successful sweep observation does not discharge the webhook's
      // outstanding facts or mergeability retry. Preserve that pending work
      // beside the independent successful observation, including on replay.
      const pending = this.state.marks.find((mark) => mark.nodeId === pr.nodeId && mark.installationId === installationId);
      if (!issue && pending) {
        const latest = this.context.store.evidence([], [pr.nodeId]).pullRequests[pr.nodeId]?.latestAttempt;
        pending.check = latest && (latest.result === "queued" || latest.result === "running")
          ? latest : this.context.store.beginCheck("pr", pr.nodeId, now, "queued");
      }
    }
    const current = this.context.store.repository(repository.repositoryId, installationId);
    if (repository.complete && current?.monitored) {
      this.context.store.reconcileCompleteRepository(repository.repositoryId, repository.prs);
      const attempt = this.track(checks, "repository", String(repository.repositoryId), startedAt);
      this.context.store.finishCheck("repository", String(repository.repositoryId), attempt, "success");
    }
  }

  private async sweep(now: number): Promise<void> {
    if (!this.context.selection) return;
    if (!this.state.sweep) {
      this.state.sweep = { generation: 0, startedAt: now, retry: 0, installations: this.context.installations().filter((entry) => entry.status === "accepted").map((entry) => entry.id), installationIndex: 0, stage: "listing", ids: [], continuation: null, unreadable: [], reason: "github-unavailable" };
      const firstInstallation = this.state.sweep.installations[0];
      if (firstInstallation !== undefined) this.context.selection.discardRefreshProgress(firstInstallation);
      const sync = this.context.store.syncStatus();
      // A fresh load must still see the previous failure during recovery.
      if (sync.latestAttempt?.result !== "failed") this.context.store.putSyncStatus({ ...sync, latestAttempt: { startedAt: now, result: "running" } });
    }
    const sweep = this.state.sweep;
    const legacyReplay = sweep.checks === undefined && sweep.continuation !== null;
    if (legacyReplay) sweep.readStartedAt = sweep.startedAt;
    this.queueSweepChecks(sweep, legacyReplay ? sweep.startedAt : now);
    this.save();
    const id = sweep.installations[sweep.installationIndex];
    if (id === undefined) {
      if (sweep.unreadable.length > 0) await this.failSweep(now, sweep.reason, sweep.unreadable);
      else {
        this.context.store.putSyncStatus({ lastSuccessfulSweepAt: sweep.startedAt, latestAttempt: { startedAt: sweep.startedAt, result: "success" }, intervalMs: this.interval(now), slowedByRateLimit: this.interval(now) > 2 * MINUTE });
        this.interruptChecks(sweep.checks);
        this.state.sweep = null;
        this.state.nextSweep = Math.max(now + 1, sweep.startedAt + this.interval(now));
      }
      await this.context.publish(now);
      return;
    }
    if (!this.accepted(id)) {
      await this.failSweep(now, "installation-removed", this.context.store.repositories(id).map((repo) => repo.id));
      return;
    }
    if (sweep.stage === "listing") {
      const revision = this.state.refreshGenerations[id] ?? 0;
      let result: Awaited<ReturnType<RepositorySelection["refreshInstallation"]>>;
      try { result = await this.context.selection.refreshInstallation(id, now, 25, () => this.state.sweep === sweep && this.context.visible(Date.now()) && (this.state.refreshGenerations[id] ?? 0) === revision); }
      catch (error) {
        if (!this.currentSweep(sweep)) { this.context.selection.discardRefreshProgress(id); return; }
        if ((this.state.refreshGenerations[id] ?? 0) === revision) throw error;
        this.context.selection.discardRefreshProgress(id);
        this.state.nextSweep = now + 1;
        return;
      }
      if (!this.currentSweep(sweep)) { this.context.selection.discardRefreshProgress(id); return; }
      if ((this.state.refreshGenerations[id] ?? 0) !== revision) {
        this.context.selection.discardRefreshProgress(id);
        this.state.nextSweep = now + 1;
        return;
      }
      if (!result.ok) {
        if (result.reason === "continuation") { this.state.nextSweep = now + 1; return; }
        await this.failSweep(now, result.reason, this.context.store.repositories(id).filter((repo) => repo.monitored).map((repo) => repo.id));
        return;
      }
      sweep.ids = this.context.store.repositories(id).filter((repo) => repo.monitored).map((repo) => repo.nodeId);
      for (const repository of this.context.store.repositories(id).filter((repo) => repo.monitored)) this.queueCi(repository, now, false, true);
      this.queueSweepChecks(sweep, now);
      sweep.stage = "count";
      sweep.generation = this.generation(id);
      sweep.continuation = null;
    } else {
      // Replaying a logical read after an event can regress PRs, visibility,
      // or membership (including a cached zero count). Restart this phase
      // with every monitored repository, including ones the old count omitted.
      if (sweep.generation !== this.generation(id)) {
        const repositories = this.context.store.repositories(id);
        const repositoryIds = new Set(repositories.map((repository) => String(repository.id)));
        const prIds = new Set(this.context.store.pullRequests().filter((pr) => repositoryIds.has(String(pr.repositoryId))).map((pr) => pr.nodeId));
        const obsolete = sweep.checks!.filter((check) => check.scope === "repository" ? repositoryIds.has(check.key) : prIds.has(check.key));
        this.interruptChecks(obsolete);
        sweep.checks = sweep.checks!.filter((check) => !obsolete.includes(check));
        this.queueSweepChecks(sweep, now);
        sweep.readStartedAt = undefined;
        sweep.continuation = null;
        sweep.ids = this.context.store.repositories(id).filter((repo) => repo.monitored).map((repo) => repo.nodeId);
        sweep.generation = this.generation(id);
      }
      if (!sweep.continuation) {
        this.invalidateReads(id);
        sweep.generation = this.generation(id);
      }
      const generation = sweep.generation;
      const current = () => this.state.sweep === sweep && this.context.visible(Date.now()) && this.accepted(id) && this.generation(id) === generation;
      sweep.readStartedAt ??= now;
      for (const repository of this.context.store.repositories(id).filter((repo) => sweep.ids.includes(repo.nodeId))) {
        const attempt = this.track(sweep.checks!, "repository", String(repository.id), sweep.readStartedAt);
        this.context.store.runCheck("repository", String(repository.id), attempt);
        if (sweep.stage === "read") {
          for (const pr of this.context.store.pullRequests(repository.id)) this.track(sweep.checks!, "pr", pr.nodeId, sweep.readStartedAt);
        }
      }
      this.save();
      let reader: GithubPrReader | null;
      try { reader = await this.reader(id, now, sweep.continuation, true, current); }
      catch (error) {
        if (!this.currentSweep(sweep)) return;
        if (!current()) { this.state.nextSweep = now + 1; return; }
        throw error;
      }
      if (!this.currentSweep(sweep)) return;
      if (!current()) { this.state.nextSweep = now + 1; return; }
      if (!reader) { await this.failSweep(now, "github-unavailable", this.context.store.repositories(id).filter((repo) => repo.monitored).map((repo) => repo.id)); return; }
      if (sweep.stage === "count") {
        const result = await reader.countOpenPrs(sweep.ids);
        if (!this.currentSweep(sweep)) return;
        if (!current()) { this.state.nextSweep = now + 1; return; }
        this.updateMeta(id, result, now);
        if (result.continuation) sweep.continuation = result.continuation;
        else {
          for (const repo of result.repositories) {
            const previous = this.context.store.repository(repo.repositoryId, id);
            if (previous && this.accepted(id)) {
              this.context.store.putRepository({ ...previous, visibility: repo.visibility, listedAt: now, visibilityReportedAt: now });
              if (repo.count === 0 && previous.monitored) {
                this.context.store.reconcileCompleteRepository(repo.repositoryId, []);
                const attempt = this.track(sweep.checks!, "repository", String(repo.repositoryId), sweep.readStartedAt);
                this.context.store.finishCheck("repository", String(repo.repositoryId), attempt, "success");
              }
            }
          }
          if (result.status !== "complete") {
            await this.failSweep(now, readFailure(result), this.context.store.repositories(id).filter((repo) => sweep.ids.includes(repo.nodeId) && !result.repositories.some((read) => read.nodeId === repo.nodeId)).map((repo) => repo.id));
            return;
          }
          sweep.ids = result.repositories.filter((repo) => repo.count > 0).map((repo) => repo.nodeId);
          sweep.stage = "read";
          sweep.readStartedAt = undefined;
          sweep.continuation = null;
        }
      } else {
        const result = await reader.readRepositories(sweep.ids);
        if (!this.currentSweep(sweep)) return;
        if (!current()) { this.state.nextSweep = now + 1; return; }
        this.updateMeta(id, result, now);
        for (const repository of result.repositories) this.applyRepository(repository, id, now, sweep.checks!, sweep.readStartedAt, result.issues);
        if (result.continuation) sweep.continuation = result.continuation;
        else if (result.status !== "complete" || result.repositories.some((repo) => !repo.complete)) {
          await this.failSweep(now, readFailure(result), this.context.store.repositories(id).filter((repo) => sweep.ids.includes(repo.nodeId) && !result.repositories.some((read) => read.nodeId === repo.nodeId && read.complete)).map((repo) => repo.id));
          return;
        } else {
          sweep.installationIndex++;
          const nextInstallation = sweep.installations[sweep.installationIndex];
          if (nextInstallation !== undefined) this.context.selection.discardRefreshProgress(nextInstallation);
          sweep.stage = "listing";
          sweep.readStartedAt = undefined;
          sweep.ids = [];
          sweep.continuation = null;
        }
      }
    }
    this.state.nextSweep = now + 1;
    await this.context.publish(now);
  }
  private currentSweep(sweep: Sweep): boolean {
    if (this.state.sweep === sweep && this.context.visible(Date.now())) return true;
    if (this.state.sweep === sweep) {
      const id = sweep.installations[sweep.installationIndex];
      if (id !== undefined && sweep.stage === "listing") this.context.selection?.discardRefreshProgress(id);
      this.interruptChecks(sweep.checks);
      this.state.sweep = null; this.state.nextSweep = null;
    }
    return false;
  }
  private async failSweep(now: number, reason: SyncFailureReason, unreadable: readonly number[]): Promise<void> {
    const sweep = this.state.sweep;
    if (!sweep) return;
    const installationId = sweep.installations[sweep.installationIndex];
    const failedIds = unreadable.length > 0 ? unreadable : this.context.store.repositories(installationId).filter((repo) => repo.monitored).map((repo) => repo.id);
    for (const repositoryId of failedIds) {
      const attempt = sweep.checks?.find((check) => check.scope === "repository" && check.key === String(repositoryId))?.attempt;
      if (attempt) this.context.store.finishCheck("repository", String(repositoryId), attempt, "failed", reason);
      for (const pr of this.context.store.pullRequests(repositoryId)) {
        const prAttempt = sweep.checks?.find((check) => check.scope === "pr" && check.key === pr.nodeId)?.attempt;
        if (prAttempt) this.context.store.finishCheck("pr", pr.nodeId, prAttempt, "failed", reason);
      }
    }
    this.interruptChecks(sweep.checks);
    reportGithubFailure(sweep.stage === "listing" ? "sync-listing" : sweep.stage === "count" ? "sync-count" : "sync-read",
      reason, undefined, { attempt: sweep.retry === 0 ? 1 : 2 });
    if (sweep.retry === 0) {
      this.state.sweep = { ...sweep, retry: 1, installationIndex: 0, stage: "listing", ids: [], continuation: null, unreadable: [], reason, checks: undefined, readStartedAt: undefined };
      this.state.nextSweep = now + 15_000;
    } else {
      const installation = sweep.installations[sweep.installationIndex];
      if (installation !== undefined && sweep.stage === "listing") this.context.selection?.discardRefreshProgress(installation);
      const sync = this.context.store.syncStatus();
      this.context.store.putSyncStatus({ ...sync, latestAttempt: { startedAt: sweep.startedAt, result: "failed", reason, unreadableRepositoryIds: [...new Set(unreadable)] } });
      this.state.sweep = null;
      this.state.nextSweep = now + this.interval(now);
    }
    await this.context.publish(now);
  }
}
