import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIXTURE_REPOSITORY, fixturePr } from "../shared/overview/fixtures";
import { OverviewStore } from "./overview-store";

describe("durable scoped check evidence", () => {
  it("starts unknown despite recent metadata and persists independent unchanged successes", async () => {
    const stub = env.INSTANCE.getByName("scoped-check-persistence");
    await stub.health();
    await runInDurableObject(stub, (_instance, state) => {
      const store = new OverviewStore(state.storage);
      store.putRepository(FIXTURE_REPOSITORY);
      store.putPullRequest(fixturePr());
      expect(store.checkFreshness().repositories["12"]?.lastSuccessfulCheckAt).toBeNull();
      const repo = store.beginCheck("repository", "12", 10, "running");
      store.finishCheck("repository", "12", repo, "success");
      const pr = store.beginCheck("pr", "PR_example", 20);
      store.runCheck("pr", "PR_example", pr);
      store.recordCheckSuccess("pr", "PR_example", pr);
      expect(store.checkFreshness().pullRequests.PR_example).toMatchObject({
        lastSuccessfulCheckAt: 20, latestAttempt: { result: "running" },
      });
      store.finishCheck("pr", "PR_example", pr, "success");
      // Facts did not change; a real new read still supplies newer evidence.
      expect(store.putPullRequest(fixturePr())).toBe(false);
      const unchanged = store.beginCheck("pr", "PR_example", 30, "running");
      store.finishCheck("pr", "PR_example", unchanged, "success");
    });
    await evictDurableObject(stub);
    const snapshot = await stub.overviewSnapshot(100);
    expect(snapshot.freshness?.repositories["12"]?.lastSuccessfulCheckAt).toBe(10);
    expect(snapshot.freshness?.pullRequests.PR_example?.lastSuccessfulCheckAt).toBe(30);
  });

  it("rejects delayed completions and replays while retaining success through failures", async () => {
    const stub = env.INSTANCE.getByName("scoped-check-ordering");
    await stub.health();
    await runInDurableObject(stub, (_instance, state) => {
      const store = new OverviewStore(state.storage);
      store.putRepository(FIXTURE_REPOSITORY);
      const older = store.beginCheck("repository", "12", 10, "running");
      const newer = store.beginCheck("repository", "12", 20, "running");
      store.finishCheck("repository", "12", newer, "success");
      store.finishCheck("repository", "12", older, "success");
      store.finishCheck("repository", "12", newer, "failed", "github-unavailable");
      store.runCheck("repository", "12", newer);
      const delayedStart = store.beginCheck("repository", "12", 15, "running");
      store.finishCheck("repository", "12", delayedStart, "success");
      expect(store.checkFreshness().repositories["12"]).toMatchObject({
        lastSuccessfulCheckAt: 20, latestAttempt: { id: newer.id, result: "success" },
      });
      const retry = store.beginCheck("repository", "12", 30);
      store.finishCheck("repository", "12", retry, "failed", "rate-limited");
      expect(store.checkFreshness().repositories["12"]).toMatchObject({
        lastSuccessfulCheckAt: 20, latestAttempt: { result: "failed", reason: "rate-limited" },
      });
    });
  });

  it("does not inherit evidence after unmonitoring, removal or ownership transfer", async () => {
    const stub = env.INSTANCE.getByName("scoped-check-identity");
    await stub.health();
    await runInDurableObject(stub, (_instance, state) => {
      const store = new OverviewStore(state.storage);
      store.putRepository(FIXTURE_REPOSITORY); store.putPullRequest(fixturePr());
      const repo = store.beginCheck("repository", "12", 10, "running");
      const pr = store.beginCheck("pr", "PR_example", 10, "running");
      store.finishCheck("repository", "12", repo, "success");
      store.finishCheck("pr", "PR_example", pr, "success");
      store.putRepository({ ...FIXTURE_REPOSITORY, ownerAccountId: 2002 });
      expect(store.checkFreshness().repositories["12"]?.lastSuccessfulCheckAt).toBeNull();
      expect(store.pullRequests()).toEqual([]);
      store.putRepository({ ...FIXTURE_REPOSITORY, monitored: false });
      expect(store.checkFreshness()).toEqual({ repositories: {}, pullRequests: {} });
      store.removeRepository(12); store.putRepository(FIXTURE_REPOSITORY);
      store.finishCheck("repository", "12", repo, "success");
      expect(store.checkFreshness().repositories["12"]?.lastSuccessfulCheckAt).toBeNull();
      expect(store.beginCheck("repository", "12", 20).id).toBeGreaterThan(pr.id);
    });
  });
});
