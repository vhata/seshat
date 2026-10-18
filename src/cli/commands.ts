import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseProjectIndex } from "../shared/projects/index.ts";
import type { IndexEntry, IndexProblem, ProjectIndex } from "../shared/projects/types.ts";
import { CliError, isRelativeIndexPath, loadSettings } from "./settings.ts";
import type { Settings } from "./settings.ts";
import { discoverDirectories, isPathExcluded, survey } from "./survey.ts";
import type { SurveyDirectory, SurveyOptions } from "./survey.ts";

const help = `Usage: seshat <command> [options]

  list [CLASSIFICATION ...] [--paths | --json]
  each [CLASSIFICATION ...] -- COMMAND [ARG ...]
  check [FILE] [--strict] [--json] [--format-only]
  survey [--json]

Options: --file FILE  --root DIRECTORY  --config FILE  --help
Classifications match section names exactly; omit them to select all.
Settings: $SESHAT_SURVEY_CONFIG, else $XDG_CONFIG_HOME/seshat/survey.conf
          (XDG_CONFIG_HOME defaults to ~/.config).
Read docs/CLI.md in the Seshat checkout for output and settings contracts.
`;

type Command = "list" | "each" | "check" | "survey";
interface Arguments {
  command: Command;
  file?: string;
  root?: string;
  config?: string;
  json: boolean;
  paths: boolean;
  strict: boolean;
  formatOnly: boolean;
  positional: string[];
  child: string[];
}

function parseArguments(args: string[]): Arguments | undefined {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return undefined;
  const command = args[0];
  if (command !== "list" && command !== "each" && command !== "check" && command !== "survey") {
    throw new CliError("Unknown command. Run seshat --help.");
  }
  // After -- everything is the child's argv, including its --help.
  const delimiter = args.indexOf("--");
  const own = delimiter < 0 ? args.slice(1) : args.slice(1, delimiter);
  if (own.includes("--help") || own.includes("-h")) return undefined;
  const result: Arguments = { command, json: false, paths: false, strict: false,
    formatOnly: false, positional: [], child: delimiter < 0 ? [] : args.slice(delimiter + 1) };
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    if (arg === "--file" || arg === "--root" || arg === "--config") {
      const value = own[++i];
      if (value === undefined || value.startsWith("--")) throw new CliError(`${arg} needs a value.`);
      result[arg.slice(2) as "file" | "root" | "config"] = value;
    } else if (arg === "--json" && command !== "each") result.json = true;
    else if (arg === "--paths" && command === "list") result.paths = true;
    else if (arg === "--strict" && command === "check") result.strict = true;
    else if (arg === "--format-only" && command === "check") result.formatOnly = true;
    else if (arg.startsWith("-")) throw new CliError(`Unknown option: ${arg}`);
    else result.positional.push(arg);
  }
  if (result.paths && result.json) throw new CliError("Choose --paths or --json.");
  if (command === "each" && (delimiter < 0 || result.child.length === 0)) {
    throw new CliError("each needs -- COMMAND [ARG ...].");
  }
  if (command !== "each" && delimiter >= 0) throw new CliError("Only each accepts -- COMMAND.");
  if (command === "survey" && result.positional.length > 0) throw new CliError("survey takes no positional arguments; use --file or --root.");
  if (command === "check" && result.positional.length > 0) {
    if (result.positional.length !== 1 || result.file !== undefined) throw new CliError("check accepts one index file.");
    result.file = result.positional[0];
  }
  return result;
}

export function field(entry: IndexEntry, label: string): string | undefined {
  return entry.fields.find(item => item.label === label)?.value;
}

function entries(index: ProjectIndex): { classification: string; entry: IndexEntry }[] {
  return index.sections.flatMap(section => section.entries.map(entry => ({ classification: section.name, entry })));
}

function paths(index: ProjectIndex): string[] {
  return entries(index).flatMap(({ entry }) => {
    const path = field(entry, "Path");
    return path !== undefined && isRelativeIndexPath(path) ? [path] : [];
  });
}

function options(settings: Settings, index: ProjectIndex): SurveyOptions {
  if (!settings.root) throw new CliError("Set survey.root or pass --root; use check --format-only to skip disk checks.");
  return { root: settings.root, exclude: settings.exclude, excludeRemote: settings.excludeRemote,
    githubHosts: settings.githubHosts, paths: paths(index) };
}

async function readIndex(file: string): Promise<ProjectIndex> {
  try { return parseProjectIndex(await readFile(file)); }
  catch { throw new CliError(`Cannot read the index file: ${file}`); }
}

function sortProblems(problems: IndexProblem[]): IndexProblem[] {
  return problems.sort((a, b) => a.line - b.line || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

function printProblems(file: string, problems: IndexProblem[]): void {
  for (const problem of problems) {
    process.stdout.write(`${cell(file)}:${problem.line}: ${problem.severity} ${problem.code}: ${cell(problem.message)}\n`);
  }
}

function requireValid(index: ProjectIndex): void {
  if (index.problems.some(problem => problem.severity === "error")) {
    throw new CliError("Index has format errors; run seshat check --format-only for details.");
  }
}

export async function diskProblems(settings: Settings, index: ProjectIndex): Promise<IndexProblem[]> {
  const found = await discoverDirectories({ ...options(settings, index), includeIndexedParents: true });
  const byPath = new Map(found.directories.map(directory => [directory.path, directory]));
  const problems: IndexProblem[] = [];
  const indexedPaths = paths(index);
  for (const directory of found.directories) {
    if (!indexedPaths.includes(directory.path) && !indexedPaths.some(path => path.startsWith(`${directory.path}/`))) {
      problems.push({ code: "checkout-without-entry", severity: "warning", line: 1,
        message: `Directory ${JSON.stringify(directory.path)} has no entry.` });
    }
  }
  for (const { entry } of entries(index)) {
    const path = field(entry, "Path");
    if (path === undefined || !isRelativeIndexPath(path)) continue;
    const directory = byPath.get(path);
    if (directory === undefined) {
      // Discovery intentionally omits excluded entries. Only report paths
      // that are missing; excluded paths are filtered below by discovery's
      // shared exclusion predicate as well as directory enumeration.
      if (await isPathExcluded(path, settings.exclude)) continue;
      let exists = false;
      try { exists = (await stat(resolve(settings.root!, path))).isDirectory(); }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      if (!exists) problems.push({ code: "missing-checkout", severity: "warning", line: entry.line,
        entry: entry.name, message: `Checkout for ${JSON.stringify(entry.name)} is missing.` });
      continue;
    }
    const remote = field(entry, "Remote");
    const actualRemote = directory.remote ?? (directory.remoteStatus === "none" ? "none" : undefined);
    if (remote !== undefined && remote.toLowerCase() !== actualRemote?.toLowerCase()) {
      problems.push({ code: "remote-mismatch", severity: "warning", line: entry.line,
        entry: entry.name, message: `Origin does not match Remote for ${JSON.stringify(entry.name)}.` });
    }
  }
  return problems;
}

function select(index: ProjectIndex, classifications: string[]) {
  for (const name of classifications) {
    if (!index.sections.some(section => section.name === name)) throw new CliError(`No classification named ${JSON.stringify(name)}.`);
  }
  return entries(index).filter(item => classifications.length === 0 || classifications.includes(item.classification));
}

function cell(value: string): string {
  // Tables and paths are one record per line even when a heading or a local
  // filename contains a control character. JSON retains the original string.
  return value.replace(/[\x00-\x1f\x7f]/g, character => JSON.stringify(character).slice(1, -1));
}

async function each(settings: Settings, index: ProjectIndex, args: Arguments): Promise<number> {
  const selected = select(index, args.positional);
  const found = await discoverDirectories({ ...options(settings, index), includeIndexedParents: true });
  const byPath = new Map(found.directories.map(directory => [directory.path, directory]));
  const targets: { directory: SurveyDirectory; name: string; classification: string }[] = [];
  // Preflight every target before invoking the first command.
  for (const { entry, classification } of selected) {
    const path = field(entry, "Path");
    if (path === undefined) {
      process.stderr.write(`seshat: skipping ${cell(entry.name)} (no local Path).\n`);
      continue;
    }
    if (await isPathExcluded(path, settings.exclude)) continue;
    const directory = byPath.get(path);
    if (!directory) {
      try { if ((await stat(resolve(settings.root!, path))).isDirectory()) continue; }
      catch { /* A missing selected checkout stops all execution. */ }
      throw new CliError(`Checkout for ${JSON.stringify(entry.name)} is missing.`);
    }
    targets.push({ directory, name: entry.name, classification });
  }
  let failed = false;
  for (const target of targets) {
    process.stderr.write(`seshat: ${cell(target.classification)} / ${cell(target.name)}\n`);
    const code = await new Promise<number>(resolveExit => {
      const child = spawn(args.child[0]!, args.child.slice(1), { cwd: target.directory.absolutePath,
        stdio: "inherit", env: { ...process.env, SESHAT_PROJECT: target.name,
          SESHAT_CLASSIFICATION: target.classification, SESHAT_PATH: target.directory.path } });
      child.once("error", () => resolveExit(1));
      child.once("exit", (code, signal) => resolveExit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : code ?? 1));
    });
    if (code === 130 || code === 143) return code;
    if (code !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

export async function runCli(argv: string[]): Promise<number> {
  const args = parseArguments(argv);
  if (!args) { process.stdout.write(help); return 0; }
  const settings = await loadSettings(args);
  let index: ProjectIndex;
  if (args.command === "survey" && args.file === undefined && !settings.indexConfigured) {
    try { await stat(settings.file); index = await readIndex(settings.file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      index = { format: 1, preamble: "", fields: [], sections: [], problems: [] };
    }
  } else index = await readIndex(settings.file);

  if (args.command === "check") {
    const problems = sortProblems([...index.problems, ...(args.formatOnly ? [] : await diskProblems(settings, index))]);
    if (args.json) process.stdout.write(`${JSON.stringify({ ...index, problems }, null, 2)}\n`);
    else if (problems.length) printProblems(settings.file, problems);
    else process.stdout.write(`${cell(settings.file)}: no problems\n`);
    return problems.some(problem => problem.severity === "error" || args.strict) ? 1 : 0;
  }
  requireValid(index);
  if (args.command === "list") {
    const projects = select(index, args.positional).map(({ entry, classification }) => ({
      classification, ...entry,
      ...(field(entry, "Path") === undefined || !settings.root ? {} : { path: resolve(settings.root, field(entry, "Path")!) }),
    }));
    if (args.json) process.stdout.write(`${JSON.stringify(projects, null, 2)}\n`);
    else if (args.paths) {
      if (!settings.root) throw new CliError("Set survey.root or pass --root to print local paths.");
      for (const project of projects) if (project.path) process.stdout.write(`${cell(project.path)}\n`);
    } else {
      process.stdout.write("CLASSIFICATION\tPROJECT\tPATH\n");
      for (const project of projects) process.stdout.write(`${cell(project.classification)}\t${cell(project.name)}\t${cell(field(project, "Path") ?? "not reported")}\n`);
    }
    return 0;
  }
  if (args.command === "each") return each(settings, index, args);
  const report = await survey(options(settings, index));
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write("PATH\tREMOTE\tCHECKED OUT\tBRANCHES\tUNPUSHED\tUNCOMMITTED\n");
    for (const project of report.projects) {
      process.stdout.write([project.path, project.remote ?? "not reported", project.signals.checkedOut ?? "not a checkout",
        project.signals.branches ?? "not reported", project.signals.unpushed ?? "not reported",
        project.signals.uncommitted ?? "not reported"].map(cell).join("\t") + "\n");
      for (const warning of project.warnings ?? []) process.stderr.write(`seshat: ${cell(project.path)}: ${cell(warning)}\n`);
    }
    process.stderr.write(`seshat: ${report.excluded} excluded directories.\n`);
  }
  return 0;
}
