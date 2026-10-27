import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanGitEnvironment } from "./git.ts";
import { deploySite, prepareDeployArtifact } from "./site-deploy.ts";
import { createSiteRuntime } from "./site-runtime.ts";
import { parseSiteArguments, runSiteCli } from "./site.ts";
import type { SiteConfig, SiteRuntime } from "./site-types.ts";

const exec = promisify(execFile);
const initialVersion = "11111111-1111-4111-8111-111111111111";
const uploadedVersion = "22222222-2222-4222-8222-222222222222";
const deploymentId = "33333333-3333-4333-8333-333333333333";
let root: string;
let runtime: SiteRuntime;
let config: SiteConfig;
let commit: string;
let calls: string[][];
let uploaded: boolean;
let failUpload: boolean;
let failVerify: boolean;
let onConfirm: (() => Promise<void>) | undefined;

async function fixtureGit(...args: string[]) {
  return exec("git", ["-C", root, ...args], { env: { ...cleanGitEnvironment(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } });
}

async function buildArtifact() {
  await mkdir(join(root, "dist/seshat"), { recursive: true });
  await mkdir(join(root, ".wrangler/deploy"), { recursive: true });
  await writeFile(join(root, ".wrangler/deploy/config.json"), JSON.stringify({ configPath: "../../dist/seshat/wrangler.json" }));
  await writeFile(join(root, "dist/seshat/wrangler.json"), JSON.stringify({ name: "seshat", main: "index.js", assets: { directory: "../client" },
    durable_objects: { bindings: [{ name: "INSTANCE", class_name: "InstanceObject" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["InstanceObject"] }] }));
  await writeFile(join(root, "dist/seshat/revision.json"), JSON.stringify({ commit, dirty: false }));
  await writeFile(join(root, "dist/seshat/index.js"), "built source");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "seshat-site-deploy-"));
  calls = []; uploaded = false; failUpload = false; failVerify = false; onConfirm = undefined;
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "src/cli"), { recursive: true });
  await mkdir(join(root, "node_modules/wrangler/bin"), { recursive: true });
  await copyFile(resolve("scripts/inspect-revision.mjs"), join(root, "scripts/inspect-revision.mjs"));
  await writeFile(join(root, "src/cli/site-cloudflare.ts"), `
    export async function inspectWorkerTarget(runtime, config) { return {namespaceId: "${"b".repeat(32)}", configured: config.stage === "configured"}; }
    export async function assertWorkerAbsent() {}
  `);
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "package-lock.json"), "locked");
  await writeFile(join(root, "node_modules/wrangler/bin/wrangler.js"), "");
  await writeFile(join(root, ".gitignore"), ".seshat/\nnode_modules/\ndist/\n.wrangler/\n");
  await fixtureGit("init", "--initial-branch=main");
  await fixtureGit("add", ".");
  await fixtureGit("commit", "-m", "Fixture source");
  commit = (await fixtureGit("rev-parse", "HEAD")).stdout.trim();
  config = { format: 1, accountId: "a".repeat(32), workerName: "personal-seshat", origin: "https://personal.example", stage: "configured", namespaceId: "b".repeat(32) };
  runtime = createSiteRuntime(root);
  await runtime.writeConfig(config);
  await runtime.writePrivate("dependencies.json", { lock: createHash("sha256").update("locked").digest("hex") });
  runtime.command = async (executable, args) => {
    calls.push([executable, ...args]);
    if (args.includes("build:release")) await buildArtifact();
    return "";
  };
  runtime.confirm = async () => { await onConfirm?.(); };
  runtime.wrangler = async (args, options) => {
    expect(options?.accountId).toBe(config.accountId);
    calls.push(["wrangler", ...args]);
    if (args[0] === "deploy") {
      expect(args).toContain(config.workerName);
      if (failUpload) throw new Error("secret raw output");
      uploaded = true;
      return `Current Version ID: ${uploadedVersion}`;
    }
    if (args[0] === "deployments") return JSON.stringify({ id: deploymentId, versions: [{ version_id: uploaded ? uploadedVersion : initialVersion, percentage: 100 }] });
    if (args[0] === "versions") return JSON.stringify({ id: uploaded ? uploadedVersion : initialVersion, annotations: { "workers/tag": commit } });
    throw new Error("Unexpected Wrangler call");
  };
  runtime.fetchJson = async () => {
    if (uploaded && failVerify) throw new Error("offline");
    return { ok: true, schemaVersion: 4, build: { commit, dirty: false }, version: { id: uploaded ? uploadedVersion : initialVersion } };
  };
  runtime.request = async url => new Response(url.endsWith("/setup") ? "Setup is finished" : "", {
    status: url === config.origin + "/" ? 200 : url.endsWith("/setup") ? 404 : 401, headers: { "cache-control": "no-store" },
  });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("site command contract", () => {
  it.each(["validate", "update"])("runs %s validation without saved or inherited account selectors", async command => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", config.accountId);
    vi.stubEnv("CF_ACCOUNT_ID", config.accountId);
    await writeFile(join(root, "scripts/check.sh"), `node -e 'process.stdout.write(JSON.stringify({account:process.env.CLOUDFLARE_ACCOUNT_ID,alias:process.env.CF_ACCOUNT_ID}))'\n`);
    await fixtureGit("add", "scripts/check.sh");
    await fixtureGit("commit", "-m", "Add local validation fixture");
    commit = (await fixtureGit("rev-parse", "HEAD")).stdout.trim();
    const commandStub = runtime.command;
    const execute = createSiteRuntime(root).command;
    let checked = false;
    runtime.command = async (executable, args, options) => {
      if (executable === "bash") {
        expect(await execute(executable, args, { ...options, interactive: false })).toBe("{}");
        checked = true;
        return "";
      }
      if (args.includes("build:release")) expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(config.accountId);
      return commandStub(executable, args, options);
    };
    expect(await runSiteCli([command, ...(command === "update" ? ["--yes"] : [])], root, runtime)).toBe(0);
    expect(checked).toBe(true);
    expect(uploaded).toBe(command === "update");
  });

  it("accepts only documented per-command flags", () => {
    expect(parseSiteArguments(["update", "--yes"])).toEqual({ command: "update", yes: true, json: false });
    expect(parseSiteArguments(["status", "--json"])).toEqual({ command: "status", yes: false, json: true });
    for (const args of [["logs", "--yes"], ["update", "--json"], ["update", "--yes", "--yes"], ["setup", "--other"], ["unknown"]]) {
      expect(() => parseSiteArguments(args)).toThrow();
    }
  });

  it("validates and builds the current source, pins a derived target and records the exact verified serving version", async () => {
    const result = await deploySite(runtime, config, { yes: true });
    expect(result.version.id).toBe(uploadedVersion);
    expect(calls.slice(1, 3)).toEqual([["bash", "scripts/check.sh"], ["npm", "run", "--silent", "build:release"]]);
    expect(calls.some(call => call.includes("fetch") || call.includes("pull") || call.includes("checkout"))).toBe(false);
    const deployed = calls.find(call => call[1] === "deploy")!;
    expect(deployed).toEqual(["wrangler", "deploy", "--config", join(root, "dist/seshat/site-wrangler.json"), "--name", config.workerName, "--tag", commit]);
    const derived = JSON.parse(await readFile(deployed[3]!, "utf8")) as Record<string, unknown>;
    expect(derived).toMatchObject({ name: config.workerName, account_id: config.accountId, main: "index.js", assets: { directory: "../client" } });
    expect(await runtime.readPrivate("operation.json")).toMatchObject({ state: "verified", source: commit, uploadedVersion });
  });

  it("refuses dirty source before any command or deployment", async () => {
    await writeFile(join(root, "uncommitted.ts"), "local changes");
    await expect(deploySite(runtime, config, { yes: true })).rejects.toThrow("clean checkout");
    expect(calls).toEqual([]);
  });

  it.each(["source", "artifact", "settings", "decline"])("does not upload after %s changes or confirmation refusal", async kind => {
    onConfirm = async () => {
      if (kind === "source") await writeFile(join(root, "uncommitted.ts"), "changed");
      if (kind === "artifact") await writeFile(join(root, "dist/seshat/index.js"), "changed");
      if (kind === "settings") await runtime.writeConfig({ ...config, origin: "https://other.example" });
      if (kind === "decline") throw new Error("cancelled");
    };
    await expect(deploySite(runtime, config, { yes: false })).rejects.toThrow();
    expect(uploaded).toBe(false);
  });

  it("records unknown upload outcomes separately from successful but unverified deployments", async () => {
    failUpload = true;
    await expect(deploySite(runtime, config, { yes: true })).rejects.toThrow("outcome is unknown");
    expect(await runtime.readPrivate("operation.json")).toMatchObject({ state: "upload-outcome-unknown" });
    failUpload = false; failVerify = true;
    await expect(deploySite(runtime, config, { yes: true })).rejects.toThrow("Deployment succeeded");
    expect(await runtime.readPrivate("operation.json")).toMatchObject({ state: "deployed-unverified", uploadedVersion });
  });

  it("rejects artifact namespace/binding surprises", async () => {
    await buildArtifact();
    const path = join(root, "dist/seshat/wrangler.json");
    const generated = JSON.parse(await readFile(path, "utf8")) as { durable_objects: { bindings: Record<string, unknown>[] } };
    generated.durable_objects.bindings[0]!.script_name = "other-worker";
    await writeFile(path, JSON.stringify(generated));
    await expect(prepareDeployArtifact(runtime, config, commit)).rejects.toThrow("unexpected account");
  });

  it("returns one machine-readable status record, preserving unknown identity and operation state", async () => {
    await runtime.writePrivate("operation.json", { state: "deployed-unverified", uploadedVersion });
    runtime.fetchJson = async () => ({ ok: true, schemaVersion: 4 });
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stdout.write;
    try {
      expect(await runSiteCli(["status", "--json"], root, runtime)).toBe(1);
      expect(JSON.parse(output)).toMatchObject({ verified: false, lastOperation: { state: "deployed-unverified" } });
      output = "";
      expect(await runSiteCli(["status"], root, runtime)).toBe(1);
      expect(output).toContain("Last operation: deployed-unverified");
      expect(output).toContain(`Account: ${config.accountId}`);
      expect(output).toContain(`Worker: ${config.workerName}`);
    } finally { process.stdout.write = original; }
  });
});
