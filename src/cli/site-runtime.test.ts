import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSiteRuntime, ensureSiteDependencies, siteEnvironment, siteValidationEnvironment } from "./site-runtime.ts";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), "seshat-site-runtime-")); roots.push(root); return root; }

describe("site command runtime", () => {
  it("pins the account and refuses conflicting environment selectors while clearing Git hook selectors", () => {
    const account = "a".repeat(32);
    const env = siteEnvironment(account, { CLOUDFLARE_ACCOUNT_ID: account, GIT_DIR: "/sentinel", GIT_INDEX_FILE: "/sentinel/index", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "x", GIT_CONFIG_VALUE_0: "y", CLOUDFLARE_API_TOKEN: "auth" });
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe(account);
    expect(env.CLOUDFLARE_API_TOKEN).toBe("auth");
    expect(Object.keys(env).filter(key => key.startsWith("GIT_"))).toEqual([]);
    for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID", "CLOUDFLARE_ENV", "WRANGLER_ENV", "WRANGLER_CONFIG", "CLOUDFLARE_API_BASE_URL"]) {
      expect(() => siteEnvironment(account, { [name]: "elsewhere" })).toThrow("Unset");
      expect(() => siteValidationEnvironment(account, { [name]: "elsewhere" })).toThrow("Unset");
    }
  });

  it("still pins the saved account in the actual Wrangler subprocess", async () => {
    const root = await temporary();
    const runtime = createSiteRuntime(root);
    const accountId = "a".repeat(32);
    await runtime.writeConfig({ format: 1, accountId, workerName: "fixture", origin: "https://example.com", stage: "configured" });
    await mkdir(join(root, "node_modules/wrangler/bin"), { recursive: true });
    await writeFile(join(root, "node_modules/wrangler/bin/wrangler.js"), "process.stdout.write(process.env.CLOUDFLARE_ACCOUNT_ID)");
    expect(await runtime.wrangler(["whoami"])).toBe(accountId);
  });

  it("waits for all subprocess output and never reports credential-bearing stderr", async () => {
    const runtime = createSiteRuntime(await temporary());
    const output = await runtime.command(process.execPath, ["-e", 'process.stdout.write("x".repeat(1024 * 1024))']);
    expect(output.length).toBe(1024 * 1024);
    await expect(runtime.command(process.execPath, ["-e", 'process.stderr.write("SECRET"); process.exit(1)'])).rejects.toThrow("Node command failed");
    try { await runtime.command(process.execPath, ["-e", 'process.stderr.write("SECRET"); process.exit(1)']); }
    catch (error) { expect(String(error)).not.toContain("SECRET"); }
  });

  it("bootstraps only locked dependencies, skips unchanged installs and never installs hooks", async () => {
    const root = await temporary();
    const runtime = createSiteRuntime(root);
    await writeFile(join(root, "package-lock.json"), "first lock");
    const commands: string[][] = [];
    runtime.command = async (executable, args) => {
      commands.push([executable, ...args]);
      await mkdir(join(root, "node_modules/wrangler/bin"), { recursive: true });
      await writeFile(join(root, "node_modules/wrangler/bin/wrangler.js"), "");
      return "";
    };
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await ensureSiteDependencies(runtime);
    await ensureSiteDependencies(runtime);
    expect(commands).toEqual([["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]]);
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
    await writeFile(join(root, "package-lock.json"), "changed lock");
    await ensureSiteDependencies(runtime);
    expect(commands).toHaveLength(2);
  });

  it("shows both top-level and site help from a fresh checkout without packages", async () => {
    const root = await temporary();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    await cp(resolve("src/cli"), join(root, "src/cli"), { recursive: true });
    await cp(resolve("src/object"), join(root, "src/object"), { recursive: true });
    await cp(resolve("scripts/build-identity.ts"), join(root, "scripts/build-identity.ts"));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const top = await exec(process.execPath, [join(root, "src/cli/main.ts"), "--help"], { cwd: tmpdir() });
    const site = await exec(process.execPath, [join(root, "src/cli/main.ts"), "site", "--help"], { cwd: tmpdir() });
    expect(top.stdout).toContain("site");
    expect(site.stdout).toContain("update [--yes]");
    expect(await readFile(join(root, "package.json"), "utf8")).toBe('{"type":"module"}');

    // A PATH symlink must keep its own site's settings even when invoked from
    // an unrelated checkout and before npm dependencies have been installed.
    await mkdir(join(root, "bin"));
    await cp(resolve("bin/seshat"), join(root, "bin/seshat"));
    const elsewhere = await temporary();
    const link = join(elsewhere, "seshat");
    await symlink(join(root, "bin/seshat"), link);
    const runtime = createSiteRuntime(root);
    await runtime.writeConfig({ format: 1, accountId: "a".repeat(32), workerName: "owning-checkout", origin: "https://example.com", stage: "configured" });
    let status: string;
    try { status = (await exec(link, ["site", "status", "--json"], { cwd: elsewhere })).stdout; }
    catch (error) { status = (error as { stdout: string }).stdout; }
    expect(JSON.parse(status)).toMatchObject({ workerName: "owning-checkout", verified: false });
    expect(JSON.parse(status).checkout.replace(/\/$/, "")).toBe(await realpath(root));
  });

  it("terminates and waits for an active subprocess before releasing its lock on SIGTERM", async () => {
    const root = await temporary();
    const configSource = pathToFileURL(resolve("src/cli/site-config.ts")).href;
    const runtimeSource = pathToFileURL(resolve("src/cli/site-runtime.ts")).href;
    const script = `
      import {lockSite} from ${JSON.stringify(configSource)};
      import {createSiteRuntime} from ${JSON.stringify(runtimeSource)};
      await lockSite(${JSON.stringify(join(root, ".seshat"))});
      try { await createSiteRuntime(${JSON.stringify(root)}).command(process.execPath,
        ["-e", 'process.stdout.write("CHILD="+process.pid); setInterval(()=>{},10000)'], {interactive:true}); } catch {}
      setInterval(()=>{},10000);
    `;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let childPid: number | undefined;
    try {
      childPid = await new Promise<number>((resolveReady, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Child did not announce readiness.")), 3000);
        parent.stdout.on("data", chunk => {
          output += String(chunk);
          const matched = /CHILD=(\d+)/.exec(output);
          if (matched) { clearTimeout(timer); resolveReady(Number(matched[1])); }
        });
        parent.once("error", error => { clearTimeout(timer); reject(error); });
        parent.once("exit", () => { clearTimeout(timer); reject(new Error("Parent exited before starting its child.")); });
      });
      const exited = new Promise<number | null>(resolveExit => parent.once("exit", code => resolveExit(code)));
      parent.kill("SIGTERM");
      expect(await exited).toBe(143);
      expect(() => process.kill(childPid!, 0)).toThrow();
      const { lockSite } = await import("./site-config.ts");
      await (await lockSite(join(root, ".seshat")))();
    } finally {
      parent.kill("SIGKILL");
      if (childPid !== undefined) try { process.kill(childPid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }, 10_000);
});
