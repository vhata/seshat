import type { RepositoryPermission } from "../shared/overview/types";
import type { PermissionCacheEntry } from "../worker/github-permissions";
import type { ListedRepository, RepositoryPage } from "../worker/github-repositories";

export interface RepositoryDiscoveryProgress {
  phase: "listing" | "permissions";
  total: number | null;
  pages: RepositoryPage[];
  repositories: ListedRepository[];
  permissionIndex: number;
  permissions: [number, RepositoryPermission][];
  permissionCache: Record<number, PermissionCacheEntry>;
  ownerLogin: string | null;
}
export interface RepositoryDiscoveryState {
  readonly cachedPages: readonly RepositoryPage[];
  readonly permissionCache: Readonly<Record<number, PermissionCacheEntry>>;
  readonly progress: RepositoryDiscoveryProgress | null;
}

/** Private repository metadata and permission facts, never credentials. */
export class RepositoryDiscoveryStore {
  constructor(private readonly storage: DurableObjectStorage) {}
  get(installationId: number): RepositoryDiscoveryState {
    const row = this.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", this.key(installationId)).toArray()[0];
    return row ? JSON.parse(row.value) as RepositoryDiscoveryState : { cachedPages: [], permissionCache: {}, progress: null };
  }
  save(installationId: number, state: RepositoryDiscoveryState): void {
    const key = this.key(installationId);
    const value = JSON.stringify(state);
    const old = this.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key).toArray()[0];
    if (old?.value === value) return;
    this.storage.sql.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }
  forget(installationId: number): void {
    const key = this.key(installationId);
    if (this.storage.sql.exec("SELECT 1 FROM settings WHERE key = ?", key).toArray().length) {
      this.storage.sql.exec("DELETE FROM settings WHERE key = ?", key);
    }
  }
  monitoringOverride(repositoryId: number, ownerAccountId: number): boolean | null {
    const row = this.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", `repository-monitoring:${repositoryId}`).toArray()[0];
    if (!row) return null;
    const value = JSON.parse(row.value) as { ownerAccountId?: number; override?: boolean } | boolean;
    if (typeof value === "object" && value !== null && value.ownerAccountId === ownerAccountId && typeof value.override === "boolean") return value.override;
    // Unknown legacy ownership and a different owner both require a new choice.
    this.forgetMonitoringOverride(repositoryId);
    return null;
  }
  /** Existing rows establish the owner of choices saved before owner scoping. */
  migrateMonitoringOverride(repositoryId: number, ownerAccountId: number, override: boolean | null): void {
    const row = this.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", `repository-monitoring:${repositoryId}`).toArray()[0];
    if (row?.value === "true" || row?.value === "false") {
      // A reset record cannot establish that a legacy choice belongs to its
      // current owner: a transfer may already have cleared only that record.
      this.saveMonitoringOverride(repositoryId, ownerAccountId, override !== null && String(override) === row.value ? override : null);
    }
  }
  saveMonitoringOverride(repositoryId: number, ownerAccountId: number, override: boolean | null): void {
    if (override === null) { this.forgetMonitoringOverride(repositoryId); return; }
    const key = `repository-monitoring:${repositoryId}`;
    const old = this.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key).toArray()[0];
    const value = JSON.stringify({ ownerAccountId, override });
    if (old?.value !== value) this.storage.sql.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }
  forgetMonitoringOverride(repositoryId: number, ownerAccountId?: number): void {
    const key = `repository-monitoring:${repositoryId}`;
    const row = this.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key).toArray()[0];
    if (!row) return;
    const value = JSON.parse(row.value) as { ownerAccountId?: number } | boolean;
    if (ownerAccountId !== undefined && typeof value === "object" && value !== null && value.ownerAccountId !== ownerAccountId) return;
    this.storage.sql.exec("DELETE FROM settings WHERE key = ?", key);
  }
  private key(installationId: number): string { return `repository-discovery:${installationId}`; }
}
