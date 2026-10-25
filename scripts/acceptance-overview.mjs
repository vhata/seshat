/**
 * Assembled acceptance: production React assets, Worker and Durable Object,
 * real Chromium WebSockets, and a strictly local stand-in for GitHub.
 *
 * Run after `npm run build`, with Playwright available to Node (or set
 * PLAYWRIGHT_MODULE to its module path). CHROMIUM_PATH selects an installed
 * browser. The default mode stubs GitHub and never reaches the network.
 * SESHAT_REAL_APP_VARS explicitly enables read-only live GitHub queries and
 * ephemeral token creation. Neither mode deploys or tunnels. Evidence is
 * ignored, including screenshots that may contain private repository data.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = path.join(root, ".context", "acceptance-overview");
await mkdir(evidence, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const liveVars = {};
if (process.env.SESHAT_REAL_APP_VARS) {
  const source = await readFile(process.env.SESHAT_REAL_APP_VARS, "utf8");
  for (const line of source.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'")) value = value.slice(1, -1);
    liveVars[match[1]] = value;
  }
  for (const name of ["OWNER_ID", "GITHUB_APP_SLUG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]) assert.ok(liveVars[name], `Missing configuration: ${name}`);
}
const live = Boolean(process.env.SESHAT_REAL_APP_VARS);
const key = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
let now = Date.now() + (live ? 0 : 3_600_000);
const began = now;
const owner = { databaseId: 1001, login: "example", __typename: "User" };
const repository = { id: "R_example", databaseId: 12, nameWithOwner: "example/observatory", visibility: "PUBLIC", owner };
const connection = (nodes) => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } });
const iso = (at = now) => new Date(at).toISOString();
const tail = (at = null) => ({ nodes: at ? [{ createdAt: iso(at) }] : [] });
function pr(number, overrides = {}) {
  return {
    id: `PR_${number}`, databaseId: number, number, state: "OPEN",
    title: `Pull request ${number}`, url: `https://github.com/example/observatory/pull/${number}`,
    repository, createdAt: iso(began - 10 * 86_400_000), updatedAt: iso(began - 8 * 86_400_000),
    isDraft: false, headRefOid: `head${number}`, mergeable: "MERGEABLE", author: owner,
    reviews: connection([]), commits: { totalCount: 1 }, comments: tail(), forcePush: tail(),
    stateChange: tail(), statusCheckRollup: { contexts: connection([]) }, ...overrides,
  };
}
let prs = [
  pr(1, { title: "Keep the overview current" }),
  pr(2, { title: "Repair the check pipeline", statusCheckRollup: { contexts: connection([{ __typename: "StatusContext", id: "CI_2", context: "CI", state: "FAILURE" }]) } }),
  pr(3, { title: "Update the dependency tree", author: { databaseId: 2002, login: "dependency-bot", __typename: "Bot" }, mergeable: "UNKNOWN" }),
  pr(4, { title: "Improve the review response", reviews: connection([{ id: "REVIEW_4", databaseId: 4, author: owner, state: "CHANGES_REQUESTED", submittedAt: iso(began - 9 * 86_400_000), commit: { oid: "head4" }, comments: tail() }]) }),
  pr(5, { title: "Add an incremental build cache", statusCheckRollup: { contexts: connection([{ __typename: "StatusContext", id: "CI_5", context: "CI", state: "PENDING" }]) } }),
  pr(6, { title: "Document the response format", author: { databaseId: 2003, login: "helper", __typename: "User" }, reviews: connection([{ id: "REVIEW_6", databaseId: 6, author: owner, state: "COMMENTED", submittedAt: iso(began - 9 * 86_400_000), commit: { oid: "head6" }, comments: tail() }]) }),
  pr(7, { title: "Explore rendering approaches", isDraft: true }),
];
let failing = false;
const calls = [];
const unexpected = [];
const installation = { id: 9, account: { id: 1001, login: "example", type: "User" }, repository_selection: "all", suspended_at: null };
const restRepository = { id: 12, node_id: "R_example", full_name: "example/observatory", owner: { id: 1001, login: "example" }, visibility: "public", fork: false, archived: false };
let listing = [restRepository];
async function github(request) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.origin}${url.pathname}`;
  calls.push({ route, at: now });
  if (live) {
    assert.equal(url.origin, "https://api.github.com", "Real-App probe only contacts GitHub's API");
    const token = request.method === "POST" && /^\/app\/installations\/[1-9][0-9]*\/access_tokens$/.test(url.pathname);
    const graphql = request.method === "POST" && url.pathname === "/graphql";
    assert.ok(request.method === "GET" || token || graphql, `Refused mutation: ${request.method} ${url.pathname}`);
    if (graphql) assert.match((await request.clone().json()).query, /^query\s/, "Real-App probe refuses GraphQL mutations");
    let response;
    try {
      response = await fetch(url, { method: request.method, headers: Object.fromEntries(request.headers), body: request.method === "POST" ? await request.text() : undefined, redirect: "manual" });
    } catch (error) {
      console.error("acceptance: live transport failed", { type: error.name, code: error.cause?.code });
      throw error;
    }
    calls.at(-1).status = response.status;
    // Node fetch has already decoded compression. Do not tell workerd that
    // the decoded bytes are still gzip encoded, or keep the encoded length.
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(await response.arrayBuffer(), { status: response.status, headers });
  }
  if (failing) return new Response(null, { status: 503 });
  if (route === "GET https://api.github.com/app/installations") return Response.json([installation]);
  if (route === "POST https://api.github.com/app/installations/9/access_tokens") return Response.json({ token: "acceptance-memory-only-token", expires_at: iso(now + 7_200_000) }, { status: 201 });
  if (route === "GET https://api.github.com/installation/repositories") return Response.json({ total_count: listing.length, repositories: listing });
  if (route === "GET https://api.github.com/user/1001") return Response.json({ id: 1001, login: "example" });
  if (route === "GET https://api.github.com/repos/example/observatory/collaborators/example/permission") return Response.json({ permission: "admin", user: { id: 1001, login: "example" } });
  if (route === "POST https://api.github.com/graphql") {
    const { query, variables } = await request.json();
    const repositoryFor = (id) => {
      const listed = listing.find((entry) => entry.node_id === id);
      return { ...repository, id, databaseId: listed?.id ?? repository.databaseId, nameWithOwner: listed?.full_name ?? repository.nameWithOwner };
    };
    const nodes = query.includes("SeshatPrCounts")
      ? variables.ids.map((id) => ({ ...repositoryFor(id), pullRequests: { totalCount: id === repository.id ? prs.filter((p) => p.state === "OPEN").length : 0 } }))
      : query.includes("SeshatRepositoryPrs")
        ? variables.ids.map((id) => ({ ...repositoryFor(id), pullRequests: connection(id === repository.id ? prs.filter((p) => p.state === "OPEN") : []) }))
        : variables.ids.map((id) => prs.find((p) => p.id === id) ?? null);
    return Response.json({ data: { nodes, rateLimit: { cost: 1, remaining: 4900, limit: 5000, resetAt: iso(now + 3_600_000) } } });
  }
  const number = Number(url.pathname.match(/\/pulls\/(\d+)/)?.[1]);
  const current = prs.find((p) => p.number === number);
  if (request.method === "GET" && current && url.pathname.endsWith("/commits")) return Response.json([{ sha: current.headRefOid, commit: { committer: { date: iso(began - 8 * 86_400_000) } } }]);
  if (request.method === "GET" && current && url.pathname.endsWith(`/pulls/${number}`)) return Response.json({ mergeable: current.mergeable === "UNKNOWN" ? null : current.mergeable === "MERGEABLE", head: { sha: current.headRefOid } });
  unexpected.push(route);
  return new Response("Unexpected outbound request", { status: 500 });
}

// Only this generated test bundle exports the service-binding control. The
// deployed entrypoint and InstanceObject remain the production implementations.
// CONTROL is reachable through Miniflare's binding API, never through HTTP.
const bundle = await build({
  stdin: {
    contents: `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import worker, { InstanceObject } from "./src/worker/index.ts";
      export { InstanceObject };
      export class AcceptanceInstance extends InstanceObject {
        async runAcceptanceAlarm() { await super.alarm(); }
      }
      export default worker;
      let now = ${now};
      Date.now = () => now;
      export class AcceptanceControl extends WorkerEntrypoint {
        async fetch(request) {
          const command = await request.json();
          if (command.now !== undefined) now = command.now;
          const instance = this.env.INSTANCE.getByName("instance");
          if (command.op === "seed") {
            await instance.createSession(command.key, now, Number(this.env.OWNER_ID));
            await instance.checkInstallations(now);
          } else if (command.op === "alarm") {
            for (let i = 0; i < (command.count ?? 1); i++) { now++; await instance.runAcceptanceAlarm(); }
          } else if (command.op === "end-session") await instance.endSession(command.key);
          return Response.json(await instance.overviewSnapshot(now));
        }
      }
    `,
    resolveDir: root,
    sourcefile: "acceptance-entry.ts",
    loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2024", external: ["cloudflare:*"],
});
const mf = new Miniflare(convertV4MiniflareOptions({
  port: 0,
  cf: false,
  telemetry: { enabled: false },
  workers: [
    {
      name: "app", modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-12",
      bindings: {
        OWNER_ID: "1001", INSTANCE_LOCATION_HINT: "wnam", GITHUB_APP_SLUG: "acceptance-test",
        GITHUB_CLIENT_ID: "Iv23acceptance", GITHUB_CLIENT_SECRET: "acceptance-client-secret",
        GITHUB_PRIVATE_KEY: key.privateKey, GITHUB_WEBHOOK_SECRET: "acceptance-webhook-secret",
        ...liveVars,
      },
      durableObjects: { INSTANCE: { className: "AcceptanceInstance", useSQLite: true } },
      assets: {
        directory: path.join(root, "dist/client"),
        run_worker_first: ["/api", "/api/*", "/auth/*", "/setup", "/setup/*"],
        routerConfig: { has_user_worker: true },
        assetConfig: { not_found_handling: "single-page-application" },
      },
      outboundService: github,
    },
    {
      name: "controls", modules: true, script: "export default { fetch() { return new Response(null, {status: 404}); } }",
      serviceBindings: { CONTROL: { name: "app", entrypoint: "AcceptanceControl" } },
      compatibilityDate: "2026-10-12",
    },
  ],
}));
let browser;
try {
  console.log("acceptance: starting local Workers runtime");
  const origin = (await mf.ready).origin;
  const control = (await mf.getBindings("controls")).CONTROL;
  async function command(op, data = {}) {
    if (live) now = Date.now();
    const response = await control.fetch("http://control/", { method: "POST", body: JSON.stringify({ op, now, ...data }) });
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    if (op === "alarm") now = snapshot.serverTime;
    return snapshot;
  }
  const cookie = randomBytes(32).toString("base64url");
  const sessionKey = createHash("sha256").update(cookie).digest("hex");
  await command("seed", { key: sessionKey });
  console.log("acceptance: owner session seeded through private binding");
  const sessionResponse = await fetch(`${origin}/api/session`, { headers: { cookie: `seshat-session=${cookie}` } });
  assert.equal(sessionResponse.status, 200, `Owner session gate: ${await sessionResponse.text()}`);
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: "seshat-session", value: cookie, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  const external = [];
  const sockets = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("websocket", (socket) => sockets.push(socket));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  // Visibility reports use the actual client handler and the real socket.
  // A controlled document property makes tab visibility repeatable headlessly.
  await page.addInitScript(() => {
    window.acceptanceVisibility = "visible";
    Object.defineProperty(document, "visibilityState", { get: () => window.acceptanceVisibility });
  });
  await page.clock.install({ time: now });
  await page.goto(origin);
  console.log("acceptance: browser loaded production assets");
  async function drain(count = 12) { return command("alarm", { count }); }
  async function advance(ms, { alarm = true } = {}) {
    const target = now + ms;
    while (now < target) {
      const step = Math.min(15_000, target - now);
      now += step;
      await command("clock");
      await page.clock.fastForward(step);
      // Let the real network deliver auto-response pongs between fake timer
      // ticks. A single multi-minute jump would falsely look like a dead
      // connection to the production client's liveness timeout.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (alarm) await drain();
  }
  async function visibility(visible) {
    await page.evaluate((visible) => {
      window.acceptanceVisibility = visible ? "visible" : "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    }, visible);
    // Drain after the frame carrying the visibility report reaches the object.
    await page.waitForTimeout(100);
  }
  await page.waitForFunction(() => document.querySelector(".sync-pill"));
  await page.waitForTimeout(150);
  await drain();
  console.log("acceptance: initial sweep drained", { calls: calls.length, unexpected });
  if (live) {
    let snapshot = await command("snapshot");
    for (let round = 0; snapshot.sync.latestAttempt?.result !== "success" && round < 200; round++) {
      if (snapshot.sync.latestAttempt?.result === "failed") throw new Error(`Real-App sweep failed: ${snapshot.sync.latestAttempt.reason}`);
      // The real host can dispatch an automatic alarm while a network read
      // is in flight. Yield instead of repeatedly hitting its running guard.
      await new Promise((resolve) => setTimeout(resolve, 250));
      snapshot = await drain(5);
      if (round % 20 === 0) console.log("acceptance: live sweep progressing", { githubCalls: calls.length });
    }
    assert.equal(snapshot.sync.latestAttempt?.result, "success", `Real-App sweep did not complete; HTTP statuses ${calls.map((call) => call.status).join(",")}`);
    const rows = snapshot.buckets.flatMap((bucket) => bucket.rows);
    assert.equal(await page.locator(".pr-row").count(), rows.length);
    assert.equal(new Set(rows.map((row) => row.pr.nodeId)).size, rows.length);
    await page.setViewportSize({ width: 390, height: 844 });
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    assert.ok(dimensions.width <= dimensions.viewport);
    await page.screenshot({ path: path.join(evidence, "real-app-phone-private.png"), fullPage: true });
    await page.screenshot({ path: path.join(evidence, "real-app-phone-viewport-private.png") });
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(external.length, 0, JSON.stringify(external));
    const summary = { realApp: true, completedAt: new Date().toISOString(), repositories: snapshot.repositories.length, rows: rows.length, uniqueRows: new Set(rows.map((row) => row.pr.nodeId)).size, privateRepositories: snapshot.repositories.filter((repo) => repo.visibility !== "public").length, dimensions, sockets: sockets.length, githubCalls: calls.length, errors, external, lastSuccessfulSweepAt: snapshot.sync.lastSuccessfulSweepAt, mutationsAllowed: ["ephemeral installation token creation"] };
    await writeFile(path.join(evidence, "real-app-results.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
    process.exitCode = 0;
  } else {
  await page.locator(".pr-row").first().waitFor();
  assert.equal(await page.locator(".pr-row").count(), 7);
  assert.equal(new Set(await page.locator(".pr-row").evaluateAll((rows) => rows.map((row) => row.dataset.pr))).size, 7);
  for (const bucket of ["ready-to-land", "broken", "awaiting-your-review", "changes-requested-on-yours", "ci-running", "waiting-on-the-author", "draft"]) {
    assert.equal(await page.locator(`#rows-${bucket} .pr-row`).count(), 1, bucket);
  }
  assert.equal(await page.locator(".badge.stale").count(), 7);
  assert.equal(await page.locator("a a").count(), 0);
  await page.screenshot({ path: path.join(evidence, "desktop.png"), fullPage: true });

  const transitions = [];
  async function sendDelivery(event, payload) {
    const body = JSON.stringify({ installation: { id: 9 }, repository: { id: 12, owner: { id: 1001 }, visibility: "public" }, ...payload });
    const before = calls.length;
    const response = await fetch(`${origin}/api/github/webhook`, { method: "POST", body, headers: { "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", "acceptance-webhook-secret").update(body).digest("hex")}` } });
    assert.equal(response.status, 202);
    assert.equal(calls.length, before, "Webhook acknowledgement must make no GitHub reads");
    const reported = now;
    await advance(2500);
    transitions.push({ event, action: payload.action ?? payload.state, elapsedMs: now - reported });
  }
  async function webhook(action, change) {
    prs[0] = { ...prs[0], ...change, updatedAt: iso() };
    await sendDelivery("pull_request", { action, pull_request: { node_id: "PR_1", head: { sha: prs[0].headRefOid }, updated_at: iso(), merged: prs[0].state === "MERGED" } });
  }
  await webhook("edited", { title: "Title updated through a real socket" });
  await page.getByRole("link", { name: "Title updated through a real socket" }).waitFor();
  await webhook("converted_to_draft", { isDraft: true });
  assert.equal(await page.locator('#rows-draft [data-pr="PR_1"]').count(), 1);
  await webhook("ready_for_review", { isDraft: false });
  await webhook("closed", { state: "CLOSED" });
  await page.locator('[data-pr="PR_1"]').waitFor({ state: "detached" });
  await webhook("reopened", { state: "OPEN" });
  await page.locator('[data-pr="PR_1"]').waitFor();
  await webhook("synchronize", { headRefOid: "new-head1" });
  prs[0] = { ...prs[0], statusCheckRollup: { contexts: connection([{ __typename: "StatusContext", id: "CI_1", context: "CI", state: "PENDING" }]) } };
  await sendDelivery("status", { sha: "new-head1", context: "CI", state: "pending", updated_at: iso() });
  assert.equal(await page.locator('#rows-ci-running [data-pr="PR_1"]').count(), 1);
  prs[0] = { ...prs[0], statusCheckRollup: { contexts: connection([{ __typename: "CheckRun", id: "CHECK_1", databaseId: 101, name: "Build", status: "COMPLETED", conclusion: "SUCCESS" }]) } };
  await sendDelivery("check_run", { action: "completed", check_run: { id: 101, head_sha: "new-head1", status: "completed", conclusion: "success", completed_at: iso(), pull_requests: [{ node_id: "PR_1" }] } });
  assert.equal(await page.locator('#rows-ready-to-land [data-pr="PR_1"]').count(), 1);
  prs[0] = { ...prs[0], reviews: connection([{ id: "REVIEW_1", databaseId: 101, author: owner, state: "CHANGES_REQUESTED", submittedAt: iso(), commit: { oid: "new-head1" }, comments: tail() }]) };
  await sendDelivery("pull_request_review", { action: "submitted", pull_request: { node_id: "PR_1", updated_at: iso() }, review: { id: 101, state: "changes_requested", submitted_at: iso() } });
  assert.equal(await page.locator('#rows-changes-requested-on-yours [data-pr="PR_1"]').count(), 1);
  await webhook("closed", { state: "MERGED" });
  await page.locator('[data-pr="PR_1"]').waitFor({ state: "detached" });
  await webhook("opened", { state: "OPEN", reviews: connection([]) });
  await page.locator('[data-pr="PR_1"]').waitFor();
  const created = { ...restRepository, id: 13, node_id: "R_created", full_name: "example/new-repository" };
  listing = [...listing, created];
  await sendDelivery("repository", { action: "created", repository: created });
  assert.equal((await command("snapshot")).repositories.find((repo) => repo.id === 13)?.monitored, true, "A newly created owned repository must become monitored automatically");
  listing = listing.map((repo) => repo.id === 13 ? { ...repo, archived: true } : repo);
  await sendDelivery("repository", { action: "archived", repository: { ...created, archived: true } });
  assert.equal((await command("snapshot")).repositories.find((repo) => repo.id === 13)?.monitored, false, "Archiving must stop monitoring without owner action");

  // No webhook: the next scheduled sweep must replace stale row data.
  prs[0] = { ...prs[0], title: "Missed delivery recovered while visible" };
  const missedAt = now;
  await advance(120_000);
  await page.getByRole("link", { name: prs[0].title }).waitFor();
  assert.ok(now - missedAt <= 300_000);
  prs[2] = { ...prs[2], mergeable: "MERGEABLE" };
  await advance(6000);
  await visibility(false);
  const dormantCalls = calls.length;
  prs[0] = { ...prs[0], title: "Catch-up after becoming visible" };
  await advance(360_000);
  assert.equal(calls.length, dormantCalls, "Hidden overview must not make scheduled GitHub reads");
  await visibility(true);
  await drain();
  await page.getByRole("link", { name: prs[0].title }).waitFor();

  await page.goto(`${origin}/repositories`);
  await page.getByRole("heading", { name: "Repositories", exact: true }).waitFor();
  await page.getByRole("switch", { name: "Monitor example/observatory" }).click();
  await page.waitForFunction(() => { const input = document.querySelector('input[aria-label="Monitor example/observatory"]'); return input && !input.checked && !input.disabled; });
  assert.equal((await command("snapshot")).buckets.flatMap((bucket) => bucket.rows).length, 0);
  await page.getByRole("switch", { name: "Monitor example/observatory" }).click();
  await page.waitForFunction(() => { const input = document.querySelector('input[aria-label="Monitor example/observatory"]'); return input && input.checked && !input.disabled; });
  await page.getByRole("link", { name: "PR overview" }).click();
  await page.waitForTimeout(150);
  await drain();
  await page.locator(".pr-row").first().waitFor();

  await visibility(false);
  await advance(360_000);
  await visibility(true);
  await page.getByText("● Checking", { exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0, "A newly visible stale overview must say checking first");
  await advance(60_100, { alarm: false });
  await page.getByText("Sync overdue — these pull requests may be out of date").waitFor();
  failing = true;
  await drain();
  await advance(15_100);
  await page.getByText("Sync failed — the sweep and its retry both failed").waitFor();
  assert.equal(await page.locator(".pr-row").count(), 7, "Failure must preserve known rows");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(evidence, "phone-failed.png"), fullPage: true });
  failing = false;
  // Catch-up and explicit retry share the specified per-instance minute
  // throttle. Let it expire before asking for a manual recovery attempt.
  await advance(60_000, { alarm: false });
  await page.getByRole("button", { name: "Retry now" }).click();
  await page.waitForTimeout(100);
  await drain();
  await page.locator(".status-live").waitFor();
  await mf.unsafeEvictDurableObject("app", "AcceptanceInstance", { name: "instance", webSockets: "close" });
  await page.getByText("Disconnected — reconnecting to the instance").waitFor();
  await advance(1200, { alarm: false });
  await page.locator(".status-live").waitFor();
  const widths = [];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    assert.ok(dimensions.width <= width, `Phone horizontal overflow: ${JSON.stringify(dimensions)}`);
    widths.push(dimensions);
    await page.screenshot({ path: path.join(evidence, `phone-${width}.png`), fullPage: true });
    await page.screenshot({ path: path.join(evidence, `phone-${width}-viewport.png`) });
  }
  assert.ok(sockets.length >= 2, "Navigation must establish real sockets");
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(external.length, 0, JSON.stringify(external));
  assert.equal(unexpected.length, 0, JSON.stringify(unexpected));
  const anonymous = await browser.newContext();
  const denied = await anonymous.request.get(`${origin}/api/overview`);
  assert.equal(denied.status(), 401);
  assert.ok(!(await denied.text()).includes("observatory"));
  await command("end-session", { key: sessionKey });
  await page.getByText("Disconnected — reconnecting to the instance").waitFor();
  const summary = { rows: 7, buckets: 7, transitions, widths, sockets: sockets.length, githubCalls: calls.length, errors, external, unexpected, scenarios: ["owner-gated snapshot", "real WebSocket", "all seven buckets", "stale flags", "signed webhooks", "visible missed-event sweep", "dormancy without reads", "visibility catch-up", "repository routing and monitoring changes", "checking before overdue", "failed sync preserves rows", "retry recovers", "object restart and reconnect", "phone readability", "session revocation disconnects"] };
  await writeFile(path.join(evidence, "results.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  }
} finally {
  await browser?.close();
  await mf.dispose();
}
