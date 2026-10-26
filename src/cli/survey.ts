import { readdir, readFile, realpath, stat, lstat } from "node:fs/promises";
import { join } from "node:path";
import { git, shellCaseMatches } from "./git.ts";

export interface SurveyOptions {
  root: string;
  exclude: string[];
  excludeRemote: string[];
  githubHosts: string[];
  paths: string[];
  includeIndexedParents?: boolean;
}

export interface SurveyDirectory {
  path: string;
  absolutePath: string;
  checkout: boolean;
  remote?: string;
  remoteStatus: "none" | "supported" | "unsupported";
}

export interface SurveySignals {
  stack?: string;
  started?: string;
  lastCommit?: string;
  checkedOut?: string;
  branches?: string;
  unpushed?: string;
  uncommitted?: string;
}

export interface SurveyProject extends Omit<SurveyDirectory, "absolutePath"> {
  signals: SurveySignals;
  warnings?: string[];
}

export interface SurveyReport {
  version: 1;
  surveyed: string;
  projects: SurveyProject[];
  excluded: number;
}

const lines = (value: string): string[] => value.trimEnd().split("\n").filter(Boolean);

async function matchesAny(value: string, patterns: string[]): Promise<boolean> {
  for (const pattern of patterns) if (await shellCaseMatches(value, pattern)) return true;
  return false;
}

export async function isPathExcluded(path: string, patterns: string[]): Promise<boolean> {
  const segments = path.split("/");
  for (let i = 1; i <= segments.length; i++) {
    if (await matchesAny(segments.slice(0, i).join("/"), patterns)) return true;
  }
  return false;
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw new Error("Could not inspect a survey directory.");
  }
}

function remoteSlug(url: string, hosts: string[]): string | undefined {
  let host: string | undefined;
  let path: string | undefined;
  if (/^(?:https?|ssh):\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      // URL parameters and fragments are not repository names.
      if (parsed.search || parsed.hash) return undefined;
      path = parsed.pathname.replace(/^\//, "").replace(/\/$/, "");
    } catch { return undefined; }
  } else {
    const scp = /^(?:[^@/]+@)?([^/:]+):([^/]+\/[^/]+)$/.exec(url);
    if (scp) { host = scp[1]; path = scp[2]; }
  }
  if (!host || !path || !["github.com", ...hosts].some((h) => h.toLowerCase() === host.toLowerCase())) return undefined;
  const slug = path.replace(/\.git$/, "");
  return /^[A-Za-z0-9-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/.test(slug) ? slug : undefined;
}

export async function discoverDirectories(options: SurveyOptions): Promise<{ directories: SurveyDirectory[]; excluded: number }> {
  let children;
  try { children = await readdir(options.root, { withFileTypes: true }); }
  catch { throw new Error("Could not read the survey root."); }
  const candidates = new Set(children
    .filter((child) => child.isDirectory() || child.isSymbolicLink())
    .map((child) => child.name)
    .filter((name) => (options.includeIndexedParents && options.paths.includes(name))
      || !options.paths.some((path) => path.startsWith(`${name}/`))));
  for (const path of options.paths) if (path.includes("/")) candidates.add(path);
  const directories: SurveyDirectory[] = [];
  let excluded = 0;
  for (const path of [...candidates].sort()) {
    // Test lexical ancestors too, so an excluded container cannot leak nested entries.
    if (await isPathExcluded(path, options.exclude)) { excluded++; continue; }
    const absolutePath = join(options.root, path);
    if (!await isDirectory(absolutePath)) continue;
    const physical = await realpath(absolutePath);
    const top = (await git(absolutePath, ["rev-parse", "--show-toplevel"], [0, 128])).trimEnd();
    const checkout = top !== "" && top === physical;
    // Ordinary directories inside a checkout share its remote exclusions,
    // even though they must not receive that checkout's survey signals.
    const remotes = top !== "" ? lines(await git(absolutePath, ["remote"])) : [];
    let remoteExcluded = false;
    for (const remote of remotes) {
      const urls = [
        ...lines(await git(absolutePath, ["remote", "get-url", "--all", remote])),
        ...lines(await git(absolutePath, ["remote", "get-url", "--push", "--all", remote])),
      ];
      for (const url of urls) {
        if (await matchesAny(url, options.excludeRemote)) { remoteExcluded = true; break; }
      }
      if (remoteExcluded) break;
    }
    if (remoteExcluded) { excluded++; continue; }
    if (!checkout) { directories.push({ path, absolutePath, checkout, remoteStatus: "none" }); continue; }
    if (remotes.length === 0) {
      directories.push({ path, absolutePath, checkout, remote: "none", remoteStatus: "none" });
    } else {
      const origin = remotes.includes("origin") ? (await git(absolutePath, ["remote", "get-url", "origin"])).trimEnd() : "";
      const remote = remoteSlug(origin, options.githubHosts);
      directories.push({ path, absolutePath, checkout, ...(remote ? { remote } : {}), remoteStatus: remote ? "supported" : "unsupported" });
    }
  }
  return { directories, excluded };
}

async function stack(directory: string): Promise<string | undefined> {
  const names = await readdir(directory);
  const tools = new Set<string>();
  const has = (pattern: RegExp): boolean => names.some((name) => pattern.test(name));
  if (has(/^(?:tsconfig(?:\..+)?\.json)$|\.tsx?$/)) tools.add("TypeScript");
  if (has(/\.jsx?$/)) tools.add("JavaScript");
  if (has(/^vite\.config\./)) tools.add("Vite");
  if (has(/^wrangler\.(?:toml|jsonc?)$/)) tools.add("Cloudflare Workers");
  if (has(/^Dockerfile(?:\..+)?$/)) tools.add("Docker");
  if (has(/^package(?:-lock)?\.json$|^yarn\.lock$|^pnpm-lock\.yaml$|^bun\.lockb?$/)) tools.add("JavaScript");
  if (has(/^pyproject\.toml$|^uv\.lock$|^poetry\.lock$|\.py$/)) tools.add("Python");
  if (has(/^uv\.lock$/)) tools.add("uv");
  if (has(/^Cargo\.(?:toml|lock)$|\.rs$/)) tools.add("Rust");
  if (has(/^go\.(?:mod|sum)$|\.go$/)) tools.add("Go");
  if (has(/^Gemfile(?:\.lock)?$|\.rb$/)) tools.add("Ruby");
  if (has(/^composer\.(?:json|lock)$|\.php$/)) tools.add("PHP");
  if (has(/^mix\.(?:exs|lock)$|\.exs?$/)) tools.add("Elixir");
  if (has(/^pom\.xml$|^build\.gradle/)) tools.add("Java");
  if (has(/^deno\.jsonc?$|^deno\.lock$/)) tools.add("Deno");
  const allowedManifest = /^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile|composer\.json|mix\.exs|pom\.xml|build\.gradle[^/]*|deno\.json[^/]*|wrangler\.(?:toml|json[^/]*))$/;
  for (const name of names.filter((name) => allowedManifest.test(name))) {
    if (/secret|token|credential|\.pem$|\.key$|\.p12$|\.keychain/i.test(name)) continue;
    const file = join(directory, name);
    // Do not follow a manifest symlink into files outside this checkout.
    if (!(await lstat(file)).isFile()) continue;
    const text = await readFile(file, "utf8");
    if (name === "package.json" || name.startsWith("deno.json")) {
      let manifest;
      try { manifest = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
      const dependencies = Object.assign({}, manifest.dependencies, manifest.devDependencies, manifest.peerDependencies) as Record<string, unknown>;
      for (const [pkg, tool] of [
        ["typescript", "TypeScript"], ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"],
        ["vite", "Vite"], ["next", "Next.js"], ["wrangler", "Cloudflare Workers"],
        ["@cloudflare/vite-plugin", "Cloudflare Workers"], ["astro", "Astro"], ["vitest", "Vitest"],
      ]) if (Object.hasOwn(dependencies, pkg!)) tools.add(tool!);
    } else if (name === "pyproject.toml") {
      if (/\bdjango\b/i.test(text)) tools.add("Django");
      if (/\bfastapi\b/i.test(text)) tools.add("FastAPI");
      if (/\bflask\b/i.test(text)) tools.add("Flask");
      if (/\[tool\.poetry\]/.test(text)) tools.add("Poetry");
    }
  }
  if (tools.has("TypeScript")) tools.delete("JavaScript");
  return tools.size ? [...tools].join(", ") : undefined;
}

function statusCounts(status: string): { modified: number; untracked: number } {
  const records = status.split("\0");
  let modified = 0;
  let untracked = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    if (record.startsWith("??")) untracked++;
    else { modified++; if (/^[RC]|^.[RC]/.test(record)) i++; }
  }
  return { modified, untracked };
}

const status = (directory: string): Promise<string> => git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

async function uncommitted(directory: string): Promise<string> {
  const { modified, untracked } = statusCounts(await status(directory));
  const stashed = lines(await git(directory, ["stash", "list", "--format=%gd"])).length;
  const physical = await realpath(directory);
  const worktrees = (await git(directory, ["worktree", "list", "--porcelain", "-z"]))
    .split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
  let total = 0;
  let changed = 0;
  for (const other of worktrees) {
    if (other === physical || !await isDirectory(other)) continue;
    total++;
    const counts = statusCounts(await status(other));
    if (counts.modified || counts.untracked) changed++;
  }
  const counts: string[] = [];
  if (modified || untracked || stashed) counts.push(`${modified} modified`, `${untracked} untracked`);
  if (stashed) counts.push(`${stashed} stashed`);
  return `${counts.join(", ") || "none"}${changed ? `; changes in ${changed} of ${total} other worktrees` : ""}`;
}

async function signals(directory: SurveyDirectory): Promise<{ signals: SurveySignals; warnings: string[] }> {
  const d = directory.absolutePath;
  const warnings: string[] = [];
  const result: SurveySignals = {};
  const inferredStack = await stack(d);
  if (inferredStack) result.stack = inferredStack;
  const branches = lines(await git(d, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/"]));
  const current = (await git(d, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1])).trimEnd();
  result.checkedOut = current || "detached";
  const remoteHead = (await git(d, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], [0, 1])).trimEnd();
  let defaultBranch = remoteHead.startsWith("origin/") ? remoteHead.slice(7) : undefined;
  if (!defaultBranch) {
    const conventional = branches.filter((branch) => branch === "main" || branch === "master");
    if (conventional.length === 1) defaultBranch = conventional[0];
  }
  if (!defaultBranch && branches.length) warnings.push("Default branch could not be determined; all local branches are listed.");
  result.branches = branches.filter((branch) => branch !== defaultBranch).join(", ") || "none";
  result.uncommitted = await uncommitted(d);
  const head = (await git(d, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1])).trimEnd();
  if (!head && branches.length === 0) return { signals: result, warnings };
  const started = lines(await git(d, ["log", "--branches", "--max-parents=0", "--format=%as"])).sort()[0];
  if (started) result.started = started;
  const last = (await git(d, ["for-each-ref", "--sort=-committerdate", "--count=1", "--format=%(committerdate:short) on %(refname:lstrip=2)", "refs/heads/"])).trimEnd();
  if (last) result.lastCommit = last;
  if (directory.remoteStatus === "none") { result.unpushed = "no remote"; return { signals: result, warnings }; }
  const unpushed: string[] = [];
  const tracking = lines(await git(d, ["for-each-ref", "--format=%(refname:lstrip=2)%09%(upstream)%09%(upstream:track)", "refs/heads/"]));
  for (const entry of tracking) {
    const [branch, upstream = "", track = ""] = entry.split("\t");
    const count = Number((await git(d, ["rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes"])).trim());
    if (!count) continue;
    const annotation = track === "[gone]" ? " (upstream gone)" : !upstream.startsWith("refs/remotes/") ? " (no upstream)" : "";
    unpushed.push(`${count} on ${branch}${annotation}`);
    if (track === "[gone]") warnings.push("A branch has a gone upstream; it may have been squash-merged and deleted on the remote.");
  }
  if (!current && head) {
    const count = Number((await git(d, ["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"])).trim());
    if (count) unpushed.push(`${count} on detached HEAD`);
  }
  result.unpushed = unpushed.join(", ") || "none";
  return { signals: result, warnings: [...new Set(warnings)] };
}

/** A local, read-only snapshot. Remote-tracking counts use the last fetch. */
export async function survey(options: SurveyOptions): Promise<SurveyReport> {
  const { directories, excluded } = await discoverDirectories(options);
  const projects: SurveyProject[] = [];
  for (const directory of directories) {
    const { absolutePath: _absolutePath, ...project } = directory;
    if (!directory.checkout) { projects.push({ ...project, signals: {} }); continue; }
    const observed = await signals(directory);
    projects.push({ ...project, signals: observed.signals, ...(observed.warnings.length ? { warnings: observed.warnings } : {}) });
  }
  const now = new Date();
  const surveyed = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return { version: 1, surveyed, projects, excluded };
}
