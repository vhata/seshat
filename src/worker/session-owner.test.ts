import { env, exports } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewSync } from "../object/overview-sync";
import { MIGRATIONS } from "../object/schema";
import { sessionKey } from "../shared/auth";
import { randomToken } from "../shared/encoding";
import { instanceStub } from "./instance-stub";
import { BASE, fetchWithConfig, ownerSession, SESSION_COOKIE_NAME } from "./test-helpers";
import { SOCKET_PATH } from "../shared/overview/protocol";
import { SYNC_FIXTURES } from "../shared/overview/fixtures";

// Model deploy-time configuration changes on both the Worker and the object.
async function objectOwner(owner: string | undefined) {
  await runInDurableObject(instanceStub(env), (instance) => {
    (instance as unknown as { env: { OWNER_ID: string | undefined } }).env.OWNER_ID = owner;
  });
}
afterEach(async () => { await objectOwner("1001"); vi.restoreAllMocks(); await reset(); });

describe("owner-bound sessions", () => {
  it.each(["2002", undefined, "not-an-id"])("rejects old HTTP sessions with OWNER_ID=%s", async (owner) => {
    const cookie = await ownerSession();
    const response = await fetchWithConfig({ OWNER_ID: owner }, "/api/session", { headers: { cookie } });
    expect(response.status).toBe(401);
  });
  it("permits a new owner's session while refusing the previous owner's", async () => {
    const old = await ownerSession();
    await objectOwner("2002");
    const token = randomToken(32);
    await instanceStub(env).createSession(await sessionKey(token), Date.now(), 2002);
    const config = { OWNER_ID: "2002" };
    expect((await fetchWithConfig(config, "/api/session", { headers: { cookie: old } })).status).toBe(401);
    expect((await fetchWithConfig(config, "/api/session", { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } })).status).toBe(200);
    await runInDurableObject(instanceStub(env), async (instance) => {
      await expect(instance.createSession("stale", Date.now(), 1001)).rejects.toThrow("Session owner");
    });
  });
  it("upgrades legacy unbound rows without authorizing them, including after restart", async () => {
    const stub = instanceStub(env);
    const token = randomToken(32);
    const key = await sessionKey(token);
    await runInDurableObject(stub, (_instance, state) => {
      for (const migration of MIGRATIONS.filter((item) => item.version < 4)) {
        for (const statement of migration.statements) state.storage.sql.exec(statement);
      }
      state.storage.sql.exec("CREATE TABLE schema_version (version INTEGER NOT NULL) STRICT");
      state.storage.sql.exec("INSERT INTO schema_version VALUES (3)");
      state.storage.sql.exec("INSERT INTO sessions VALUES (?, ?, ?)", key, Date.now(), Date.now() + 60000);
    });
    await evictDurableObject(stub);
    const response = await exports.default.fetch(`${BASE}/api/session`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });
    expect(response.status).toBe(401);
    await evictDurableObject(stub);
    expect(await stub.sessionExpiry(key, Date.now())).toBeNull();
    expect((await exports.default.fetch(`${BASE}/api/session`, { headers: { cookie: await ownerSession() } })).status).toBe(200);
  });
  it.each(["2002", undefined, "bad"])("closes existing sockets before publication with owner %s", async (owner) => {
    vi.spyOn(OverviewSync.prototype, "rearm").mockResolvedValue(undefined);
    const cookie = await ownerSession();
    const response = await exports.default.fetch(`${BASE}${SOCKET_PATH}`, { headers: { cookie, origin: BASE, upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const client = response.webSocket!;
    const initial = new Promise((resolve) => client.addEventListener("message", resolve, { once: true }));
    client.accept();
    await initial;
    const received: unknown[] = [];
    client.addEventListener("message", (event) => received.push(event.data));
    const closed = new Promise<CloseEvent>((resolve) => client.addEventListener("close", resolve, { once: true }));
    await objectOwner(owner);
    await instanceStub(env).publishOverview({ type: "sync", sync: SYNC_FIXTURES.live, serverTime: Date.now() });
    expect(await closed).toMatchObject({ code: 1008, reason: "session ended" });
    expect(received).toEqual([]);
  });
});
