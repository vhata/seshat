import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_REPOSITORY, fixturePr, SYNC_FIXTURES } from "../shared/overview/fixtures";
import { reduceDelivery } from "../shared/overview/webhook-marks";
import type { StoredInstallation } from "../shared/installations";
import { OverviewStore } from "./overview-store";
import { OverviewSync } from "./overview-sync";
import type { RepositorySelection } from "./repository-selection";

const NOW = Date.now() + 3_600_000;
const WHEN = new Date(NOW).toISOString();
const owner = { databaseId: 1001, login: "example", __typename: "User" };
const tail = (at: string | null = null) => ({ nodes: at ? [{ createdAt: at }] : [] });
const connection = (nodes: unknown[]) => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } });
const repository = { id: "R_example", databaseId: 12, nameWithOwner: "example/observatory", visibility: "PUBLIC", owner };
const INSTALLATIONS: StoredInstallation[] = [{ id: 9, accountId: 1001, accountType: "User", status: "accepted", repositorySelection: "all" }];
function pr(overrides: Record<string, unknown> = {}) {
  return { id: "PR_example", databaseId: 3, number: 1, state: "OPEN", title: "Updated through GitHub", url: "https://github.com/example/observatory/pull/1", repository,
    createdAt: WHEN, updatedAt: WHEN, isDraft: false, headRefOid: "head", mergeable: "MERGEABLE", author: owner, reviews: connection([]), commits: { totalCount: 1 },
    comments: tail(), forcePush: tail(), stateChange: tail(), statusCheckRollup: { contexts: connection([]) }, ...overrides };
}
function github(current: () => Record<string, unknown>, options: { count?: () => number; failure?: () => boolean; remaining?: number; limit?: number } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (options.failure?.()) return new Response(null, { status: 503 });
    if (String(url).endsWith("/graphql")) {
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { ids: string[] } };
      const nodes = query.includes("SeshatPrCounts") ? [{ ...repository, pullRequests: { totalCount: options.count?.() ?? 1 } }]
        : query.includes("SeshatRepositoryPrs") ? [{ ...repository, pullRequests: connection([current()]) }]
        : variables.ids.map(() => current());
      return Response.json({ data: { nodes, rateLimit: { cost: 1, remaining: options.remaining ?? 4900, limit: options.limit ?? 5000, resetAt: new Date(NOW + 3_600_000).toISOString() } } });
    }
    if (String(url).includes("/commits?")) return Response.json([{ sha: String(current().headRefOid), commit: { committer: { date: WHEN } } }]);
    if (String(url).endsWith("/pulls/1")) return Response.json({ mergeable: current().mergeable === "UNKNOWN" ? null : true, head: { sha: current().headRefOid } });
    throw new Error(`Unexpected ${String(url)}`);
  });
}
function selection() {
  return { tokens: { get: vi.fn(async () => ({ ok: true, token: "memory-only-token", expiresAt: NOW + 7_200_000 })) },
    refreshInstallation: vi.fn(async () => ({ ok: true, changed: false, repositoryIds: [12], requestsUsed: 2 })) } as unknown as RepositorySelection;
}
function delivery(action = "synchronize", changes: Record<string, unknown> = {}) {
  return reduceDelivery("pull_request", { installation: { id: 9 }, repository: { id: 12, owner: { id: 1001 }, visibility: "public" }, action,
    pull_request: { node_id: "PR_example", head: { sha: "head" }, updated_at: WHEN, ...changes } }, NOW)!;
}
async function object(name: string) {
  const stub = env.INSTANCE.getByName(`sync-${name}`); await stub.health(); return stub;
}

describe("durable overview reconciliation", () => {
  it("persists coalesced facts, answers without GitHub, and rereads while no page is visible", async () => {
    const calls = github(() => pr());
    const stub = await object("dormant-reread");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      const published: number[] = [];
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => false, guard: async () => true, publish: async (now) => { published.push(now); } });
      await sync.receive(delivery(), NOW); await sync.receive(delivery(), NOW);
      expect(calls).not.toHaveBeenCalled();
      expect(await state.storage.getAlarm()).toBe(NOW + 2000);
      await sync.alarm(NOW + 2000);
      expect(store.pullRequests()).toHaveLength(1);
      expect(store.pullRequests()[0]?.title).toBe("Updated through GitHub");
      expect(store.syncStatus().lastSuccessfulSweepAt).toBeNull();
      expect(JSON.stringify(state.storage.sql.exec("SELECT * FROM settings").toArray())).not.toContain("memory-only-token");
      expect(published.length).toBeGreaterThan(0);
    });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("survives restart, retries unseen facts at 5/15/30 seconds, and leaves them to sweeps afterwards", async () => {
    const calls = github(() => pr({ headRefOid: "old" }));
    const stub = await object("restart-facts");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      const context = { storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => false, guard: async () => true, publish: async () => {} };
      await new OverviewSync(context).receive(delivery(), NOW);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => false, guard: async () => true, publish: async () => {} });
      for (const at of [NOW + 2000, NOW + 7000, NOW + 17000, NOW + 32000]) await sync.alarm(at);
      const saved = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key='overview-sync-work-v1'").toArray()[0]!.value);
      expect(saved.marks).toEqual([]);
      expect(store.pullRequests()[0]?.headSha).toBe("old");
    });
    expect(calls).toHaveBeenCalledTimes(5); // First head date, then immutable cache.
  });

  it("holds an unmatched SHA until a new head is read, then schedules a second read", async () => {
    const stub = await object("sha-race"); github(() => pr());
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY); store.putPullRequest(fixturePr({ headSha: "old" }));
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => false, guard: async () => true, publish: async () => {} });
      await sync.receive(reduceDelivery("status", { installation: { id: 9 }, repository: { id: 12, visibility: "public" }, sha: "head", context: "CI", state: "success" }, NOW)!, NOW);
      await sync.receive(delivery(), NOW);
      await sync.alarm(NOW + 2000);
      const saved = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key='overview-sync-work-v1'").toArray()[0]!.value);
      expect(saved.shas).toEqual([]);
      expect(saved.marks[0].facts).toMatchObject([{ kind: "status", state: "success" }]);
      expect(saved.marks[0].due).toBeLessThanOrEqual(NOW + 7000);
    });
  });

  it("runs immediate visible catchup and timed sweeps, records start time, and never polls while hidden", async () => {
    let count = 1; const calls = github(() => pr(), { count: () => count });
    const stub = await object("visibility-sweep");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      let visible = true;
      const discovery = selection();
      const sync = new OverviewSync({ storage: state.storage, store, selection: discovery, installations: () => INSTALLATIONS, visible: () => visible, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, false);
      for (let i = 0; i < 4; i++) await sync.alarm(NOW + i);
      expect(store.syncStatus().lastSuccessfulSweepAt).toBe(NOW);
      expect(store.pullRequests()).toHaveLength(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
      const before = calls.mock.calls.length;
      visible = false; await sync.visibility(NOW + 1000, false); await sync.alarm(NOW + 120_000);
      expect(calls.mock.calls.length).toBe(before);
      visible = true; count = 0; await sync.visibility(NOW + 360_000, false);
      for (let i = 0; i < 4; i++) await sync.alarm(NOW + 360_000 + i);
      expect(store.pullRequests()).toEqual([]);
      expect(store.syncStatus().lastSuccessfulSweepAt).toBe(NOW + 360_000);
    });
  });

  it("keeps known PRs after errors, retries once after 15 seconds, and latches failure through recovery", async () => {
    let failing = true; github(() => pr(), { failure: () => failing });
    const stub = await object("failure-retry");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY); store.putPullRequest(fixturePr()); store.putSyncStatus(SYNC_FIXTURES.live);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => true, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, true);
      await sync.alarm(NOW); await sync.alarm(NOW + 1);
      expect(store.syncStatus().latestAttempt?.result).toBe("running");
      await sync.alarm(NOW + 15_001); await sync.alarm(NOW + 15_002);
      expect(store.syncStatus().latestAttempt).toMatchObject({ result: "failed", unreadableRepositoryIds: [12] });
      expect(store.pullRequests()).toHaveLength(1);
      failing = false;
      await sync.visibility(NOW + 60_000, true); await sync.alarm(NOW + 60_000);
      expect(store.syncStatus().latestAttempt?.result).toBe("failed");
      for (let i = 1; i < 4; i++) await sync.alarm(NOW + 60_000 + i);
      expect(store.syncStatus().latestAttempt?.result).toBe("success");
    });
  });

  it("slows below ten percent of the actual installation limit and resets after resetAt", async () => {
    github(() => pr(), { limit: 12_500, remaining: 1000 });
    const stub = await object("rate-limit");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => true, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, false); for (let i = 0; i < 4; i++) await sync.alarm(NOW + i);
      expect(store.syncStatus()).toMatchObject({ intervalMs: 240_000, slowedByRateLimit: true });
      // A new sweep after reset receives the new authoritative budget.
    });
  });

  it("drops unaccepted data but keeps a new installation guard and resumes discovery while dormant", async () => {
    const calls = github(() => pr());
    const stub = await object("new-installation");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage);
      let installations: StoredInstallation[] = [];
      const guard = vi.fn(async () => { installations = INSTALLATIONS; store.putRepository(FIXTURE_REPOSITORY); return true; });
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => installations, visible: () => false, guard, publish: async () => {} });
      expect(await sync.receive(delivery(), NOW)).toBe(false);
      expect(await sync.receive(reduceDelivery("installation", { installation: { id: 9 }, action: "created" }, NOW)!, NOW)).toBe(false);
      expect(calls).not.toHaveBeenCalled();
      await sync.alarm(NOW); expect(guard).toHaveBeenCalledOnce();
      await sync.alarm(NOW + 1); await sync.alarm(NOW + 2);
      expect(store.pullRequests()).toHaveLength(1);
      expect(store.syncStatus().lastSuccessfulSweepAt).toBeNull();
    });
  });
});
