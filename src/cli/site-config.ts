import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CliError } from "./settings.ts";
import type { SiteConfig } from "./site-types.ts";

export function validateSiteConfig(value: unknown): SiteConfig {
  if (typeof value !== "object" || value === null) throw new CliError("Site settings are not valid JSON settings.");
  const config = value as Record<string, unknown>;
  let origin: URL;
  try { origin = new URL(String(config.origin)); } catch { throw new CliError("Site settings need an HTTPS origin."); }
  if (config.format !== 1 || typeof config.accountId !== "string" || !/^[a-fA-F0-9]{32}$/.test(config.accountId) ||
      typeof config.workerName !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/.test(config.workerName) ||
      origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      !["selected", "bootstrap", "credentials", "configured"].includes(String(config.stage)) ||
      (config.ownerId !== undefined && (!Number.isSafeInteger(config.ownerId) || Number(config.ownerId) <= 0)) ||
      (config.namespaceId !== undefined && (typeof config.namespaceId !== "string" || !/^[^\s\u0000-\u001f]{1,128}$/.test(config.namespaceId))) ||
      (config.appSlug !== undefined && (typeof config.appSlug !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(config.appSlug)))) {
    throw new CliError("Site settings have an invalid format, account, Worker, origin or setup stage.");
  }
  return { format: 1, accountId: config.accountId, workerName: config.workerName, origin: origin.origin,
    stage: config.stage as SiteConfig["stage"],
    ...(config.ownerId === undefined ? {} : { ownerId: config.ownerId as number }),
    ...(config.appSlug === undefined ? {} : { appSlug: config.appSlug as string }),
    ...(config.namespaceId === undefined ? {} : { namespaceId: config.namespaceId as string }) };
}

function privatePath(directory: string, name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new CliError("Invalid private site filename.");
  return join(directory, name);
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new CliError("The .seshat directory must be a private directory, not a symlink.");
  if (info.uid !== process.getuid?.()) throw new CliError("The .seshat directory must belong to your user.");
  await chmod(directory, 0o700);
}

async function inspectFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new CliError("Private site files must be owned by you, mode 600, regular files without links.");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readPrivate(directory: string, name: string): Promise<unknown | null> {
  try { await lstat(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  await ensurePrivateDirectory(directory);
  const path = privatePath(directory, name);
  if (!await inspectFile(path)) return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024) throw new CliError("Private site file is not a supported JSON file.");
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new CliError("Private site file contains invalid JSON.");
    throw error;
  } finally { await file.close(); }
}

export async function writePrivate(directory: string, name: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(directory);
  const path = privatePath(directory, name);
  await inspectFile(path);
  const temporary = privatePath(directory, `pending-${randomUUID()}.json`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
    await file.close();
    await inspectFile(path);
    await rename(temporary, path);
  } finally {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function removePrivate(directory: string, name: string): Promise<void> {
  await ensurePrivateDirectory(directory);
  const path = privatePath(directory, name);
  if (await inspectFile(path)) await unlink(path);
}

export async function lockSite(directory: string): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(directory);
  const lock = join(directory, "operation.lock");
  try {
    const file = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.close();
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await inspectFile(lock);
  // SQLite's OS-backed lock is released even after SIGKILL. Keeping the file
  // avoids stale-PID recovery and pathname races between competing reclaimers.
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(lock);
  try { database.exec("BEGIN EXCLUSIVE"); }
  catch {
    database.close();
    throw new CliError("Another site operation holds this checkout's lock. Retry after it finishes; interrupted operations release the lock automatically.");
  }
  let released = false;
  function release() {
    if (released) return;
    released = true;
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    database.exec("ROLLBACK");
    database.close();
  }
  let stopping = false;
  async function stop(signal: "SIGINT" | "SIGTERM", code: number) {
    if (stopping) return;
    stopping = true;
    const { stopSiteChildren } = await import("./site-runtime.ts");
    await stopSiteChildren(signal);
    release();
    process.exit(code);
  }
  function interrupt() { void stop("SIGINT", 130); }
  function terminate() { void stop("SIGTERM", 143); }
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    for (const name of await readdir(directory)) {
      if (!/^pending-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/.test(name)) continue;
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o600) await unlink(path);
    }
  } catch (error) { release(); throw error; }
  return async () => { release(); };
}
