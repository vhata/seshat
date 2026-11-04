import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanGitEnvironment } from "./git.ts";
import { prepareCiSite, summarizeCiDeployment } from "./site-ci.ts";
import { createSiteRuntime } from "./site-runtime.ts";
import type { SiteRuntime } from "./site-types.ts";

const exec = promisify(execFile);
let root: string;
let runtime: SiteRuntime;
let env: NodeJS.ProcessEnv;
let commit: string;
let remote: string;
let upload: ReturnType<typeof vi.fn<SiteRuntime["wrangler"]>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "seshat-ci-"));
  const git = (...args: string[]) => exec("git", ["-C", root, ...args], {
    env: { ...cleanGitEnvironment(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  });
  await git("init", "--initial-branch=main");
  await writeFile(join(root, ".gitignore"), ".seshat/\n");
  await git("add", ".");
  await git("commit", "-m", "Fixture source");
  commit = (await git("rev-parse", "HEAD")).stdout.trim();
  remote = `${commit}\trefs/heads/main\n`;
  runtime = createSiteRuntime(root);
  runtime.command = vi.fn(async (executable, args) => {
    expect([executable, ...args]).toEqual(["git", "ls-remote", "--exit-code", "origin", "refs/heads/main"]);
    return remote;
  });
  upload = vi.fn<SiteRuntime["wrangler"]>(async () => "uploaded");
  runtime.wrangler = upload;
  env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: commit,
    CLOUDFLARE_API_TOKEN: "synthetic-token", SESHAT_ACCOUNT_ID: "a".repeat(32), SESHAT_WORKER_NAME: "seshat",
    SESHAT_ORIGIN: "https://seshat.example", SESHAT_NAMESPACE_ID: "b".repeat(32) };
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("automatic production updates", () => {
  it.each([
    ["GITHUB_ACTIONS", "false"], ["GITHUB_EVENT_NAME", "pull_request"], ["GITHUB_EVENT_NAME", "workflow_dispatch"],
    ["GITHUB_REF", "refs/heads/feature"], ["GITHUB_SHA", "c".repeat(40)],
    ["CLOUDFLARE_API_TOKEN", ""], ["SESHAT_ACCOUNT_ID", ""], ["SESHAT_WORKER_NAME", ""],
    ["SESHAT_ORIGIN", "http://unsafe.example"], ["SESHAT_NAMESPACE_ID", ""], ["SESHAT_NAMESPACE_ID", undefined],
  ])("refuses invalid %s before saving or uploading", async (key, value) => {
    env[key] = value;
    await expect(prepareCiSite(runtime, env)).rejects.toThrow();
    expect(await runtime.readConfig()).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it("saves only the pinned target and delegates the upload with its account", async () => {
    await prepareCiSite(runtime, env);
    expect(await runtime.readConfig()).toEqual({ format: 1, stage: "configured", accountId: env.SESHAT_ACCOUNT_ID,
      workerName: "seshat", origin: "https://seshat.example", namespaceId: env.SESHAT_NAMESPACE_ID });
    await runtime.wrangler(["deploy", "--tag", commit], { accountId: env.SESHAT_ACCOUNT_ID });
    expect(upload).toHaveBeenCalledWith(["deploy", "--tag", commit], { accountId: env.SESHAT_ACCOUNT_ID });
    expect(runtime.command).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, ".seshat/site.json"), "utf8")).not.toContain("synthetic-token");
  });

  it("refuses an old workflow rerun before preparing the site", async () => {
    remote = `${"c".repeat(40)}\trefs/heads/main\n`;
    await expect(prepareCiSite(runtime, env)).rejects.toThrow("no longer current main");
    expect(await runtime.readConfig()).toBeNull();
  });

  it("refuses source superseded during validation immediately before upload", async () => {
    await prepareCiSite(runtime, env);
    remote = `${"c".repeat(40)}\trefs/heads/main\n`;
    await expect(runtime.wrangler(["deploy"])).rejects.toThrow("no longer current main");
    expect(upload).not.toHaveBeenCalled();
    await runtime.wrangler(["deployments", "status"]);
    expect(upload).toHaveBeenCalledWith(["deployments", "status"], undefined);
  });

  it("fails closed when remote main cannot be read", async () => {
    await prepareCiSite(runtime, env);
    runtime.command = async () => { throw new Error("unavailable"); };
    await expect(runtime.wrangler(["deploy"])).rejects.toThrow("unavailable");
    expect(upload).not.toHaveBeenCalled();
  });

  it.each(["uploading", "upload-outcome-unknown", "deployed-unverified", "verified"])("records %s without raw settings or credentials", async state => {
    await runtime.writePrivate("operation.json", { state, source: commit,
      uploadedVersion: "11111111-1111-4111-8111-111111111111", token: "private-value", origin: "https://private.example" });
    const summary = join(root, "summary.md");
    await summarizeCiDeployment(runtime, summary);
    const text = await readFile(summary, "utf8");
    expect(text).toContain(state);
    expect(text).toContain(commit);
    expect(text).toContain("11111111-1111-4111-8111-111111111111");
    expect(text).not.toContain("private-value");
    expect(text).not.toContain("private.example");
  });

  it("reports no upload when preflight fails", async () => {
    const summary = join(root, "summary.md");
    await summarizeCiDeployment(runtime, summary);
    expect(await readFile(summary, "utf8")).toContain("not-uploaded");
  });
});
