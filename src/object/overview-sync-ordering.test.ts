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
const WHEN = new Date(NOW).toISOString();
const INSTALLATIONS: StoredInstallation[] = [{ id: 9, accountId: 1001, accountType: "User", status: "accepted", repositorySelection: "all" }];
const owner = { databaseId: 1001, login: "example", __typename: "User" };
const repository = { id: "R_example", databaseId: 12, nameWithOwner: "example/observatory", visibility: "PUBLIC", owner };
const connection = (nodes: unknown[]) => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } });
function rawPr(number = 1, head = "old", state = "OPEN") {
  return { id: number === 1 ? "PR_example" : `PR_${number}`, databaseId: number + 2, number, state, title: head,
    url: `https://github.com/example/observatory/pull/${number}`, repository, createdAt: WHEN, updatedAt: WHEN,
    isDraft: false, headRefOid: head, mergeable: "MERGEABLE", author: owner, reviews: connection([]), commits: { totalCount: 1 },
    comments: { nodes: [] }, forcePush: { nodes: [] }, stateChange: { nodes: [] }, statusCheckRollup: { contexts: connection([]) } };
}
function selection() {
  return { tokens: { get: vi.fn(async () => ({ ok: true, token: "memory-only-token", expiresAt: NOW + 7_200_000 })) },
    refreshInstallation: vi.fn(async () => ({ ok: true, changed: false, repositoryIds: [12], requestsUsed: 2 })),
    discardRefreshProgress: vi.fn() } as unknown as RepositorySelection;
}
function event(at: number, action = "synchronize", installationId = 9, repositoryId = 12, nodeId = "PR_example") {
  return reduceDelivery("pull_request", { installation: { id: installationId }, repository: { id: repositoryId, owner: { id: 1001 }, visibility: "public" },
    action, pull_request: { node_id: nodeId, head: { sha: "new" }, updated_at: WHEN } }, at)!;
}
const meta: ReadMeta = { status: "complete", requestsUsed: 1, issues: [], rateLimit: null, permissionCache: [], headCommitDates: [], continuation: null };
const continuation: ReaderContinuation = { version: 1, responses: [], permissionCache: [], headCommitDates: [], refreshedPermissionKeys: [], rateLimit: null };
const fresh = () => fixturePr({ title: "new", headSha: "new", updatedAt: NOW });
const repoRead = (prs = [fresh()]) => ({ ...meta, repositories: [{ repositoryId: 12, nodeId: "R_example", visibility: "public" as const, complete: true, prs }] });
function saved(storage: DurableObjectStorage) {
  return JSON.parse(storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key='overview-sync-work-v1'").toArray()[0]!.value) as { reread: unknown; sweep: { continuation: unknown } | null };
}
async function object(name: string) { const stub = env.INSTANCE.getByName(`ordering-${name}`); await stub.health(); return stub; }

describe("overview sync observation ordering", () => {
  it("refetches a continued repository reread after a PR event invalidates its cached empty membership", async () => {
    let newer = false;
    let queries = 0;
    const other = { ...repository, id: "R_other", databaseId: 13 };
    const original = GithubPrReader.prototype.readRepositories;
    vi.spyOn(GithubPrReader.prototype, "readRepositories").mockImplementation(function (this: GithubPrReader, ids) {
      Object.defineProperty(this, "requestLimit", { value: 2 });
      return original.call(this, ids);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const address = String(url);
      if (address.endsWith("/graphql")) {
        queries++;
        const { variables } = JSON.parse(String(init?.body)) as { variables: { ids: string[] } };
        return Response.json({ data: { nodes: variables.ids.map((id) => id === "R_example"
          ? { ...repository, pullRequests: connection(newer ? [rawPr(1, "new")] : []) }
          : { ...other, pullRequests: connection([2, 3].map((number) => ({ ...rawPr(number, `head-${number}`), repository: other }))) }),
        rateLimit: { cost: 1, remaining: 4900, limit: 5000, resetAt: new Date(NOW + 3_600_000).toISOString() } } });
      }
      const number = Number(address.match(/\/pulls\/(\d+)/)?.[1]);
      const head = number === 1 ? "new" : `head-${number}`;
      if (address.includes("/commits?")) return Response.json([{ sha: head, commit: { committer: { date: WHEN } } }]);
      if (/\/pulls\/\d+$/.test(address)) return Response.json({ mergeable: true, head: { sha: head } });
      throw new Error(address);
    });
    const stub = await object("repository-reread-membership");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      store.putRepository({ ...FIXTURE_REPOSITORY, id: 13, nodeId: "R_other" });
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => false, guard: async () => true, publish: async () => {} });
      sync.discoveryChanged(9, NOW); await sync.alarm(NOW);
      expect(saved(state.storage).reread).not.toBeNull();
      newer = true; await sync.receive(event(NOW + 1, "opened"), NOW + 1); await sync.alarm(NOW + 1);
      expect(queries).toBe(2);
      expect(store.pullRequests(12)[0]?.headSha).toBe("new");
    });
  });

  it("finishes both a continued sweep and a continued event read without invalidating each other forever", async () => {
    let newer = false;
    const repositoryRead = GithubPrReader.prototype.readRepositories;
    const reread = GithubPrReader.prototype.rereadPrs;
    // Lower the invocation budget so both real reader paths must persist
    // and replay progress with a small, readable GitHub response fixture.
    const sweeps = vi.spyOn(GithubPrReader.prototype, "readRepositories").mockImplementation(function (this: GithubPrReader, ids) {
      Object.defineProperty(this, "requestLimit", { value: 2 });
      return repositoryRead.call(this, ids);
    });
    const events = vi.spyOn(GithubPrReader.prototype, "rereadPrs").mockImplementation(function (this: GithubPrReader, ids) {
      Object.defineProperty(this, "requestLimit", { value: 2 });
      return reread.call(this, ids);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const address = String(url);
      if (address.endsWith("/graphql")) {
        const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { ids: string[] } };
        const rows = [1, 2, 3].map((number) => rawPr(number, newer ? `new-${number}` : `old-${number}`));
        const nodes = query.includes("SeshatPrCounts") ? [{ ...repository, pullRequests: { totalCount: 3 } }]
          : query.includes("SeshatRepositoryPrs") ? [{ ...repository, pullRequests: connection(rows) }]
          : variables.ids.map((id) => rows.find((pr) => pr.id === id));
        return Response.json({ data: { nodes, rateLimit: { cost: 1, remaining: 4900, limit: 5000, resetAt: new Date(NOW + 3_600_000).toISOString() } } });
      }
      const number = Number(address.match(/\/pulls\/(\d+)/)?.[1]);
      const head = newer ? `new-${number}` : `old-${number}`;
      if (address.includes("/commits?")) return Response.json([{ sha: head, commit: { committer: { date: WHEN } } }]);
      if (/\/pulls\/\d+$/.test(address)) return Response.json({ mergeable: true, head: { sha: head } });
      throw new Error(address);
    });
    const stub = await object("two-continuations");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => true, guard: async () => true, publish: async () => {} });
      for (const number of [2, 3]) await sync.receive(event(NOW, "edited", 9, 12, `PR_${number}`), NOW);
      await sync.visibility(NOW, false); await sync.alarm(NOW); await sync.alarm(NOW + 1); await sync.alarm(NOW + 1999);
      expect(saved(state.storage).sweep?.continuation).not.toBeNull();
      newer = true;
      await sync.alarm(NOW + 2000);
      expect(saved(state.storage).reread).not.toBeNull();
      for (let index = 1; index <= 16; index++) await sync.alarm(NOW + 2000 + index);
      expect(saved(state.storage).reread).toBeNull();
      expect(saved(state.storage).sweep).toBeNull();
      expect(store.syncStatus().latestAttempt?.result).toBe("success");
      expect(store.pullRequests().map((pr) => pr.headSha).sort()).toEqual(["new-1", "new-2", "new-3"]);
      expect(events.mock.calls.length).toBeGreaterThan(1);
      expect(sweeps.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it("drops a cached zero count after a newer event reopens the PR", async () => {
    let reopened = false;
    const repositories = Array.from({ length: 101 }, (_, index) => ({ ...FIXTURE_REPOSITORY, id: index + 12, nodeId: index === 0 ? "R_example" : `R_${index}` }));
    const original = GithubPrReader.prototype.countOpenPrs;
    let rounds = 0;
    vi.spyOn(GithubPrReader.prototype, "countOpenPrs").mockImplementation(function (this: GithubPrReader, ids) {
      if (++rounds === 1) Object.defineProperty(this, "requestLimit", { value: 1 });
      return original.call(this, ids);
    });
    vi.spyOn(GithubPrReader.prototype, "rereadPrs").mockResolvedValue({ ...meta, nodes: [{ kind: "open", visibility: "public", pr: fresh() }] });
    vi.spyOn(GithubPrReader.prototype, "readRepositories").mockImplementation(async (ids) => ids.includes("R_example") ? repoRead() : { ...meta, repositories: [] });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { variables } = JSON.parse(String(init?.body)) as { variables: { ids: string[] } };
      return Response.json({ data: { nodes: variables.ids.map((id) => {
        const repo = repositories.find((repo) => repo.nodeId === id)!;
        return { ...repository, id, databaseId: repo.id, pullRequests: { totalCount: reopened && id === "R_example" ? 1 : 0 } };
      }), rateLimit: { cost: 1, remaining: 4900, limit: 5000, resetAt: new Date(NOW + 3_600_000).toISOString() } } });
    });
    const stub = await object("zero-count-reopen");
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); for (const repo of repositories) store.putRepository(repo);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => true, guard: async () => true, publish: async () => {} });
      await sync.receive(event(NOW, "reopened"), NOW);
      await sync.visibility(NOW, false); await sync.alarm(NOW); await sync.alarm(NOW + 1999);
      expect(saved(state.storage).sweep?.continuation).not.toBeNull();
      reopened = true; await sync.alarm(NOW + 2000);
      expect(store.pullRequests()[0]?.headSha).toBe("new");
      await sync.alarm(NOW + 2001);
      expect(store.pullRequests()[0]?.headSha).toBe("new");
      for (let index = 2; index <= 6; index++) await sync.alarm(NOW + 2000 + index);
      expect(store.pullRequests()[0]?.headSha).toBe("new");
      expect(store.syncStatus().latestAttempt?.result).toBe("success");
      expect(rounds).toBe(2);
    });
  });

  it.each(["closed", "reopened", "queued-head"] as const)("restarts cached repository membership after a newer %s event read", async (change) => {
    let newer = false;
    let repositoryQueries = 0;
    const oldRows = Array.from({ length: 22 }, (_, index) => rawPr(index + (change === "reopened" ? 2 : 1), `old-${index + 1}`));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const address = String(url);
      if (address.endsWith("/graphql")) {
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        let nodes: unknown[];
        if (query.includes("SeshatPrCounts")) nodes = [{ ...repository, pullRequests: { totalCount: oldRows.length } }];
        else if (query.includes("SeshatRepositoryPrs")) {
          repositoryQueries++;
          const rows = !newer ? oldRows : change === "closed" ? oldRows.filter((pr) => pr.number !== 1)
            : change === "reopened" ? [rawPr(1, "new"), ...oldRows] : oldRows.map((pr) => pr.number === 1 ? rawPr(1, "new") : pr);
          nodes = [{ ...repository, pullRequests: connection(rows) }];
        } else nodes = [rawPr(1, "new", change === "closed" ? "CLOSED" : "OPEN")];
        return Response.json({ data: { nodes, rateLimit: { cost: 1, remaining: 4900, limit: 5000, resetAt: new Date(NOW + 3_600_000).toISOString() } } });
      }
      const number = Number(address.match(/\/pulls\/(\d+)/)?.[1]);
      const head = newer && number === 1 ? "new" : `old-${number - (change === "reopened" ? 1 : 0)}`;
      if (address.includes("/commits?")) return Response.json([{ sha: head, commit: { committer: { date: WHEN } } }]);
      if (/\/pulls\/\d+$/.test(address)) return Response.json({ mergeable: true, head: { sha: head } });
      throw new Error(address);
    });
    const stub = await object(`membership-${change}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      const discovery = selection();
      const sync = new OverviewSync({ storage: state.storage, store, selection: discovery, installations: () => INSTALLATIONS, visible: () => true, guard: async () => true, publish: async () => {} });
      // GitHub still serves old facts while the delivery is coalescing.
      // Applying the later event read must invalidate the continuation even
      // though no additional delivery arrives after the sweep starts.
      await sync.receive(event(NOW, change === "closed" ? "closed" : change === "reopened" ? "reopened" : "synchronize"), NOW);
      await sync.visibility(NOW, false);
      await sync.alarm(NOW); await sync.alarm(NOW + 1); await sync.alarm(NOW + 1999);
      expect(saved(state.storage).sweep?.continuation).not.toBeNull();
      newer = true;
      await sync.alarm(NOW + 2000);
      const current = () => store.pullRequests().find((pr) => pr.nodeId === "PR_example");
      if (change === "closed") expect(current()).toBeUndefined();
      else expect(current()?.headSha).toBe("new");
      for (let index = 1; index <= 8; index++) await sync.alarm(NOW + 2000 + index);
      expect(store.syncStatus().latestAttempt?.result).toBe("success");
      if (change === "closed") expect(current()).toBeUndefined();
      else expect(current()?.headSha).toBe("new");
      expect(repositoryQueries).toBe(2);
      expect(discovery.refreshInstallation).toHaveBeenCalledTimes(1);
    });
  });

  it("discards a removed installation's durable reread before selecting another installation's due work", async () => {
    const stub = await object("removed-installation");
    const other = { ...INSTALLATIONS[0]!, id: 20 };
    const read = vi.spyOn(GithubPrReader.prototype, "rereadPrs").mockResolvedValueOnce({ ...meta, status: "partial", continuation, nodes: [] })
      .mockResolvedValue({ ...meta, nodes: [{ kind: "open", visibility: "public", pr: fixturePr({ id: 30, nodeId: "PR_other", repositoryId: 21, headSha: "new" }) }] });
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      store.putRepository({ ...FIXTURE_REPOSITORY, id: 21, nodeId: "R_other", installationId: 20 });
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => [...INSTALLATIONS, other], visible: () => false, guard: async () => true, publish: async () => {} });
      await sync.receive(event(NOW), NOW); await sync.alarm(NOW + 2000);
      expect(saved(state.storage).reread).not.toBeNull();
      store.removeRepository(12);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => [other], visible: () => false, guard: async () => true, publish: async () => {} });
      await sync.receive(event(NOW + 3000, "synchronize", 20, 21, "PR_other"), NOW + 3000);
      await sync.alarm(NOW + 5000);
      expect(read).toHaveBeenLastCalledWith(["PR_other"]);
      expect(store.pullRequests()[0]?.nodeId).toBe("PR_other");
      expect(saved(state.storage).reread).toBeNull();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it.each([false, true])("rearms a visible sweep after restart with an empty orphan reread (legacy: %s)", async (legacy) => {
    const stub = await object(`orphan-rearm-${legacy}`);
    vi.spyOn(GithubPrReader.prototype, "rereadPrs").mockResolvedValue({ ...meta, status: "partial", continuation, nodes: [] });
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS, visible: () => false, guard: async () => true, publish: async () => {} });
      await sync.receive(event(NOW), NOW); await sync.alarm(NOW + 2000);
      const row = state.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key='overview-sync-work-v1'").toArray()[0]!;
      const progress = JSON.parse(row.value);
      progress.marks = [];
      if (legacy) { delete progress.reread.installationId; delete progress.reread.generation; delete progress.observationGenerations; }
      state.storage.sql.exec("UPDATE settings SET value=? WHERE key='overview-sync-work-v1'", JSON.stringify(progress));
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.removeRepository(12);
      const sync = new OverviewSync({ storage: state.storage, store, selection: selection(), installations: () => [], visible: () => true, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW + 3000, false);
      expect(saved(state.storage).reread).toBeNull();
      expect(await state.storage.getAlarm()).toBe(NOW + 3000);
      await sync.alarm(NOW + 3000);
      expect(store.syncStatus().latestAttempt?.result).toBe("success");
    });
  });

  it.each(["token", "count", "read"] as const)("rejects a sweep result when an event arrives during its %s await", async (phase) => {
    const stub = await object(`inflight-${phase}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY); store.putPullRequest(fixturePr({ headSha: "retained" }));
      const selected = selection(); let sync: OverviewSync; let interrupted = false;
      const interrupt = async () => { if (!interrupted) { interrupted = true; await sync.receive(event(NOW + 2), NOW + 2); } };
      if (phase === "token") vi.spyOn(selected.tokens, "get").mockImplementation(async () => { await interrupt(); return { ok: true, token: "memory-only-token", expiresAt: NOW + 7_200_000 }; });
      const counts = vi.spyOn(GithubPrReader.prototype, "countOpenPrs").mockImplementation(async () => {
        if (phase === "count" && !interrupted) { await interrupt(); return { ...meta, repositories: [{ repositoryId: 12, nodeId: "R_example", visibility: "private", count: 0 }] }; }
        return { ...meta, repositories: [{ repositoryId: 12, nodeId: "R_example", visibility: "public", count: 1 }] };
      });
      vi.spyOn(GithubPrReader.prototype, "readRepositories").mockImplementation(async () => {
        if (phase === "read" && !interrupted) { await interrupt(); return repoRead([fixturePr({ headSha: "stale" })]); }
        return repoRead();
      });
      sync = new OverviewSync({ storage: state.storage, store, selection: selected, installations: () => INSTALLATIONS, visible: () => true, guard: async () => true, publish: async () => {} });
      await sync.visibility(NOW, false); await sync.alarm(NOW); await sync.alarm(NOW + 1);
      if (phase === "read") await sync.alarm(NOW + 2);
      expect(interrupted).toBe(true);
      expect(store.pullRequests()[0]?.headSha).toBe("retained");
      expect(store.repositories()[0]?.visibility).toBe("public");
      expect(store.syncStatus().lastSuccessfulSweepAt).toBeNull();
      if (phase === "token") expect(counts).not.toHaveBeenCalled();
      for (let index = 3; index <= 8; index++) await sync.alarm(NOW + index);
      expect(store.pullRequests()[0]?.headSha).toBe("new");
      expect(store.syncStatus().latestAttempt?.result).toBe("success");
    });
  });
});
