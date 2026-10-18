import { env, exports } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixturePr } from "../shared/overview/fixtures";
import { OverviewSync } from "./overview-sync";
import { OverviewStore } from "./overview-store";
import { instanceStub } from "../worker/instance-stub";
import { BASE, json, OWNER_ID, ownerSession, storedRows, stubGitHub } from "../worker/test-helpers";

const NOW = Date.now();
const LIST = "GET https://api.github.com/installation/repositories";
const PERSONAL = { id: 10, account: { id: OWNER_ID, login: "owner", type: "User" }, repository_selection: "all" };
const ORG = { id: 20, account: { id: 3003, login: "org", type: "Organization" }, repository_selection: "all" };
function repository(id: number, changes: Record<string, unknown> = {}) {
  return { id, node_id: `R_${id}`, full_name: `owner/repo-${id}`, owner: { id: OWNER_ID, login: "owner" }, visibility: "private", fork: false, archived: false, ...changes };
}
function githubRoutes(list: () => unknown[], installations: () => unknown[] = () => [PERSONAL]) {
  return {
    "GET https://api.github.com/app/installations": () => json(installations()),
    "POST https://api.github.com/app/installations/10/access_tokens": () => json({ token: "installation-secret", expires_at: new Date(NOW + 3_600_000).toISOString() }, 201),
    "POST https://api.github.com/app/installations/20/access_tokens": () => json({ token: "organization-secret", expires_at: new Date(NOW + 3_600_000).toISOString() }, 201),
    [LIST]: () => json({ total_count: list().length, repositories: list() }),
    [`GET https://api.github.com/user/${OWNER_ID}`]: () => json({ id: OWNER_ID, login: "owner" }),
  };
}
// These tests drive discovery one bounded call at a time. The scheduler has
// separate end-to-end tests and must not race the explicit continuation here.
beforeEach(() => { vi.spyOn(OverviewSync.prototype, "rearm").mockResolvedValue(undefined); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe("repository selection in the instance", () => {
  it("monitors owned IDs by default, discovers new repositories and stops archived ones", async () => {
    let listed = [repository(1), repository(2, { fork: true }), repository(3, { archived: true })];
    stubGitHub(githubRoutes(() => listed));
    const stub = instanceStub(env); await stub.checkInstallations(NOW);
    expect(await stub.refreshInstallation(10, NOW)).toEqual({ ok: true, changed: true, repositoryIds: [1], requestsUsed: 2 });
    let settings = await stub.repositorySettings();
    expect(settings.repositories.map((entry) => [entry.id, entry.monitored, entry.visibility, entry.listedAt])).toEqual([
      [1, true, "private", NOW], [2, false, "private", NOW], [3, false, "private", NOW],
    ]);
    listed = [repository(1, { archived: true }), repository(2, { fork: true }), repository(3, { archived: true }), repository(4)];
    expect(await stub.refreshInstallation(10, NOW + 1)).toMatchObject({ ok: true, repositoryIds: [4] });
    settings = await stub.repositorySettings();
    expect(settings.repositories.find((entry) => entry.id === 1)?.monitored).toBe(false);
  });
  it("keeps overrides across rename/listings and can restore defaults", async () => {
    let listed = [repository(1), repository(2, { fork: true })];
    stubGitHub(githubRoutes(() => listed));
    const stub = instanceStub(env); await stub.checkInstallations(NOW); await stub.refreshInstallation(10, NOW);
    expect(await stub.setMonitoringOverride(1, false, NOW)).toMatchObject({ ok: true, repository: { monitored: false } });
    expect(await stub.setMonitoringOverride(2, true, NOW)).toMatchObject({ ok: true, repository: { monitored: true } });
    listed = [repository(1, { full_name: "owner/renamed", visibility: "public" }), repository(2, { fork: true })];
    await stub.refreshInstallation(10, NOW + 1);
    expect((await stub.repositorySettings()).repositories.map((entry) => [entry.id, entry.fullName, entry.monitorOverride, entry.monitored])).toEqual([
      [1, "owner/renamed", false, false], [2, "owner/repo-2", true, true],
    ]);
    expect(await stub.setMonitoringOverride(1, null, NOW)).toMatchObject({ ok: true, repository: { monitored: true, monitorOverride: null } });
    expect(await stub.setMonitoringOverride(2, null, NOW)).toMatchObject({ ok: true, repository: { monitored: false } });
  });
  it("keeps an explicit off choice when a repository leaves and later returns to the listing", async () => {
    let listed = [repository(1)];
    stubGitHub(githubRoutes(() => listed));
    const stub = instanceStub(env); await stub.checkInstallations(NOW); await stub.refreshInstallation(10, NOW);
    await stub.setMonitoringOverride(1, false, NOW);
    listed = []; await stub.refreshInstallation(10, NOW + 1);
    expect((await stub.repositorySettings()).repositories).toEqual([]);
    listed = [repository(1)]; await stub.refreshInstallation(10, NOW + 2);
    expect((await stub.repositorySettings()).repositories).toMatchObject([{ id: 1, monitored: false, monitorOverride: false }]);
    await stub.setMonitoringOverride(1, null, NOW + 3);
    listed = []; await stub.refreshInstallation(10, NOW + 4);
    listed = [repository(1)]; await stub.refreshInstallation(10, NOW + 5);
    expect((await stub.repositorySettings()).repositories).toMatchObject([{ id: 1, monitored: true, monitorOverride: null }]);
  });
  it("turning monitoring off deletes stored PRs and publishes a new snapshot", async () => {
    stubGitHub(githubRoutes(() => [repository(12)]));
    const stub = instanceStub(env); await stub.checkInstallations(NOW); await stub.refreshInstallation(10, NOW);
    await runInDurableObject(stub, (_instance, state) => { new OverviewStore(state.storage).putPullRequest(fixturePr()); });
    expect((await stub.overviewSnapshot(NOW)).buckets.flatMap((bucket) => bucket.rows)).toHaveLength(1);
    const published = await runInDurableObject(stub, async (instance) => {
      const publish = vi.spyOn(instance, "publishOverview");
      await instance.setMonitoringOverride(12, false, NOW);
      return publish.mock.calls;
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.[0].type).toBe("snapshot");
    expect((await stub.overviewSnapshot(NOW)).buckets.flatMap((bucket) => bucket.rows)).toEqual([]);
    expect((await storedRows()).pull_requests).toEqual([]);
  });
  it("does not read a pending organization or opt any repository in when accepted", async () => {
    const github = stubGitHub({
      ...githubRoutes(() => [repository(5, { full_name: "org/repo-5", owner: { id: 3003, login: "org" }, permissions: { admin: true } })], () => [ORG]),
      "GET https://api.github.com/repos/org/repo-5/collaborators/owner/permission": () => json({ permission: "read", user: { id: OWNER_ID } }),
    });
    const stub = instanceStub(env); await stub.checkInstallations(NOW);
    expect(await stub.refreshInstallation(20, NOW)).toMatchObject({ ok: false, reason: "installation-removed" });
    expect(github.calls).toHaveLength(1);
    expect(await stub.decideOrganization(20, true, NOW)).toEqual({ ok: true });
    await stub.refreshInstallation(20, NOW);
    expect((await stub.repositorySettings()).repositories).toMatchObject([{ id: 5, monitored: false, ownerPermission: "read" }]);
    expect(await stub.setMonitoringOverride(5, true, NOW)).toMatchObject({ ok: true, repository: { monitored: true } });
  });
  it("does not reveal or opt in a repository whose owner cannot read it", async () => {
    stubGitHub({
      ...githubRoutes(() => [repository(5, { full_name: "org/hidden", owner: { id: 3003, login: "org" }, permissions: { admin: true } })], () => [ORG]),
      "GET https://api.github.com/repos/org/hidden/collaborators/owner/permission": () => json({ permission: "none", user: { id: OWNER_ID } }),
    });
    const stub = instanceStub(env); await stub.checkInstallations(NOW); await stub.decideOrganization(20, true, NOW);
    await stub.refreshInstallation(20, NOW);
    expect((await stub.repositorySettings()).repositories).toEqual([]);
    expect(JSON.stringify(await stub.overviewSnapshot(NOW))).not.toContain("hidden");
    expect(await stub.setMonitoringOverride(5, true, NOW)).toEqual({ ok: false, reason: "not-found" });
  });
  it("keeps the last complete listing on a permission lookup failure", async () => {
    let failing = false;
    stubGitHub({
      ...githubRoutes(() => [repository(5, { full_name: "org/repo-5", owner: { id: 3003, login: "org" } })], () => [ORG]),
      "GET https://api.github.com/repos/org/repo-5/collaborators/owner/permission": () => failing ? json({}, 500) : json({ permission: "read", user: { id: OWNER_ID } }),
    });
    const stub = instanceStub(env); await stub.checkInstallations(NOW); await stub.decideOrganization(20, true, NOW); await stub.refreshInstallation(20, NOW);
    const before = await stub.repositorySettings(); expect(before.repositories).toHaveLength(1); failing = true;
    expect(await stub.refreshInstallation(20, NOW + 1)).toMatchObject({ ok: false, reason: "github-unavailable" });
    expect(await stub.repositorySettings()).toEqual(before);
  });
  it("does not permit archives to be switched on", async () => {
    stubGitHub(githubRoutes(() => [repository(1, { archived: true })]));
    const stub = instanceStub(env); await stub.checkInstallations(NOW); await stub.refreshInstallation(10, NOW);
    expect(await stub.setMonitoringOverride(1, true, NOW)).toEqual({ ok: false, reason: "not-allowed" });
    expect(await stub.setMonitoringOverride(99, false, NOW)).toEqual({ ok: false, reason: "not-found" });
  });
  it("preserves rows and PRs on incomplete listing, removes them only after a complete omission", async () => {
    let failed = false; let listed = [repository(12)];
    stubGitHub({ ...githubRoutes(() => listed), [LIST]: () => json({ total_count: failed ? 2 : listed.length, repositories: listed }) });
    const stub = instanceStub(env); await stub.checkInstallations(NOW); await stub.refreshInstallation(10, NOW);
    await runInDurableObject(stub, (_instance, state) => { new OverviewStore(state.storage).putPullRequest(fixturePr()); });
    const before = await stub.repositorySettings(); failed = true;
    expect(await stub.refreshInstallation(10, NOW + 1)).toMatchObject({ ok: false, reason: "github-unavailable" });
    expect(await stub.repositorySettings()).toEqual(before);
    expect((await storedRows()).pull_requests).toHaveLength(1);
    failed = false; listed = []; await stub.refreshInstallation(10, NOW + 2);
    expect((await stub.repositorySettings()).repositories).toEqual([]);
    expect((await storedRows()).pull_requests).toEqual([]);
    expect(JSON.stringify(await storedRows())).not.toMatch(/installation-secret|organization-secret/);
  });
  it("removes stored repositories and PRs when the guard confirms the installation is gone", async () => {
    let installations = [PERSONAL];
    stubGitHub(githubRoutes(() => [repository(12)], () => installations));
    const stub = instanceStub(env); await stub.checkInstallations(NOW); await stub.refreshInstallation(10, NOW);
    await runInDurableObject(stub, (_instance, state) => { new OverviewStore(state.storage).putPullRequest(fixturePr()); });
    installations = []; await stub.checkInstallations(NOW + 1);
    expect((await stub.repositorySettings()).repositories).toEqual([]);
    expect((await storedRows()).pull_requests).toEqual([]);
  });
  it("refuses pending organizations by uninstalling on GitHub and forgets them only on success", async () => {
    let refuseOk = false;
    const github = stubGitHub({ ...githubRoutes(() => [], () => [ORG]), "DELETE https://api.github.com/app/installations/20": () => new Response(null, { status: refuseOk ? 204 : 500 }) });
    const stub = instanceStub(env); await stub.checkInstallations(NOW);
    expect(await stub.decideOrganization(20, false, NOW)).toEqual({ ok: false });
    expect((await stub.repositorySettings()).installations).toHaveLength(1);
    refuseOk = true; expect(await stub.decideOrganization(20, false, NOW)).toEqual({ ok: true });
    expect((await stub.repositorySettings()).installations).toEqual([]);
    expect(github.called("DELETE", "https://api.github.com/app/installations/20")).toHaveLength(2);
  });
  it("preserves organization acceptance during a guard's pending stranger uninstall", async () => {
    const stub = instanceStub(env);
    let decide!: (accept: boolean) => Promise<{ ok: boolean }>;
    await stub.health();
    await runInDurableObject(stub, (instance) => { decide = (accept) => instance.decideOrganization(20, accept, NOW); });
    let installations = [ORG];
    const stranger = { id: 30, account: { id: 4004, login: "stranger", type: "User" }, repository_selection: "all" };
    stubGitHub({ ...githubRoutes(() => [], () => installations), "DELETE https://api.github.com/app/installations/30": async () => {
      expect(await decide(true)).toEqual({ ok: true });
      return new Response(null, { status: 204 });
    } });
    await stub.checkInstallations(NOW);
    installations = [{ ...ORG, repository_selection: "selected" }, stranger];
    expect(await stub.checkInstallations(NOW + 1)).toMatchObject({ ok: true, kept: [{ id: 20, status: "accepted", repositorySelection: "selected" }] });
    expect((await stub.repositorySettings()).installations).toMatchObject([{ id: 20, status: "accepted", repositorySelection: "selected" }]);
  });
  it("does not resurrect a refused organization from an in-flight guard response", async () => {
    const stub = instanceStub(env);
    let decide!: (accept: boolean) => Promise<{ ok: boolean }>;
    await stub.health();
    await runInDurableObject(stub, (instance) => { decide = (accept) => instance.decideOrganization(20, accept, NOW); });
    let installations = [ORG];
    const stranger = { id: 30, account: { id: 4004, login: "stranger", type: "User" }, repository_selection: "all" };
    stubGitHub({ ...githubRoutes(() => [], () => installations),
      "DELETE https://api.github.com/app/installations/20": () => new Response(null, { status: 204 }),
      "DELETE https://api.github.com/app/installations/30": async () => {
        expect(await decide(false)).toEqual({ ok: true });
        return new Response(null, { status: 204 });
      },
    });
    await stub.checkInstallations(NOW);
    installations = [{ ...ORG, repository_selection: "selected" }, stranger];
    expect(await stub.checkInstallations(NOW + 1)).toMatchObject({ ok: true, kept: [] });
    expect((await stub.repositorySettings()).installations).toEqual([]);
    // A later stale GitHub listing must not reverse the same decision either.
    installations = [ORG]; await stub.checkInstallations(NOW + 2);
    expect((await stub.repositorySettings()).installations).toEqual([]);
  });
  it("removes durable discovery data after eviction when the guard removes an installation", async () => {
    let installations = [PERSONAL];
    stubGitHub(githubRoutes(() => [repository(1)], () => installations));
    const stub = instanceStub(env); await stub.checkInstallations(NOW); await stub.refreshInstallation(10, NOW);
    expect(JSON.stringify((await storedRows()).settings)).toContain("repository-discovery:10");
    await evictDurableObject(stub);
    installations = []; await stub.checkInstallations(NOW + 1);
    expect(JSON.stringify((await storedRows()).settings)).not.toContain("repository-discovery:10");
  }, 15_000);
  it("cleans stale discovery data when refusing a pending organization after eviction", async () => {
    stubGitHub({ ...githubRoutes(() => [], () => [ORG]), "DELETE https://api.github.com/app/installations/20": () => new Response(null, { status: 204 }) });
    const stub = instanceStub(env); await stub.checkInstallations(NOW);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO settings (key, value) VALUES ('repository-discovery:20', '{}')");
    });
    await evictDurableObject(stub);
    expect(await stub.decideOrganization(20, false, NOW)).toEqual({ ok: true });
    expect(JSON.stringify((await storedRows()).settings)).not.toContain("repository-discovery:20");
  }, 15_000);
  it("does not accept an organization while its refusal is in flight", async () => {
    stubGitHub({ ...githubRoutes(() => [], () => [ORG]), "DELETE https://api.github.com/app/installations/20": () => new Response(null, { status: 204 }) });
    const stub = instanceStub(env); await stub.checkInstallations(NOW);
    const results = await Promise.all([
      stub.decideOrganization(20, false, NOW),
      stub.decideOrganization(20, true, NOW),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: false }]);
    expect((await stub.repositorySettings()).installations).toEqual([]);
  });
  it("resumes organization permission work after object eviction without exposing partial listings", async () => {
    const repositories = Array.from({ length: 9 }, (_, index) => repository(index + 1, {
      full_name: `org/repo-${index + 1}`, owner: { id: 3003, login: "org" },
    }));
    const routes = githubRoutes(() => repositories, () => [ORG]);
    const permissions = Object.fromEntries(repositories.map((entry) => [
      `GET https://api.github.com/repos/org/repo-${entry.id}/collaborators/owner/permission`,
      () => json({ permission: "read", user: { id: OWNER_ID } }),
    ]));
    const github = stubGitHub({ ...routes, ...permissions });
    const stub = instanceStub(env); await stub.checkInstallations(NOW); await stub.decideOrganization(20, true, NOW);
    const first = await stub.refreshInstallation(20, NOW, 5);
    expect(first).toEqual({ ok: false, reason: "continuation", requestsUsed: 5 });
    expect((await stub.repositorySettings()).repositories).toEqual([]);
    expect(github.calls).toHaveLength(6); // Guard plus five budgeted requests.
    // Eviction waits for each invocation's 10-second AbortSignal timer.
    await evictDurableObject(stub);
    const second = await stub.refreshInstallation(20, NOW + 1, 5);
    expect(second).toEqual({ ok: false, reason: "continuation", requestsUsed: 5 });
    expect((await stub.repositorySettings()).repositories).toEqual([]);
    await evictDurableObject(stub);
    const result = await stub.refreshInstallation(20, NOW + 2, 5);
    expect(result).toMatchObject({ ok: true, repositoryIds: [], requestsUsed: 4 });
    expect((await stub.repositorySettings()).repositories).toHaveLength(9);
    expect(github.called("GET", "https://api.github.com/installation/repositories")).toHaveLength(1);
    expect(JSON.stringify(await storedRows())).not.toMatch(/installation-secret|organization-secret/);
  }, 30_000);
  it("continues large installation pages without a permanent thousand-repository ceiling", async () => {
    const github = stubGitHub({ ...githubRoutes(() => []), [LIST]: (call) => {
      const page = Number(call.url.searchParams.get("page"));
      const start = (page - 1) * 100;
      return json({ total_count: 1101, repositories: Array.from({ length: Math.min(100, 1101 - start) }, (_, index) => repository(start + index + 1)) });
    } });
    const stub = instanceStub(env); await stub.checkInstallations(NOW);
    for (let invocation = 0; invocation < 3; invocation++) {
      expect(await stub.refreshInstallation(10, NOW + invocation, 4)).toEqual({ ok: false, reason: "continuation", requestsUsed: 4 });
      expect((await stub.repositorySettings()).repositories).toEqual([]);
    }
    const result = await stub.refreshInstallation(10, NOW + 3, 4);
    expect(result.ok).toBe(true);
    expect(result.requestsUsed).toBe(4);
    expect((await stub.repositorySettings()).repositories).toHaveLength(1101);
    expect(github.called("GET", "https://api.github.com/installation/repositories").map((call) => Number(call.url.searchParams.get("page")))).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  });
  it("charges no calls when the supplied allowance cannot start work", async () => {
    const github = stubGitHub(githubRoutes(() => []));
    const stub = instanceStub(env); await stub.checkInstallations(NOW);
    expect(await stub.refreshInstallation(10, NOW, 1)).toEqual({ ok: false, reason: "continuation", requestsUsed: 0 });
    expect(github.calls).toHaveLength(1);
  });
  it("reports selected personal installations for the prominent warning", async () => {
    stubGitHub(githubRoutes(() => [], () => [{ ...PERSONAL, repository_selection: "selected" }]));
    const stub = instanceStub(env); await stub.checkInstallations(NOW);
    expect((await stub.repositorySettings()).installations).toMatchObject([{ repositorySelection: "selected", accountId: OWNER_ID }]);
    expect(await stub.decideOrganization(10, false, NOW)).toEqual({ ok: false });
  });
});

describe("owner-only repository routes", () => {
  it("returns stored settings without external reads, refuses invalid mutations and CSRF", async () => {
    const github = stubGitHub({}); const cookie = await ownerSession();
    const response = await exports.default.fetch(`${BASE}/api/repositories`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ownerId: OWNER_ID, repositories: [], installations: [] });
    expect(github.calls).toEqual([]);
    for (const [path, body] of [["refresh", { installationId: -1 }], ["monitoring", { repositoryId: 1, override: "yes" }], ["organization", { installationId: 1, accept: "yes" }]] as const) {
      expect((await exports.default.fetch(`${BASE}/api/repositories/${path}`, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(400);
      expect((await exports.default.fetch(`${BASE}/api/repositories/${path}`, { method: "POST", headers: { cookie, origin: "https://elsewhere.test", "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(403);
    }
    expect(github.calls).toEqual([]);
  });
});
