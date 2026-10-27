import assert from "node:assert/strict";
import test from "node:test";
import { inspectRunningRevision, main, parseArguments, readHealth } from "./inspect-revision.mjs";

const deployed = "11111111-1111-1111-1111-111111111111";
const older = "22222222-2222-2222-2222-222222222222";
const deploymentId = "33333333-3333-3333-3333-333333333333";
const sha = "a".repeat(40);
const origin = "https://instance.example";
function fixture(overrides = {}) {
  const calls = [];
  const deployment = overrides.deployment ?? {
    id: deploymentId, versions: [{ version_id: deployed, percentage: 100 }],
    author_email: "PRIVATE_EMAIL", annotations: { "workers/message": "PRIVATE_MESSAGE" },
  };
  const health = overrides.health ?? {
    ok: true, schemaVersion: 1, build: { commit: sha, dirty: false },
    version: { id: deployed }, privateData: "PRIVATE_HEALTH_DATA",
  };
  const version = overrides.version ?? {
    id: health.version?.id,
    annotations: { "workers/tag": sha, "workers/message": "PRIVATE_VERSION_MESSAGE" },
    resources: { bindings: [{ name: "PRIVATE_BINDING", value: "PRIVATE_BINDING_VALUE" }] },
  };
  let statusReads = 0;
  return { calls, options: { origin, name: "example-worker" }, dependencies: {
    runWrangler: async (args) => {
      calls.push(args);
      if (args[0] === "deployments") {
        statusReads += 1;
        return statusReads === 2 && overrides.after ? overrides.after : deployment;
      }
      return version;
    },
    fetchHealth: async (url) => { calls.push(url); return health; },
  } };
}
async function rejects(overrides, code) {
  const f = fixture(overrides);
  await assert.rejects(inspectRunningRevision(f.options, f.dependencies), { code });
}

test("verifies responding version against stable active deployment and exact version", async () => {
  const f = fixture();
  const result = await inspectRunningRevision(f.options, f.dependencies);
  assert.deepEqual(result, {
    verified: true, origin, schemaVersion: 1,
    build: { commit: sha, dirty: false }, version: { id: deployed, tag: sha },
    deployment: { id: deploymentId, versions: [{ id: deployed, percentage: 100 }] },
  });
  assert.deepEqual(f.calls, [
    ["deployments", "status", "--json", "--name", "example-worker"],
    `${origin}/api/health`,
    ["versions", "view", deployed, "--json", "--name", "example-worker"],
    ["deployments", "status", "--json", "--name", "example-worker"],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("uses configured Worker when --name omitted", async () => {
  const f = fixture();
  await inspectRunningRevision({ origin }, f.dependencies);
  assert.deepEqual(f.calls[0], ["deployments", "status", "--json"]);
  assert.deepEqual(f.calls[2], ["versions", "view", deployed, "--json"]);
});

test("rollback selects actual older responding version, never latest upload", async () => {
  const f = fixture({
    deployment: { id: deploymentId, versions: [{ version_id: older, percentage: 100 }] },
    health: { ok: true, schemaVersion: 2, build: { commit: sha, dirty: false }, version: { id: older } },
  });
  assert.equal((await inspectRunningRevision(f.options, f.dependencies)).version.id, older);
  assert.equal(f.calls[2][2], older);
});

test("gradual deployment verifies one response and reports all traffic allocations", async () => {
  const f = fixture({ deployment: { id: deploymentId, versions: [
    { version_id: older, percentage: 90 }, { version_id: deployed, percentage: 10 },
  ] } });
  const report = await inspectRunningRevision(f.options, f.dependencies);
  assert.equal(report.version.id, deployed);
  assert.deepEqual(report.deployment.versions, [{ id: deployed, percentage: 10 }, { id: older, percentage: 90 }]);
});

test("untagged version verifies clean running build and exact version", async () => {
  const f = fixture({ version: { id: deployed } });
  assert.equal((await inspectRunningRevision(f.options, f.dependencies)).version.tag, null);
});

test("latest-upload ID outside active deployment is refused", () => rejects({
  deployment: { id: deploymentId, versions: [{ version_id: older, percentage: 100 }] },
}, "version-inactive"));

test("zero-weight versions are inactive", () => rejects({
  deployment: { id: deploymentId, versions: [{ version_id: older, percentage: 100 }, { version_id: deployed, percentage: 0 }] },
}, "version-inactive"));

test("different exact version response is refused", () => rejects({ version: { id: older } }, "version-mismatch"));

for (const tag of ["b".repeat(40), "PRIVATE_TAG\nPRIVATE_SECRET", `${sha}\n`, "A".repeat(40), "", null, 12]) {
  test(`rejects mismatching or malformed annotation ${JSON.stringify(tag)}`, () => rejects({
    version: { id: deployed, annotations: { "workers/tag": tag } },
  }, "tag-mismatch"));
}

for (const build of [{ commit: sha, dirty: true }, { commit: null, dirty: null },
  { commit: sha, dirty: null }, { commit: "abc1234", dirty: false }, { commit: `${sha}\n`, dirty: false }, { commit: "A".repeat(40), dirty: false }, {}]) {
  test(`rejects unverified build ${JSON.stringify(build)}`, () => rejects({
    health: { ok: true, schemaVersion: 1, build, version: { id: deployed } },
  }, "build-unverified"));
}

for (const health of [{}, { ok: false },
  { ok: true, schemaVersion: "1", version: { id: deployed } },
  { ok: true, schemaVersion: 0, version: { id: deployed } },
  { ok: true, schemaVersion: 1, version: { id: null } }]) {
  test(`rejects incomplete health ${JSON.stringify(health)}`, () => rejects({ health }, "health-format"));
}

test("rejects deployment changed during inspection", () => rejects({ after: {
  id: older, versions: [{ version_id: deployed, percentage: 100 }],
} }, "deployment-changed"));

test("rejects traffic changed during inspection", () => rejects({ after: {
  id: deploymentId, versions: [{ version_id: deployed, percentage: 50 }, { version_id: older, percentage: 50 }],
} }, "deployment-changed"));

test("ignores unrelated deployment metadata and traffic ordering", async () => {
  const versions = [{ version_id: deployed, percentage: 80 }, { version_id: older, percentage: 20 }];
  const f = fixture({ deployment: { id: deploymentId, versions }, after: {
    id: deploymentId, versions: [...versions].reverse(), annotations: { "workers/message": "PRIVATE" },
  } });
  assert.equal((await inspectRunningRevision(f.options, f.dependencies)).verified, true);
});

for (const versions of [[], [{ version_id: "PRIVATE", percentage: 100 }],
  [{ version_id: deployed, percentage: -1 }], [{ version_id: deployed, percentage: "100" }],
  [{ version_id: deployed, percentage: NaN }], [{ version_id: deployed, percentage: 99 }],
  [{ version_id: deployed, percentage: 50 }, { version_id: deployed, percentage: 50 }]]) {
  test(`rejects malformed traffic ${JSON.stringify(versions)}`, () => rejects({
    deployment: { id: deploymentId, versions },
  }, "deployment-format"));
}

test("arguments reject credentials, extra flags and non-HTTPS fetches", () => {
  assert.deepEqual(parseArguments([`${origin}/`]), { origin, name: undefined });
  for (const args of [[], [origin, "--other"], [origin, "--name", "--help"],
    [origin, "--name", "worker\n"], ["http://instance.example"], ["https://user:password@instance.example"],
    [`${origin}/api/health`], [`${origin}?private=secret`], [`${origin}#secret`]]) {
    assert.throws(() => parseArguments(args), { code: "usage" });
  }
});

test("health GET has timeout, no redirects, and cache revalidation", async (t) => {
  const expected = { ok: true };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, `${origin}/api/health`);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["cache-control"], "no-cache");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => expected };
  });
  assert.deepEqual(await readHealth(`${origin}/api/health`), expected);
});

test("HTTP failures, network failures and non-JSON bodies fail safely", async (t) => {
  const stub = t.mock.method(globalThis, "fetch", async () => ({ ok: false }));
  await assert.rejects(readHealth(`${origin}/api/health`), { code: "health-http" });
  stub.mock.mockImplementation(async () => { throw new Error("PRIVATE_TRANSPORT"); });
  await assert.rejects(readHealth(`${origin}/api/health`), { code: "health-read" });
  stub.mock.mockImplementation(async () => ({ ok: true, json: async () => { throw new Error("PRIVATE_BODY"); } }));
  await assert.rejects(readHealth(`${origin}/api/health`), { code: "health-json" });
});

test("CLI allowlists success and suppresses raw dependency errors", async (t) => {
  let stdout = "";
  let stderr = "";
  t.mock.method(process.stdout, "write", (text) => { stdout += text; return true; });
  t.mock.method(process.stderr, "write", (text) => { stderr += text; return true; });
  const f = fixture();
  assert.equal(await main([origin], f.dependencies), 0);
  assert.equal(JSON.parse(stdout).verified, true);
  assert.doesNotMatch(stdout, /PRIVATE/);
  stdout = "";
  assert.equal(await main([origin], { runWrangler: async () => { throw new Error("PRIVATE_TOKEN"); } }), 1);
  assert.equal(stdout, "");
  assert.equal(stderr, "inspection-failed: Running revision inspection failed.\n");
});
