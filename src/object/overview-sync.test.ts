import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSnapshot } from "../shared/overview/protocol";
import { FIXTURE_REPOSITORY, fixturePr, SYNC_FIXTURES } from "../shared/overview/fixtures";
import { reduceDelivery } from "../shared/overview/webhook-marks";
import type { StoredInstallation } from "../shared/installations";
import { GithubPrReader } from "../worker/github-pr-reader";
import { RepositorySelection as ActualSelection } from "./repository-selection";
import { RepositoryDiscoveryStore } from "./repository-discovery-store";
import { readConfig } from "../shared/config";
import { OverviewStore } from "./overview-store";
import { OverviewSync } from "./overview-sync";
import type { RepositorySelection } from "./repository-selection";

afterEach(() => { vi.restoreAllMocks(); });

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
function github(current: () => Record<string, unknown>, options: { count?: () => number; failure?: () => boolean; remaining?: number; limit?: number; resetAt?: number; permission?: () => Response } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (options.failure?.()) return new Response(null, { status: 503 });
    if (String(url).endsWith("/graphql")) {
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { ids: string[] } };
      const nodes = query.includes("SeshatPrCounts") ? [{ ...repository, pullRequests: { totalCount: options.count?.() ?? 1 } }]
        : query.includes("SeshatRepositoryPrs") ? [{ ...repository, pullRequests: connection([current()]) }]
        : variables.ids.map(() => current());
      return Response.json({ data: { nodes, rateLimit: { cost: 1, remaining: options.remaining ?? 4900, limit: options.limit ?? 5000, resetAt: new Date(options.resetAt ?? NOW + 3_600_000).toISOString() } } });
    }
    if (String(url).includes("/collaborators/") && options.permission) return options.permission();
    if (String(url).includes("/commits?")) return Response.json([{ sha: String(current().headRefOid), commit: { committer: { date: WHEN } } }]);
    if (String(url).endsWith("/pulls/1")) return Response.json({ mergeable: current().mergeable === "UNKNOWN" ? null : true, head: { sha: current().headRefOid } });
    throw new Error(`Unexpected ${String(url)}`);
  });
}
function selection() {
  return { tokens: { get: vi.fn(async () => ({ ok: true, token: "memory-only-token", expiresAt: NOW + 7_200_000 })) },
    refreshInstallation: vi.fn(async () => ({ ok: true, changed: false, repositoryIds: [12], requestsUsed: 2 })), discardRefreshProgress: vi.fn() } as unknown as RepositorySelection;
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
    github(() => pr(), { limit: 12_500, remaining: 1000, resetAt: NOW + 60_000 });
    const stub = await object("rate-limit");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => true, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, false); for (let i = 0; i < 4; i++) await sync.alarm(NOW + i);
      expect(store.syncStatus()).toMatchObject({ intervalMs: 240_000, slowedByRateLimit: true });
      await sync.rearm(NOW + 60_001);
      expect(store.syncStatus()).toMatchObject({ intervalMs: 120_000, slowedByRateLimit: false });
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

  it("derives exactly one stale row from GitHub activity", async () => {
    const old = new Date(NOW - 10 * 86_400_000).toISOString();
    github(() => pr({ createdAt: old, comments: tail(old), stateChange: tail(old) }));
    const stub = await object("activity-and-partial");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => false, guard: async () => true, publish: async () => {} });
      await sync.receive(delivery("edited"), NOW); await sync.alarm(NOW + 2000);
      const snapshot = buildSnapshot(store.repositories(), store.pullRequests(), store.syncStatus(), 1001, NOW + 20 * 86_400_000);
      const rows = snapshot.buckets.flatMap((bucket) => bucket.rows);
      expect(rows).toHaveLength(1); expect(rows[0]?.stale).toBe(true);
      expect(rows[0]?.lastActivityAt).toBe(NOW); // GitHub head committer date.
    });
  });

  it("resumes a large sweep after eviction with at most 41 network calls per phase and no cached tokens", async () => {
    const many = Array.from({ length: 22 }, (_, index) => pr({ id: `P${index + 1}`, databaseId: index + 1, number: index + 1, headRefOid: `head${index + 1}` }));
    const calls = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const address = String(url);
      if (address.endsWith("/graphql")) {
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        const data = query.includes("SeshatPrCounts") ? { nodes: [{ ...repository, pullRequests: { totalCount: many.length } }] }
          : query.includes("SeshatPrPage") ? { node: { ...repository, pullRequests: { ...connection(many.slice(20)), totalCount: 22 } } }
          : { nodes: [{ ...repository, pullRequests: { nodes: many.slice(0, 20), totalCount: 22, pageInfo: { hasNextPage: true, endCursor: "after20" } } }] };
        return Response.json({ data: { ...data, rateLimit: { cost: 20, limit: 5000, remaining: 4800, resetAt: new Date(NOW + 3_600_000).toISOString() } } });
      }
      const number = address.match(/\/pulls\/(\d+)/)?.[1];
      if (address.includes("/commits?")) return Response.json([{ sha: `head${number}`, commit: { committer: { date: WHEN } } }]);
      if (/\/pulls\/\d+$/.test(address)) return Response.json({ mergeable: true, head: { sha: `head${number}` } });
      throw new Error(address);
    });
    const stub = await object("large-continuation");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => true, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, false); await sync.alarm(NOW); await sync.alarm(NOW + 1);
      const before = calls.mock.calls.length; await sync.alarm(NOW + 2);
      expect(calls.mock.calls.length - before).toBeLessThanOrEqual(40);
      expect(store.syncStatus().lastSuccessfulSweepAt).toBeNull();
      const saved = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key='overview-sync-work-v1'").toArray()[0]!.value);
      expect(saved.sweep.continuation).not.toBeNull();
      expect(JSON.stringify(saved)).not.toContain("memory-only-token");
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => true, guard: async () => true, publish: async () => {} });
      for (let index = 3; index < 6; index++) {
        const before = calls.mock.calls.length; await sync.alarm(NOW + index);
        expect(calls.mock.calls.length - before).toBeLessThanOrEqual(40);
      }
      expect(store.pullRequests()).toHaveLength(22);
      expect(store.syncStatus().lastSuccessfulSweepAt).toBe(NOW);
    });
    const graphQueries = calls.mock.calls.filter(([url]) => String(url).endsWith("/graphql"));
    expect(graphQueries).toHaveLength(3); // Count, PR page and final PR page; no replayed HTTP.
  }, 20_000);

  it("discards a partial sweep when hidden and starts a fresh read when visible again", async () => {
    const calls = github(() => pr()); const stub = await object("pause-no-stale-cache");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY); let visible = true;
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => visible, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, false); await sync.alarm(NOW);
      visible = false; await sync.visibility(NOW + 1, false); await sync.alarm(NOW + 120_000);
      expect(calls).not.toHaveBeenCalled();
      visible = true; await sync.visibility(NOW + 3_600_000, false);
      for (let index = 0; index < 4; index++) await sync.alarm(NOW + 3_600_000 + index);
      expect(store.syncStatus().lastSuccessfulSweepAt).toBe(NOW + 3_600_000);
    });
  });

  it("records visibility for every delivery and withdraws transferred/deleted rows immediately", async () => {
    const stub = await object("repository-withdrawal");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY); store.putPullRequest(fixturePr());
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => false, guard: async () => true, publish: async () => {} });
      await sync.receive(reduceDelivery("repository", { installation: { id: 9 }, action: "privatized", repository: { id: 12 } }, NOW)!, NOW);
      expect(store.repositories()[0]).toMatchObject({ visibility: "private", listedAt: FIXTURE_REPOSITORY.listedAt, visibilityReportedAt: NOW });
      await sync.receive(delivery("edited"), NOW + 1);
      expect(store.repositories()[0]?.listedAt).toBe(FIXTURE_REPOSITORY.listedAt);
      await sync.receive(reduceDelivery("repository", { installation: { id: 9 }, action: "transferred", repository: { id: 12, visibility: "public", owner: { id: 4 } } }, NOW + 1)!, NOW + 1);
      expect(store.pullRequests()).toEqual([]); expect(store.repositories()[0]).toMatchObject({ monitored: false, monitorOverride: null, ownerAccountId: 4 });
      await sync.receive(reduceDelivery("repository", { installation: { id: 9 }, action: "deleted", repository: { id: 12 } }, NOW + 2)!, NOW + 2);
      expect(store.repositories()).toEqual([]);
    });
  });

  it("advances overdue sweep phases during a continuous stream of newly due PR marks", async () => {
    github(() => pr()); const stub = await object("due-fairness");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => true, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, false);
      // A newly received event is due at each invocation. The older sweep
      // deadline must still advance instead of giving marks fixed priority.
      for (let index = 0; index < 10; index++) {
        const at = NOW + index * 3000;
        await sync.receive(delivery("edited"), at - 2000);
        await sync.alarm(at);
      }
      expect(store.syncStatus().lastSuccessfulSweepAt).toBeGreaterThanOrEqual(NOW);
      expect(store.syncStatus().lastSuccessfulSweepAt).toBeLessThanOrEqual(NOW + 3000);
      expect(store.syncStatus().latestAttempt?.result).toBe("success");
    });
  });

  it("stops pagination when a page hides during a read and never commits the abandoned sweep", async () => {
    let visible = true; let hideDuringQuery = false;
    const calls = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (!String(url).endsWith("/graphql")) throw new Error("A cancelled sweep started another REST request");
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (hideDuringQuery) visible = false;
      return Response.json({ data: { nodes: query.includes("SeshatPrCounts") ? [{ ...repository, pullRequests: { totalCount: 1 } }] : [{ ...repository, pullRequests: connection([pr()]) }],
        rateLimit: { cost: 1, limit: 5000, remaining: 4900, resetAt: new Date(NOW + 3_600_000).toISOString() } } });
    });
    const stub = await object("hide-during-read");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY); store.putPullRequest(fixturePr());
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => visible, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, false); await sync.alarm(NOW); await sync.alarm(NOW + 1);
      hideDuringQuery = true; await sync.alarm(NOW + 2);
      expect(calls).toHaveBeenCalledTimes(2); // Count and initial PR query only.
      expect(store.pullRequests()[0]?.title).toBe("Keep the overview current");
      expect(store.syncStatus().lastSuccessfulSweepAt).toBeNull();
      const saved = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key='overview-sync-work-v1'").toArray()[0]!.value);
      expect(saved.sweep).toBeNull(); expect(saved.nextSweep).toBeNull();
    });
  });

  it("retains absent known rows on partial PR reads and names the repository after both attempts fail", async () => {
    github(() => pr());
    vi.spyOn(GithubPrReader.prototype, "readRepositories").mockResolvedValue({ status: "partial", requestsUsed: 1, issues: [{ nodeId: "P_bad", reason: "malformed" }], rateLimit: null, permissionCache: [], headCommitDates: [], continuation: null,
      repositories: [{ repositoryId: 12, nodeId: "R_example", visibility: "private", complete: false, prs: [fixturePr({ title: "Partly updated" })] }] });
    const stub = await object("partial-keeps-known");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY); store.putPullRequest(fixturePr()); store.putPullRequest(fixturePr({ id: 4, nodeId: "PR_legacy", number: 2 }));
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => true, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, false); for (let i = 0; i < 3; i++) await sync.alarm(NOW + i);
      expect(store.pullRequests()).toHaveLength(2);
      expect(store.pullRequests().find((pr) => pr.nodeId === "PR_example")?.title).toBe("Partly updated");
      for (let i = 0; i < 3; i++) await sync.alarm(NOW + 15_002 + i);
      expect(store.pullRequests()).toHaveLength(2);
      expect(store.syncStatus().latestAttempt).toMatchObject({ result: "failed", unreadableRepositoryIds: [12] });
    });
  });

  it("discards exhausted discovery pages between alarms so returning visibility reads fresh repository facts", async () => {
    let archived = false; let lists = 0;
    const org = [{ ...INSTALLATIONS[0]!, accountType: "Organization" as const, accountId: 3003 }];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const address = String(url);
      if (address.endsWith("/access_tokens")) return Response.json({ token: "secret", expires_at: new Date(NOW + 7_200_000).toISOString() }, { status: 201 });
      if (address.includes("/installation/repositories?")) {
        lists++;
        return Response.json({ total_count: 30, repositories: Array.from({ length: 30 }, (_, index) => ({ id: index + 1, node_id: `R${index + 1}`, full_name: `org/repo${index + 1}`, owner: { id: 3003, login: "org" }, visibility: "public", fork: false, archived: index === 0 && archived })) });
      }
      if (address.endsWith("/user/1001")) return Response.json({ id: 1001, login: "example" });
      if (address.includes("/collaborators/")) return Response.json({ permission: "read", user: { id: 1001 } });
      throw new Error(address);
    });
    const stub = await object("discard-discovery");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); const discovery = new RepositoryDiscoveryStore(state.storage); let visible = true;
      const actual = new ActualSelection({ ownerId: 1001, app: readConfig(env as unknown as Record<string, unknown>).app!, store, discovery, installations: () => org, publish: async () => {} });
      const sync = new OverviewSync({ storage: state.storage, store, selection: actual, installations: () => org, visible: () => visible, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, false); await sync.alarm(NOW);
      expect(discovery.get(9).progress).not.toBeNull(); expect(lists).toBe(1);
      visible = false; await sync.visibility(NOW + 1, false); expect(discovery.get(9).progress).toBeNull();
      archived = true; visible = true; await sync.visibility(NOW + 120_000, false); await sync.alarm(NOW + 120_000);
      expect(lists).toBe(2); expect(discovery.get(9).progress?.repositories[0]?.isArchived).toBe(true);
      // A newer delivery between continuation alarms also invalidates pages.
      archived = false; sync.refresh(9, NOW + 120_001);
      expect(discovery.get(9).progress).toBeNull();
      await sync.alarm(NOW + 120_001);
      expect(lists).toBe(3); expect(discovery.get(9).progress?.repositories[0]?.isArchived).toBe(false);
    });
  });

  it("keeps a new repository delivery that arrives while discovery is in flight", async () => {
    const stub = await object("refresh-generation");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      const selected = selection(); let sync: OverviewSync; let rounds = 0;
      vi.spyOn(selected, "refreshInstallation").mockImplementation(async (_id, _now, _budget, shouldContinue) => {
        rounds++;
        if (rounds === 1) { sync.refresh(9, NOW + 1); expect(shouldContinue?.()).toBe(false); return { ok: false, reason: "continuation", requestsUsed: 2 }; }
        return { ok: true, changed: false, repositoryIds: [], requestsUsed: 2 };
      });
      sync = new OverviewSync({ storage: state.storage, store, selection: selected, installations: () => INSTALLATIONS, visible: () => false, guard: async () => true, publish: async () => {} });
      sync.refresh(9, NOW); await sync.alarm(NOW); await sync.alarm(NOW + 1);
      expect(rounds).toBe(2); expect(selected.discardRefreshProgress).toHaveBeenCalledWith(9);
    });
  });

  it("never replenishes a rate budget from a continuation that predates an event read", async () => {
    github(() => pr()); const stub = await object("rate-continuation-race");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY); let sync: OverviewSync; let reads = 0;
      const rate = (remaining: number) => ({ cost: 1, limit: 5000, remaining, resetAt: NOW + 3_600_000 });
      const meta = { issues: [], requestsUsed: 1, permissionCache: [], headCommitDates: [] };
      vi.spyOn(GithubPrReader.prototype, "readRepositories").mockImplementation(async () => {
        reads++;
        if (reads === 1) {
          await sync.receive(delivery("edited"), NOW - 3000);
          return { ...meta, status: "partial", rateLimit: rate(600), repositories: [], continuation: { version: 1, responses: [], permissionCache: [], headCommitDates: [], refreshedPermissionKeys: [], rateLimit: rate(600) } };
        }
        return { ...meta, status: "complete", rateLimit: rate(600), continuation: null, repositories: [{ repositoryId: 12, nodeId: "R_example", visibility: "public", complete: true, prs: [fixturePr()] }] };
      });
      vi.spyOn(GithubPrReader.prototype, "rereadPrs").mockResolvedValue({ ...meta, status: "complete", rateLimit: rate(450), continuation: null, nodes: [{ kind: "open", pr: fixturePr(), visibility: "public" }] });
      sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => true, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, false); for (let index = 0; index < 6; index++) await sync.alarm(NOW + index);
      expect(store.syncStatus()).toMatchObject({ intervalMs: 240_000, slowedByRateLimit: true, lastSuccessfulSweepAt: NOW });
      const saved = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key='overview-sync-work-v1'").toArray()[0]!.value);
      expect(saved.rates[0].rate.remaining).toBe(450);
    });
  });

  it("retries a new reviewer's incomplete permission read before clearing its observed review mark", async () => {
    let failing = true;
    const review = { id: "REV1", databaseId: 44, state: "APPROVED", submittedAt: WHEN, commit: { oid: "head" }, author: { databaseId: 2002, login: "reviewer", __typename: "User" }, comments: tail() };
    github(() => pr({ reviews: connection([review]) }), { permission: () => failing ? new Response(null, { status: 503 }) : Response.json({ permission: "write", user: { id: 2002 } }) });
    const stub = await object("retry-new-reviewer");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY); store.putPullRequest(fixturePr());
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => false, guard: async () => true, publish: async () => {} });
      const event = reduceDelivery("pull_request_review", { installation: { id: 9 }, repository: { id: 12, visibility: "public", owner: { id: 1001 } }, action: "submitted", pull_request: { node_id: "PR_example", updated_at: WHEN }, review: { id: 44, state: "approved", submitted_at: WHEN } }, NOW)!;
      await sync.receive(event, NOW); await sync.alarm(NOW + 2000);
      const saved = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key='overview-sync-work-v1'").toArray()[0]!.value);
      expect(saved.marks).toHaveLength(1); expect(saved.marks[0].due).toBe(NOW + 7000);
      failing = false; await sync.alarm(NOW + 7000);
      expect(store.pullRequests()[0]?.reviewerPermissions.get(2002)).toBe("write");
      const snapshot = buildSnapshot(store.repositories(), store.pullRequests(), store.syncStatus(), 1001, NOW + 7000);
      expect(snapshot.buckets.flatMap((bucket) => bucket.rows)[0]?.facts.reviewState).toBe("approved");
      expect(store.syncStatus().lastSuccessfulSweepAt).toBeNull();
    });
  });

  it("exhausts token failures through the bounded event retry schedule while dormant", async () => {
    const stub = await object("bounded-token-failure");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      const selected = selection(); const get = vi.spyOn(selected.tokens, "get").mockResolvedValue({ ok: false, reason: "installation-removed" });
      const sync = new OverviewSync({ storage: state.storage, store, selection: selected, installations: () => INSTALLATIONS, visible: () => false, guard: async () => true, publish: async () => {} });
      await sync.receive(delivery(), NOW);
      for (const at of [NOW + 2000, NOW + 7000, NOW + 17000, NOW + 32000]) await sync.alarm(at);
      expect(get).toHaveBeenCalledTimes(4);
      const saved = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key='overview-sync-work-v1'").toArray()[0]!.value);
      expect(saved.marks).toEqual([]); expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("forgets a failed logical listing before later catch-up confirms changed repository facts", async () => {
    let archived = false; let failing = true; let lists = 0;
    const org = [{ ...INSTALLATIONS[0]!, accountType: "Organization" as const, accountId: 3003 }];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const address = String(url);
      if (address.endsWith("/access_tokens")) return Response.json({ token: "secret", expires_at: new Date(NOW + 7_200_000).toISOString() }, { status: 201 });
      if (address.includes("/installation/repositories?")) { lists++; return Response.json({ total_count: 1, repositories: [{ id: 1, node_id: "R1", full_name: "org/repository", owner: { id: 3003, login: "org" }, visibility: "public", fork: false, archived }] }); }
      if (address.endsWith("/user/1001")) return Response.json({ id: 1001, login: "example" });
      if (address.includes("/collaborators/")) return failing ? new Response(null, { status: 503 }) : Response.json({ permission: "read", user: { id: 1001 } });
      throw new Error(address);
    });
    const stub = await object("failed-listing-fresh-round");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); const discovery = new RepositoryDiscoveryStore(state.storage); let visible = true;
      const actual = new ActualSelection({ ownerId: 1001, app: readConfig(env as unknown as Record<string, unknown>).app!, store, discovery, installations: () => org, publish: async () => {} });
      const sync = new OverviewSync({ storage: state.storage, store, selection: actual, installations: () => org, visible: () => visible, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, false); await sync.alarm(NOW);
      expect(discovery.get(9).progress).not.toBeNull();
      await sync.alarm(NOW + 15_000); expect(store.syncStatus().latestAttempt?.result).toBe("failed");
      expect(discovery.get(9).progress).toBeNull();
      visible = false; await sync.visibility(NOW + 15_001, false);
      failing = false; archived = true; visible = true; await sync.visibility(NOW + 120_000, false);
      for (let i = 0; i < 4; i++) await sync.alarm(NOW + 120_000 + i);
      expect(lists).toBe(2); expect(store.repositories()[0]?.isArchived).toBe(true);
      expect(store.syncStatus().latestAttempt?.result).toBe("success");
    });
  });

});
