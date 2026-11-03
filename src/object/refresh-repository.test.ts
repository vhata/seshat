import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredInstallation } from "../shared/installations";
import { FIXTURE_REPOSITORY, fixturePr } from "../shared/overview/fixtures";
import { reduceDelivery } from "../shared/overview/webhook-marks";
import { GithubPrReader, type ReadMeta, type ReaderContinuation } from "../worker/github-pr-reader";
import { OverviewStore } from "./overview-store";
import { OverviewSync } from "./overview-sync";
import type { RepositorySelection } from "./repository-selection";

afterEach(() => { vi.restoreAllMocks(); });
const NOW = Date.now() + 3_600_000;
const INSTALLATION: StoredInstallation = { id: 9, accountId: 1001, accountType: "User", status: "accepted", repositorySelection: "all" };
const META: ReadMeta = { status: "complete", requestsUsed: 1, issues: [], rateLimit: null, permissionCache: [], headCommitDates: [], continuation: null };
const CONTINUATION: ReaderContinuation = { version: 1, responses: [], permissionCache: [], headCommitDates: [], refreshedPermissionKeys: [], rateLimit: null };
const OTHER = { ...FIXTURE_REPOSITORY, id: 13, nodeId: "R_other", fullName: "example/other" };
function context(storage: DurableObjectStorage, visible = false) {
  const selection = { tokens: { get: vi.fn(async () => ({ ok: true, token: "synthetic-token", expiresAt: NOW + 7_200_000 })) },
    refreshInstallation: vi.fn(async () => ({ ok: true, changed: false, repositoryIds: [12, 13], requestsUsed: 2 })), discardRefreshProgress: vi.fn() } as unknown as RepositorySelection;
  return { storage, store: new OverviewStore(storage), selection, installations: () => [INSTALLATION],
    visible: () => visible, guard: async () => true, publish: vi.fn(async (_now: number) => {}) };
}
function read(prs = [fixturePr()], complete = true) {
  return { ...META, repositories: [{ repositoryId: 12, nodeId: "R_example", visibility: "public" as const, complete, prs }] };
}
function event(at: number) {
  return reduceDelivery("pull_request", { installation: { id: 9 }, repository: { id: 12, owner: { id: 1001 }, visibility: "public" },
    action: "synchronize", pull_request: { node_id: "PR_example", head: { sha: "new-head" }, updated_at: new Date(at).toISOString() } }, at)!;
}
async function object(name: string) { const stub = env.INSTANCE.getByName(`manual-refresh-${name}`); await stub.health(); return stub; }
function receipt(store: OverviewStore) { return store.checkFreshness().repositoryRefreshes?.[12]; }

describe("requested single repository refresh", () => {
  it.each([false, true])("targets one repository including muted=%s and reconciles missed opens and closes", async (muted) => {
    const opened = fixturePr({ nodeId: "PR_new", number: 2, id: 4, title: "Missed open", headSha: "latest-head" });
    const reader = vi.spyOn(GithubPrReader.prototype, "readRepositories").mockResolvedValue(read([opened]));
    const count = vi.spyOn(GithubPrReader.prototype, "countOpenPrs");
    const stub = await object(`target-${muted}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository({ ...FIXTURE_REPOSITORY, muted }); ctx.store.putRepository(OTHER);
      ctx.store.putPullRequest(fixturePr());
      const sync = new OverviewSync(ctx);
      const requested = await sync.refreshRepository(12, 1001, NOW);
      expect(requested).toMatchObject({ ok: true, attempt: { result: "queued", startedAt: NOW } });
      expect(receipt(ctx.store)?.latestAttempt?.result).toBe("queued");
      expect(reader).not.toHaveBeenCalled();
      await sync.alarm(NOW + 1);
      expect(reader).toHaveBeenCalledExactlyOnceWith(["R_example"]);
      expect(count).not.toHaveBeenCalled(); expect(ctx.selection.refreshInstallation).not.toHaveBeenCalled();
      expect(ctx.store.pullRequests().map((pr) => pr.nodeId)).toEqual(["PR_new"]);
      expect(ctx.store.pullRequests()[0]?.headSha).toBe("latest-head");
      expect(receipt(ctx.store)).toMatchObject({ lastSuccessfulCheckAt: NOW, latestAttempt: { result: "success" } });
      expect(ctx.store.checkFreshness().repositories[13]?.latestAttempt).toBeNull();
      expect(ctx.store.syncStatus().lastSuccessfulSweepAt).toBeNull();
      const background = ctx.store.beginCheck("repository", "12", NOW + 2);
      ctx.store.finishCheck("repository", "12", background, "failed", "github-unavailable");
      expect(receipt(ctx.store)?.latestAttempt?.result).toBe("success");
    });
  });

  it("accepts an empty authoritative repository result", async () => {
    vi.spyOn(GithubPrReader.prototype, "readRepositories").mockResolvedValue(read([]));
    const stub = await object("empty");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY); ctx.store.putPullRequest(fixturePr());
      const sync = new OverviewSync(ctx); await sync.refreshRepository(12, 1001, NOW); await sync.alarm(NOW);
      expect(ctx.store.pullRequests()).toEqual([]);
      expect(receipt(ctx.store)?.latestAttempt?.result).toBe("success");
    });
  });

  it("coalesces queued, running and continued requests without resetting their work or budgets", async () => {
    let release = (_result: ReturnType<typeof read>) => {};
    let enter = () => {};
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const pending = new Promise<ReturnType<typeof read>>((resolve) => { release = resolve; });
    const reader = vi.spyOn(GithubPrReader.prototype, "readRepositories").mockImplementationOnce(() => { enter(); return pending; })
      .mockResolvedValue(read());
    const stub = await object("coalesce");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY);
      const sync = new OverviewSync(ctx); const first = await sync.refreshRepository(12, 1001, NOW);
      expect(await sync.refreshRepository(12, 1001, NOW + 1)).toEqual(first);
      const running = sync.alarm(NOW + 2); await entered;
      expect(receipt(ctx.store)?.latestAttempt?.result).toBe("running");
      expect(await sync.refreshRepository(12, 1001, NOW + 3)).toMatchObject({ ok: true, attempt: { id: first.ok && first.attempt.id, result: "running" } });
      release({ ...read([], false), status: "partial", continuation: CONTINUATION }); await running;
      expect(await sync.refreshRepository(12, 1001, NOW + 4)).toMatchObject({ ok: true, attempt: { id: first.ok && first.attempt.id } });
      await sync.alarm(NOW + 4);
      expect(reader).toHaveBeenCalledTimes(2);
      expect(receipt(ctx.store)?.latestAttempt).toMatchObject({ id: first.ok && first.attempt.id, result: "success" });
    });
  });

  it.each(["github-unavailable", "rate-limited"] as const)("retains cached data and previous success after exhausted %s retries", async (reason) => {
    const reader = vi.spyOn(GithubPrReader.prototype, "readRepositories").mockResolvedValue(read());
    const stub = await object(`failure-${reason}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY); ctx.store.putPullRequest(fixturePr());
      const sync = new OverviewSync(ctx); await sync.refreshRepository(12, 1001, NOW); await sync.alarm(NOW);
      reader.mockResolvedValue({ ...META, status: "failed", repositories: [], issues: [{ nodeId: "R_example", reason: reason === "rate-limited" ? "rate-limited" : "unavailable" }] });
      const second = await sync.refreshRepository(12, 1001, NOW + 1);
      for (const delta of [1, 5001, 15001, 30001]) {
        await sync.alarm(NOW + delta);
        if (delta !== 30001) expect(await sync.refreshRepository(12, 1001, NOW + delta + 1)).toMatchObject({ ok: true, attempt: { id: second.ok && second.attempt.id } });
      }
      expect(reader).toHaveBeenCalledTimes(5);
      expect(ctx.store.pullRequests()).toHaveLength(1);
      expect(receipt(ctx.store)).toMatchObject({ lastSuccessfulCheckAt: NOW, latestAttempt: { result: "failed", reason } });
      const check = ctx.store.beginCheck("repository", "12", NOW + 40000); ctx.store.finishCheck("repository", "12", check, "success");
      expect(receipt(ctx.store)?.latestAttempt?.result).toBe("failed");
    });
  });

  it("retains cached rows when current reviewer permissions cannot be read", async () => {
    vi.spyOn(GithubPrReader.prototype, "readRepositories").mockResolvedValue({ ...read([], false), status: "partial", issues: [{ nodeId: "PR_example", reason: "permission-failed" }] });
    const stub = await object("permissions");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY); ctx.store.putPullRequest(fixturePr());
      const sync = new OverviewSync(ctx); await sync.refreshRepository(12, 1001, NOW);
      for (const delta of [0, 5000, 15000, 30000]) await sync.alarm(NOW + delta);
      expect(ctx.store.pullRequests()).toEqual([fixturePr()]);
      expect(receipt(ctx.store)?.latestAttempt).toMatchObject({ result: "failed", reason: "github-unavailable" });
    });
  });

  it("rejects unknown, unmonitored, changed-owner and inaccessible repositories without GitHub work", async () => {
    const stub = await object("rejected");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); const sync = new OverviewSync(ctx);
      expect(await sync.refreshRepository(12, 1001, NOW)).toEqual({ ok: false, reason: "not-found" });
      ctx.store.putRepository({ ...FIXTURE_REPOSITORY, monitored: false });
      expect(await sync.refreshRepository(12, 1001, NOW)).toEqual({ ok: false, reason: "not-allowed" });
      ctx.store.putRepository(FIXTURE_REPOSITORY);
      expect(await sync.refreshRepository(12, 2002, NOW)).toEqual({ ok: false, reason: "not-allowed" });
      ctx.store.putRepository({ ...FIXTURE_REPOSITORY, ownerPermission: "none" });
      expect(await sync.refreshRepository(12, 1001, NOW)).toEqual({ ok: false, reason: "not-allowed" });
      expect(ctx.selection.tokens.get).not.toHaveBeenCalled();
    });
  });

  it("restarts superseded observations without attributing stale membership to the manual request", async () => {
    let release = (_result: ReturnType<typeof read>) => {};
    let enter = () => {};
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const pending = new Promise<ReturnType<typeof read>>((resolve) => { release = resolve; });
    vi.spyOn(GithubPrReader.prototype, "readRepositories").mockImplementationOnce(() => { enter(); return pending; })
      .mockResolvedValue(read([fixturePr({ headSha: "new-head" })]));
    vi.spyOn(GithubPrReader.prototype, "rereadPrs").mockResolvedValue({ ...META, nodes: [{ kind: "open", pr: fixturePr({ headSha: "new-head" }), visibility: "public" }] });
    const stub = await object("webhook-race");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY); ctx.store.putPullRequest(fixturePr());
      const sync = new OverviewSync(ctx); const requested = await sync.refreshRepository(12, 1001, NOW);
      const running = sync.alarm(NOW); await entered;
      await sync.receive(event(NOW + 1), NOW + 1);
      release(read([])); await running;
      expect(ctx.store.pullRequests()).toHaveLength(1);
      expect(receipt(ctx.store)?.latestAttempt?.result).toBe("running");
      await sync.alarm(NOW + 2); await sync.alarm(NOW + 2001);
      expect(ctx.store.pullRequests()[0]?.headSha).toBe("new-head");
      expect(receipt(ctx.store)?.latestAttempt).toMatchObject({ id: requested.ok && requested.attempt.id, result: "success" });
      expect(ctx.store.checkFreshness().pullRequests.PR_example?.latestAttempt?.result).toBe("success");
    });
  });

  it("keeps receipt identity and continuation across object eviction", async () => {
    vi.spyOn(GithubPrReader.prototype, "readRepositories").mockResolvedValueOnce({ ...read([], false), status: "partial", continuation: CONTINUATION }).mockResolvedValue(read());
    const stub = await object("eviction"); let requestId = 0;
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY);
      const sync = new OverviewSync(ctx); const request = await sync.refreshRepository(12, 1001, NOW);
      requestId = request.ok ? request.attempt.id : 0; await sync.alarm(NOW);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); const sync = new OverviewSync(ctx);
      expect(await sync.refreshRepository(12, 1001, NOW + 1)).toMatchObject({ ok: true, attempt: { id: requestId } });
      await sync.alarm(NOW + 60000);
      expect(receipt(ctx.store)).toMatchObject({ lastSuccessfulCheckAt: NOW, latestAttempt: { id: requestId, result: "success" } });
      expect(ctx.store.checkFreshness().repositories[12]?.lastSuccessfulCheckAt).toBe(NOW);
    });
  });

  it("interrupts pending work on installation loss without leaving a permanent running receipt", async () => {
    const stub = await object("installation-loss");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY);
      let installed = true;
      const sync = new OverviewSync({ ...ctx, installations: () => installed ? [INSTALLATION] : [] });
      await sync.refreshRepository(12, 1001, NOW); installed = false; await sync.alarm(NOW);
      expect(receipt(ctx.store)?.latestAttempt?.result).toBe("interrupted");
      expect(ctx.selection.tokens.get).not.toHaveBeenCalled();
    });
  });
});
