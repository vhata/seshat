import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class CliError extends Error {}

export interface Settings {
  config: string;
  file: string;
  root?: string;
  exclude: string[];
  excludeRemote: string[];
  githubHosts: string[];
  indexConfigured: boolean;
}

export interface SettingsOverrides { config?: string; root?: string; file?: string }

export async function loadSettings(overrides: SettingsOverrides): Promise<Settings> {
  const config = resolve(overrides.config ?? process.env.SESHAT_SURVEY_CONFIG ??
    resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "seshat/survey.conf"));
  let exists = true;
  try { await access(config); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CliError("Cannot read survey settings.");
    exists = false;
  }
  if (!exists && (overrides.config !== undefined || process.env.SESHAT_SURVEY_CONFIG !== undefined)) {
    throw new CliError("Survey settings file does not exist.");
  }

  async function get(key: string, path = false): Promise<string[]> {
    if (!exists) return [];
    try {
      // NUL records preserve embedded whitespace and newlines in paths/patterns.
      const { stdout } = await exec("git", ["config", "--file", config, "--includes", "--null",
        ...(path ? ["--type=path"] : []), "--get-all", key], { maxBuffer: 1024 * 1024 });
      return stdout.split("\0").filter((_, i, all) => i < all.length - 1);
    } catch (error) {
      if ((error as { code?: number }).code === 1) return [];
      throw new CliError("Cannot read survey settings with git config.");
    }
  }

  const last = (values: string[]) => values.at(-1);
  const rootValue = overrides.root ?? last(await get("survey.root", true));
  const clone = last(await get("index.clone", true));
  const configuredFile = last(await get("index.file")) ?? "PROJECTS.md";
  if (!isRelativeIndexPath(configuredFile)) throw new CliError("index.file must be a relative path inside the index clone.");
  return {
    config,
    // Path settings from the file are relative to that file. Command flags
    // remain relative to the caller, so a scratch survey worktree works too.
    root: rootValue === undefined ? undefined : resolve(overrides.root === undefined ? dirname(config) : process.cwd(), rootValue),
    file: overrides.file === undefined
      ? resolve(clone === undefined ? process.cwd() : resolve(dirname(config), clone), configuredFile)
      : resolve(overrides.file),
    exclude: await get("survey.exclude"),
    excludeRemote: await get("survey.excludeRemote"),
    githubHosts: await get("survey.githubHost"),
    indexConfigured: clone !== undefined,
  };
}

export function isRelativeIndexPath(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !value.startsWith("~") &&
    !value.endsWith("/") && !value.includes("\\") &&
    value.split("/").every(part => part !== "." && part !== "..");
}
