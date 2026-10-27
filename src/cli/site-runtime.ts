import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { cleanGitEnvironment } from "./git.ts";
import { CliError } from "./settings.ts";
import { readPrivate, removePrivate, validateSiteConfig, writePrivate } from "./site-config.ts";
import type { CommandOptions, SiteRuntime } from "./site-types.ts";

const children = new Map<ChildProcess, { closed: Promise<void>; detached: boolean }>();

/** Finish subprocess shutdown before a signal releases the site's mutation lock. */
export async function stopSiteChildren(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const active = [...children];
  const send = (child: ChildProcess, detached: boolean, value: NodeJS.Signals) => {
    try {
      if (detached && child.pid !== undefined) process.kill(-child.pid, value);
      else child.kill(value);
    } catch { /* The subprocess may already have exited. */ }
  };
  for (const [child, state] of active) send(child, state.detached, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(active.map(([, state]) => state.closed)), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
  clearTimeout(timer);
  for (const [child, state] of active) if (children.has(child)) send(child, state.detached, "SIGKILL");
  await Promise.all(active.map(([, state]) => state.closed));
}

/** Authentication can be inherited; target selectors may never redirect a saved site. */
export function siteEnvironment(accountId?: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = cleanGitEnvironment(environment);
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID"]) {
    if (result[key] && result[key] !== accountId) throw new CliError(`Unset ${key}; it conflicts with the saved site target.`);
    delete result[key];
  }
  for (const key of ["CLOUDFLARE_ENV", "WRANGLER_ENV", "WRANGLER_CONFIG", "CLOUDFLARE_API_BASE_URL", "CF_API_BASE_URL"]) {
    if (result[key]) throw new CliError(`Unset ${key}; site commands use an explicit saved target.`);
  }
  if (accountId) result.CLOUDFLARE_ACCOUNT_ID = accountId;
  result.WRANGLER_SEND_METRICS = "false";
  return result;
}

export function createSiteRuntime(root: string): SiteRuntime {
  const configDir = join(root, ".seshat");
  const runtime: SiteRuntime = {
    root, configDir,
    readPrivate: name => readPrivate(configDir, name),
    writePrivate: (name, value) => writePrivate(configDir, name, value),
    removePrivate: name => removePrivate(configDir, name),
    async readConfig() {
      const value = await runtime.readPrivate("site.json");
      return value === null ? null : validateSiteConfig(value);
    },
    writeConfig: config => runtime.writePrivate("site.json", validateSiteConfig(config)),
    async command(executable: string, args: string[], options: CommandOptions = {}) {
      return new Promise<string>((resolve, reject) => {
        const detached = !options.interactive;
        const child = spawn(executable, args, { cwd: root, detached, env: { ...cleanGitEnvironment(), ...options.env },
          stdio: [options.input === undefined && options.interactive ? "inherit" : "pipe", options.interactive ? "inherit" : "pipe", options.interactive ? "inherit" : "pipe"] });
        const closed = new Promise<void>(resolveClosed => child.once("close", () => { children.delete(child); resolveClosed(); }));
        children.set(child, { closed, detached });
        let output = "";
        let tooLarge = false;
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (Buffer.byteLength(output) > 16 * 1024 * 1024) { tooLarge = true; child.kill(); }
        });
        // Drain without exposing potentially credential-bearing subprocess stderr.
        child.stderr?.resume();
        child.stdin?.on("error", () => undefined);
        if (child.stdin) child.stdin.end(options.input);
        child.once("error", () => reject(new CliError(`Could not start ${executable === process.execPath ? "Node" : executable}; check prerequisites.`)));
        child.once("close", (code, signal) => {
          if (code === 0 && !tooLarge) resolve(output);
          else reject(new CliError(`The ${executable === process.execPath ? "Node" : executable} command ${signal ? "was interrupted" : "failed"}; check authentication, prerequisites and the selected target.`));
        });
      });
    },
    async wrangler(args, options = {}) {
      const config = await runtime.readConfig();
      const account = options.accountId ?? config?.accountId;
      const explicitConfig = args.includes("--config") || args.includes("-c");
      return runtime.command(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), ...args,
        ...(explicitConfig ? [] : ["--config", join(root, "wrangler.jsonc")])],
      { input: options.input, interactive: options.interactive, env: siteEnvironment(account) });
    },
    async prompt(message, defaultValue) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError("This step needs an interactive terminal; run site setup in a terminal.");
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try { return (await terminal.question(`${message}${defaultValue ? ` [${defaultValue}]` : ""}: `)).trim() || defaultValue || ""; }
      finally { terminal.close(); }
    },
    async confirm(message, yes) {
      if (yes) return;
      const reply = await runtime.prompt(`${message} Continue? (yes/no)`, "no");
      if (reply.toLowerCase() !== "yes") throw new CliError("Site operation cancelled; nothing further was changed.");
    },
    async open(url) {
      const parsed = new URL(url);
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new CliError("Cannot open this URL.");
      const executable = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
      if (!executable) throw new CliError("Automatic browser opening is unavailable on this platform.");
      await runtime.command(executable, [url]);
    },
    request: (url, init) => fetch(url, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(15_000) }),
    async fetchJson(url) {
      const response = await runtime.request(url, { headers: { accept: "application/json", "cache-control": "no-cache" } });
      if (!response.ok) throw new CliError("The requested endpoint returned an unsuccessful status.");
      return response.json() as Promise<unknown>;
    },
  };
  return runtime;
}

/** Usable directly from a fresh clone: this module has no package imports. */
export async function ensureSiteDependencies(runtime: SiteRuntime): Promise<void> {
  const lock = await readFile(join(runtime.root, "package-lock.json"), "utf8");
  let installed: string | null = null;
  let exists = true;
  try { await access(join(runtime.root, "node_modules/wrangler/bin/wrangler.js")); }
  catch { exists = false; }
  if (exists) installed = await runtime.readPrivate("dependencies.json").then(value =>
    typeof value === "object" && value !== null && "lock" in value && typeof value.lock === "string" ? value.lock : null);
  const { createHash } = await import("node:crypto");
  const fingerprint = createHash("sha256").update(lock).digest("hex");
  if (installed === fingerprint) return;
  process.stderr.write("seshat: installing locked dependencies (without package install scripts or Git hooks).\n");
  await runtime.command("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  await runtime.writePrivate("dependencies.json", { lock: fingerprint });
}
