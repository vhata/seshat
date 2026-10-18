import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanGitEnvironment, git, shellCaseMatches } from "./git.ts";
import { discoverDirectories, isPathExcluded, survey, type SurveyOptions } from "./survey.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

let temporary: string;
let root: string;
const run = (directory: string, ...args: string[]): string => {
  const execute = (gitArgs: string[]): string => execFileSync("git", [
    "-c", "user.name=Survey Test", "-c", "user.email=survey@example.invalid",
    "-c", "commit.gpgsign=false", "-C", directory, ...gitArgs,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: cleanGitEnvironment() }).trimEnd();
  // Guard every initialization, including direct calls and bare fixtures,
  // independently of the sanitizer in case its isolation ever regresses.
  if (args.includes("init")) {
    try {
      const existingGit = realpathSync(execute(["rev-parse", "--absolute-git-dir"]));
      const disposableRoot = realpathSync(temporary);
      if (existingGit !== disposableRoot && !existingGit.startsWith(`${disposableRoot}${sep}`)) {
        throw new Error("Refusing to initialize a fixture outside its disposable repository root.");
      }
    } catch (error) {
      if ((error as { status?: number }).status !== 128) throw error;
    }
  }
  return execute(args);
};
const options = (extra: Partial<SurveyOptions> = {}): SurveyOptions => ({ root, exclude: [], excludeRemote: [], githubHosts: [], paths: [], ...extra });
async function repo(name: string, initial = true): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  run(directory, "init", "--initial-branch=main");
  if (initial) {
    await writeFile(join(directory, "tracked.txt"), "initial\n");
    run(directory, "add", ".");
    run(directory, "commit", "-m", "Initial");
  }
  return directory;
}
async function commit(directory: string, content: string): Promise<string> {
  await writeFile(join(directory, "tracked.txt"), content);
  run(directory, "add", ".");
  run(directory, "commit", "-m", "Work");
  return run(directory, "rev-parse", "HEAD");
}

beforeEach(async () => {
  vi.clearAllMocks();
  temporary = await mkdtemp(join(tmpdir(), "seshat-survey-"));
  root = join(temporary, "root");
  await mkdir(root);
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(temporary, { recursive: true, force: true }); });

describe("shell exclusions and discovery", () => {
  it("removes all inherited repository selectors while preserving global config and identity", () => {
    const localVariables = [
      "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
      "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
      "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
      "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_123", "GIT_CONFIG_VALUE_123",
    ];
    const environment = Object.fromEntries(localVariables.map((key) => [key, "inherited"]));
    const retained = { GIT_CONFIG_GLOBAL: "/tmp/survey-global", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Owner", PATH: "/bin" };
    Object.assign(environment, retained);
    expect(cleanGitEnvironment(environment)).toEqual(retained);
    expect(environment.GIT_DIR).toBe("inherited");
  });

  it("surveys the intended checkout inside a hook without touching its enclosing repository", async () => {
    const original = await repo("hook-target");
    const guarded = join(temporary, "hook-target");
    await rename(original, guarded);
    const protectedFiles = ["config", "HEAD", "index"];
    const before = await Promise.all(protectedFiles.map((name) => readFile(join(guarded, ".git", name))));
    vi.stubEnv("GIT_DIR", join(guarded, ".git"));
    vi.stubEnv("GIT_COMMON_DIR", join(guarded, ".git"));
    vi.stubEnv("GIT_WORK_TREE", guarded);
    vi.stubEnv("GIT_INDEX_FILE", join(guarded, ".git", "index"));
    vi.stubEnv("GIT_PREFIX", "hook/path/");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.bare");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
    // Fixture commands must be isolated too: even init must target this directory.
    const intended = await repo("intended");
    run(intended, "branch", "-m", "intended-branch");
    const result = await survey(options());
    expect(result.projects.map((project) => [project.path, project.signals.checkedOut])).toEqual([["intended", "intended-branch"]]);
    const after = await Promise.all(protectedFiles.map((name) => readFile(join(guarded, ".git", name))));
    expect(after).toEqual(before);
    expect(run(guarded, "config", "--bool", "core.bare")).toBe("false");
  });

  it("uses Bash case semantics without evaluating pattern contents", async () => {
    expect(await shellCaseMatches("work/team/project", "work/*")).toBe(true);
    expect(await shellCaseMatches("project-b", "project-[!a]")).toBe(true);
    expect(await shellCaseMatches("project-a", "project-[!a]")).toBe(false);
    expect(await shellCaseMatches("literal*", "literal\\*")).toBe(true);
    expect(await shellCaseMatches("a|b", "a|b")).toBe(true);
    const injection = `$(touch ${join(temporary, "injected")})`;
    expect(await shellCaseMatches(injection, injection)).toBe(true);
    await expect(readFile(join(temporary, "injected"))).rejects.toThrow();
    expect(await isPathExcluded("work/team/project", ["work"])).toBe(true);
  });

  it("follows root and checkout symlinks, skips parent containers and loose files", async () => {
    await repo("direct");
    await repo("group/nested");
    await mkdir(join(root, "plain"));
    await writeFile(join(root, "loose.txt"), "private");
    const elsewhere = await repo("elsewhere");
    await rename(elsewhere, join(temporary, "elsewhere"));
    await symlink(join(temporary, "elsewhere"), join(root, "linked"));
    await symlink(join(temporary, "missing"), join(root, "broken"));
    await symlink(root, join(temporary, "root-link"));
    const result = await discoverDirectories(options({ root: join(temporary, "root-link"), paths: ["group/nested"] }));
    expect(result.directories.map((d) => [d.path, d.checkout])).toEqual([
      ["direct", true], ["group/nested", true], ["linked", true], ["plain", false],
    ]);
  });

  it("does not mistake a directory inside an enclosing repository for a checkout", async () => {
    run(root, "init", "--initial-branch=main");
    await mkdir(join(root, "inside"));
    expect((await discoverDirectories(options())).directories.find((d) => d.path === "inside")?.checkout).toBe(false);
  });

  it("includes explicitly indexed parent checkouts only when requested and still excludes their remotes", async () => {
    const parent = await repo("group");
    await repo("group/child");
    const nestedParent = await repo("deep/nested");
    await repo("deep/nested/child");
    const paths = ["group", "group/child", "deep/nested", "deep/nested/child"];
    const normal = await discoverDirectories(options({ paths }));
    expect(normal.directories.map((d) => d.path)).toEqual(["deep/nested", "deep/nested/child", "group/child"]);
    const explicit = await discoverDirectories(options({ paths, includeIndexedParents: true }));
    expect(explicit.directories.map((d) => [d.path, d.checkout])).toEqual([
      ["deep/nested", true], ["deep/nested/child", true], ["group", true], ["group/child", true],
    ]);
    for (const directory of [parent, nestedParent]) {
      run(directory, "remote", "add", "origin", "https://private.invalid/team/project.git");
    }
    const excluded = await discoverDirectories(options({ paths, includeIndexedParents: true, excludeRemote: ["*private.invalid*"] }));
    expect(excluded.excluded).toBe(2);
    expect(excluded.directories.map((d) => d.path)).toEqual(["deep/nested/child", "group/child"]);
  });

  it("excludes lexical ancestors and every rewritten fetch and push URL", async () => {
    await repo("work/nested");
    const fetch = await repo("fetch");
    run(fetch, "remote", "add", "origin", "https://github.com/public/fetch.git");
    run(fetch, "config", "url.https://private.invalid/.insteadOf", "short:");
    run(fetch, "remote", "add", "work", "short:team/private.git");
    const push = await repo("push");
    run(push, "remote", "add", "origin", "https://github.com/public/push.git");
    run(push, "config", "--add", "remote.origin.pushurl", "https://public.invalid/repo.git");
    run(push, "config", "--add", "remote.origin.pushurl", "ssh://git@private.invalid/team/repo.git");
    const kept = await repo("kept");
    run(kept, "remote", "add", "origin", "git@github-alias:Owner/Kept.git");
    const result = await survey(options({ paths: ["work/nested"], exclude: ["work"], excludeRemote: ["*private.invalid*"], githubHosts: ["github-alias"] }));
    expect(result.excluded).toBe(3);
    expect(result.projects.map((d) => [d.path, d.remote])).toEqual([["kept", "Owner/Kept"]]);
    expect(JSON.stringify(result)).not.toMatch(/private|nested|"fetch"|"push"|https|absolutePath/);
  });

  it("reduces supported origin URLs, strips credentials, and distinguishes unsupported remotes", async () => {
    const credentialed = await repo("credentialed");
    run(credentialed, "remote", "add", "origin", "https://user:credential@github.com/Owner/Repo.git");
    const ssh = await repo("ssh");
    run(ssh, "remote", "add", "origin", "ssh://git@github.com/Owner/Ssh.git");
    const other = await repo("other");
    run(other, "remote", "add", "origin", "https://gitlab.com/Owner/Other.git");
    const noOrigin = await repo("no-origin");
    run(noOrigin, "remote", "add", "elsewhere", "https://github.com/Owner/Other.git");
    await repo("local");
    const result = await discoverDirectories(options());
    expect(result.directories.map((d) => [d.path, d.remoteStatus, d.remote])).toEqual([
      ["credentialed", "supported", "Owner/Repo"], ["local", "none", "none"],
      ["no-origin", "unsupported", undefined], ["other", "unsupported", undefined], ["ssh", "supported", "Owner/Ssh"],
    ]);
    expect(JSON.stringify(result)).not.toContain("credential@");
  });

  it("sanitizes failed git commands rather than echoing stderr or argument secrets", async () => {
    await expect(git(root, ["not-a-command-https://token@private.invalid/repo"])).rejects.toThrow("A local git command failed");
  });
});

describe("git signals", () => {
  it("reports empty and local-only repositories and omits signals for plain directories", async () => {
    await repo("empty", false);
    await repo("local");
    await mkdir(join(root, "plain"));
    const report = await survey(options());
    expect(report.projects[0]!.signals).toEqual({ checkedOut: "main", branches: "none", uncommitted: "none" });
    expect(report.projects[1]!.signals).toMatchObject({ checkedOut: "main", branches: "none", unpushed: "no remote", uncommitted: "none" });
    expect(report.projects[1]!.signals.started).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.projects[2]!.signals).toEqual({});
    expect(JSON.stringify(report)).not.toContain(temporary);
    const now = new Date();
    expect(report.surveyed).toBe(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
  });

  it("counts unpushed across all remote refs, ignoring upstream ahead and hidden refs", async () => {
    const directory = await repo("project");
    run(directory, "remote", "add", "origin", "https://github.com/example/project.git");
    run(directory, "update-ref", "refs/remotes/origin/main", "HEAD");
    run(directory, "checkout", "-b", "feature", "--track", "origin/main");
    const pushed = await commit(directory, "pushed\n");
    run(directory, "update-ref", "refs/remotes/other/feature", pushed);
    vi.stubEnv("GIT_AUTHOR_DATE", "2099-01-01T00:00:00Z");
    vi.stubEnv("GIT_COMMITTER_DATE", "2099-01-01T00:00:00Z");
    const hidden = await commit(directory, "hidden\n");
    run(directory, "update-ref", "refs/tooling/hidden", hidden);
    run(directory, "reset", "--hard", pushed);
    const result = (await survey(options())).projects[0]!;
    expect(result.signals.unpushed).toBe("none");
    expect(result.signals.branches).toBe("feature");
    expect(result.signals.lastCommit).toMatch(/ on feature$/);
    expect(result.signals.lastCommit).not.toContain("2099");
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  it("annotates local-only and gone-upstream branches and reports default ambiguity", async () => {
    const directory = await repo("project");
    run(directory, "remote", "add", "origin", "https://github.com/example/project.git");
    run(directory, "update-ref", "refs/remotes/origin/main", "HEAD");
    run(directory, "branch", "master");
    run(directory, "checkout", "-b", "gone", "--track", "origin/main");
    await commit(directory, "gone\n");
    run(directory, "update-ref", "-d", "refs/remotes/origin/main");
    run(directory, "branch", "local");
    const result = (await survey(options())).projects[0]!;
    expect(result.signals.branches).toBe("gone, local, main, master");
    expect(result.signals.unpushed).toBe("2 on gone (upstream gone), 2 on local (no upstream), 1 on main (no upstream), 1 on master (no upstream)");
    expect(result.warnings).toEqual([
      "Default branch could not be determined; all local branches are listed.",
      "A branch has a gone upstream; it may have been squash-merged and deleted on the remote.",
    ]);
  });

  it("uses remote HEAD to resolve a nonconventional default and counts detached commits", async () => {
    const directory = await repo("project");
    run(directory, "branch", "-m", "trunk");
    run(directory, "remote", "add", "origin", "git@github.com:example/project.git");
    run(directory, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    run(directory, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    run(directory, "checkout", "--detach");
    await commit(directory, "detached\n");
    const result = (await survey(options())).projects[0]!;
    expect(result.signals).toMatchObject({ checkedOut: "detached", branches: "none", unpushed: "1 on detached HEAD" });
    expect(result.warnings).toBeUndefined();
  });

  it("counts renamed, modified, newline-named and untracked files, stashes and other worktrees", async () => {
    const directory = await repo("project");
    await writeFile(join(directory, "tracked.txt"), "stashed\n");
    run(directory, "stash", "push");
    const other = join(temporary, "other");
    run(directory, "worktree", "add", "-b", "other", other);
    await writeFile(join(other, "tracked.txt"), "other changes\n");
    await rename(join(directory, "tracked.txt"), join(directory, "renamed\nfile.txt"));
    run(directory, "add", "-A");
    await writeFile(join(directory, "untracked\nfile.txt"), "untracked");
    const beforeIndex = await readFile(join(directory, ".git/index"));
    const result = (await survey(options())).projects[0]!;
    expect(result.signals.uncommitted).toBe("1 modified, 1 untracked, 1 stashed; changes in 1 of 1 other worktrees");
    expect(await readFile(join(directory, ".git/index"))).toEqual(beforeIndex);
    expect(JSON.stringify(result)).not.toMatch(/tracked\.txt|renamed|untracked\\nfile/);
    // The invoking worktree need not be the first listed (the main checkout).
    await symlink(other, join(root, "other-link"));
    const fromOther = (await survey(options({ exclude: ["project"] }))).projects[0]!;
    expect(fromOther.signals.uncommitted).toBe("1 modified, 0 untracked, 1 stashed; changes in 1 of 1 other worktrees");
  });

  it("identifies tools from allowed manifests and names without reading loose secret files", async () => {
    const directory = await repo("project");
    await writeFile(join(directory, "package.json"), JSON.stringify({ devDependencies: { typescript: "*", vite: "*", wrangler: "*" }, dependencies: { react: "*" } }));
    await writeFile(join(directory, ".env.secret"), "PRIVATE_MARKER=never-report-this");
    await writeFile(join(directory, "vite.config.ts"), "throw new Error('must not execute')");
    const secretNames = ["build.gradle.secret", "build.gradle.credentials", "wrangler.json.token", "deno.json.secret", "build.gradle.pem"];
    for (const name of secretNames) await writeFile(join(directory, name), "private manifest-like file");
    const result = (await survey(options())).projects[0]!;
    expect(result.signals.stack?.split(", ")).toEqual(expect.arrayContaining(["TypeScript", "React", "Vite", "Cloudflare Workers"]));
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_MARKER|never-report-this|must not execute|\.env/);
    const opened = vi.mocked(readFile).mock.calls.map(([path]) => String(path));
    expect(opened).toContain(join(directory, "package.json"));
    for (const name of [...secretNames, ".env.secret", "vite.config.ts"]) {
      expect(opened).not.toContain(join(directory, name));
    }
  });
});
