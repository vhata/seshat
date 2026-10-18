import type { AppConfig } from "../shared/config";
import type { StoredInstallation } from "../shared/installations";
import { monitoredRepository } from "../shared/repositories";
import type { InstallationRefreshResult, MonitoringMutationResult, RepositoryRecord, RepositorySelectionOperations } from "../shared/overview/protocol";
import { InstallationTokens } from "../worker/github-installation-token";
import { GitHubRepositoryListing } from "../worker/github-repositories";
import type { OverviewStore } from "./overview-store";

interface SelectionContext {
  readonly ownerId: number;
  readonly app: AppConfig;
  readonly store: OverviewStore;
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

  refreshInstallation(installationId: number, now: number): Promise<InstallationRefreshResult> {
    const pending = this.refreshing.get(installationId);
    if (pending) return pending;
    const refreshing = this.refreshCompleteInstallation(installationId, now)
      .finally(() => this.refreshing.delete(installationId));
    this.refreshing.set(installationId, refreshing);
    return refreshing;
  }

  private async refreshCompleteInstallation(installationId: number, now: number): Promise<InstallationRefreshResult> {
    const installation = this.acceptedInstallation(installationId);
    if (!installation) return { ok: false, reason: "installation-removed" };
    const authorization = await this.tokens.get(installationId, now);
    if (!authorization.ok) return { ok: false, reason: "github-unavailable" };
    const listing = await this.github.list(authorization.token, installationId);
    if (!listing.ok) {
      if (listing.reason === "installation-removed") this.tokens.forget(installationId);
      return listing;
    }
    const needsPermission = listing.repositories.some((repository) => repository.ownerAccountId !== this.context.ownerId);
    const login = needsPermission ? await this.github.ownerLogin(authorization.token, this.context.ownerId) : null;
    if (needsPermission && !login) return { ok: false, reason: "github-unavailable" };
    const permissions = new Map<number, RepositoryRecord["ownerPermission"]>();
    for (const repository of listing.repositories) {
      const permission = await this.github.ownerPermission(authorization.token, repository, this.context.ownerId, login ?? repository.ownerLogin);
      if (permission === null) return { ok: false, reason: "github-unavailable" };
      permissions.set(repository.id, permission);
    }
    // Awaited GitHub calls allow settings to change. Read overrides and the
    // installation again immediately before the synchronous replacement.
    if (!this.acceptedInstallation(installationId)) return { ok: false, reason: "installation-removed" };
    const previous = this.context.store.repositories();
    const before = new Map(previous.map((repository) => [repository.id, repository]));
    const repositories = listing.repositories.filter((listed) => permissions.get(listed.id) !== "none")
      .map((listed): RepositoryRecord => {
      const repository = {
        ...listed, installationId, ownerPermission: permissions.get(listed.id)!,
        monitorOverride: before.get(listed.id)?.monitorOverride ?? null, listedAt: now,
      };
      return {
        ...repository,
        monitored: monitoredRepository(repository, this.context.ownerId, installation.accountType === "Organization"),
      };
    });
    const old = previous.filter((repository) => repository.installationId === installationId);
    const changed = JSON.stringify(old) !== JSON.stringify(repositories);
    this.context.store.replaceInstallationRepositories(installationId, repositories);
    if (changed) await this.context.publish(now);
    return { ok: true, changed, repositoryIds: repositories.filter((repository) => repository.monitored).map((repository) => repository.id) };
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
    if (this.context.store.putRepository(result)) await this.context.publish(now);
    return { ok: true, repository: result };
  }

  forget(installationId: number): void {
    this.tokens.forget(installationId);
    this.github.forget(installationId);
  }

  private acceptedInstallation(id: number): StoredInstallation | undefined {
    return this.context.installations().find((installation) => installation.id === id && installation.status === "accepted");
  }
}
