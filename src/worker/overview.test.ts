import { env, exports } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewSync } from "../object/overview-sync";
import { OverviewStore } from "../object/overview-store";
import { fixturePr, FIXTURE_NOW, FIXTURE_REPOSITORY, SYNC_FIXTURES } from "../shared/overview/fixtures";
import { KEEP_ALIVE_REQUEST, KEEP_ALIVE_RESPONSE, parseServerMessage, SNAPSHOT_PATH, SOCKET_PATH, toPrDto, type SocketAttachment } from "../shared/overview/protocol";
import { instanceStub } from "./instance-stub";
import { BASE, fetchWithConfig, ownerSession } from "./test-helpers";

// Protocol/session tests isolate publication from background GitHub work;
// overview-sync.test.ts exercises the real scheduler separately.
beforeEach(() => { vi.spyOn(OverviewSync.prototype, "rearm").mockResolvedValue(undefined); });
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
  await reset();
});
function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
}
function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}
async function connect(cookie: string) {
  const response = await exports.default.fetch(`${BASE}${SOCKET_PATH}`, { headers: { cookie, origin: BASE, upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const client = response.webSocket!;
  clients.push(client);
  const first = nextMessage(client);
  client.accept();
  const message = parseServerMessage((await first).data);
  expect(message?.type).toBe("snapshot");
  return { client, message };
}
async function seed() {
  const stub = instanceStub(env);
  await stub.health();
  await runInDurableObject(stub, (_instance, state) => {
    const store = new OverviewStore(state.storage);
    store.putRepository(FIXTURE_REPOSITORY);
    store.putPullRequest(fixturePr());
    store.putRepository({ ...FIXTURE_REPOSITORY, id: 13, monitored: false });
    // Even legacy/unexpected stored rows must never escape snapshot filtering.
    state.storage.sql.exec("INSERT INTO pull_requests (node_id, repository_id, data) VALUES (?, ?, ?)", "PR_hidden", 13, JSON.stringify(toPrDto(fixturePr({ nodeId: "PR_hidden", repositoryId: 13 }))));
    store.putSyncStatus(SYNC_FIXTURES.failed);
  });
}

describe("owner overview boundary", () => {
  it("requires the owner for both snapshot and upgrade", async () => {
    for (const path of [SNAPSHOT_PATH, SOCKET_PATH]) {
      const response = await exports.default.fetch(`${BASE}${path}`, { headers: { origin: BASE, upgrade: "websocket" } });
      expect(response.status).toBe(401);
    }
  });
  it("returns a derived owner snapshot of only monitored PRs", async () => {
    const cookie = await ownerSession();
    await seed();
    const response = await exports.default.fetch(`${BASE}${SNAPSHOT_PATH}`, { headers: { cookie } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { buckets: { rows: { pr: { nodeId: string }; facts: { isOwners: boolean } }[] }[] };
    const rows = body.buckets.flatMap((bucket) => bucket.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pr: { nodeId: "PR_example" }, facts: { isOwners: true } });
  });
  it("refuses absent and cross-site Origin, HEAD and ordinary requests", async () => {
    const cookie = await ownerSession();
    for (const origin of [undefined, "https://elsewhere.test"]) {
      const headers: Record<string, string> = { cookie, upgrade: "websocket" };
      if (origin) headers.origin = origin;
      expect((await exports.default.fetch(`${BASE}${SOCKET_PATH}`, { headers })).status).toBe(403);
    }
    expect((await fetchWithConfig({ OWNER_ID: "1001" }, SOCKET_PATH, { method: "HEAD", headers: { cookie, origin: BASE, upgrade: "websocket" } })).status).toBe(405);
    expect((await exports.default.fetch(`${BASE}${SOCKET_PATH}`, { headers: { cookie, origin: BASE } })).status).toBe(426);
  });
  it("does not permit direct object fetch without a persisted session", async () => {
    const response = await instanceStub(env).fetch(`${BASE}${SOCKET_PATH}`, { headers: { origin: BASE, upgrade: "websocket", "x-seshat-session-key": "forged" } });
    expect(response.status).toBe(401);
  });
  it("sends a snapshot, auto-responds to keep-alives and persists visibility across hibernation", async () => {
    const cookie = await ownerSession();
    await seed();
    const { client, message } = await connect(cookie);
    expect(message?.type === "snapshot" && message.snapshot.sync).toEqual(SYNC_FIXTURES.failed);
    const pong = nextMessage(client);
    client.send(KEEP_ALIVE_REQUEST);
    expect((await pong).data).toBe(KEEP_ALIVE_RESPONSE);
    const stub = instanceStub(env);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.getWebSocketAutoResponse()?.request).toBe(KEEP_ALIVE_REQUEST);
      expect((state.getWebSockets()[0]!.deserializeAttachment() as SocketAttachment).visibility).toBeNull();
    });
    client.send(JSON.stringify({ type: "visibility", visible: true, reportedAt: -1 }));
    await vi.waitFor(async () => {
      await runInDurableObject(stub, (_instance, state) => {
        const attachment = state.getWebSockets()[0]!.deserializeAttachment() as SocketAttachment;
        expect(attachment.visibility?.visible).toBe(true);
        expect(attachment.visibility?.reportedAt).toBeGreaterThan(FIXTURE_NOW);
      });
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, state) => {
      expect((state.getWebSockets()[0]!.deserializeAttachment() as SocketAttachment).visibility?.visible).toBe(true);
    });
    const update = nextMessage(client);
    await stub.publishOverview({ type: "sync", sync: SYNC_FIXTURES.live, serverTime: Date.now() });
    expect(parseServerMessage((await update).data)?.type).toBe("sync");
  });
  it("closes malformed or binary client messages", async () => {
    for (const message of ["{", new Uint8Array([1, 2, 3])]) {
      const { client } = await connect(await ownerSession());
      const closed = nextClose(client);
      client.send(message);
      expect((await closed).code).toBe(1008);
    }
  });
  it("closes all sockets for a signed-out session before publishing more private data", async () => {
    const cookie = await ownerSession();
    const { client } = await connect(cookie);
    const closed = nextClose(client);
    await exports.default.fetch(`${BASE}/auth/sign-out`, { method: "POST", headers: { cookie, origin: BASE }, redirect: "manual" });
    expect((await closed).code).toBe(1008);
  });
  it("checks expiry on publication and messages even after the socket upgrades", async () => {
    const cookie = await ownerSession();
    const { client } = await connect(cookie);
    const closed = nextClose(client);
    await runInDurableObject(instanceStub(env), (_instance, state) => {
      state.storage.sql.exec("UPDATE sessions SET expires_at = ?", Date.now() - 1);
    });
    await instanceStub(env).publishOverview({ type: "sync", sync: SYNC_FIXTURES.live, serverTime: Date.now() });
    expect((await closed).code).toBe(1008);
  });
});
