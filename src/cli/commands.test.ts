import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanGitEnvironment } from "./git.ts";

const exec = promisify(execFile);
const configure = (args: string[]) => exec("git", args, { env: cleanGitEnvironment() });
const launcher = resolve("bin/seshat");
let temporary: string;
let root: string;
let config: string;
let index: string;
let env: NodeJS.ProcessEnv;

async function git(path: string, ...args: string[]) {
  const fixtureEnvironment = { ...cleanGitEnvironment(), GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  if (args[0] === "init") {
    // Fail before any mutation if an inherited process setting ever makes a
    // fixture resolve to a repository outside this test's disposable root.
    try {
      const found = await exec("git", ["-C", path, "rev-parse", "--absolute-git-dir"], { env: fixtureEnvironment });
      if (!found.stdout.trim().startsWith(`${await realpath(temporary)}/`)) throw new Error("Fixture escaped its temporary repository.");
    } catch (error) {
      if ((error as { code?: number }).code !== 128) throw error;
    }
  }
  return exec("git", ["-C", path, ...args], { env: fixtureEnvironment });
}

async function run(args: string[], executable = launcher) {
  try {
    const result = await exec(executable, args, { cwd: temporary, env, maxBuffer: 1024 * 1024 });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as { stdout: string; stderr: string; code: number };
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  }
}

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "seshat-cli-"));
  root = join(temporary, "checkouts");
  await mkdir(root);
  await mkdir(join(root, "alpha"));
  await git(join(root, "alpha"), "init", "--initial-branch=main");
  await git(join(root, "alpha"), "commit", "--allow-empty", "-m", "Initial");
  config = join(temporary, "survey.conf");
  index = join(temporary, "PROJECTS.md");
  await configure(["config", "--file", config, "survey.root", root]);
  await configure(["config", "--file", config, "index.clone", temporary]);
  env = { ...cleanGitEnvironment(), SESHAT_SURVEY_CONFIG: config, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  await writeFile(index, "# Projects\n\n## Active\n\n### alpha\n\n- Path: alpha\n- Remote: none\n\n## Cooling\n\n### elsewhere\n\n- Remote: example/elsewhere\n");
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

describe("source-checkout command line", () => {
  it("loads shared settings and preserves file ordering in list JSON", async () => {
    const result = await run(["list", "--json"]);
    expect(result.code).toBe(0);
    const projects = JSON.parse(result.stdout);
    expect(projects.map((project: { name: string }) => project.name)).toEqual(["alpha", "elsewhere"]);
    expect(projects[0]).toMatchObject({ classification: "Active", path: join(root, "alpha"), key: "path:alpha" });
    expect(projects[1].path).toBeUndefined();
  });

  it("lists paths for an exact classification and rejects a misspelling", async () => {
    expect(await run(["list", "Active", "--paths"])).toMatchObject({ code: 0, stdout: `${join(root, "alpha")}\n` });
    expect(await run(["list", "active"])).toMatchObject({ code: 2 });
    expect(await run(["list", "--paths", "--json"])).toMatchObject({ code: 2 });
  });

  it("resolves a symlink installation while retaining caller-relative --file", async () => {
    const link = join(temporary, "seshat");
    await symlink(launcher, link);
    const result = await run(["check", "PROJECTS.md", "--format-only"], link);
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain("no problems");
  });

  it("reads included settings and path values relative to the config directory", async () => {
    await writeFile(join(temporary, "included.conf"), "[survey]\nroot = checkouts\n[index]\nclone = .\n");
    await writeFile(config, "[include]\npath = included.conf\n");
    expect(await run(["list", "Active", "--paths"])).toMatchObject({ code: 0, stdout: `${join(root, "alpha")}\n` });
  });

  it("prints the shared parse and makes warnings fatal only in strict mode", async () => {
    await writeFile(index, "## Active\n### alpha\n- Path: alpha\n- Future: value\n");
    const result = await run(["check", "--json", "--format-only"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).problems).toEqual([expect.objectContaining({ code: "unknown-field", severity: "warning", line: 4 })]);
    expect(await run(["check", "--strict", "--format-only"])).toMatchObject({ code: 1 });
  });

  it("reports malformed UTF-8 as a format error and missing input as could-not-run", async () => {
    await writeFile(index, new Uint8Array([0xff]));
    const result = await run(["check", "--format-only", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).problems[0].code).toBe("not-utf8");
    expect(await run(["check", "absent.md", "--format-only"])).toMatchObject({ code: 2 });
  });

  it("checks disk coverage, missing paths and remote mismatches with sorted diagnostics", async () => {
    await mkdir(join(root, "unindexed"));
    await git(join(root, "alpha"), "remote", "add", "origin", "https://github.com/example/alpha.git");
    await writeFile(index, "## Active\n### alpha\n- Path: alpha\n- Remote: none\n### missing\n- Path: missing\n");
    const result = await run(["check", "--strict", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).problems.map((problem: { code: string }) => problem.code))
      .toEqual(["checkout-without-entry", "remote-mismatch", "missing-checkout"]);
  });

  it("suppresses excluded missing paths and checkouts excluded by a secondary push URL", async () => {
    await configure(["config", "--file", config, "--add", "survey.exclude", "private/*"]);
    await configure(["config", "--file", config, "--add", "survey.excludeRemote", "*company.invalid*"]);
    await git(join(root, "alpha"), "remote", "add", "secondary", "https://public.invalid/team/repo");
    await git(join(root, "alpha"), "remote", "set-url", "--push", "secondary", "https://token@company.invalid/team/repo");
    await writeFile(index, "## Active\n### alpha\n- Path: alpha\n- Remote: none\n### hidden\n- Path: private/missing\n");
    const result = await run(["check", "--strict", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).problems).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain("company.invalid");
  });

  it("checks nested Paths with repeated slashes according to the format grammar", async () => {
    await mkdir(join(root, "group", "project"), { recursive: true });
    await writeFile(index, "## Active\n### nested\n- Path: group//project\n- Remote: none\n");
    const result = await run(["check", "--strict", "--json"]);
    expect(result.code).toBe(1); // alpha is deliberately still unindexed.
    expect(JSON.parse(result.stdout).problems.map((problem: { code: string }) => problem.code))
      .toEqual(["checkout-without-entry"]);
  });

  it("executes literal argv and exposes project metadata without shell interpolation", async () => {
    const argument = "$(touch not-executed); spaces and 'quotes'";
    const result = await run(["each", "Active", "--", process.execPath, "-e",
      "console.log(JSON.stringify([process.cwd(), process.env.SESHAT_PROJECT, process.env.SESHAT_CLASSIFICATION, process.env.SESHAT_PATH, process.argv[1]]))", argument]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([await realpath(join(root, "alpha")), "alpha", "Active", "alpha", argument]);
    await expect(readFile(join(root, "alpha", "not-executed"))).rejects.toThrow();
  });

  it("returns failure for a failing child but continues over selected projects", async () => {
    await mkdir(join(root, "beta"));
    await writeFile(index, "## Active\n### alpha\n- Path: alpha\n### beta\n- Path: beta\n");
    const result = await run(["each", "--", process.execPath, "-e", "console.log(process.env.SESHAT_PROJECT); process.exit(3)"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("alpha\nbeta\n");
  });

  it("preflights missing targets before executing and never runs excluded targets", async () => {
    await writeFile(index, "## Active\n### alpha\n- Path: alpha\n### missing\n- Path: missing\n");
    const failed = await run(["each", "--", process.execPath, "-e", "console.log('ran')"]);
    expect(failed).toMatchObject({ code: 2, stdout: "" });
    await configure(["config", "--file", config, "--add", "survey.exclude", "missing"]);
    await configure(["config", "--file", config, "--add", "survey.exclude", "alpha"]);
    expect(await run(["each", "--", process.execPath, "-e", "console.log('ran')"])).toMatchObject({ code: 0, stdout: "" });
  });

  it("runs indexed parents and nested entries, and checks their remotes independently", async () => {
    await mkdir(join(root, "alpha", "child"));
    await writeFile(index, "## Active\n### parent\n- Path: alpha\n- Remote: example/parent\n### child\n- Path: alpha/child\n");
    const result = await run(["each", "--", process.execPath, "-e", "console.log(process.env.SESHAT_PROJECT)"]);
    expect(result).toMatchObject({ code: 0, stdout: "parent\nchild\n" });
    const checked = await run(["check", "--json"]);
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.stdout).problems.map((problem: { code: string }) => problem.code))
      .toEqual(["remote-mismatch"]);
  });

  it("prints a stable survey schema and table, with no raw URLs or modified filenames", async () => {
    await writeFile(join(root, "alpha", "sensitive-file-name.txt"), "not read");
    const result = await run(["survey", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ version: 1, excluded: 0, projects: [
      { path: "alpha", checkout: true, remote: "none", signals: { checkedOut: "main", branches: "none", unpushed: "no remote", uncommitted: "0 modified, 1 untracked" } },
    ] });
    expect(result.stdout).not.toContain("sensitive-file-name");
    expect(report.projects[0].absolutePath).toBeUndefined();
    expect((await run(["survey"])).stdout.split("\n")[0]).toBe("PATH\tREMOTE\tCHECKED OUT\tBRANCHES\tUNPUSHED\tUNCOMMITTED");
  });

  it("allows a root-only survey without an index and distinguishes missing configured files", async () => {
    await rm(index);
    expect(await run(["survey", "--json"])).toMatchObject({ code: 2 });
    await writeFile(config, "");
    const result = await run(["survey", "--root", root, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).projects[0].path).toBe("alpha");
  });

  it("shows help without opening settings and refuses unknown or incomplete arguments", async () => {
    env.SESHAT_SURVEY_CONFIG = join(temporary, "absent.conf");
    expect(await run(["survey", "--help"])).toMatchObject({ code: 0 });
    expect(await run(["each", "--help"])).toMatchObject({ code: 0 });
    expect(await run(["unknown"])).toMatchObject({ code: 2 });
    expect(await run(["each", "Active"])).toMatchObject({ code: 2 });
    expect(await run(["check", "--file"])).toMatchObject({ code: 2 });
    expect(await run(["list", "--unexpected"])).toMatchObject({ code: 2 });
  });

  it("isolates survey, settings and each from a calling Git hook's repository environment", async () => {
    const sentinel = join(temporary, "sentinel");
    await mkdir(sentinel);
    await git(sentinel, "init", "--initial-branch=main");
    await git(sentinel, "commit", "--allow-empty", "-m", "Sentinel");
    const configBefore = await readFile(join(sentinel, ".git", "config"));
    const headBefore = await git(sentinel, "rev-parse", "HEAD");
    env.GIT_DIR = join(sentinel, ".git");
    env.GIT_WORK_TREE = sentinel;
    env.GIT_INDEX_FILE = join(sentinel, ".git", "other-index");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "core.bare";
    env.GIT_CONFIG_VALUE_0 = "true";
    const result = await run(["survey", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).projects[0]).toMatchObject({ path: "alpha", checkout: true });
    expect(await run(["each", "Active", "--", "git", "rev-parse", "--show-toplevel"]))
      .toMatchObject({ code: 0, stdout: `${await realpath(join(root, "alpha"))}\n` });
    expect(await readFile(join(sentinel, ".git", "config"))).toEqual(configBefore);
    expect((await git(sentinel, "rev-parse", "HEAD")).stdout).toBe(headBefore.stdout);
    await expect(readFile(join(sentinel, ".git", "other-index"))).rejects.toThrow();
  });
});
