/**
 * Offline recovery proof against disposable Miniflare persistence. No live
 * configuration, remote calls, production entrypoint changes, or PITR claims.
 * Run: node scripts/acceptance-recovery.mjs
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

process.umask(0o077);
const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceRoot = path.join(root, ".context", "recovery");
await mkdir(evidenceRoot, { recursive: true });
// Always allocate a new private directory: this script cannot restore an
// operator-supplied path or overwrite a previous run, even on failure.
const evidence = await mkdtemp(path.join(evidenceRoot, "run-"));
const active = path.join(evidence, "active");
const checkpoint = path.join(evidence, "checkpoint");
const restored = path.join(evidence, "restored");
const undo = path.join(evidence, "before-restore");
const report = { source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), checks: [], outboundRequests: 0 };
const record = (name) => { report.checks.push(name); console.log(`recovery: ${name}`); };
const cookie = randomBytes(32).toString("base64url");
const sessionKey = createHash("sha256").update(cookie).digest("hex");
let runtime;

async function bundle(mode) {
  const result = await build({
    stdin: {
      contents: `
        import { WorkerEntrypoint } from "cloudflare:workers";
        import worker from "./src/worker/index.ts";
        import { InstanceObject } from "./src/object/instance.ts";
        import { MIGRATIONS } from "./src/object/schema.ts";
        import { OverviewStore } from "./src/object/overview-store.ts";
        import { RepositoryDiscoveryStore } from "./src/object/repository-discovery-store.ts";
        import { FIXTURE_REPOSITORY, fixturePr } from "./src/shared/overview/fixtures.ts";
        ${mode === "migration" ? `MIGRATIONS.push({ version: MIGRATIONS.length + 1, statements: ["ALTER TABLE settings ADD COLUMN recovery_marker TEXT"] });` : ""}
        export class RecoveryInstance extends InstanceObject {
          async control(op, key) {
            await this.health();
            const sql = this.ctx.storage.sql;
            if (op === "seed") {
              await this.createSession(key, Date.now(), 1001);
              sql.exec("INSERT INTO installations VALUES (9,1001,'User','accepted','all'), (20,2002,'Organization','accepted','selected'), (21,2003,'Organization','pending','all')");
              sql.exec("INSERT INTO settings VALUES ('installation-refused:22', 'true')");
              new RepositoryDiscoveryStore(this.ctx.storage).saveMonitoringOverride(99, 1001, false);
              new RepositoryDiscoveryStore(this.ctx.storage).saveMonitoringOverride(12, 1001, true);
              const store = new OverviewStore(this.ctx.storage);
              store.putRepository({ ...FIXTURE_REPOSITORY, monitorOverride: true });
              store.putPullRequest(fixturePr());
              store.putSyncStatus({ ...store.syncStatus(), lastSuccessfulSweepAt: Date.now() });
            } else if (op === "damage") {
              sql.exec("DELETE FROM settings");
              sql.exec("UPDATE installations SET status='pending' WHERE id=20");
              sql.exec("DELETE FROM pull_requests");
              await this.endSession(key);
            } else if (op === "invalidate") {
              // Test-only maintenance step, before any public requests after restore.
              sql.exec("DELETE FROM sessions");
              await this.ctx.storage.deleteAlarm();
            }
            const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' ORDER BY name").toArray();
            return Object.fromEntries(tables.map(({name}) => [name, sql.exec('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY 1').toArray()]));
          }
        }
        export default ${mode === "broken" ? `{ fetch() { return new Response("synthetic code regression", { status: 503 }); } }` : "worker"};
        export class RecoveryControl extends WorkerEntrypoint {
          async fetch(request) {
            const {op,key} = await request.json();
            const instance = this.env.INSTANCE.getByName("instance");
            return Response.json(await instance.control(op,key));
          }
        }
      `,
      sourcefile: "recovery-entry.ts", resolveDir: root, loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2024", external: ["cloudflare:*"],
  });
  return result.outputFiles[0].text;
}
const codes = Object.fromEntries(await Promise.all(["current", "broken", "migration"].map(async (mode) => [mode, await bundle(mode)])));
await writeFile(path.join(evidence, "bundles.json"), JSON.stringify(Object.fromEntries(Object.entries(codes).map(([mode, code]) => [mode, createHash("sha256").update(code).digest("hex")]))));

async function stop() {
  if (runtime) { await runtime.dispose(); runtime = undefined; }
}
async function start(directory, mode = "current") {
  assert.equal(runtime, undefined, "Stop the runtime before switching code or copying state");
  runtime = new Miniflare(convertV4MiniflareOptions({
    port: 0, cf: false, telemetry: { enabled: false }, resourcePersistencePath: directory,
    workers: [
      {
        name: "recovery-app", modules: true, script: codes[mode], compatibilityDate: "2026-10-12",
        bindings: { OWNER_ID: "1001", INSTANCE_LOCATION_HINT: "wnam" },
        durableObjects: { INSTANCE: { className: "RecoveryInstance", useSQLite: true } },
        outboundService: () => { report.outboundRequests++; throw new Error("Recovery proof forbids outbound requests"); },
      },
      {
        name: "controls", modules: true, script: "export default { fetch() { return new Response(null, {status:404}); } }",
        compatibilityDate: "2026-10-12",
        serviceBindings: { CONTROL: { name: "recovery-app", entrypoint: "RecoveryControl" } },
      },
    ],
  }));
  await runtime.ready;
}
async function command(op = "inspect") {
  const { CONTROL } = await runtime.getBindings("controls");
  const response = await CONTROL.fetch("http://control/", { method: "POST", body: JSON.stringify({ op, key: sessionKey }) });
  assert.equal(response.status, 200);
  return response.json();
}
async function request(route, authenticated = false) {
  return runtime.dispatchFetch(`http://localhost${route}`, { headers: authenticated ? { cookie: `seshat-session=${cookie}` } : {} });
}
async function copyStopped(source, target) {
  assert.equal(runtime, undefined, "Never copy an open SQLite database or WAL");
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
}

try {
  await start(active);
  const baseline = await command("seed");
  const schemaVersion = baseline.schema_version[0].version;
  assert.equal((await request("/api/overview", true)).status, 200);
  assert.equal((await request("/api/overview")).status, 401);
  await stop();
  await copyStopped(active, checkpoint);
  await writeFile(path.join(evidence, "baseline.json"), JSON.stringify(baseline, null, 2));
  record(`captured stopped-runtime checkpoint at schema ${schemaVersion}`);

  await start(active, "broken");
  await command("damage");
  assert.equal((await request("/api/health")).status, 503);
  await stop();
  await start(active);
  assert.equal((await request("/api/health")).status, 200);
  const damaged = await command();
  assert.notDeepEqual(damaged.settings, baseline.settings);
  assert.equal(damaged.installations.find(({id}) => id === 20).status, "pending");
  assert.equal((await request("/api/overview", true)).status, 401);
  record("code rollback repaired HTTP health while damaged choices and revoked session remained");
  await stop();

  await start(active, "migration");
  assert.equal((await command()).schema_version[0].version, schemaVersion + 1);
  await stop();
  await start(active);
  // The real application's migration guard must refuse the future schema.
  assert.equal((await request("/api/health")).status, 500);
  record("code rollback refused a synthetic newer SQL schema");
  await stop();
  await copyStopped(active, undo);
  await copyStopped(checkpoint, restored);
  await start(restored);
  const recovered = await command();
  assert.deepEqual(recovered, baseline);
  assert.deepEqual(await (await request("/api/health")).json(), { ok: true, schemaVersion });
  // Do not exercise HTTP with the revoked cookie before invalidation. The
  // restored session row proves that whole-database restore resurrected it.
  assert.equal(recovered.sessions.some(({key}) => key === sessionKey), true);
  await command("invalidate");
  assert.equal((await request("/api/overview", true)).status, 401);
  assert.equal((await request("/api/overview")).status, 401);
  record("restored every application row; invalidated resurrected sessions before owner HTTP access");
  await stop();
  await start(restored);
  assert.equal((await command()).sessions.length, 0);
  assert.equal((await request("/api/overview", true)).status, 401);
  const freshCookie = randomBytes(32).toString("base64url");
  const freshKey = createHash("sha256").update(freshCookie).digest("hex");
  const instance = (await runtime.getDurableObjectNamespace("INSTANCE", "recovery-app")).getByName("instance");
  await instance.createSession(freshKey, Date.now(), 1001);
  const overview = await runtime.dispatchFetch("http://localhost/api/overview", { headers: { cookie: `seshat-session=${freshCookie}` } });
  assert.equal(overview.status, 200);
  const snapshot = await overview.json();
  assert.equal(snapshot.buckets.flatMap(({rows}) => rows).length, 1);
  record("restart retained session invalidation and restored overview accepted a fresh synthetic owner session");
  await stop();
  await start(undo, "migration");
  assert.equal((await command()).schema_version[0].version, schemaVersion + 1);
  assert.equal((await command()).pull_requests.length, 0);
  record("preserved pre-restore state is separately readable with its matching code");
  assert.equal(report.outboundRequests, 0);
  report.schemaVersion = schemaVersion;
  report.result = "passed";
} finally {
  await stop();
  await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2));
  console.log(`recovery: evidence ${path.relative(root, evidence)}`);
}
