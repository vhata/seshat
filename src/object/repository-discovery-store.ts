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

/** Only public GitHub metadata and permission facts, never credentials. */
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
  private key(installationId: number): string { return `repository-discovery:${installationId}`; }
}
