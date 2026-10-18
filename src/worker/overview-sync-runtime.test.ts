import { env, exports } from "cloudflare:workers";
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewStore } from "../object/overview-store";
import { fixturePr, FIXTURE_REPOSITORY } from "../shared/overview/fixtures";
import { parseServerMessage, SOCKET_PATH, type OverviewSnapshot, type SocketAttachment } from "../shared/overview/protocol";
import { utf8 } from "../shared/encoding";
import { signWebhookBody } from "../shared/webhook";
import { receiveWebhook } from "./webhook";
import { readConfig } from "../shared/config";
import { instanceStub } from "./instance-stub";
import { BASE, ownerSession } from "./test-helpers";

const START = Date.now() + 3_600_000;
let clock = START;
let clients: WebSocket[] = [];
beforeEach(() => { clock = START; vi.spyOn(Date, "now").mockImplementation(() => clock); });
afterEach(async () => {
  for (const client of clients) client.close(); clients = [];
  await reset(); vi.restoreAllMocks();
});
const tail = { nodes: [] };
const connection = (nodes: unknown[]) => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } });
const owner = { databaseId: 1001, login: "example", __typename: "User" };
const repo = { id: "R_example", databaseId: 12, nameWithOwner: "example/observatory", visibility: "PUBLIC", owner };
function githubPr(changes: Record<string, unknown> = {}) {
  return { id: "PR_example", databaseId: 3, number: 1, state: "OPEN", title: "Changed on GitHub", url: "https://github.com/example/observatory/pull/1", repository: repo,
    createdAt: new Date(START - 15 * 86_400_000).toISOString(), updatedAt: new Date(clock).toISOString(), isDraft: false, headRefOid: "head", mergeable: "MERGEABLE", author: owner,
    reviews: connection([]), commits: { totalCount: 1 }, comments: tail, forcePush: tail, stateChange: tail, statusCheckRollup: { contexts: connection([]) }, ...changes };
}
function github(current: () => ReturnType<typeof githubPr>, options: { failing?: () => boolean; remaining?: number; resetAt?: number } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const address = String(url);
    if (options.failing?.()) return new Response(null, { status: 503 });
    if (address.endsWith("/access_tokens")) return Response.json({ token: "secret-installation-token", expires_at: new Date(clock + 3_600_000).toISOString() }, { status: 201 });
    if (address.includes("/installation/repositories?")) return Response.json({ total_count: 1, repositories: [{ id: 12, node_id: "R_example", full_name: "example/observatory", owner: { id: 1001, login: "example" }, visibility: "public", fork: false, archived: false }] });
    if (address.endsWith("/graphql")) {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      const nodes = query.includes("SeshatPrCounts") ? [{ ...repo, pullRequests: { totalCount: 1 } }]
        : query.includes("SeshatRepositoryPrs") ? [{ ...repo, pullRequests: connection([current()]) }] : [current()];
      return Response.json({ data: { nodes, rateLimit: { cost: 1, remaining: options.remaining ?? 4900, limit: 5000, resetAt: new Date(options.resetAt ?? clock + 3_600_000).toISOString() } } });
    }
    if (address.includes("/commits?")) return Response.json([{ sha: "head", commit: { committer: { date: new Date(START - 15 * 86_400_000).toISOString() } } }]);
    if (address.endsWith("/pulls/1")) return Response.json({ mergeable: true, head: { sha: "head" } });
    throw new Error(`Unanswered GitHub call: ${address}`);
  });
}
async function seed() {
  const stub = instanceStub(env); await stub.health();
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("INSERT INTO installations VALUES (9,1001,'User','accepted','all')");
    const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY); store.putPullRequest(fixturePr());
  });
  return stub;
}
async function openSocket() {
  const cookie = await ownerSession();
  const response = await exports.default.fetch(`${BASE}${SOCKET_PATH}`, { headers: { cookie, origin: BASE, upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const client = response.webSocket!; clients.push(client);
  const snapshots: OverviewSnapshot[] = [];
  client.addEventListener("message", (event) => {
    const message = parseServerMessage(event.data); if (message?.type === "snapshot") snapshots.push(message.snapshot);
  });
  client.accept(); await vi.waitFor(() => expect(snapshots).toHaveLength(1));
  return { client, snapshots };
}
async function report(client: WebSocket, visible: boolean, type = "visibility") {
  client.send(JSON.stringify({ type, visible }));
  await vi.waitFor(async () => runInDurableObject(instanceStub(env), (_instance, state) => {
    const report = (state.getWebSockets()[0]!.deserializeAttachment() as SocketAttachment).visibility;
    expect(report).toEqual({ visible, reportedAt: clock });
  }));
}
async function alarm() { expect(await runDurableObjectAlarm(instanceStub(env))).toBe(true); clock++; }
async function webhook(action: string, pr: Record<string, unknown> = {}) {
  const body = JSON.stringify({ installation: { id: 9 }, repository: { id: 12, owner: { id: 1001 }, visibility: "public" }, action,
    pull_request: { node_id: "PR_example", updated_at: new Date(clock).toISOString(), head: { sha: "head" }, ...pr } });
  return exports.default.fetch(`${BASE}/api/github/webhook`, { method: "POST", headers: { "x-github-event": "pull_request", "x-hub-signature-256": await signWebhookBody("test-webhook-secret", utf8(body)) }, body });
}

describe("Worker, durable scheduler and real owner sockets", () => {
  it("acknowledges durable webhook marks before any API call and delivers the authoritative row within 60 seconds", async () => {
    const calls = github(() => githubPr()); const stub = await seed(); const { snapshots } = await openSocket();
    const receivedAt = clock;
    expect((await webhook("synchronize")).status).toBe(202); expect(calls).not.toHaveBeenCalled();
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT value FROM settings WHERE key='overview-sync-work-v1'").toArray()).toHaveLength(1);
    });
    clock += 2000; await alarm();
    await vi.waitFor(() => expect(snapshots.at(-1)?.buckets.flatMap((bucket) => bucket.rows)[0]?.pr.title).toBe("Changed on GitHub"));
    expect(clock - receivedAt).toBeLessThan(60_000);
    expect(snapshots.at(-1)?.sync.lastSuccessfulSweepAt).toBeNull();
    expect(snapshots.at(-1)?.buckets.flatMap((bucket) => bucket.rows)).toHaveLength(1);
    await runInDurableObject(stub, (_instance, state) => { expect(JSON.stringify(state.storage.sql.exec("SELECT * FROM settings").toArray())).not.toContain("secret-installation-token"); });
  });

  it("catches a dropped event through the visible sweep and stops without a grace tail", async () => {
    let draft = false; const calls = github(() => githubPr({ isDraft: draft })); const stub = await seed(); const { client, snapshots } = await openSocket();
    await report(client, true); for (let i = 0; i < 4; i++) await alarm();
    await vi.waitFor(() => expect(snapshots.at(-1)?.sync.lastSuccessfulSweepAt).toBe(START));
    draft = true; clock = START + 120_000; for (let i = 0; i < 4; i++) await alarm();
    await vi.waitFor(() => expect(snapshots.at(-1)?.buckets.flatMap((bucket) => bucket.rows)[0]?.pr.isDraft).toBe(true));
    expect(clock - START).toBeLessThan(300_000);
    const before = calls.mock.calls.length; await report(client, false);
    clock += 120_000; expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(calls.mock.calls.length).toBe(before);
    expect(snapshots.at(-1)?.buckets.flatMap((bucket) => bucket.rows)).toHaveLength(1);
  });

  it("hibernates visibility, expires a sleeping page after 15 minutes, and re-arms a broken alarm on the overdue report", async () => {
    const calls = github(() => githubPr()); const stub = await seed(); const { client } = await openSocket();
    await report(client, true); for (let i = 0; i < 4; i++) await alarm();
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, state) => { expect((state.getWebSockets()[0]!.deserializeAttachment() as SocketAttachment).visibility?.reportedAt).toBe(START); });
    clock = START + 900_001; const before = calls.mock.calls.length; await alarm();
    expect(calls.mock.calls.length).toBe(before);
    await runInDurableObject(stub, async (_instance, state) => { expect(await state.storage.getAlarm()).toBeNull(); });
    await report(client, true, "overdue");
    await runInDurableObject(stub, async (_instance, state) => { expect(await state.storage.getAlarm()).toBe(clock); await state.storage.deleteAlarm(); });
    await report(client, true, "overdue");
    await runInDurableObject(stub, async (_instance, state) => { expect(await state.storage.getAlarm()).toBe(clock); });
    for (let i = 0; i < 4; i++) await alarm();
    const successAt = (await stub.overviewSnapshot(clock)).sync.lastSuccessfulSweepAt!;
    expect(successAt).toBeGreaterThanOrEqual(START + 900_001);
    expect(successAt).toBeLessThanOrEqual(START + 900_002);
  }, 20_000);

  it("reports handoff failure instead of acknowledging a delivery that was not stored", async () => {
    const body = JSON.stringify({ installation: { id: 9 }, action: "created" });
    const request = new Request(`${BASE}/api/github/webhook`, { method: "POST", headers: { "x-github-event": "installation", "x-hub-signature-256": await signWebhookBody("test-webhook-secret", utf8(body)) }, body });
    const response = await receiveWebhook({ request, now: clock, url: new URL(request.url), secure: true, session: null,
      config: readConfig(env as unknown as Record<string, unknown>),
      env: { ...env, INSTANCE: { getByName: () => ({ receiveDelivery: async () => { throw new Error("storage write failed"); } }) } } as unknown as Env,
    });
    expect(response.status).toBe(503);
  });

  it("bounds an installation guard invocation even when many foreign installations need deletion", async () => {
    const installations = Array.from({ length: 100 }, (_, index) => ({ id: index + 20, account: { id: index + 4000, login: `foreign${index}`, type: "User" }, repository_selection: "all" }));
    const calls = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/app/installations?")) return Response.json(installations);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(String(url));
    });
    // The first full 100-item page requires an empty second page.
    calls.mockImplementation(async (url, init) => {
      if (String(url).includes("/app/installations?")) return Response.json(String(url).endsWith("page=1") ? installations : []);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(String(url));
    });
    const result = await instanceStub(env).checkInstallations(clock);
    expect(result.ok).toBe(true);
    expect(calls.mock.calls.length).toBe(42);
    if (result.ok) { expect(result.deleted).toHaveLength(40); expect(result.undeleted).toHaveLength(60); }
    expect(calls.mock.calls.length).toBeLessThanOrEqual(50);
  });
  it("publishes both failed attempts and the later recovery to the connected owner", async () => {
    let failing = true; github(() => githubPr(), { failing: () => failing }); await seed(); const { client, snapshots } = await openSocket();
    await report(client, true); await alarm();
    clock = START + 15_000; await alarm();
    await vi.waitFor(() => expect(snapshots.at(-1)?.sync.latestAttempt).toMatchObject({ result: "failed", reason: "github-unavailable", unreadableRepositoryIds: [12] }));
    failing = false; clock = START + 60_000; await report(client, true, "retry-now");
    await alarm(); expect(snapshots.at(-1)?.sync.latestAttempt?.result).toBe("failed");
    for (let index = 0; index < 3; index++) await alarm();
    await vi.waitFor(() => expect(snapshots.at(-1)?.sync.latestAttempt?.result).toBe("success"));
  });

  it("publishes the ordinary interval when the reported rate window resets", async () => {
    github(() => githubPr(), { remaining: 450, resetAt: START + 60_000 }); await seed(); const { client, snapshots } = await openSocket();
    await report(client, true); for (let index = 0; index < 4; index++) await alarm();
    await vi.waitFor(() => expect(snapshots.at(-1)?.sync).toMatchObject({ intervalMs: 240_000, slowedByRateLimit: true }));
    clock = START + 60_001; await report(client, true);
    await vi.waitFor(() => expect(snapshots.at(-1)?.sync).toMatchObject({ intervalMs: 120_000, slowedByRateLimit: false }));
  });

});
