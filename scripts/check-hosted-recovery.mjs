/** Offline checks of the hosted fixture's safeguards; native PITR is NOT simulated. */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { bundleFixture, targetIdentity, prepare, root } from "./prepare-hosted-recovery.mjs";

import { loadArtifacts, endpointFor, bookmarkEvidence } from "./hosted-recovery-control.mjs";

execFileSync(path.join(root, "node_modules/.bin/tsc"), ["--ignoreConfig", "--noEmit", "--target", "ES2024", "--lib", "ES2024", "--module", "ESNext", "--moduleResolution", "bundler", "--skipLibCheck", "worker-configuration.d.ts", "scripts/recovery/fixture.ts"], { cwd: root, stdio: "inherit" });
const target = targetIdentity("0".repeat(32), "seshat-recovery-proof-offline", "example");
assert.throws(() => targetIdentity(target.account, "seshat"));
assert.throws(() => targetIdentity("", target.name));
const token = "1".repeat(64);
const directory = await mkdtemp(path.join(tmpdir(), "seshat-hosted-fixture-"));
const artifacts = await prepare(target);
const loaded = await loadArtifacts(artifacts);
assert.equal(loaded.manifest.name, target.name);
const cleanupConfig = JSON.parse(await readFile(path.join(artifacts, "wrangler.cleanup.json"), "utf8"));
assert.equal(cleanupConfig.account_id, target.account);
assert.equal(cleanupConfig.name, target.name);
assert.equal(cleanupConfig.main, "./cleanup.mjs");
assert.equal(cleanupConfig.durable_objects, undefined);
assert.equal(cleanupConfig.vars, undefined);
assert.deepEqual(cleanupConfig.migrations, [
  { tag: "recovery-fixture-v1", new_sqlite_classes: ["RecoveryFixture"] },
  { tag: "recovery-fixture-v2", deleted_classes: ["RecoveryFixture"] },
]);
assert.equal(Object.keys(loaded.manifest.sha256).length, 8);
const tombstone = new Miniflare(convertV4MiniflareOptions({
  port: 0, cf: false, telemetry: { enabled: false },
  workers: [{ name: target.name, modules: true, script: await readFile(path.join(artifacts, "cleanup.mjs"), "utf8"), compatibilityDate: "2026-10-12" }],
}));
try { assert.equal((await tombstone.dispatchFetch("http://fixture/recovery/inspect")).status, 410); }
finally { await tombstone.dispose(); }
assert.equal(endpointFor(loaded.manifest, `https://${target.name}.example.workers.dev`), `https://${target.name}.example.workers.dev`);
assert.throws(() => endpointFor(loaded.manifest, "https://seshat.example.workers.dev"));
assert.throws(() => endpointFor(loaded.manifest, `https://${target.name}.different-account.workers.dev`));
assert.throws(() => endpointFor(loaded.manifest, `https://${target.name}.example.workers.dev.attacker.example`));
assert.throws(() => bookmarkEvidence({ target, response: { bookmark: "x" } }, loaded.manifest, "bookmark"));
assert.equal(bookmarkEvidence({ target, status: 200, operation: "bookmark", observedIdentity: { objectId: "a".repeat(64) }, response: { bookmark: "example" } }, loaded.manifest, "bookmark").value, "example");
assert.equal(bookmarkEvidence({ target, status: 200, operation: "prepare-restore", observedIdentity: { objectId: "a".repeat(64) }, response: { undoBookmark: "native-undo" } }, loaded.manifest, "undoBookmark").value, "native-undo");
let runtime;
let outbound = 0;
const codes = Object.fromEntries(await Promise.all(["current", "broken", "migration"].map(async mode => [mode, await bundleFixture(target, mode, "offline-self-check")])));
async function start(mode = "current", overrides = {}) {
  runtime = new Miniflare(convertV4MiniflareOptions({
    port: 0, cf: false, telemetry: { enabled: false }, resourcePersistencePath: directory,
    workers: [{
      name: target.name, modules: true, script: codes[mode], compatibilityDate: "2026-10-12",
      bindings: { OWNER_ID: "1001", RECOVERY_ACCOUNT: target.account, RECOVERY_NAME: target.name, RECOVERY_MAINTENANCE: "enabled", RECOVERY_TOKEN: token, RECOVERY_NATIVE_PITR: "disabled-local", ...overrides },
      durableObjects: { RECOVERY: { className: "RecoveryFixture", useSQLite: true } },
      outboundService: () => { outbound++; throw new Error("No network allowed"); },
    }],
  }));
  await runtime.ready;
}
async function stop() { await runtime?.dispose(); runtime = undefined; }
async function command(op, input = {}, auth = token) {
  return runtime.dispatchFetch(`http://fixture/recovery/${op}`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ target, ...input }) });
}
try {
  await start();
  assert.equal((await runtime.dispatchFetch("http://fixture/recovery/status")).status, 401);
  assert.equal((await command("seed", {}, "wrong")).status, 401);
  assert.equal((await command("status", { target: { ...target, name: "seshat" } })).status, 409);
  assert.equal((await command("status", { padding: "a".repeat(5000) })).status, 400);
  assert.equal((await runtime.dispatchFetch("http://fixture/api/health")).status, 503);
  assert.deepEqual(await (await command("inspect")).json(), {}); // Refusal did not initialize DB.
  const status = await (await command("status")).json();
  assert.equal(status.name, target.name);
  assert.equal(status.mode, "current");
  assert.match(status.objectId, /^[a-f0-9]{64}$/);
  assert.equal((await command("restart", { undoBookmark: "unrecorded" })).status, 409);
  assert.equal((await command("seed")).status, 200);
  assert.equal((await command("seed")).status, 409);
  const baseline = await (await command("inspect")).json();
  assert.equal(baseline.sessions.length, 1);
  assert.equal(baseline.pull_requests.length, 1);
  assert.equal((await command("health")).status, 200);
  assert.equal((await command("invalidate-sessions")).status, 200);
  await stop();
  await start();
  assert.equal((await (await command("inspect")).json()).sessions.length, 0);
  const bookmark = await command("bookmark");
  assert.equal(bookmark.status, 501);
  assert.deepEqual(await bookmark.json(), { error: "native-pitr-disabled-local", localProof: false });
  assert.equal((await command("prepare-restore", { bookmark: "valid-looking-local-bookmark" })).status, 501);
  assert.equal((await command("restart")).status, 409);
  await stop();
  await start("broken");
  assert.equal((await command("health")).status, 503);
  assert.equal((await command("damage")).status, 200);
  await stop();
  await start();
  assert.equal((await command("health")).status, 200);
  const damaged = await (await command("inspect")).json();
  assert.equal(damaged.pull_requests.length, 0);
  assert.equal(damaged.installations.find(row => row.id === 20).status, "pending");
  await stop();
  await start("migration");
  assert.equal((await command("health")).status, 200);
  await stop();
  await start();
  assert.equal((await command("health")).status, 500);
  assert.equal((await command("inspect")).status, 200);
  assert.equal((await command("invalidate-sessions")).status, 200);
  await stop();
  await start("current", { RECOVERY_NAME: "seshat" });
  assert.equal((await command("status")).status, 503);
  await stop();
  await start("current", { RECOVERY_MAINTENANCE: "disabled" });
  assert.equal((await command("status")).status, 503);
  assert.equal(outbound, 0);
  console.log("hosted fixture: auth/body/identity/maintenance guards, synthetic state, code/schema rollback and local PITR refusal passed; zero network requests");
} finally { await stop(); await rm(directory, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
