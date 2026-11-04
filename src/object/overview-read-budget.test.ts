import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../shared/config";
import type { StoredInstallation } from "../shared/installations";
import { FIXTURE_REPOSITORY, fixturePr } from "../shared/overview/fixtures";
import type { PullRequestRecord, RepositoryRecord } from "../shared/overview/protocol";
import { GithubPrReader } from "../worker/github-pr-reader";
import { GitHubRepositoryListing } from "../worker/github-repositories";
import { OverviewStore } from "./overview-store";
import { OverviewSync } from "./overview-sync";
import { RepositoryDiscoveryStore } from "./repository-discovery-store";
import { RepositorySelection } from "./repository-selection";

const NOW = Date.now() + 3_600_000;
const INSTALLATIONS: StoredInstallation[] = [{ id: 9, accountId: 1001, accountType: "User", status: "accepted", repositorySelection: "all" }];

afterEach(() => { vi.restoreAllMocks(); });

function seed(store: OverviewStore, count: number): { repositories: RepositoryRecord[]; prs: PullRequestRecord[] } {
  const repositories = Array.from({ length: count }, (_, index) => ({
    ...FIXTURE_REPOSITORY, id: index + 1, nodeId: `R_${index}`, fullName: `example/repository-${index}`,
  }));
  const prs = repositories.map((repository, index) => fixturePr({
    id: index + 1, nodeId: `PR_${index}`, repositoryId: repository.id,
    repository: { fullName: repository.fullName, ownerAccountId: repository.ownerAccountId },
  }));
  for (const repository of repositories) store.putRepository(repository);
  for (const pr of prs) store.putPullRequest(pr);
  return { repositories, prs };
}

/** Count actual SQLite work after cursors have been consumed, not query text. */
async function reads<T>(storage: DurableObjectStorage, action: () => T | Promise<T>) {
  const exec = vi.spyOn(storage.sql, "exec");
  try {
    const value = await action();
    const rowsRead = exec.mock.results.reduce((sum, result) => sum + (result.type === "return" ? result.value.rowsRead : 0), 0);
    return { value, rowsRead };
  } finally { exec.mockRestore(); }
}

describe("overview SQL read budgets", () => {
  it("reads current keyed records within their installation or repository boundary", async () => {
    const stub = env.INSTANCE.getByName("read-budget-keyed-identities");
    await stub.health();
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage);
      const { repositories, prs } = seed(store, 100);
      const measured = await reads(state.storage, () => {
        for (const repository of repositories) {
          expect(store.repository(repository.id, 9)).toEqual(repository);
          expect(store.repository(repository.id, 10)).toBeUndefined();
        }
        for (const pr of prs) {
          expect(store.pullRequest(pr.nodeId, pr.repositoryId)).toEqual(pr);
          expect(store.pullRequest(pr.nodeId, pr.repositoryId + 1000)).toBeUndefined();
        }
        expect(store.repository(1000)).toBeUndefined();
        expect(store.pullRequest("PR_missing")).toBeUndefined();
      });
      expect(measured.rowsRead).toBeLessThanOrEqual(800);

      const moved = { ...repositories[0]!, installationId: 10, ownerAccountId: 2002 };
      store.putRepository(moved);
      expect(store.repository(moved.id, 9)).toBeUndefined();
      expect(store.repository(moved.id, 10)).toEqual(moved);
      expect(store.pullRequest(prs[0]!.nodeId)).toBeUndefined();
      store.putRepository({ ...moved, monitored: false });
      expect(store.repository(moved.id)?.monitored).toBe(false);
    });
  });

  it.each([20, 100])("rearms %i pending PR updates without scanning unrelated repositories", async (count) => {
    const stub = env.INSTANCE.getByName(`read-budget-rearm-${count}`);
    await stub.health();
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage);
      const { repositories, prs } = seed(store, count);
      const marks = prs.map((pr) => ({
        nodeId: pr.nodeId, repositoryId: pr.repositoryId, installationId: 9,
        facts: [], due: NOW + 60_000, queuedAt: NOW, firstRead: null,
        retry: 0, revision: 0, mergeability: false, repositoryOwnerAccountId: 1001,
      }));
      state.storage.sql.exec("INSERT INTO settings (key,value) VALUES (?,?)", "overview-sync-work-v1", JSON.stringify({
        marks, shas: [], refresh: [], refreshGenerations: {}, observationGenerations: {},
        guard: null, nextSweep: null, lastCatchup: null, sweep: null, reread: null,
        permissions: [], headDates: [], rates: [],
      }));
      const sync = new OverviewSync({
        storage: state.storage, store, selection: null, installations: () => INSTALLATIONS,
        visible: () => false, guard: async () => true, publish: async () => {},
      });
      const measured = await reads(state.storage, () => sync.rearm(NOW));
      expect(measured.rowsRead).toBeLessThanOrEqual(2 * marks.length);
      expect(await state.storage.getAlarm()).toBe(NOW + 60_000);

      // Every later rearm must recheck current ownership and monitoring.
      for (const repository of repositories) store.putRepository({ ...repository, ownerAccountId: 2002 });
      await sync.rearm(NOW + 1);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("assembles a snapshot without rereading the repository and PR tables for freshness", async () => {
    const stub = env.INSTANCE.getByName("read-budget-snapshot");
    await stub.health();
    await runInDurableObject(stub, async (instance, state) => {
      const store = new OverviewStore(state.storage);
      const { repositories, prs } = seed(store, 100);
      for (const repository of repositories) {
        const attempt = store.beginCheck("repository", String(repository.id), NOW);
        store.finishCheck("repository", String(repository.id), attempt, "success");
      }
      for (const pr of prs) {
        const attempt = store.beginCheck("pr", pr.nodeId, NOW);
        store.finishCheck("pr", pr.nodeId, attempt, "success");
      }
      const measured = await reads(state.storage, () => instance.overviewSnapshot(NOW));
      expect(measured.value.repositories).toHaveLength(repositories.length);
      expect(measured.value.buckets.flatMap((bucket) => bucket.rows)).toHaveLength(prs.length);
      expect(measured.value.freshness?.repositories["1"]?.lastSuccessfulCheckAt).toBe(NOW);
      expect(measured.value.freshness?.pullRequests["PR_0"]?.lastSuccessfulCheckAt).toBe(NOW);
      // One pass over data and one successful-check row for each identity.
      expect(measured.rowsRead).toBeLessThanOrEqual(2 * (repositories.length + prs.length) + 16);
    });
  });

  it.each([20, 80])("completes a sweep of %i repositories and PRs within a linear read budget", async (count) => {
    const stub = env.INSTANCE.getByName(`read-budget-sweep-${count}`);
    await stub.health();
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage);
      const { repositories, prs } = seed(store, count);
      const discovery = new RepositoryDiscoveryStore(state.storage);
      const selection = new RepositorySelection({
        ownerId: 1001, app: readConfig(env as unknown as Record<string, unknown>).app!,
        store, discovery, installations: () => INSTALLATIONS, publish: async () => {},
      });
      vi.spyOn(selection.tokens, "get").mockResolvedValue({ ok: true, token: "synthetic-read-budget-token", expiresAt: NOW + 7_200_000 });
      vi.spyOn(GitHubRepositoryListing.prototype, "readPage").mockResolvedValue({ ok: true, page: { etag: null, total: count, repositories } });
      const meta = { status: "complete" as const, issues: [], rateLimit: null, requestsUsed: 1, permissionCache: [], headCommitDates: [], continuation: null };
      vi.spyOn(GithubPrReader.prototype, "countOpenPrs").mockResolvedValue({
        ...meta, repositories: repositories.map((repository) => ({ repositoryId: repository.id, nodeId: repository.nodeId, visibility: repository.visibility, count: 1 })),
      });
      vi.spyOn(GithubPrReader.prototype, "readRepositories").mockResolvedValue({
        ...meta, repositories: repositories.map((repository, index) => ({ repositoryId: repository.id, nodeId: repository.nodeId, visibility: repository.visibility, complete: true, prs: [prs[index]!] })),
      });
      const sync = new OverviewSync({
        ownerId: 1001, storage: state.storage, store, selection, installations: () => INSTALLATIONS,
        visible: () => true, guard: async () => true, publish: async () => {},
      });
      const measured = await reads(state.storage, async () => {
        await sync.visibility(NOW, false);
        for (let index = 0; index < 4; index++) await sync.alarm(NOW + index);
      });
      expect(store.syncStatus().latestAttempt?.result).toBe("success");
      expect(store.syncStatus().lastSuccessfulSweepAt).toBe(NOW);
      expect(store.pullRequests()).toHaveLength(prs.length);
      for (const repository of repositories) expect(store.checkStatus("repository", String(repository.id)).lastSuccessfulCheckAt).not.toBeNull();
      for (const pr of prs) expect(store.checkStatus("pr", pr.nodeId).lastSuccessfulCheckAt).not.toBeNull();
      // Discovery, count, read, persistence and check evidence are real;
      // GitHub providers are synthetic, and socket publication is excluded.
      expect(measured.rowsRead).toBeLessThanOrEqual(50 * (repositories.length + prs.length) + 100);
      await state.storage.deleteAlarm();
    });
  });
});
