import type { StoredInstallation } from "./installations";
import type { RepositoryRecord } from "./overview/protocol";

export const REPOSITORIES_PATH = "/api/repositories";
export interface RepositorySettings {
  readonly ownerId: number;
  readonly installations: readonly StoredInstallation[];
  readonly repositories: readonly RepositoryRecord[];
}

/** Archive always wins over an override; organizations always start off. */
export function monitoredRepository(
  repository: Pick<RepositoryRecord, "ownerAccountId" | "isFork" | "isArchived" | "ownerPermission" | "monitorOverride">,
  ownerId: number,
  organizationAccepted: boolean,
): boolean {
  if (repository.isArchived || repository.ownerPermission === "none") return false;
  const owned = repository.ownerAccountId === ownerId;
  if (!owned && !organizationAccepted) return false;
  return repository.monitorOverride ?? (owned && !repository.isFork);
}

export function canMonitorRepository(repository: RepositoryRecord, settings: RepositorySettings): boolean {
  const installation = settings.installations.find((entry) => entry.id === repository.installationId);
  return !repository.isArchived && repository.ownerPermission !== "none"
    && installation?.status === "accepted"
    && (repository.ownerAccountId === settings.ownerId || installation.accountType === "Organization");
}
