import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CliError } from "./settings.ts";
import { lockSite } from "./site-config.ts";
import { inspectSite, deploySite, verifySite } from "./site-deploy.ts";
import { createSiteRuntime, ensureSiteDependencies, siteEnvironment, siteValidationEnvironment } from "./site-runtime.ts";
import type { SiteConfig, SiteRuntime } from "./site-types.ts";

export const siteHelp = `Usage: seshat site <command> [options]

  setup [--yes]      Discover, adopt or set up this checkout's hosted site
  update [--yes]     Validate, build and deploy the current clean checkout
  status [--json]    Inspect the live Worker deployment and source identity
  doctor [--json]    Check local prerequisites and anonymous hosted gates
  logs              Follow new Worker events until Ctrl-C
  open              Open this checkout's saved site in your browser
  validate          Run the repository's complete local checks
  build             Build the current checkout for local inspection

Site settings belong to the launcher's checkout in .seshat/.
Update never fetches or pulls. --yes skips the normal change confirmation;
new billable provisioning still requires explicit confirmation.
`;

type SiteCommand = "setup" | "update" | "status" | "doctor" | "logs" | "open" | "validate" | "build";

export function parseSiteArguments(args: string[]): { command: SiteCommand; yes: boolean; json: boolean } | null {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    if (args.length > 1) throw new CliError("Unexpected arguments after site help.");
    return null;
  }
  const command = args[0] as SiteCommand;
  if (!["setup", "update", "status", "doctor", "logs", "open", "validate", "build"].includes(command)) throw new CliError("Unknown site command. Run seshat site --help.");
  const options = args.slice(1);
  if (options.length === 1 && (options[0] === "--help" || options[0] === "-h")) return null;
  let yes = false;
  let json = false;
  for (const option of options) {
    if (option === "--yes" && (command === "setup" || command === "update") && !yes) yes = true;
    else if (option === "--json" && (command === "status" || command === "doctor") && !json) json = true;
    else throw new CliError(`Unexpected site option: ${option}. Run seshat site --help.`);
  }
  return { command, yes, json };
}

export async function runSiteCli(args: string[], root: string, injected?: SiteRuntime): Promise<number> {
  const parsed = parseSiteArguments(args);
  if (parsed === null) { process.stdout.write(siteHelp); return 0; }
  const runtime = injected ?? createSiteRuntime(root);
  const mutable = ["setup", "update", "validate", "build"].includes(parsed.command);
  const unlock = mutable ? await lockSite(runtime.configDir) : undefined;
  try {
    if (parsed.command === "setup") {
      await ensureSiteDependencies(runtime);
      const setupUrl = pathToFileURL(join(root, "src/cli/site-setup.ts")).href;
      const { setupSite } = await import(setupUrl) as { setupSite(runtime: SiteRuntime, yes: boolean): Promise<unknown> };
      await setupSite(runtime, parsed.yes);
      return 0;
    }
    if (parsed.command === "validate" || parsed.command === "build") {
      await ensureSiteDependencies(runtime);
      const config = await runtime.readConfig();
      const env = parsed.command === "validate" ? siteValidationEnvironment(config?.accountId) : siteEnvironment(config?.accountId);
      await runtime.command(parsed.command === "validate" ? "bash" : "npm",
        parsed.command === "validate" ? ["scripts/check.sh"] : ["run", "--silent", "build"], { interactive: true, env });
      return 0;
    }
    const config = await runtime.readConfig();
    if (config === null) throw new CliError("No site belongs to this checkout yet. Run seshat site setup.");
    siteEnvironment(config.accountId);
    if (parsed.command === "update") {
      await deploySite(runtime, config, { yes: parsed.yes });
      return 0;
    }
    if (parsed.command === "open") { await runtime.open(config.origin); return 0; }
    if (parsed.command === "logs") {
      await runtime.wrangler(["tail", config.workerName, "--format", "pretty"], { accountId: config.accountId, interactive: true });
      return 0;
    }
    let report: unknown;
    if (parsed.command === "doctor") {
      const local: Record<string, boolean> = {};
      for (const executable of ["git", "npm"]) {
        try { await runtime.command(executable, ["--version"]); local[executable] = true; }
        catch { local[executable] = false; }
      }
      local.node = Number(process.versions.node.split(".")[0]) >= 24;
      try { await access(join(root, "node_modules/wrangler/bin/wrangler.js")); local.dependencies = true; }
      catch { local.dependencies = false; }
      let hosted: unknown;
      let healthy = Object.values(local).every(Boolean) && config.stage === "configured";
      try {
        const targetUrl = pathToFileURL(join(root, "src/cli/site-cloudflare.ts")).href;
        const { inspectWorkerTarget } = await import(targetUrl) as { inspectWorkerTarget(runtime: SiteRuntime, config: SiteConfig): Promise<unknown> };
        const target = await inspectWorkerTarget(runtime, config);
        hosted = { ...await verifySite(runtime, config, config.stage === "configured"), target };
      }
      catch { healthy = false; hosted = { verified: false, message: "Hosted checks did not pass; check authentication, setup stage, target origin and active deployment." }; }
      report = { healthy, checkout: root, accountId: config.accountId, workerName: config.workerName, origin: config.origin, stage: config.stage, local, hosted,
        lastOperation: await runtime.readPrivate("operation.json"),
        limits: "Anonymous checks do not verify owner sign-in, authenticated sockets, GitHub freshness, quota or recovery." };
      if (parsed.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        process.stdout.write(`Site ${config.origin}: ${healthy ? "anonymous checks passed" : "checks need attention"}\n`);
        process.stdout.write(`Account: ${config.accountId}\nWorker: ${config.workerName}\nCheckout: ${root}\nSetup: ${config.stage}\n`);
        for (const [name, passed] of Object.entries(local)) process.stdout.write(`${name}: ${passed ? "available" : "missing"}\n`);
        const operation = (report as { lastOperation: { state?: unknown } | null }).lastOperation;
        if (operation && typeof operation.state === "string") process.stdout.write(`Last operation: ${operation.state}\n`);
        process.stdout.write("Owner sign-in, authenticated sockets and real GitHub freshness still require browser verification.\n");
      }
      return healthy ? 0 : 1;
    }
    let inspection;
    try { inspection = await inspectSite(runtime, config); }
    catch {
      report = { verified: false, origin: config.origin, accountId: config.accountId, workerName: config.workerName, checkout: root, stage: config.stage,
        message: "Serving source identity is unknown or could not be verified; run site doctor.",
        lastOperation: await runtime.readPrivate("operation.json") };
      if (parsed.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        process.stdout.write(`${config.origin}\nAccount: ${config.accountId}\nWorker: ${config.workerName}\nSource: unknown or unverified\nSetup: ${config.stage}\nCheckout: ${root}\n`);
        const operation = (report as { lastOperation: { state?: unknown } | null }).lastOperation;
        if (operation && typeof operation.state === "string") process.stdout.write(`Last operation: ${operation.state}\n`);
      }
      return 1;
    }
    report = { checkout: root, accountId: config.accountId, workerName: config.workerName, stage: config.stage, ...inspection, lastOperation: await runtime.readPrivate("operation.json") };
    if (parsed.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      const identity = report as { build: { commit: string }; deployment: { id: string; versions: { id: string; percentage: number }[] } };
      process.stdout.write(`${config.origin}\nAccount: ${config.accountId}\nWorker: ${config.workerName}\nSource: ${identity.build.commit}\nDeployment: ${identity.deployment.id}\n`);
      for (const version of identity.deployment.versions) process.stdout.write(`Version: ${version.id} (${version.percentage}%)\n`);
      process.stdout.write(`Setup: ${config.stage}\nCheckout: ${root}\n`);
      const operation = (report as { lastOperation: { state?: unknown } | null }).lastOperation;
      if (operation && typeof operation.state === "string") process.stdout.write(`Last operation: ${operation.state}\n`);
    }
    return 0;
  } finally { await unlock?.(); }
}
