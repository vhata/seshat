import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockSite, readPrivate, removePrivate, validateSiteConfig, writePrivate } from "./site-config.ts";

let root: string;
let directory: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "seshat-site-settings-")); directory = join(root, ".seshat"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("checkout-owned private site files", () => {
  it("does not create settings during an absent read; writes atomically with private modes", async () => {
    expect(await readPrivate(directory, "site.json")).toBeNull();
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await writePrivate(directory, "site.json", { first: 1 });
    await writePrivate(directory, "site.json", { second: 2 });
    expect(await readPrivate(directory, "site.json")).toEqual({ second: 2 });
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, "site.json"))).mode & 0o777).toBe(0o600);
    await removePrivate(directory, "site.json");
    expect(await readPrivate(directory, "site.json")).toBeNull();
  });

  it("refuses a symlink settings directory and linked/private-file escape attempts", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, directory);
    await expect(writePrivate(directory, "site.json", {})).rejects.toThrow("symlink");
    await rm(directory);
    await mkdir(directory, { mode: 0o700 });
    const sentinel = join(root, "sentinel");
    await writeFile(sentinel, "untouched", { mode: 0o600 });
    await symlink(sentinel, join(directory, "site.json"));
    await expect(writePrivate(directory, "site.json", {})).rejects.toThrow("without links");
    await expect(readPrivate(directory, "site.json")).rejects.toThrow("without links");
    await expect(removePrivate(directory, "site.json")).rejects.toThrow("without links");
    await expect(writePrivate(directory, "../sentinel", {})).rejects.toThrow("filename");
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
  });

  it("refuses public credential files and serializes mutators with a process lock", async () => {
    await writePrivate(directory, "credentials.json", { secret: "private" });
    await chmod(join(directory, "credentials.json"), 0o644);
    await expect(readPrivate(directory, "credentials.json")).rejects.toThrow("mode 600");
    const unlock = await lockSite(directory);
    await expect(lockSite(directory)).rejects.toThrow("Another site operation");
    await unlock();
    await (await lockSite(directory))();
  });

  it("releases a killed owner's lock and sweeps only safe interrupted private writes", async () => {
    const source = pathToFileURL(resolve("src/cli/site-config.ts")).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {lockSite} from ${JSON.stringify(source)}; await lockSite(${JSON.stringify(directory)}); process.stdout.write("locked"); setInterval(()=>{},10000);`], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolveReady, reject) => {
        child.stdout.once("data", () => resolveReady());
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Child exited before taking the lock.")));
      });
      await expect(lockSite(directory)).rejects.toThrow("Another site operation");
      const pending = "pending-11111111-1111-4111-8111-111111111111.json";
      const linked = "pending-22222222-2222-4222-8222-222222222222.json";
      await writeFile(join(directory, pending), '{"secret":"interrupted"}', { mode: 0o600 });
      const sentinel = join(root, "sentinel");
      await writeFile(sentinel, "untouched", { mode: 0o600 });
      await symlink(sentinel, join(directory, linked));
      const exited = new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
      child.kill("SIGKILL");
      await exited;
      const unlock = await lockSite(directory);
      await unlock();
      await expect(lstat(join(directory, pending))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(join(directory, linked))).isSymbolicLink()).toBe(true);
      expect(await readFile(sentinel, "utf8")).toBe("untouched");
    } finally { child.kill("SIGKILL"); }
  });

  it("validates saved targets and projects only the supported schema", () => {
    const config = { format: 1, accountId: "a".repeat(32), workerName: "personal-site", origin: "https://example.com/", stage: "configured", namespaceId: "b".repeat(32), privateKey: "must not persist" };
    expect(validateSiteConfig(config)).toEqual({ format: 1, accountId: config.accountId, workerName: config.workerName,
      origin: "https://example.com", stage: "configured", namespaceId: config.namespaceId });
    for (const change of [{ origin: "https://user:secret@example.com" }, { origin: "http://example.com" }, { origin: "https://example.com/path" },
      { accountId: "bad" }, { workerName: "../other" }, { stage: "other" }, { namespaceId: "bad namespace" }, { ownerId: 0 }]) {
      expect(() => validateSiteConfig({ ...config, ...change })).toThrow();
    }
    expect(validateSiteConfig({ ...config, namespaceId: "namespace-1" }).namespaceId).toBe("namespace-1");
  });
});
