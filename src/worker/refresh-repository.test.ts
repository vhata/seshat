import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewSync } from "../object/overview-sync";
import { OverviewStore } from "../object/overview-store";
import { FIXTURE_REPOSITORY } from "../shared/overview/fixtures";
import { instanceStub } from "./instance-stub";
import { BASE, fetchWithConfig, ownerSession } from "./test-helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const PATH = "/api/repositories/refresh-one";
const BODY = { repositoryId: 12, ownerAccountId: 1001 };
function post(cookie?: string, origin = BASE, body: unknown = BODY) {
  return exports.default.fetch(`${BASE}${PATH}`, { method: "POST", headers: {
    ...(cookie ? { cookie } : {}), origin, "content-type": "application/json",
  }, body: JSON.stringify(body) });
}
describe("owner single-repository refresh route", () => {
  it("requires a current owner session and same-origin POST", async () => {
    expect((await post()).status).toBe(401);
    const cookie = await ownerSession();
    expect((await post(cookie, "https://elsewhere.test")).status).toBe(403);
    expect((await fetchWithConfig({ OWNER_ID: "2002" }, PATH, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(BODY) })).status).toBe(401);
    expect((await exports.default.fetch(`${BASE}${PATH}`, { headers: { cookie } })).status).toBe(405);
    expect((await exports.default.fetch(`${BASE}${PATH}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(BODY) })).status).toBe(403);
  });
  it("rejects malformed and stale-identity requests without scheduling", async () => {
    const cookie = await ownerSession();
    const schedule = vi.spyOn(OverviewSync.prototype, "refreshRepository");
    for (const body of [null, [], {}, { repositoryId: 12 }, { ...BODY, repositoryId: -1 }, { ...BODY, ownerAccountId: "1001" }, { ...BODY, repositoryId: 1.5 }]) {
      expect((await post(cookie, BASE, body)).status).toBe(400);
    }
    expect(schedule).not.toHaveBeenCalled();
    expect((await post(cookie)).status).toBe(404);
    await runInDurableObject(instanceStub(env), (_instance, state) => {
      new OverviewStore(state.storage).putRepository(FIXTURE_REPOSITORY);
      state.storage.sql.exec("INSERT INTO installations (id,account_id,account_type,status,repository_selection) VALUES (9,1001,'User','accepted','all')");
    });
    expect((await post(cookie, BASE, { ...BODY, ownerAccountId: 2002 })).status).toBe(403);
  });
  it("acknowledges durable coalesced work without making inline GitHub calls", async () => {
    const cookie = await ownerSession();
    // The endpoint queues work; freeze alarms while inspecting its receipts.
    vi.spyOn(OverviewSync.prototype, "rearm").mockResolvedValue(undefined);
    await runInDurableObject(instanceStub(env), (_instance, state) => {
      new OverviewStore(state.storage).putRepository({ ...FIXTURE_REPOSITORY, muted: true });
      state.storage.sql.exec("INSERT INTO installations (id,account_id,account_type,status,repository_selection) VALUES (9,1001,'User','accepted','all')");
    });
    const first = await post(cookie); expect(first.status).toBe(202);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const response = await first.json();
    expect(response).toMatchObject({ ok: true, attempt: { result: "queued", id: expect.any(Number), startedAt: expect.any(Number) } });
    expect(await (await post(cookie)).json()).toEqual(response);
    const snapshot = await instanceStub(env).overviewSnapshot(Date.now());
    expect(snapshot.freshness?.repositoryRefreshes?.[12]?.latestAttempt).toEqual((response as { attempt: unknown }).attempt);
  });
});
