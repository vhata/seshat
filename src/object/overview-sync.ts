import type { StoredInstallation } from "../shared/installations";
import type { PullRequestRecord, RepositoryRecord, SyncFailureReason } from "../shared/overview/protocol";
import { coalesceFacts, factObserved, type DeliveryFact, type PrMark, type ReducedDelivery } from "../shared/overview/webhook-marks";
import { GithubPrReader, type HeadCommitDate, type RateLimit, type ReadMeta, type ReaderContinuation } from "../worker/github-pr-reader";
import type { PermissionCacheEntry } from "../worker/github-permissions";
import type { OverviewStore } from "./overview-store";
import type { RepositorySelection } from "./repository-selection";

const KEY = "overview-sync-work-v1";
const MINUTE = 60_000;
const RETRIES = [5_000, 15_000, 30_000] as const;
interface PendingMark extends PrMark { due: number; firstRead: number | null; retry: number; revision: number; mergeability: boolean }
interface PendingSha { installationId: number; repositoryId: number; sha: string; facts: DeliveryFact[]; expires: number }
interface ReadProgress { ids: string[]; revisions: [string, number][]; continuation: ReaderContinuation | null }
interface Sweep {
  startedAt: number;
  retry: number;
  installations: number[];
  installationIndex: number;
  stage: "listing" | "count" | "read";
  ids: string[];
  continuation: ReaderContinuation | null;
  unreadable: number[];
  reason: SyncFailureReason;
}
interface State {
  marks: PendingMark[];
  shas: PendingSha[];
  refresh: { id: number; due: number; revision: number }[];
  refreshGenerations: Record<number, number>;
  guard: number | null;
  nextSweep: number | null;
  lastCatchup: number | null;
  sweep: Sweep | null;
  reread: ReadProgress | null;
  permissions: PermissionCacheEntry[];
  headDates: HeadCommitDate[];
  rates: { installationId: number; rate: RateLimit }[];
}
interface Context {
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
  return { marks: [], shas: [], refresh: [], refreshGenerations: {}, guard: null, nextSweep: null, lastCatchup: null, sweep: null, reread: null, permissions: [], headDates: [], rates: [] };
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
  }

  private save(): void {
    const value = JSON.stringify(this.state);
    const before = this.context.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", KEY).toArray()[0];
    if (before?.value !== value) this.context.storage.sql.exec("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", KEY, value);
  }
  private accepted(id: number): boolean { return this.context.installations().some((installation) => installation.id === id && installation.status === "accepted"); }

  /** The acknowledgement follows this durable write. No GitHub call occurs here. */
  async receive(delivery: ReducedDelivery, now: number): Promise<boolean> {
    if (delivery.guard) this.state.guard = Math.min(this.state.guard ?? now, now);
    if (!this.accepted(delivery.installationId)) {
      // A brand-new installation still needs its guard; no repository/PR data is accepted.
      if (delivery.guard) this.save();
      await this.rearm(now);
      return false;
    }
    const metadata = delivery.repository;
    if (metadata) {
      const previous = this.context.store.repositories().find((repo) => repo.id === metadata.id && repo.installationId === delivery.installationId);
      if (!previous && !metadata.deleted && !delivery.refresh) this.refresh(delivery.installationId, now);
      if (previous) {
        if (metadata.deleted) this.context.store.removeRepository(previous.id);
        else this.context.store.putRepository({ ...previous, visibility: metadata.visibility, visibilityReportedAt: now,
          ...(metadata.transferred || metadata.ownerId !== null && metadata.ownerId !== previous.ownerAccountId
            ? { monitored: false, monitorOverride: null, ownerAccountId: metadata.ownerId ?? previous.ownerAccountId } : {}),
        });
      }
    }
    if (delivery.refresh) this.refresh(delivery.installationId, now);
    for (const mark of delivery.marks) this.mark(mark, now + 2_000);
    if (delivery.sha) {
      const sha = delivery.sha;
      const matching = this.context.store.pullRequests(sha.repositoryId).filter((pr) => pr.headSha === sha.value);
      for (const pr of matching) this.mark({ nodeId: pr.nodeId, repositoryId: pr.repositoryId, installationId: delivery.installationId, facts: sha.facts }, now + 2_000);
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
    this.save();
  }
  discoveryChanged(id: number, now: number): void {
    for (const repository of this.context.store.repositories(id)) if (repository.monitored) this.queueRepositoryRead(repository, now);
    this.save();
  }

  /** Repository/settings changes schedule discovery without making a hidden page visible. */
  refresh(id: number, now: number, invalidate = true): void {
    if (invalidate) this.context.selection?.discardRefreshProgress(id);
    const revision = (this.state.refreshGenerations[id] ?? 0) + 1;
    this.state.refreshGenerations[id] = revision;
    const existing = this.state.refresh.find((entry) => entry.id === id);
    if (existing) { existing.due = Math.min(existing.due, now); existing.revision = revision; }
    else this.state.refresh.push({ id, due: now, revision });
    this.save();
  }

  private mark(mark: PrMark, due: number, mergeability = false): void {
    const previous = this.state.marks.find((pending) => pending.nodeId === mark.nodeId && pending.installationId === mark.installationId);
    if (previous) {
      previous.facts = coalesceFacts(previous.facts, mark.facts);
      previous.due = Math.min(previous.due, due);
      previous.revision++;
      previous.mergeability ||= mergeability;
      if (mark.facts.length > 0) { previous.firstRead = null; previous.retry = 0; }
    } else this.state.marks.push({ ...mark, due, firstRead: null, retry: 0, revision: 0, mergeability });
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

  /** Every inbound request calls this. Existing earlier alarms incur no write. */
  async rearm(now: number): Promise<void> {
    const active = this.context.visible(now);
    if (!active && (this.state.sweep !== null || this.state.nextSweep !== null)) {
      // A resumed sweep must not replay cached facts from a quiet interval.
      const interruptedInstallation = this.state.sweep?.installations[this.state.sweep.installationIndex];
      if (interruptedInstallation !== undefined && this.state.sweep?.stage === "listing") this.context.selection?.discardRefreshProgress(interruptedInstallation);
      this.state.sweep = null;
      this.state.nextSweep = null;
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
    const times = [this.state.guard, ...this.state.refresh.map((job) => job.due), ...this.state.marks.map((mark) => mark.due), ...this.state.shas.map((sha) => sha.expires)];
    if (active) {
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
    if (current === null || current > due) await this.context.storage.setAlarm(due);
  }

  /** One bounded operation per alarm, including at most one token-mint allowance. */
  async alarm(now: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.state.shas = this.state.shas.filter((sha) => sha.expires > now && this.accepted(sha.installationId));
      this.state.marks = this.state.marks.filter((mark) => this.accepted(mark.installationId));
      const earliestRefresh = this.state.refresh.reduce<{ id: number; due: number; revision: number } | null>((first, job) => first === null || job.due < first.due ? job : first, null);
      const readMarks = this.state.reread ? this.state.marks.filter((mark) => this.state.reread!.ids.includes(mark.nodeId)) : this.state.marks;
      const rereadDue = Math.min(...readMarks.map((mark) => mark.due));
      const jobs = [
        { kind: "guard", due: this.state.guard ?? Infinity },
        { kind: "refresh", due: earliestRefresh?.due ?? Infinity },
        { kind: "reread", due: rereadDue },
        { kind: "sweep", due: this.context.visible(now) ? this.state.nextSweep ?? Infinity : Infinity },
      ].sort((left, right) => left.due - right.due);
      const job = jobs[0]!;
      if (job.due <= now) {
        if (job.kind === "guard") {
          this.state.guard = null;
          if (await this.context.guard(now)) {
            for (const installation of this.context.installations()) if (installation.status === "accepted") this.refresh(installation.id, now);
          } else this.state.guard = now + 15_000;
        } else if (job.kind === "refresh") await this.refreshRepositories(earliestRefresh!.id, now);
        else if (job.kind === "reread") await this.reread(now);
        else await this.sweep(now);
      }
    } catch (error) {
      if (this.state.sweep) await this.failSweep(now, error instanceof SyncReadError ? error.reason : "github-unavailable", []);
      for (const mark of this.state.marks) if (mark.due <= now) this.retryMark(mark, now);
      for (const job of this.state.refresh) if (job.due <= now) job.due = now + 15_000;
      if (this.state.guard !== null && this.state.guard <= now) this.state.guard = now + 15_000;
      await this.context.publish(now);
    } finally {
      this.running = false;
      this.save();
      await this.rearm(now);
    }
  }

  private interval(now: number): number {
    return this.state.rates.some(({ rate }) => rate.resetAt > now && rate.limit !== undefined && rate.remaining < rate.limit / 10) ? 4 * MINUTE : 2 * MINUTE;
  }
  private updateMeta(id: number, meta: ReadMeta, now: number): void {
    if (meta.rateLimit) {
      const previous = this.state.rates.find((entry) => entry.installationId === id)?.rate;
      const incoming = meta.rateLimit;
      // A continuation can replay an older GraphQL response after a newer
      // event read. Never replenish its budget from that cached sample.
      const rate = previous && previous.resetAt > incoming.resetAt ? previous
        : previous && previous.resetAt === incoming.resetAt ? { ...incoming,
          remaining: Math.min(previous.remaining, incoming.remaining),
          ...(previous.limit === undefined && incoming.limit === undefined ? {} : { limit: Math.max(previous.limit ?? 0, incoming.limit ?? 0) }),
        } : incoming;
      this.state.rates = this.state.rates.filter((entry) => entry.installationId !== id);
      this.state.rates.push({ installationId: id, rate });
    }
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
  private async reader(id: number, now: number, continuation: ReaderContinuation | null, sweep: boolean, shouldContinue?: () => boolean): Promise<GithubPrReader | null> {
    if (!this.accepted(id) || !this.context.selection) return null;
    const token = await this.context.selection.tokens.get(id, now);
    if (!token.ok) throw new SyncReadError(token.reason === "rate-limited" || token.reason === "installation-suspended" || token.reason === "installation-removed" ? token.reason : "github-unavailable");
    return new GithubPrReader(token.token, { requestLimit: 40, refreshPermissions: sweep, verifyMergeability: sweep,
      permissionCache: this.state.permissions, headCommitDates: this.state.headDates, continuation, shouldContinue });
  }
  private async refreshRepositories(id: number, now: number): Promise<void> {
    const job = this.state.refresh.find((entry) => entry.id === id)!;
    const revision = job.revision;
    const result = await this.context.selection?.refreshInstallation(id, now, 25, () => job.revision === revision);
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
      }
    } else if (this.accepted(id)) {
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
    const first = this.state.reread ? this.state.marks.find((mark) => mark.nodeId === this.state.reread!.ids[0]) : this.state.marks.find((mark) => mark.due <= now);
    if (!first) { this.state.reread = null; return; }
    const repositoryRead = first.nodeId.startsWith("repository:");
    const selected = this.state.reread
      ? this.state.marks.filter((mark) => this.state.reread!.ids.includes(mark.nodeId))
      : this.state.marks.filter((mark) => mark.installationId === first.installationId && mark.due <= now && mark.nodeId.startsWith("repository:") === repositoryRead).slice(0, 10);
    if (selected.length === 0) { this.state.reread = null; return; }
    const revisions = new Map(this.state.reread?.revisions ?? selected.map((mark): [string, number] => [mark.nodeId, mark.revision]));
    let reader: GithubPrReader | null;
    try { reader = await this.reader(first.installationId, now, this.state.reread?.continuation ?? null, false); }
    catch (error) {
      if (!(error instanceof SyncReadError)) throw error;
      for (const mark of selected) this.retryMark(mark, now);
      this.state.reread = null;
      return;
    }
    if (!reader) { for (const mark of selected) this.retryMark(mark, now); this.state.reread = null; return; }
    if (repositoryRead) {
      const result = await reader.readRepositories(selected.map((mark) => mark.nodeId.slice("repository:".length)));
      this.updateMeta(first.installationId, result, now);
      for (const repository of result.repositories) this.applyRepository(repository, first.installationId, now);
      if (result.continuation) this.state.reread = { ids: selected.map((mark) => mark.nodeId), revisions: [...revisions], continuation: result.continuation };
      else {
        this.state.reread = null;
        for (const mark of selected) {
          const complete = result.repositories.some((repository) => repository.repositoryId === mark.repositoryId && repository.complete);
          if (complete && revisions.get(mark.nodeId) === mark.revision) this.removeMark(mark); else this.retryMark(mark, now);
        }
      }
    } else {
      const result = await reader.rereadPrs(selected.map((mark) => mark.nodeId));
      this.updateMeta(first.installationId, result, now);
      if (result.continuation) this.state.reread = { ids: selected.map((mark) => mark.nodeId), revisions: [...revisions], continuation: result.continuation };
      else this.state.reread = null;
      for (const mark of selected) {
        const node = result.nodes.find((node) => (node.kind === "open" ? node.pr.nodeId : node.nodeId) === mark.nodeId);
        const previous = this.context.store.pullRequests(mark.repositoryId).find((pr) => pr.nodeId === mark.nodeId);
        if (node && node.kind !== "unavailable") {
          if (node.kind === "open") this.applyPr(node.pr, first.installationId, node.visibility ?? "private", now);
          else this.context.store.removePullRequest(node.nodeId);
          mark.facts = mark.facts.filter((fact) => !factObserved(fact, node, previous));
          mark.mergeability = node.kind === "open" && node.pr.mergeable === "unknown";
          if (!result.continuation) {
            if (mark.facts.length === 0 && !mark.mergeability && !result.issues.some((issue) => issue.nodeId === mark.nodeId) && revisions.get(mark.nodeId) === mark.revision) this.removeMark(mark);
            else this.retryMark(mark, now);
          }
        } else if (!result.continuation) this.retryMark(mark, now);
      }
    }
    if (this.state.reread) for (const mark of selected) mark.due = now + 1;
    await this.context.publish(now);
  }
  private removeMark(mark: PendingMark): void { this.state.marks = this.state.marks.filter((pending) => pending !== mark); }
  private retryMark(mark: PendingMark, now: number): void {
    mark.firstRead ??= now;
    const offset = RETRIES[mark.retry];
    if (offset === undefined) { this.removeMark(mark); return; }
    mark.retry++;
    mark.due = Math.max(now + 1, mark.firstRead + offset);
  }
  private applyPr(pr: PullRequestRecord, installationId: number, visibility: RepositoryRecord["visibility"], now: number): void {
    if (!this.accepted(installationId)) return;
    const repository = this.context.store.repositories(installationId).find((repo) => repo.id === pr.repositoryId);
    if (!repository || !repository.monitored) return;
    if (repository.ownerAccountId !== pr.repository.ownerAccountId) {
      this.context.store.putRepository({ ...repository, monitored: false, monitorOverride: null, ownerAccountId: pr.repository.ownerAccountId, visibility, listedAt: now, visibilityReportedAt: now });
      this.refresh(installationId, now);
      return;
    }
    this.context.store.putRepository({ ...repository, fullName: pr.repository.fullName, visibility, listedAt: now, visibilityReportedAt: now });
    this.context.store.putPullRequest(pr);
    const shas = this.state.shas.filter((sha) => sha.installationId === installationId && sha.repositoryId === pr.repositoryId && sha.sha === pr.headSha && sha.expires > now);
    for (const sha of shas) this.mark({ nodeId: pr.nodeId, repositoryId: pr.repositoryId, installationId, facts: sha.facts }, now + 2_000);
    this.state.shas = this.state.shas.filter((sha) => !shas.includes(sha));
    if (pr.mergeable === "unknown") this.mark({ nodeId: pr.nodeId, repositoryId: pr.repositoryId, installationId, facts: [] }, now + 5_000, true);
  }
  private applyRepository(repository: { repositoryId: number; visibility: RepositoryRecord["visibility"]; complete: boolean; prs: readonly PullRequestRecord[] }, installationId: number, now: number): void {
    if (!this.accepted(installationId)) return;
    const before = this.context.store.repositories(installationId).find((repo) => repo.id === repository.repositoryId);
    if (!before?.monitored) return;
    this.context.store.putRepository({ ...before, visibility: repository.visibility, listedAt: now, visibilityReportedAt: now });
    for (const pr of repository.prs) this.applyPr(pr, installationId, repository.visibility, now);
    const current = this.context.store.repositories(installationId).find((repo) => repo.id === repository.repositoryId);
    if (repository.complete && current?.monitored) this.context.store.reconcileCompleteRepository(repository.repositoryId, repository.prs);
  }

  private async sweep(now: number): Promise<void> {
    if (!this.context.selection) return;
    if (!this.state.sweep) {
      this.state.sweep = { startedAt: now, retry: 0, installations: this.context.installations().filter((entry) => entry.status === "accepted").map((entry) => entry.id), installationIndex: 0, stage: "listing", ids: [], continuation: null, unreadable: [], reason: "github-unavailable" };
      const firstInstallation = this.state.sweep.installations[0];
      if (firstInstallation !== undefined) this.context.selection.discardRefreshProgress(firstInstallation);
      const sync = this.context.store.syncStatus();
      // A fresh load must still see the previous failure during recovery.
      if (sync.latestAttempt?.result !== "failed") this.context.store.putSyncStatus({ ...sync, latestAttempt: { startedAt: now, result: "running" } });
    }
    const sweep = this.state.sweep;
    const id = sweep.installations[sweep.installationIndex];
    if (id === undefined) {
      if (sweep.unreadable.length > 0) await this.failSweep(now, sweep.reason, sweep.unreadable);
      else {
        this.context.store.putSyncStatus({ lastSuccessfulSweepAt: sweep.startedAt, latestAttempt: { startedAt: sweep.startedAt, result: "success" }, intervalMs: this.interval(now), slowedByRateLimit: this.interval(now) > 2 * MINUTE });
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
      const result = await this.context.selection.refreshInstallation(id, now, 25, () => this.state.sweep === sweep && this.context.visible(Date.now()) && (this.state.refreshGenerations[id] ?? 0) === revision);
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
      sweep.stage = "count";
      sweep.continuation = null;
    } else {
      const reader = await this.reader(id, now, sweep.continuation, true, () => this.state.sweep === sweep && this.context.visible(Date.now()));
      if (!this.currentSweep(sweep)) return;
      if (!reader) { await this.failSweep(now, "github-unavailable", this.context.store.repositories(id).filter((repo) => repo.monitored).map((repo) => repo.id)); return; }
      if (sweep.stage === "count") {
        const result = await reader.countOpenPrs(sweep.ids);
        if (!this.currentSweep(sweep)) return;
        this.updateMeta(id, result, now);
        if (result.continuation) sweep.continuation = result.continuation;
        else {
          for (const repo of result.repositories) {
            const previous = this.context.store.repositories(id).find((entry) => entry.id === repo.repositoryId);
            if (previous && this.accepted(id)) {
              this.context.store.putRepository({ ...previous, visibility: repo.visibility, listedAt: now, visibilityReportedAt: now });
              if (repo.count === 0 && previous.monitored) this.context.store.reconcileCompleteRepository(repo.repositoryId, []);
            }
          }
          if (result.status !== "complete") {
            await this.failSweep(now, readFailure(result), this.context.store.repositories(id).filter((repo) => sweep.ids.includes(repo.nodeId) && !result.repositories.some((read) => read.nodeId === repo.nodeId)).map((repo) => repo.id));
            return;
          }
          sweep.ids = result.repositories.filter((repo) => repo.count > 0).map((repo) => repo.nodeId);
          sweep.stage = "read";
          sweep.continuation = null;
        }
      } else {
        const result = await reader.readRepositories(sweep.ids);
        if (!this.currentSweep(sweep)) return;
        this.updateMeta(id, result, now);
        for (const repository of result.repositories) this.applyRepository(repository, id, now);
        if (result.continuation) sweep.continuation = result.continuation;
        else if (result.status !== "complete" || result.repositories.some((repo) => !repo.complete)) {
          await this.failSweep(now, readFailure(result), this.context.store.repositories(id).filter((repo) => sweep.ids.includes(repo.nodeId) && !result.repositories.some((read) => read.nodeId === repo.nodeId && read.complete)).map((repo) => repo.id));
          return;
        } else {
          sweep.installationIndex++;
          const nextInstallation = sweep.installations[sweep.installationIndex];
          if (nextInstallation !== undefined) this.context.selection.discardRefreshProgress(nextInstallation);
          sweep.stage = "listing";
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
      this.state.sweep = null; this.state.nextSweep = null;
    }
    return false;
  }
  private async failSweep(now: number, reason: SyncFailureReason, unreadable: readonly number[]): Promise<void> {
    const sweep = this.state.sweep;
    if (!sweep) return;
    if (sweep.retry === 0) {
      this.state.sweep = { ...sweep, retry: 1, installationIndex: 0, stage: "listing", ids: [], continuation: null, unreadable: [], reason };
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
