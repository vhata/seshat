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
let heldRepositoryRead = null;
const repositoryReadGates = [];
function holdRepositoryRead() {
  let entered;
  let release;
  const gate = {
    entered: new Promise((resolve) => { entered = resolve; }),
    response: new Promise((resolve) => { release = resolve; }),
    enter: () => entered(), release: () => release(),
  };
  heldRepositoryRead = gate;
  repositoryReadGates.push(gate);
  return gate;
}
const unexpected = [];
const installation = { id: 9, account: { id: 1001, login: "example", type: "User" }, repository_selection: "all", suspended_at: null };
const restRepository = { id: 12, node_id: "R_example", full_name: "example/observatory", owner: { id: 1001, login: "example" }, visibility: "public", fork: false, archived: false };
let listing = [restRepository];
async function github(request) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.origin}${url.pathname}`;
  const call = { route, at: now };
  calls.push(call);
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
    call.status = response.status;
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
    call.operation = query.match(/query\s+(\w+)/)?.[1];
    call.ids = variables.ids ?? (variables.id ? [variables.id] : []);
    const repositoryFor = (id) => {
      const listed = listing.find((entry) => entry.node_id === id);
      return { ...repository, id, databaseId: listed?.id ?? repository.databaseId, nameWithOwner: listed?.full_name ?? repository.nameWithOwner };
    };
    const nodes = query.includes("SeshatPrCounts")
      ? variables.ids.map((id) => ({ ...repositoryFor(id), pullRequests: { totalCount: id === repository.id ? prs.filter((p) => p.state === "OPEN").length : 0 } }))
      : query.includes("SeshatRepositoryPrs")
        ? variables.ids.map((id) => ({ ...repositoryFor(id), pullRequests: connection(id === repository.id ? prs.filter((p) => p.state === "OPEN") : []) }))
        : variables.ids.map((id) => prs.find((p) => p.id === id) ?? null);
    if (query.includes("SeshatRepositoryPrs") && heldRepositoryRead) {
      const gate = heldRepositoryRead;
      heldRepositoryRead = null;
      gate.enter();
      await gate.response;
    }
    return Response.json({ data: { nodes, rateLimit: { cost: 1, remaining: 4900, limit: 5000, resetAt: iso(now + 3_600_000) } } });
  }
  const number = Number(url.pathname.match(/\/pulls\/(\d+)/)?.[1]);
  const current = prs.find((p) => p.number === number);
  if (request.method === "GET" && current && url.pathname.endsWith("/reviews")) return Response.json(current.reviews.nodes.map((review) => ({ id: review.databaseId, node_id: review.id, commit_id: review.commit?.oid ?? null })));
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
  let manualPosts = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/repositories/refresh-one") manualPosts++;
  });
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
  await page.locator(".last-check").filter({ hasText: "Last full check:" }).waitFor();
  const initialChecks = (await command("snapshot")).freshness;
  assert.ok(initialChecks.repositories["12"].lastSuccessfulCheckAt !== null);
  assert.ok(initialChecks.pullRequests.PR_1.lastSuccessfulCheckAt !== null);
  const checkTrigger = page.locator('[data-pr="PR_1"] .check-trigger');
  const checkDetails = page.locator('[data-pr="PR_1"] [role="tooltip"]');
  await checkTrigger.focus();
  await checkDetails.waitFor({ state: "visible" });
  assert.ok((await checkDetails.innerText()).includes("Repository fully checked"));
  assert.ok((await checkDetails.innerText()).includes("This PR checked"));
  assert.equal(await checkTrigger.getAttribute("aria-describedby"), await checkDetails.getAttribute("id"));
  await checkTrigger.press("Escape");
  await checkDetails.waitFor({ state: "hidden" });
  await checkTrigger.blur();
  await checkTrigger.hover();
  await checkDetails.waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(evidence, "freshness-details.png") });
  await page.mouse.move(0, 0);
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
  const webhookChecks = (await command("snapshot")).freshness;
  assert.equal(webhookChecks.repositories["12"].lastSuccessfulCheckAt, initialChecks.repositories["12"].lastSuccessfulCheckAt,
    "An individual PR reread cannot claim a full repository check");
  assert.ok(webhookChecks.pullRequests.PR_1.lastSuccessfulCheckAt > initialChecks.pullRequests.PR_1.lastSuccessfulCheckAt);
  assert.equal(await page.locator('[data-pr="PR_1"] .badge.stale').count(), 1,
    "Fresh GitHub evidence must not clear the independent inactivity flag");
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
  assert.ok((await command("snapshot")).freshness.repositories["13"].lastSuccessfulCheckAt !== null,
    "A complete empty repository read supplies freshness evidence");
  await page.locator(".repository-checks summary").click();
  const emptyRepositoryDetails = page.locator(".repository-checks li").filter({ hasText: "example/new-repository" });
  await emptyRepositoryDetails.locator(".check-trigger").focus();
  await emptyRepositoryDetails.getByRole("tooltip").waitFor({ state: "visible" });
  assert.ok((await emptyRepositoryDetails.getByRole("tooltip").innerText()).includes("Repository fully checked"));
  await page.locator(".repository-checks summary").click();
  // Manual reconciliation uses a single repository's complete open set,
  // independently of discovery and of the aggregate scheduled sweep time.
  prs[2] = { ...prs[2], mergeable: "MERGEABLE" };
  await advance(6000);
  await visibility(false);
  const manualChecks = [];
  function selectedOnly(before, nodeId) {
    const observed = calls.slice(before);
    assert.ok(observed.some((call) => call.operation === "SeshatRepositoryPrs"));
    assert.ok(observed.every((call) => !call.route.endsWith("/installation/repositories")),
      "A repository refresh must not request installation discovery");
    assert.ok(observed.every((call) => call.operation !== "SeshatPrCounts"),
      "A repository refresh must not start the all-repository count phase");
    for (const call of observed.filter((call) => call.operation === "SeshatRepositoryPrs")) {
      assert.deepEqual(call.ids, [nodeId], "Only the requested repository may be reconciled");
    }
  }
  async function clickRefresh(control, repositoryId) {
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/repositories/refresh-one");
    await control.click();
    const accepted = await response;
    assert.equal(accepted.status(), 202);
    const receipt = await accepted.json();
    assert.equal(receipt.ok, true);
    assert.equal(receipt.attempt.result, "queued");
    const snapshot = await command("snapshot");
    assert.equal(snapshot.freshness.repositoryRefreshes[String(repositoryId)].latestAttempt.id, receipt.attempt.id);
    return receipt.attempt;
  }
  const beforeManual = await command("snapshot");
  const originalPrs = [...prs];
  prs = [{ ...prs[0], state: "CLOSED" }, ...prs.slice(1), pr(8, { title: "Missed open discovered by targeted refresh" })];
  const held = holdRepositoryRead();
  const selectedControl = page.locator('[data-pr="PR_1"] .repository-refresh button');
  const beforeSelectedCalls = calls.length;
  const beforeSelectedPosts = manualPosts;
  const request = await clickRefresh(selectedControl, 12);
  await page.locator('[data-pr="PR_1"] .repository-refresh [role=status]').filter({ hasText: "Requested refresh: queued." }).waitFor();
  await selectedControl.evaluate((button) => { button.click(); button.click(); });
  assert.equal(manualPosts, beforeSelectedPosts + 1, "Disabled repeated clicks send no extra requests");
  const reading = drain(1);
  let entryTimeout;
  try {
    await Promise.race([held.entered, new Promise((_, reject) => {
      entryTimeout = setTimeout(() => reject(new Error("Targeted refresh did not begin its repository read")), 10_000);
    })]);
  } finally { clearTimeout(entryTimeout); }
  await page.locator('[data-pr="PR_1"] .repository-refresh [role=status]').filter({ hasText: "Requested refresh: running;" }).waitFor();
  const duplicate = await page.evaluate(async () => {
    const response = await fetch("/api/repositories/refresh-one", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: 12, ownerAccountId: 1001 }),
    });
    return response.json();
  });
  assert.equal(duplicate.attempt.id, request.id, "A concurrent request coalesces onto the running work");
  held.release();
  await reading;
  await drain();
  const afterManual = await command("snapshot");
  assert.equal(afterManual.freshness.repositoryRefreshes["12"].latestAttempt.result, "success");
  assert.equal(afterManual.freshness.repositoryRefreshes["12"].latestAttempt.id, request.id);
  assert.equal(afterManual.sync.lastSuccessfulSweepAt, beforeManual.sync.lastSuccessfulSweepAt);
  assert.equal(afterManual.buckets.flatMap((bucket) => bucket.rows).some((row) => row.pr.nodeId === "PR_1"), false);
  await page.locator('[data-pr="PR_8"]').waitFor();
  await page.locator('[data-pr="PR_1"]').waitFor({ state: "detached" });
  await page.locator('[data-pr="PR_8"] .repository-refresh [role=status]').filter({ hasText: "Requested refresh: completed;" }).waitFor();
  selectedOnly(beforeSelectedCalls, "R_example");
  manualChecks.push("selected repository only", "queued and running feedback", "duplicate request coalescing", "missed open and close reconciliation");
  await page.screenshot({ path: path.join(evidence, "manual-refresh-completed.png"), fullPage: true });
  prs = originalPrs;
  await clickRefresh(page.locator('[data-pr="PR_8"] .repository-refresh button'), 12);
  await drain();
  await page.locator('[data-pr="PR_1"]').waitFor();
  await page.locator('[data-pr="PR_8"]').waitFor({ state: "detached" });

  // A failed explicit request retains its identity and the cached PRs while
  // ordinary retry deadlines run; a later successful request confirms recovery.
  failing = true;
  const failedRequest = await clickRefresh(page.locator('[data-pr="PR_1"] .repository-refresh button'), 12);
  await drain();
  await advance(30_100);
  const failedManual = await command("snapshot");
  assert.equal(failedManual.freshness.repositoryRefreshes["12"].latestAttempt.id, failedRequest.id);
  assert.equal(failedManual.freshness.repositoryRefreshes["12"].latestAttempt.result, "failed");
  assert.equal(await page.locator(".pr-row").count(), 7, "Manual failure must retain all cached rows");
  await page.locator('[data-pr="PR_1"] .repository-refresh [role=alert]').filter({ hasText: "Cached data retained." }).waitFor();
  await page.screenshot({ path: path.join(evidence, "manual-refresh-failed.png"), fullPage: true });
  failing = false;
  await clickRefresh(page.locator('[data-pr="PR_1"] .repository-refresh button'), 12);
  await drain();
  await page.locator('[data-pr="PR_1"] .repository-refresh [role=status]').filter({ hasText: "Requested refresh: completed;" }).waitFor();
  manualChecks.push("failed request preserves cached rows", "explicit recovery confirms a new request");
  await visibility(true);

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

  // Muting is a persisted display preference: the same monitored PRs keep
  // updating over the real socket while the muted section stays collapsed.
  const beforeMute = await command("snapshot");
  await page.goto(`${origin}/repositories`);
  const mute = page.getByRole("button", { name: "Mute example/observatory", exact: true });
  await mute.waitFor();
  await mute.focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Unmute example/observatory", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Unmute example/observatory", exact: true }).waitFor();
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent === "Refresh listings");
    return button && !button.disabled;
  });
  await page.getByRole("button", { name: "Unmute example/observatory", exact: true }).waitFor();
  await page.getByRole("link", { name: "PR overview", exact: true }).click();
  const muted = page.locator("details.muted-repositories");
  const mutedSummary = muted.locator("summary");
  await mutedSummary.waitFor();
  // Finish the repository read queued by Refresh listings before isolating
  // the later PR-only webhook observation from concurrent reconciliation.
  await drain();
  assert.equal(await muted.getAttribute("open"), null, "Muted repositories start collapsed");
  assert.equal(await page.locator(".buckets .pr-row").count(), 0, "Muted rows leave the regular buckets");
  assert.equal(await muted.locator(".pr-row").count(), 7, "Muting retains every cached PR");
  assert.match(await mutedSummary.textContent(), /1 repositor(?:y|ies).*7 (?:open )?PRs/);
  for (const heading of await page.locator(".buckets .group-heading h2").allTextContents()) {
    assert.match(heading, /0\s*$/, "Active group counts exclude muted PRs");
  }
  assert.equal(await page.getByText("No repositories monitored yet", { exact: true }).count(), 0);
  let mutedSnapshot = await command("snapshot");
  assert.equal(mutedSnapshot.repositories.find((repo) => repo.id === 12)?.muted, true);
  assert.equal(mutedSnapshot.repositories.find((repo) => repo.id === 12)?.monitored, true);
  assert.equal(mutedSnapshot.sync.intervalMs, beforeMute.sync.intervalMs, "Muting keeps the normal reconciliation interval");

  await mutedSummary.focus();
  await page.keyboard.press("Enter");
  assert.equal(await muted.evaluate((element) => element.open), true, "Enter expands the native muted disclosure");
  for (const bucket of beforeMute.buckets.filter((bucket) => bucket.rows.length)) {
    assert.ok((await muted.getByRole("heading", { name: bucket.bucket.title, exact: false }).count()) > 0, `Muted PRs retain ${bucket.bucket.title}`);
  }
  const mutedFreshnessTrigger = muted.locator('[data-pr="PR_1"] .check-trigger');
  await mutedFreshnessTrigger.focus();
  const mutedFreshnessDetails = muted.locator('[data-pr="PR_1"] [role=tooltip]');
  await mutedFreshnessDetails.waitFor({ state: "visible" });
  assert.ok((await mutedFreshnessDetails.innerText()).includes("Repository fully checked"));
  assert.ok((await mutedFreshnessDetails.innerText()).includes("This PR checked"));
  await mutedFreshnessTrigger.press("Escape");
  await page.screenshot({ path: path.join(evidence, "muted-expanded.png"), fullPage: true });
  await mutedSummary.focus();
  await page.keyboard.press("Space");
  assert.equal(await muted.evaluate((element) => element.open), false, "Space collapses the native muted disclosure");

  await webhook("edited", { title: "Muted webhook update stays collapsed" });
  const mutedWebhookChecks = (await command("snapshot")).freshness;
  assert.equal(mutedWebhookChecks.repositories["12"].lastSuccessfulCheckAt,
    mutedSnapshot.freshness.repositories["12"].lastSuccessfulCheckAt);
  assert.ok(mutedWebhookChecks.pullRequests.PR_1.lastSuccessfulCheckAt >
    mutedSnapshot.freshness.pullRequests.PR_1.lastSuccessfulCheckAt);
  await page.waitForFunction(() => document.querySelector(".muted-repositories")?.textContent.includes("Muted webhook update stays collapsed"));
  assert.equal(await muted.evaluate((element) => element.open), false, "New activity must not expand or unmute");
  assert.equal(await page.locator(".buckets .pr-row").count(), 0);
  const lastMutedSweep = (await command("snapshot")).sync.lastSuccessfulSweepAt;
  const collapsedCalls = calls.length;
  prs[0] = { ...prs[0], title: "Muted missed delivery caught by scheduled sweep" };
  await advance(120_000);
  await page.waitForFunction(() => document.querySelector(".muted-repositories")?.textContent.includes("Muted missed delivery caught by scheduled sweep"));
  mutedSnapshot = await command("snapshot");
  assert.ok(calls.length > collapsedCalls, "Collapsed muted PRs still receive scheduled GitHub reads");
  assert.ok(mutedSnapshot.sync.lastSuccessfulSweepAt > lastMutedSweep, "Muted repository reads retain freshness reporting");
  assert.ok(mutedSnapshot.freshness.repositories["12"].lastSuccessfulCheckAt >
    mutedWebhookChecks.repositories["12"].lastSuccessfulCheckAt);
  assert.equal(mutedSnapshot.repositories.find((repo) => repo.id === 12)?.muted, true);
  assert.equal(await muted.evaluate((element) => element.open), false);
  await page.screenshot({ path: path.join(evidence, "muted-collapsed.png"), fullPage: true });

  await page.goto(`${origin}/repositories`);
  await page.getByRole("switch", { name: "Monitor example/observatory", exact: true }).click();
  await page.waitForFunction(() => {
    const input = document.querySelector('input[aria-label="Monitor example/observatory"]');
    return input && !input.checked && !input.disabled;
  });
  assert.equal((await command("snapshot")).repositories.find((repo) => repo.id === 12)?.muted, true, "Monitoring off keeps the mute choice");
  await page.getByRole("switch", { name: "Monitor example/observatory", exact: true }).click();
  await page.waitForFunction(() => {
    const input = document.querySelector('input[aria-label="Monitor example/observatory"]');
    return input && input.checked && !input.disabled;
  });
  await page.getByRole("link", { name: "PR overview", exact: true }).click();
  await page.waitForTimeout(150);
  await drain();
  await page.waitForFunction(() => document.querySelectorAll(".muted-repositories .pr-row").length === 7);
  await mutedSummary.focus();
  await page.keyboard.press("Enter");
  const unmute = muted.getByRole("button", { name: "Unmute example/observatory", exact: true });
  await unmute.focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelectorAll(".buckets .pr-row").length === 7);
  await page.waitForFunction(() => document.activeElement === document.querySelector(".muted-repositories summary"));
  assert.equal((await command("snapshot")).repositories.find((repo) => repo.id === 12)?.muted, false, "Explicit keyboard unmute restores the regular buckets");

  // An empty muted repository contributes to the repository count, with no
  // PRs to infer its existence from and an explicit way to unmute it.
  listing = listing.map((repo) => repo.id === 13 ? { ...repo, archived: false } : repo);
  await sendDelivery("repository", { action: "unarchived", repository: { ...created, archived: false } });
  await page.goto(`${origin}/repositories`);
  await page.getByRole("button", { name: "Mute example/new-repository", exact: true }).click();
  await page.getByRole("button", { name: "Unmute example/new-repository", exact: true }).waitFor();
  await page.getByRole("link", { name: "PR overview", exact: true }).click();
  await mutedSummary.waitFor();
  assert.match(await mutedSummary.textContent(), /1 repositor(?:y|ies).*0 (?:open )?PRs/);
  assert.equal(await page.locator(".buckets .pr-row").count(), 7);
  // Empty muted repositories have a refresh action even without a PR row.
  await visibility(false);
  await drain();
  await page.locator(".repository-checks summary").click();
  const emptyRefresh = page.locator(".repository-checks li").filter({ hasText: "example/new-repository" });
  const emptyCalls = calls.length;
  const emptyRequest = await clickRefresh(emptyRefresh.getByRole("button", { name: "Refresh example/new-repository", exact: true }), 13);
  await drain();
  await emptyRefresh.locator(".repository-refresh [role=status]").filter({ hasText: "Requested refresh: completed;" }).waitFor();
  const emptySnapshot = await command("snapshot");
  assert.equal(emptySnapshot.freshness.repositoryRefreshes["13"].latestAttempt.id, emptyRequest.id);
  assert.equal(emptySnapshot.freshness.repositoryRefreshes["13"].latestAttempt.result, "success");
  assert.equal(emptySnapshot.repositories.find((repo) => repo.id === 13)?.muted, true);
  selectedOnly(emptyCalls, "R_created");
  manualChecks.push("empty muted repository refresh");
  await page.locator(".repository-checks summary").click();
  await visibility(true);

  await mutedSummary.focus();
  await page.keyboard.press("Enter");
  await muted.getByRole("button", { name: "Unmute example/new-repository", exact: true }).click();
  await page.waitForFunction(() => /0 repositories.*0 (?:open )?PRs/.test(document.querySelector(".muted-repositories summary")?.textContent ?? ""));
  assert.equal(await muted.getByRole("button", { name: /^Unmute / }).count(), 0);
  assert.ok((await muted.textContent()).includes("No muted repositories are monitored."));
  listing = listing.map((repo) => repo.id === 13 ? { ...repo, archived: true } : repo);
  await sendDelivery("repository", { action: "archived", repository: { ...created, archived: true } });

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
  const beforeRestart = (await command("snapshot")).freshness;
  await mf.unsafeEvictDurableObject("app", "AcceptanceInstance", { name: "instance", webSockets: "close" });
  await page.getByText("Disconnected — reconnecting to the instance").waitFor();
  await advance(1200, { alarm: false });
  await page.locator(".status-live").waitFor();
  assert.deepEqual((await command("snapshot")).freshness, beforeRestart,
    "Restart and reconnect must retain check evidence without inventing a read");
  const widths = [];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator(".repository-checks summary").click();
    const repositoryTrigger = page.locator(".repository-checks .check-trigger").last();
    await repositoryTrigger.focus();
    const tooltip = page.locator(".repository-checks [role=tooltip]").last();
    await tooltip.waitFor({ state: "visible" });
    const bounds = await tooltip.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width,
      `Freshness details exceed the ${width}px viewport: ${JSON.stringify(bounds)}`);
    await page.locator(".repository-checks summary").click();
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
  await page.getByText("Your session has ended. Sign in again to continue.").waitFor();
  await page.getByRole("link", { name: "Sign in with GitHub" }).waitFor();
  assert.equal(await page.locator(".pr-row").count(), 0);
  assert.equal(await page.getByText("Disconnected — reconnecting to the instance").count(), 0);
  const endedSockets = sockets.length;
  await page.waitForTimeout(1500);
  assert.equal(sockets.length, endedSockets, "Ended sessions must stop reconnecting");
  await page.screenshot({ path: path.join(evidence, "session-ended.png") });
  const summary = { rows: 7, buckets: 7, transitions, manualChecks, widths, sockets: sockets.length, githubCalls: calls.length, errors, external, unexpected, scenarios: ["owner-gated snapshot", "real WebSocket", "all seven buckets", "stale flags", "signed webhooks", "visible missed-event sweep", "dormancy without reads", "visibility catch-up", "repository routing and monitoring changes", "persistent repository mute through reload and discovery", "active and muted counts including empty repository", "keyboard mute disclosure and explicit unmute", "muted webhook and scheduled updates while collapsed", "mute independent from monitoring", "checking before overdue", "failed sync preserves rows", "retry recovers", "object restart and reconnect", "phone readability", "session revocation returns to sign-in", "scoped repository and PR evidence", "hover and keyboard freshness details", "PR reread preserves repository check time", "empty repository check", "object restart retains check evidence"] };
  await writeFile(path.join(evidence, "results.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  }
} finally {
  for (const gate of repositoryReadGates) gate.release();
  await browser?.close();
  await mf.dispose();
}
