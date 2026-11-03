import { env, exports } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewStore } from "../object/overview-store";
import type { MonitoringStatus } from "../shared/monitoring";
import { fixturePr, FIXTURE_REPOSITORY, SYNC_FIXTURES } from "../shared/overview/fixtures";
import { instanceStub } from "./instance-stub";
import { BASE, fetchWithConfig, ownerSession } from "./test-helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

function schedulerFixture(now: number) {
  return {
    marks: [{ nodeId: "private-pr-node", installationId: 987654, repositoryId: 876543,
      facts: [], due: now + 60_000, queuedAt: now - 3_600_000, firstRead: null, retry: 0, revision: 0, mergeability: false }],
    shas: [], refresh: [{ id: 987654, due: now + 60_000, revision: 0 }],
    refreshGenerations: {}, observationGenerations: {}, guard: now + 60_000,
    nextSweep: now + 30_000, lastCatchup: now - 1000,
    sweep: { generation: 0, startedAt: now - 120_000, retry: 1,
      installations: [987654], installationIndex: 0, stage: "count", ids: ["private-repository-node"],
      continuation: null, unreadable: [], reason: "github-unavailable" },
    reread: { installationId: 987654, generation: 0, ids: ["private-pr-node"], revisions: [["private-pr-node", 0]],
      continuation: { version: 1, responses: [["private-request-key", { title: "private cached title", token: "private-token-marker" }]],
        permissionCache: [], headCommitDates: [], refreshedPermissionKeys: [], rateLimit: null } },
    permissions: [], headDates: [], rates: [], activeSince: null,
    privateExtraField: "private-unrecognized-state",
  };
}

describe("private instance monitoring", () => {
  it("requires the current owner's session and leaves public health unchanged", async () => {
    expect((await exports.default.fetch(`${BASE}/api/monitoring`)).status).toBe(401);
    const cookie = await ownerSession();
    expect((await fetchWithConfig({ OWNER_ID: "2002" }, "/api/monitoring", { headers: { cookie } })).status).toBe(401);
    const health = await exports.default.fetch(`${BASE}/api/health`);
    expect(await health.json()).toEqual({
      ok: true,
      schemaVersion: expect.any(Number),
      build: { commit: null, dirty: null },
      version: { id: expect.any(String) },
    });
  });

  it("returns only aggregate diagnostics without GitHub traffic or per-poll writes", async () => {
    const cookie = await ownerSession();
    const stub = instanceStub(env);
    await runInDurableObject(stub, (_instance, state) => {
      const store = new OverviewStore(state.storage);
      store.putRepository({ ...FIXTURE_REPOSITORY, fullName: "private-owner/private-repository" });
      store.putPullRequest(fixturePr({ title: "private PR title" }));
      store.putSyncStatus(SYNC_FIXTURES.failed);
    });
    const before = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT * FROM settings").toArray());
    for (let i = 0; i < 2; i++) {
      const response = await exports.default.fetch(`${BASE}/api/monitoring`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json() as MonitoringStatus;
      expect(body).toMatchObject({ version: 1, activeSince: null, cloudflareCapacity: "unknown", oldestPendingAt: null });
      expect(body.sync.latestAttempt).toEqual({ startedAt: SYNC_FIXTURES.failed.latestAttempt!.startedAt, result: "failed", reason: "github-unavailable" });
      const text = JSON.stringify(body);
      for (const secret of ["private-owner", "private-repository", "private PR title", "unreadableRepositoryIds", "PR_example", cookie]) expect(text).not.toContain(secret);
      if (i === 0) await evictDurableObject(stub);
    }
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT * FROM settings").toArray())).toEqual(before);
  });

  it.each([null, 86_400_000])("observes a %s alarm without repairing or changing scheduler state", async (delay) => {
    const cookie = await ownerSession();
    const stub = instanceStub(env);
    const now = Date.now();
    const alarmAt = delay === null ? null : now + delay;
    const saved = JSON.stringify(schedulerFixture(now));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO settings (key,value) VALUES ('overview-sync-work-v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", saved);
      if (alarmAt === null) await state.storage.deleteAlarm();
      else await state.storage.setAlarm(alarmAt);
    });
    await evictDurableObject(stub);
    const before = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT total_changes() AS changes").one());
    for (let i = 0; i < 2; i++) {
      const response = await exports.default.fetch(`${BASE}/api/monitoring`, { headers: { cookie } });
      expect(response.status).toBe(200);
      const body = await response.json() as MonitoringStatus;
      expect(body.scheduler).toEqual({
        alarmAt, running: false, nextSweepAt: now + 30_000,
        sweep: { phase: "count", startedAt: now - 120_000, retry: 1 },
        rereadActive: true, rereadCachedResponseCount: 1, rereadSelectedItemCount: 1,
        pending: { guard: 1, refresh: 1, marks: 1 }, selectionConfigured: true,
      });
      const text = JSON.stringify(body);
      for (const secret of ["private-pr-node", "private-repository-node", "private-request-key", "private cached title", "private-token-marker", "private-unrecognized-state", "987654", "876543", cookie]) expect(text).not.toContain(secret);
    }
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(alarmAt);
      expect(state.storage.sql.exec("SELECT total_changes() AS changes").one()).toEqual(before);
      expect(state.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key='overview-sync-work-v1'").one().value).toBe(saved);
    });
    await evictDurableObject(stub);
    const afterRestart = await exports.default.fetch(`${BASE}/api/monitoring`, { headers: { cookie } });
    expect((await afterRestart.json() as MonitoringStatus).scheduler).toMatchObject({
      alarmAt, running: false, nextSweepAt: now + 30_000,
      rereadActive: true, rereadCachedResponseCount: 1, rereadSelectedItemCount: 1,
    });
  });

  it("still repairs scheduling on ordinary session requests", async () => {
    const cookie = await ownerSession();
    const stub = instanceStub(env);
    const due = Date.now() + 86_400_000;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO settings (key,value) VALUES ('overview-sync-work-v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ ...schedulerFixture(due), sweep: null, reread: null, nextSweep: null }));
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
    expect((await exports.default.fetch(`${BASE}/api/session`, { headers: { cookie } })).status).toBe(200);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(due + 60_000);
    });
  });
});
