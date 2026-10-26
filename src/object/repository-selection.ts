import type { AppConfig } from "../shared/config";
import type { StoredInstallation } from "../shared/installations";
import { monitoredRepository } from "../shared/repositories";
import type { InstallationRefreshResult, MonitoringMutationResult, RepositoryRecord, RepositorySelectionOperations } from "../shared/overview/protocol";
import { InstallationTokens } from "../worker/github-installation-token";
import { GitHubRepositoryListing } from "../worker/github-repositories";
import type { OverviewStore } from "./overview-store";
import type { RepositoryDiscoveryProgress, RepositoryDiscoveryStore } from "./repository-discovery-store";

interface SelectionContext {
  readonly ownerId: number;
  readonly app: AppConfig;
  readonly store: OverviewStore;
  readonly discovery: RepositoryDiscoveryStore;
  installations(): readonly StoredInstallation[];
  publish(now: number): Promise<void>;
}

/** Repository discovery and overrides; no PR reads or scheduling live here. */
export class RepositorySelection implements RepositorySelectionOperations {
  readonly tokens: InstallationTokens;
  private readonly github = new GitHubRepositoryListing();
  private readonly refreshing = new Map<number, Promise<InstallationRefreshResult>>();
  constructor(private readonly context: SelectionContext, tokens?: InstallationTokens) {
    this.tokens = tokens ?? new InstallationTokens(context.app);
  }

  refreshInstallation(installationId: number, now: number, requestBudget = 25, shouldContinue: () => boolean = () => true): Promise<InstallationRefreshResult> {
    const pending = this.refreshing.get(installationId);
    if (pending) return pending.then((result) => ({ ...result, requestsUsed: 0 }));
    const refreshing = this.refreshCompleteInstallation(installationId, now, requestBudget, shouldContinue)
      .finally(() => this.refreshing.delete(installationId));
    this.refreshing.set(installationId, refreshing);
    return refreshing;
  }

  private async refreshCompleteInstallation(installationId: number, now: number, requestBudget: number, shouldContinue: () => boolean): Promise<InstallationRefreshResult> {
    const budget = Number.isFinite(requestBudget) ? Math.max(0, Math.min(25, Math.floor(requestBudget))) : 0;
    let requestsUsed = 0;
    const installation = this.acceptedInstallation(installationId);
    if (!installation) return { ok: false, reason: "installation-removed", requestsUsed };
    if (!shouldContinue() || budget < 2) return { ok: false, reason: "continuation", requestsUsed };
    // Reserving a mint slot even for a memory-cached token keeps the caller's
    // invocation-wide allowance safe without exposing credential internals.
    requestsUsed++;
    const authorization = await this.tokens.get(installationId, now);
    if (!authorization.ok) return { ok: false, reason: authorization.reason === "rate-limited" || authorization.reason === "installation-suspended" || authorization.reason === "installation-removed" ? authorization.reason : "github-unavailable", requestsUsed };
    const state = this.context.discovery.get(installationId);
    const progress: RepositoryDiscoveryProgress = state.progress ?? {
      phase: "listing", total: null, pages: [], repositories: [],
      permissionIndex: 0, permissions: [], permissionCache: {}, ownerLogin: null,
    };
    const saveProgress = () => {
      if (this.acceptedInstallation(installationId)) this.context.discovery.save(installationId, { ...state, progress });
      else this.context.discovery.forget(installationId);
    };
    while (progress.phase === "listing" && requestsUsed < budget && shouldContinue()) {
      const index = progress.pages.length;
      requestsUsed++;
      const read = await this.github.readPage(authorization.token, index + 1, state.cachedPages[index]);
      if (!read.ok) {
        if (read.reason === "installation-removed") this.tokens.forget(installationId);
        saveProgress();
        return { ...read, requestsUsed };
      }
      const page = read.page;
      progress.total ??= page.total;
      const all = [...progress.repositories, ...page.repositories];
      const complete = all.length === progress.total;
      if (progress.total !== page.total || all.length > progress.total
        || new Set(all.map((repository) => repository.id)).size !== all.length
        || (!complete && page.repositories.length !== 100)) {
        // An inconsistent listing cannot become authoritative on a later
        // invocation; start a new round using the last complete validators.
        this.context.discovery.save(installationId, { ...state, progress: null });
        return { ok: false, reason: "github-unavailable", requestsUsed };
      }
      progress.pages.push(page);
      progress.repositories = all;
      if (complete) progress.phase = "permissions";
    }
    if (progress.phase === "permissions") {
      const needsPermission = progress.repositories.some((repository) => repository.ownerAccountId !== this.context.ownerId);
      if (needsPermission && !progress.ownerLogin && requestsUsed < budget && shouldContinue()) {
        requestsUsed++;
        const login = await this.github.readOwnerLogin(authorization.token, this.context.ownerId);
        if (!login.ok) { saveProgress(); return { ok: false, reason: login.reason, requestsUsed }; }
        progress.ownerLogin = login.login;
      }
      const priorRepositories = new Map(state.cachedPages.flatMap((page) => page.repositories).map((repository) => [repository.id, repository]));
      while (progress.permissionIndex < progress.repositories.length && shouldContinue()) {
        const repository = progress.repositories[progress.permissionIndex]!;
        if (repository.ownerAccountId === this.context.ownerId) progress.permissions.push([repository.id, "admin"]);
        else {
          if (requestsUsed >= budget || !progress.ownerLogin) break;
          requestsUsed++;
          const previous = priorRepositories.get(repository.id)?.fullName === repository.fullName ? state.permissionCache[repository.id] ?? null : null;
          const read = await this.github.readOwnerPermission(authorization.token, repository, this.context.ownerId, progress.ownerLogin, previous);
          if (!read.ok || !read.entry) { saveProgress(); return { ok: false, reason: read.reason ?? "github-unavailable", requestsUsed }; }
          progress.permissions.push([repository.id, read.entry.permission]);
          progress.permissionCache[repository.id] = read.entry;
        }
        progress.permissionIndex++;
      }
    }
    if (!this.acceptedInstallation(installationId)) {
      this.context.discovery.forget(installationId);
      return { ok: false, reason: "installation-removed", requestsUsed };
    }
    if (!shouldContinue() || progress.phase !== "permissions" || progress.permissionIndex < progress.repositories.length) {
      saveProgress();
      return { ok: false, reason: "continuation", requestsUsed };
    }
    // Overrides may change while GitHub calls are in flight. Read them again
    // immediately before committing the complete listing and its permissions.
    const previous = this.context.store.repositories();
    const before = new Map(previous.map((repository) => [repository.id, repository]));
    const permissions = new Map(progress.permissions);
    let removedTransfer = false;
    const repositories = progress.repositories.map((listed): RepositoryRecord => {
        const prior = before.get(listed.id);
        if (prior) this.context.discovery.migrateMonitoringOverride(prior.id, prior.ownerAccountId, prior.monitorOverride);
        const repository = {
          ...listed, installationId, ownerPermission: permissions.get(listed.id)!,
          monitorOverride: this.context.discovery.monitoringOverride(listed.id, listed.ownerAccountId)
            ?? (prior?.ownerAccountId === listed.ownerAccountId ? prior.monitorOverride : null) ?? null,
          listedAt: now, visibilityReportedAt: now,
        };
        // A new owner without permission must also withdraw the old owner's row.
        if (prior && prior.ownerAccountId !== listed.ownerAccountId && repository.ownerPermission === "none") {
          removedTransfer = this.context.store.removeRepository(listed.id) || removedTransfer;
        }
        return { ...repository, monitored: monitoredRepository(repository, this.context.ownerId, installation.accountType === "Organization") };
      }).filter((repository) => repository.ownerPermission !== "none");
    const old = previous.filter((repository) => repository.installationId === installationId);
    const changed = removedTransfer || JSON.stringify(old) !== JSON.stringify(repositories);
    this.context.store.replaceInstallationRepositories(installationId, repositories);
    this.context.discovery.save(installationId, {
      cachedPages: progress.pages, permissionCache: progress.permissionCache, progress: null,
    });
    if (changed) await this.context.publish(now);
    return { ok: true, changed, repositoryIds: repositories.filter((repository) => repository.monitored).map((repository) => repository.id), requestsUsed };
  }

  /** A cancelled visible sweep starts discovery afresh when it returns. */
  discardRefreshProgress(installationId: number): void {
    const state = this.context.discovery.get(installationId);
    if (state.progress) this.context.discovery.save(installationId, { ...state, progress: null });
  }

  async setMonitoringOverride(repositoryId: number, override: boolean | null, now: number): Promise<MonitoringMutationResult> {
    const repository = this.context.store.repositories().find((entry) => entry.id === repositoryId);
    if (!repository) return { ok: false, reason: "not-found" };
    const installation = this.acceptedInstallation(repository.installationId);
    if (!installation) return { ok: false, reason: "not-allowed" };
    if (override === true && repository.ownerAccountId !== this.context.ownerId) {
      const authorization = await this.tokens.get(installation.id, now);
      if (!authorization.ok) return { ok: false, reason: "not-allowed" };
      const login = await this.github.ownerLogin(authorization.token, this.context.ownerId);
      const permission = login ? await this.github.ownerPermission(authorization.token, repository, this.context.ownerId, login) : null;
      const current = this.context.store.repositories().find((entry) => entry.id === repositoryId);
      if (!permission || permission === "none" || !this.acceptedInstallation(installation.id)
        || JSON.stringify(current) !== JSON.stringify(repository)) return { ok: false, reason: "not-allowed" };
    }
    const updated = { ...repository, monitorOverride: override };
    const organization = installation.accountType === "Organization";
    if (override === true && (repository.isArchived || repository.ownerPermission === "none"
      || (repository.ownerAccountId !== this.context.ownerId && !organization))) {
      return { ok: false, reason: "not-allowed" };
    }
    const result = { ...updated, monitored: monitoredRepository(updated, this.context.ownerId, organization) };
    this.context.discovery.saveMonitoringOverride(repositoryId, repository.ownerAccountId, override);
    if (this.context.store.putRepository(result)) await this.context.publish(now);
    return { ok: true, repository: result };
  }

  forget(installationId: number): void {
    this.tokens.forget(installationId);
    this.github.forget(installationId);
    this.context.discovery.forget(installationId);
  }

  private acceptedInstallation(id: number): StoredInstallation | undefined {
    return this.context.installations().find((installation) => installation.id === id && installation.status === "accepted");
  }
}
