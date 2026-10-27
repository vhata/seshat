/**
 * Read-only identity check against the requested instance and Cloudflare's
 * active deployment. Wrangler JSON includes configuration: consume it in
 * memory and print only the validated identity fields below.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const commit = /^[0-9a-f]{40}$/;
const isUuid = (value) => typeof value === "string" && value.length === 36 && uuid.test(value);
const isCommit = (value) => typeof value === "string" && value.length === 40 && commit.test(value);

export class InspectionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new InspectionError(code, message);
}

export function parseArguments(args) {
  if (args.length !== 1 && !(args.length === 3 && args[1] === "--name")) {
    fail("usage", "Usage: node scripts/inspect-revision.mjs https://INSTANCE [--name WORKER]");
  }
  let url;
  try { url = new URL(args[0]); } catch { fail("usage", "Provide an HTTPS instance origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    fail("usage", "Provide an HTTPS instance origin without credentials, paths, queries or fragments.");
  }
  const name = args[2];
  if (name !== undefined && (typeof name !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/.test(name) || name.trim() !== name)) {
    fail("usage", "Provide a valid Worker name.");
  }
  return { origin: url.origin, name };
}

function deploymentIdentity(value) {
  if (!isUuid(value?.id) || !Array.isArray(value.versions) || value.versions.length === 0) {
    fail("deployment-format", "Cloudflare did not return a recognized active deployment.");
  }
  const versions = value.versions.map((version) => {
    if (!isUuid(version?.version_id) || typeof version.percentage !== "number" ||
      !Number.isFinite(version.percentage) || version.percentage < 0 || version.percentage > 100) {
      fail("deployment-format", "Cloudflare did not return recognized deployment traffic.");
    }
    return { id: version.version_id, percentage: version.percentage };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(versions.map((version) => version.id)).size !== versions.length ||
    Math.abs(versions.reduce((sum, version) => sum + version.percentage, 0) - 100) > 0.000001) {
    fail("deployment-format", "Cloudflare did not return recognized deployment traffic.");
  }
  return { id: value.id, versions };
}

/** Inject both dependencies in tests; never consult the local Git checkout. */
export async function inspectRunningRevision(options, { runWrangler = runInstalledWrangler, fetchHealth = readHealth } = {}) {
  const { origin, name } = parseArguments([options.origin, ...(options.name === undefined ? [] : ["--name", options.name])]);
  const target = name === undefined ? [] : ["--name", name];
  const statusArgs = ["deployments", "status", "--json", ...target];
  const before = deploymentIdentity(await runWrangler(statusArgs));
  const health = await fetchHealth(`${origin}/api/health`);
  if (health?.ok !== true || !Number.isSafeInteger(health.schemaVersion) || health.schemaVersion < 1 ||
    !isUuid(health.version?.id)) {
    fail("health-format", "Health did not report a recognized running version and schema.");
  }
  if (!isCommit(health.build?.commit) || health.build?.dirty !== false) {
    fail("build-unverified", "The running build must identify a full commit and a clean source tree.");
  }
  const versionId = health.version.id;
  const viewed = await runWrangler(["versions", "view", versionId, "--json", ...target]);
  if (viewed?.id !== versionId) {
    fail("version-mismatch", "Cloudflare returned a different version than the one running.");
  }
  const tag = viewed.annotations?.["workers/tag"];
  if (tag !== undefined && (!isCommit(tag) || tag !== health.build.commit)) {
    fail("tag-mismatch", "Cloudflare's version tag does not match the running build commit.");
  }
  const after = deploymentIdentity(await runWrangler(statusArgs));
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    fail("deployment-changed", "The active deployment changed during inspection; run the inspection again.");
  }
  if (!after.versions.some((version) => version.id === versionId && version.percentage > 0)) {
    fail("version-inactive", "The running version has no traffic in Cloudflare's active deployment.");
  }
  return {
    verified: true,
    origin,
    schemaVersion: health.schemaVersion,
    build: { commit: health.build.commit, dirty: false },
    version: { id: versionId, tag: tag ?? null },
    deployment: after,
  };
}

export async function runInstalledWrangler(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [wrangler, ...args], {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    // Child errors include stdout/stderr, which can contain account/config data.
    fail("cloudflare-read", "Could not read Cloudflare deployment/version JSON; check Wrangler authentication and the Worker target.");
  }
}

export async function readHealth(url) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail("health-read", "Could not fetch the instance health endpoint.");
  }
  if (!response.ok) fail("health-http", "The instance health endpoint returned an unsuccessful HTTP status.");
  try { return await response.json(); } catch { fail("health-json", "The instance health endpoint did not return JSON."); }
}

export async function main(args, dependencies) {
  try {
    const report = await inspectRunningRevision(parseArguments(args), dependencies);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof InspectionError ? error : new InspectionError("inspection-failed", "Running revision inspection failed.");
    process.stderr.write(`${safe.code}: ${safe.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
