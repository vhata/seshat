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
const INSTALLATIONS: StoredInstallation[] = [{ id: 9, accountId: 1001, accountType: "User", status: "accepted", repositorySelection: "all" }];
const META: ReadMeta = { status: "complete", requestsUsed: 1, issues: [], rateLimit: null, permissionCache: [], headCommitDates: [], continuation: null };
const CONTINUATION: ReaderContinuation = { version: 1, responses: [], permissionCache: [], headCommitDates: [], refreshedPermissionKeys: [], rateLimit: null };
const OTHER = { ...FIXTURE_REPOSITORY, id: 13, nodeId: "R_other", fullName: "example/other" };
function event(at = NOW, head = fixturePr().headSha) {
  return reduceDelivery("pull_request", { installation: { id: 9 }, repository: { id: 12, owner: { id: 1001 }, visibility: "public" },
    action: "synchronize", pull_request: { node_id: "PR_example", head: { sha: head }, updated_at: new Date(NOW).toISOString() } }, at)!;
}
function selection() {
  return { tokens: { get: vi.fn(async () => ({ ok: true, token: "memory-only-token", expiresAt: NOW + 7_200_000 })) },
    refreshInstallation: vi.fn(async () => ({ ok: true, changed: false, repositoryIds: [12, 13], requestsUsed: 2 })), discardRefreshProgress: vi.fn() } as unknown as RepositorySelection;
}
function context(storage: DurableObjectStorage, visible: () => boolean = () => false) {
  return { storage, store: new OverviewStore(storage), selection: selection(), installations: () => INSTALLATIONS,
    visible, guard: async () => true, publish: async () => {} };
}
function repositoryRead(complete = true, prs = [fixturePr()]) {
  return { repositoryId: 12, nodeId: "R_example", visibility: "public" as const, complete, prs };
}
async function object(name: string) { const stub = env.INSTANCE.getByName(`freshness-sync-${name}`); await stub.health(); return stub; }

describe("durable scoped freshness", () => {
  it("keeps a successful repository and unchanged PR check when another repository fails and retries", async () => {
    vi.spyOn(GithubPrReader.prototype, "countOpenPrs").mockResolvedValue({ ...META, repositories: [
      { repositoryId: 12, nodeId: "R_example", visibility: "public", count: 1 },
      { repositoryId: 13, nodeId: "R_other", visibility: "public", count: 1 },
    ] });
    vi.spyOn(GithubPrReader.prototype, "readRepositories").mockResolvedValue({ ...META, status: "partial", issues: [{ nodeId: "R_other", reason: "unavailable" }], repositories: [repositoryRead()] });
    const stub = await object("mixed");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage, () => true); ctx.store.putRepository(FIXTURE_REPOSITORY); ctx.store.putRepository(OTHER); ctx.store.putPullRequest(fixturePr());
      const sync = new OverviewSync(ctx); await sync.visibility(NOW, false);
      await sync.alarm(NOW); await sync.alarm(NOW + 1); await sync.alarm(NOW + 2);
      const first = ctx.store.checkFreshness();
      expect(first.repositories[12]).toMatchObject({ lastSuccessfulCheckAt: NOW, latestAttempt: { result: "success" } });
      expect(first.pullRequests.PR_example).toMatchObject({ lastSuccessfulCheckAt: NOW + 2, latestAttempt: { result: "success" } });
      expect(first.repositories[13]).toMatchObject({ lastSuccessfulCheckAt: null, latestAttempt: { result: "failed" } });
      expect(ctx.store.syncStatus().lastSuccessfulSweepAt).toBeNull();
      // Retry starts fresh attempts without erasing the last good evidence.
      await sync.alarm(NOW + 15_002);
      expect(ctx.store.checkFreshness().repositories[12]).toMatchObject({ lastSuccessfulCheckAt: NOW, latestAttempt: { result: "queued" } });
      expect(ctx.store.checkFreshness().repositories[13]?.lastSuccessfulCheckAt).toBeNull();
    });
  });

  it("checks an empty repository completely without deriving evidence from listedAt", async () => {
    vi.spyOn(GithubPrReader.prototype, "countOpenPrs").mockResolvedValue({ ...META, repositories: [
      { repositoryId: 12, nodeId: "R_example", visibility: "public", count: 0 },
    ] });
    const read = vi.spyOn(GithubPrReader.prototype, "readRepositories").mockResolvedValue({ ...META, repositories: [] });
    const stub = await object("empty");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage, () => true); ctx.store.putRepository({ ...FIXTURE_REPOSITORY, listedAt: NOW + 1234 }); ctx.store.putPullRequest(fixturePr());
      expect(ctx.store.checkFreshness().repositories[12]?.lastSuccessfulCheckAt).toBeNull();
      const sync = new OverviewSync(ctx); await sync.visibility(NOW, false); await sync.alarm(NOW); await sync.alarm(NOW + 1);
      expect(ctx.store.pullRequests()).toEqual([]);
      expect(ctx.store.checkFreshness().repositories[12]).toMatchObject({ lastSuccessfulCheckAt: NOW, latestAttempt: { result: "success" } });
      await sync.alarm(NOW + 2); await sync.alarm(NOW + 3);
      expect(read).toHaveBeenCalledWith([]);
    });
  });

  it("records an unchanged webhook reread without claiming a full repository check", async () => {
    vi.spyOn(GithubPrReader.prototype, "rereadPrs").mockResolvedValue({ ...META, nodes: [{ kind: "open", pr: fixturePr(), visibility: "public" }] });
    const stub = await object("webhook");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY); ctx.store.putPullRequest(fixturePr());
      const sync = new OverviewSync(ctx); await sync.receive(event(), NOW);
      expect(ctx.store.checkFreshness().pullRequests.PR_example?.latestAttempt).toMatchObject({ startedAt: NOW, result: "queued" });
      await sync.alarm(NOW + 2000);
      expect(ctx.store.checkFreshness().pullRequests.PR_example).toMatchObject({ lastSuccessfulCheckAt: NOW + 2000, latestAttempt: { result: "success" } });
      expect(ctx.store.checkFreshness().repositories[12]).toEqual({ lastSuccessfulCheckAt: null, latestAttempt: null });
    });
  });

  it("retains failed cached PRs and records their failure in a partial repository result", async () => {
    const good = fixturePr({ nodeId: "PR_good", id: 4, number: 2 });
    vi.spyOn(GithubPrReader.prototype, "readRepositories").mockResolvedValue({ ...META, status: "partial", issues: [{ nodeId: "PR_example", reason: "permission-failed" }], repositories: [repositoryRead(false, [good])] });
    const stub = await object("partial");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY); ctx.store.putPullRequest(fixturePr());
      const sync = new OverviewSync(ctx); sync.discoveryChanged(9, NOW); await sync.alarm(NOW);
      expect(ctx.store.pullRequests().map((pr) => pr.nodeId)).toEqual(["PR_example", "PR_good"]);
      const evidence = ctx.store.checkFreshness();
      expect(evidence.repositories[12]).toMatchObject({ lastSuccessfulCheckAt: null, latestAttempt: { result: "failed" } });
      expect(evidence.pullRequests.PR_example).toMatchObject({ lastSuccessfulCheckAt: null, latestAttempt: { result: "failed" } });
      expect(evidence.pullRequests.PR_good).toMatchObject({ lastSuccessfulCheckAt: NOW, latestAttempt: { result: "success" } });
    });
  });

  it("persists continuation observation times through eviction and never refreshes time on cached replay", async () => {
    let calls = 0;
    vi.spyOn(GithubPrReader.prototype, "readRepositories").mockImplementation(async () => ++calls === 1
      ? { ...META, status: "partial", continuation: CONTINUATION, repositories: [repositoryRead(), { repositoryId: 13, nodeId: "R_other", visibility: "public", complete: false, prs: [] }] }
      : { ...META, repositories: [repositoryRead(), { repositoryId: 13, nodeId: "R_other", visibility: "public", complete: true, prs: [] }] });
    const stub = await object("restart");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY); ctx.store.putRepository(OTHER);
      const sync = new OverviewSync(ctx); sync.discoveryChanged(9, NOW); await sync.alarm(NOW);
      expect(ctx.store.checkFreshness().repositories[12]?.lastSuccessfulCheckAt).toBe(NOW);
      expect(ctx.store.checkFreshness().repositories[13]?.latestAttempt?.result).toBe("running");
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); const sync = new OverviewSync(ctx); await sync.alarm(NOW + 60_000);
      const evidence = ctx.store.checkFreshness();
      expect(evidence.repositories[12]?.lastSuccessfulCheckAt).toBe(NOW);
      expect(evidence.repositories[13]?.lastSuccessfulCheckAt).toBe(NOW);
      expect(evidence.pullRequests.PR_example?.lastSuccessfulCheckAt).toBe(NOW);
      expect(evidence.repositories[13]?.latestAttempt?.result).toBe("success");
    });
  });

  it("does not let a delayed repository completion overwrite a newer queued webhook check", async () => {
    let release = (_result: Awaited<ReturnType<GithubPrReader["readRepositories"]>>) => {};
    const response = new Promise<Awaited<ReturnType<GithubPrReader["readRepositories"]>>>((resolve) => { release = resolve; });
    let enter = () => {};
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    vi.spyOn(GithubPrReader.prototype, "readRepositories").mockImplementation(() => { enter(); return response; });
    const stub = await object("delayed");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY); ctx.store.putPullRequest(fixturePr());
      const sync = new OverviewSync(ctx); sync.discoveryChanged(9, NOW); const reading = sync.alarm(NOW);
      await entered;
      await sync.receive(event(NOW + 1, "new"), NOW + 1);
      const queued = ctx.store.checkFreshness().pullRequests.PR_example?.latestAttempt;
      release({ ...META, repositories: [repositoryRead()] }); await reading;
      expect(ctx.store.checkFreshness().pullRequests.PR_example?.latestAttempt).toEqual(queued);
      expect(queued?.result).toBe("queued");
      expect(ctx.store.checkFreshness().pullRequests.PR_example?.lastSuccessfulCheckAt).toBeNull();
      expect(ctx.store.checkFreshness().repositories[12]?.latestAttempt?.result).toBe("interrupted");
    });
  });

  it("starts a fresh token after an unexpected reader failure so retry success can recover", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reread = vi.spyOn(GithubPrReader.prototype, "rereadPrs").mockRejectedValueOnce(new Error("test failure"))
      .mockResolvedValue({ ...META, nodes: [{ kind: "open", pr: fixturePr(), visibility: "public" }] });
    const stub = await object("throw-retry");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY); ctx.store.putPullRequest(fixturePr());
      const sync = new OverviewSync(ctx); await sync.receive(event(), NOW); await sync.alarm(NOW + 2000);
      const failed = ctx.store.checkFreshness().pullRequests.PR_example?.latestAttempt;
      expect(failed?.result).toBe("failed");
      await sync.alarm(NOW + 7000);
      const recovered = ctx.store.checkFreshness().pullRequests.PR_example;
      expect(recovered).toMatchObject({ lastSuccessfulCheckAt: NOW + 7000, latestAttempt: { result: "success" } });
      expect(recovered?.latestAttempt?.id).not.toBe(failed?.id);
      expect(reread).toHaveBeenCalledTimes(2);
    });
  });

  it("interrupts a hidden sweep's pending checks without claiming a success", async () => {
    const stub = await object("hidden");
    await runInDurableObject(stub, async (_instance, state) => {
      let visible = true; const ctx = context(state.storage, () => visible); ctx.store.putRepository(FIXTURE_REPOSITORY);
      const sync = new OverviewSync(ctx); await sync.visibility(NOW, false); await sync.alarm(NOW);
      expect(ctx.store.checkFreshness().repositories[12]?.latestAttempt?.result).toBe("queued");
      visible = false; await sync.rearm(NOW + 1);
      expect(ctx.store.checkFreshness().repositories[12]).toMatchObject({ lastSuccessfulCheckAt: null, latestAttempt: { result: "interrupted" } });
    });
  });

  it("keeps a queued webhook visible after a concurrent sweep successfully observes older PR facts", async () => {
    vi.spyOn(GithubPrReader.prototype, "countOpenPrs").mockResolvedValue({ ...META, repositories: [
      { repositoryId: 12, nodeId: "R_example", visibility: "public", count: 1 },
    ] });
    vi.spyOn(GithubPrReader.prototype, "readRepositories").mockResolvedValue({ ...META, repositories: [repositoryRead()] });
    const stub = await object("concurrent-pending");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage, () => true); ctx.store.putRepository(FIXTURE_REPOSITORY); ctx.store.putPullRequest(fixturePr());
      const sync = new OverviewSync(ctx); await sync.receive(event(NOW, "newer-head-not-observed"), NOW);
      await sync.visibility(NOW, false); await sync.alarm(NOW); await sync.alarm(NOW + 1); await sync.alarm(NOW + 2);
      expect(ctx.store.checkFreshness().repositories[12]?.latestAttempt?.result).toBe("success");
      expect(ctx.store.checkFreshness().pullRequests.PR_example).toMatchObject({ lastSuccessfulCheckAt: NOW + 2, latestAttempt: { result: "queued" } });
      expect(sync.schedulerStatus().pending.marks).toBe(1);
    });
  });

  it("records token failures for all cached PRs selected by a repository read", async () => {
    const stub = await object("token-failure");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY); ctx.store.putPullRequest(fixturePr());
      vi.mocked(ctx.selection.tokens.get).mockResolvedValue({ ok: false, reason: "rate-limited" });
      const sync = new OverviewSync(ctx); sync.discoveryChanged(9, NOW); await sync.alarm(NOW);
      const evidence = ctx.store.checkFreshness();
      expect(evidence.repositories[12]).toMatchObject({ lastSuccessfulCheckAt: null, latestAttempt: { result: "failed", reason: "rate-limited" } });
      expect(evidence.pullRequests.PR_example).toMatchObject({ lastSuccessfulCheckAt: null, latestAttempt: { result: "failed", reason: "rate-limited" } });
    });
  });

  it("shows discovery-triggered pending repository work and failure before its complete read", async () => {
    const stub = await object("discovery-failure");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY);
      vi.mocked(ctx.selection.refreshInstallation).mockResolvedValue({ ok: false, reason: "github-unavailable", requestsUsed: 1 });
      const sync = new OverviewSync(ctx); sync.refresh(9, NOW);
      expect(ctx.store.checkFreshness().repositories[12]?.latestAttempt?.result).toBe("queued");
      await sync.alarm(NOW);
      expect(ctx.store.checkFreshness().repositories[12]).toMatchObject({ lastSuccessfulCheckAt: null, latestAttempt: { result: "failed" } });
    });
  });

  it("adopts legacy cached sweep progress with its original conservative observation time", async () => {
    vi.spyOn(GithubPrReader.prototype, "countOpenPrs").mockResolvedValue({ ...META, repositories: [
      { repositoryId: 12, nodeId: "R_example", visibility: "public", count: 1 },
    ] });
    vi.spyOn(GithubPrReader.prototype, "readRepositories")
      .mockResolvedValueOnce({ ...META, status: "partial", continuation: CONTINUATION, repositories: [repositoryRead(false)] })
      .mockResolvedValue({ ...META, repositories: [repositoryRead()] });
    const stub = await object("legacy-sweep");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage, () => true); ctx.store.putRepository(FIXTURE_REPOSITORY);
      const sync = new OverviewSync(ctx); await sync.visibility(NOW, false);
      await sync.alarm(NOW); await sync.alarm(NOW + 1); await sync.alarm(NOW + 2);
      const saved = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key='overview-sync-work-v1'").one().value) as { sweep: { checks?: unknown; readStartedAt?: number } };
      delete saved.sweep.checks; delete saved.sweep.readStartedAt;
      state.storage.sql.exec("UPDATE settings SET value=? WHERE key='overview-sync-work-v1'", JSON.stringify(saved));
      ctx.store.forget("repository", "12"); ctx.store.forget("pr", "PR_example");
      await new OverviewSync(ctx).alarm(NOW + 60_000);
      expect(ctx.store.checkFreshness().repositories[12]?.lastSuccessfulCheckAt).toBe(NOW);
      expect(ctx.store.checkFreshness().pullRequests.PR_example?.lastSuccessfulCheckAt).toBe(NOW);
    });
  });

  it("does not fail newer discovery work when an older refresh rejects late", async () => {
    let reject = (_error: Error) => {};
    const result = new Promise<Awaited<ReturnType<RepositorySelection["refreshInstallation"]>>>((_resolve, rejectResult) => { reject = rejectResult; });
    let enter = () => {};
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const stub = await object("late-refresh-rejection");
    await runInDurableObject(stub, async (_instance, state) => {
      const ctx = context(state.storage); ctx.store.putRepository(FIXTURE_REPOSITORY);
      vi.mocked(ctx.selection.refreshInstallation).mockImplementation(() => { enter(); return result; });
      const sync = new OverviewSync(ctx); sync.refresh(9, NOW); const refreshing = sync.alarm(NOW);
      await entered; sync.refresh(9, NOW + 1);
      const queued = ctx.store.checkFreshness().repositories[12]?.latestAttempt;
      reject(new Error("superseded refresh failed")); await refreshing;
      expect(queued?.result).toBe("queued");
      expect(ctx.store.checkFreshness().repositories[12]?.latestAttempt).toEqual(queued);
    });
  });
});
