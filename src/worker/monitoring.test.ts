import { env, exports } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewStore } from "../object/overview-store";
import type { MonitoringStatus } from "../shared/monitoring";
import { fixturePr, FIXTURE_REPOSITORY, SYNC_FIXTURES } from "../shared/overview/fixtures";
import { instanceStub } from "./instance-stub";
import { BASE, fetchWithConfig, ownerSession } from "./test-helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe("private instance monitoring", () => {
  it("requires the current owner's session and leaves public health unchanged", async () => {
    expect((await exports.default.fetch(`${BASE}/api/monitoring`)).status).toBe(401);
    const cookie = await ownerSession();
    expect((await fetchWithConfig({ OWNER_ID: "2002" }, "/api/monitoring", { headers: { cookie } })).status).toBe(401);
    const health = await exports.default.fetch(`${BASE}/api/health`);
    expect(await health.json()).toEqual({ ok: true, schemaVersion: expect.any(Number) });
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
});
