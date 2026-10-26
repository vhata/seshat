import {
  fromPrDto, INITIAL_SYNC, isPrDto, toPrDto,
  type PullRequestRecord, type RepositoryRecord, type SyncStatus,
} from "../shared/overview/protocol";
import { RepositoryDiscoveryStore } from "./repository-discovery-store";

/** Typed persistence boundary. The caller brings the schema up to date. */
export class OverviewStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  repositories(installationId?: number): RepositoryRecord[] {
    const rows = installationId === undefined
      ? this.storage.sql.exec<{ data: string }>("SELECT data FROM repositories ORDER BY id")
      : this.storage.sql.exec<{ data: string }>("SELECT data FROM repositories WHERE installation_id = ? ORDER BY id", installationId);
    return rows.toArray().map(({ data }) => JSON.parse(data) as RepositoryRecord);
  }

  /** A monitoring change removes hidden PRs in the same transaction. */
  putRepository(repository: RepositoryRecord): boolean {
    const data = JSON.stringify(repository);
    const before = this.storage.sql.exec<{ data: string }>("SELECT data FROM repositories WHERE id = ?", repository.id).toArray()[0];
    if (before?.data === data) return false;
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `INSERT INTO repositories (id, installation_id, monitored, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET installation_id = excluded.installation_id,
           monitored = excluded.monitored, data = excluded.data`,
        repository.id, repository.installationId, repository.monitored ? 1 : 0, data,
      );
      if (!repository.monitored) this.removeRepositoryPrs(repository.id);
    });
    return true;
  }

  removeRepository(repositoryId: number): boolean {
    const before = this.storage.sql.exec<{ data: string }>("SELECT data FROM repositories WHERE id = ?", repositoryId).toArray()[0];
    if (!before) return false;
    this.storage.transactionSync(() => {
      // Preserve the last known owner before an omission or uninstall removes it.
      const repository = JSON.parse(before.data) as RepositoryRecord;
      new RepositoryDiscoveryStore(this.storage).migrateMonitoringOverride(repositoryId, repository.ownerAccountId, repository.monitorOverride);
      this.removeRepositoryPrs(repositoryId);
      this.storage.sql.exec("DELETE FROM repositories WHERE id = ?", repositoryId);
    });
    return true;
  }

  /** Only use after a complete listing; a failed page cannot delete state. */
  replaceInstallationRepositories(installationId: number, repositories: readonly RepositoryRecord[]): void {
    if (repositories.some((repo) => repo.installationId !== installationId)) throw new Error("installation mismatch");
    const ids = new Set(repositories.map((repo) => repo.id));
    if (ids.size !== repositories.length) throw new Error("duplicate repository");
    this.storage.transactionSync(() => {
      for (const previous of this.repositories(installationId)) {
        if (!ids.has(previous.id)) this.removeRepository(previous.id);
      }
      for (const repository of repositories) this.putRepository(repository);
    });
  }

  pullRequests(repositoryId?: number): PullRequestRecord[] {
    const rows = repositoryId === undefined
      ? this.storage.sql.exec<{ data: string }>("SELECT data FROM pull_requests ORDER BY node_id")
      : this.storage.sql.exec<{ data: string }>("SELECT data FROM pull_requests WHERE repository_id = ? ORDER BY node_id", repositoryId);
    return rows.toArray().map(({ data }) => {
      const dto: unknown = JSON.parse(data);
      if (!isPrDto(dto)) throw new Error("invalid stored PR DTO");
      return fromPrDto(dto);
    });
  }

  /** Returns false for unchanged data or a repository no longer monitored. */
  putPullRequest(pr: PullRequestRecord): boolean {
    const repository = this.storage.sql.exec<{ monitored: number }>("SELECT monitored FROM repositories WHERE id = ?", pr.repositoryId).toArray()[0];
    if (!repository) throw new Error("unknown repository");
    if (!repository.monitored) return false;
    const data = JSON.stringify(toPrDto(pr));
    const before = this.storage.sql.exec<{ data: string }>("SELECT data FROM pull_requests WHERE node_id = ?", pr.nodeId).toArray()[0];
    if (before?.data === data) return false;
    this.storage.sql.exec(
      `INSERT INTO pull_requests (node_id, repository_id, data) VALUES (?, ?, ?)
       ON CONFLICT (node_id) DO UPDATE SET repository_id = excluded.repository_id, data = excluded.data`,
      pr.nodeId, pr.repositoryId, data,
    );
    return true;
  }

  removePullRequest(nodeId: string): boolean {
    const exists = this.storage.sql.exec("SELECT 1 FROM pull_requests WHERE node_id = ?", nodeId).toArray().length > 0;
    if (!exists) return false;
    this.storage.sql.exec("DELETE FROM pull_requests WHERE node_id = ?", nodeId);
    return true;
  }

  /** Reconcile only authoritative complete reads, never a partial result. */
  reconcileCompleteRepository(repositoryId: number, prs: readonly PullRequestRecord[]): void {
    if (prs.some((pr) => pr.repositoryId !== repositoryId)) throw new Error("repository mismatch");
    const ids = new Set(prs.map((pr) => pr.nodeId));
    if (ids.size !== prs.length) throw new Error("duplicate PR");
    this.storage.transactionSync(() => {
      for (const before of this.pullRequests(repositoryId)) {
        if (!ids.has(before.nodeId)) this.removePullRequest(before.nodeId);
      }
      for (const pr of prs) this.putPullRequest(pr);
    });
  }

  syncStatus(): SyncStatus {
    const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM overview_sync WHERE id = 1").toArray()[0];
    return row ? JSON.parse(row.data) as SyncStatus : INITIAL_SYNC;
  }

  putSyncStatus(sync: SyncStatus): boolean {
    const data = JSON.stringify(sync);
    const before = this.storage.sql.exec<{ data: string }>("SELECT data FROM overview_sync WHERE id = 1").toArray()[0];
    if (before?.data === data) return false;
    this.storage.sql.exec(
      "INSERT INTO overview_sync (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data", data,
    );
    return true;
  }

  private removeRepositoryPrs(repositoryId: number): void {
    if (this.storage.sql.exec("SELECT 1 FROM pull_requests WHERE repository_id = ? LIMIT 1", repositoryId).toArray().length > 0) {
      this.storage.sql.exec("DELETE FROM pull_requests WHERE repository_id = ?", repositoryId);
    }
  }
}
