import { CliError } from "./settings.ts";
import { cloudflareDiscovery, inspectWorkerTarget } from "./site-cloudflare.ts";
import { MIGRATIONS } from "../object/schema.ts";
import { deploySite, verifySite, verifyAnonymousSite } from "./site-deploy.ts";
import { parseCredentials, registerGithubApp } from "./site-registration.ts";
import type { SiteConfig, SiteRuntime } from "./site-types.ts";

const APP_SECRETS = ["GITHUB_APP_SLUG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"];
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("The service returned an unexpected response.");
  return value as JsonObject;
}
function json(text: string): JsonObject {
  try { return object(JSON.parse(text)); } catch { throw new CliError("Wrangler returned an unexpected response; update the locked dependencies and retry."); }
}
function text(value: unknown): string | undefined { return typeof value === "string" && value !== "" ? value : undefined; }

async function choose(runtime: SiteRuntime, label: string, values: { label: string; value: string }[]): Promise<string> {
  if (values.length === 0) throw new CliError(`No ${label.toLowerCase()} were found for this authentication.`);
  if (values.length === 1) {
    process.stdout.write(`${label}: ${values[0]!.label}\n`);
    return values[0]!.value;
  }
  process.stdout.write(`${label}:\n${values.map((item, index) => `  ${index + 1}. ${item.label}`).join("\n")}\n`);
  const answer = await runtime.prompt("Choose a number");
  if (!/^[1-9][0-9]*$/.test(answer) || !values[Number(answer) - 1]) throw new CliError("Choose one of the listed numbers and run setup again.");
  return values[Number(answer) - 1]!.value;
}


async function expectedOwner(runtime: SiteRuntime): Promise<number | undefined> {
  try {
    const owner = json(await runtime.command("gh", ["api", "--hostname", "github.com", "user"]));
    if (Number.isSafeInteger(owner.id) && (owner.id as number) > 0 && owner.type === "User") {
      process.stdout.write(`GitHub account: ${String(owner.login)}\n`);
      return owner.id as number;
    }
  } catch { /* gh is optional; manifest conversion identifies the registering owner. */ }
  return undefined;
}

async function originFor(runtime: SiteRuntime, api: (path: string) => Promise<unknown>, accountId: string,
  workerName: string, existing: boolean): Promise<string> {
  const origins: string[] = [];
  if (existing) {
    const domains = await api(`/accounts/${accountId}/workers/domains`);
    if (Array.isArray(domains)) for (const entry of domains) {
      const domain = object(entry);
      if (domain.service === workerName && text(domain.hostname)) origins.push(`https://${domain.hostname as string}`);
    }
  }
  const subdomain = object(await api(`/accounts/${accountId}/workers/subdomain`));
  if (text(subdomain.subdomain)) {
    let enabled = !existing;
    if (existing) enabled = object(await api(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`)).enabled === true;
    if (enabled) origins.push(`https://${workerName}.${subdomain.subdomain as string}.workers.dev`);
  }
  if (origins.length > 0) return choose(runtime, "Instance origins", [...new Set(origins)].map(value => ({ label: value, value })));
  throw new CliError("No enabled production origin was discovered. Configure a Cloudflare workers.dev subdomain or Worker custom domain in the dashboard, then retry setup.");
}

async function remoteSecrets(api: (path: string) => Promise<unknown>, config: SiteConfig): Promise<Set<string>> {
  const values = await api(`/accounts/${config.accountId}/workers/scripts/${config.workerName}/secrets`);
  if (!Array.isArray(values)) throw new CliError("Cloudflare did not list the Worker's secret names.");
  return new Set(values.flatMap(item => typeof object(item).name === "string" ? [object(item).name as string] : []));
}
function configuredSecrets(secrets: Set<string>): boolean {
  return secrets.has("OWNER_ID") && APP_SECRETS.every(name => secrets.has(name));
}
function partialSecrets(secrets: Set<string>): boolean { return APP_SECRETS.some(name => secrets.has(name)); }


async function verifyExistingSite(runtime: SiteRuntime, config: SiteConfig): Promise<void> {
  const health = object(await runtime.fetchJson(`${config.origin}/api/health`));
  if (health.ok !== true || !Number.isSafeInteger(health.schemaVersion) || (health.schemaVersion as number) < 1 ||
    (health.schemaVersion as number) > MIGRATIONS.at(-1)!.version) {
    throw new CliError("The existing instance health/schema is incompatible with this checkout. Adoption is incomplete.");
  }
  await verifyAnonymousSite(runtime, config, true);
}

async function adopt(runtime: SiteRuntime, api: (path: string) => Promise<unknown>, config: SiteConfig): Promise<void> {
  const target = await inspectWorkerTarget(runtime, config);
  const secrets = await remoteSecrets(api, config);
  if (!configuredSecrets(secrets)) {
    throw new CliError("This existing Worker is not fully configured. Setup will not replace its App or secrets. Resume from its original checkout, or finish the existing registration using the advanced runbook.");
  }
  await runtime.confirm(`Adopt existing Worker ${config.workerName} in account ${config.accountId} at ${config.origin}? Its secrets and instance data will be preserved.`, false);
  // The existing owner/App are intentionally unknown: secret values cannot be downloaded.
  const adopted: SiteConfig = { format: 1, accountId: config.accountId, workerName: config.workerName,
    origin: config.origin, stage: "configured", namespaceId: target.namespaceId };
  await verifyExistingSite(runtime, adopted);
  await runtime.writeConfig(adopted);
  process.stdout.write("Existing instance adopted. Its owner and App credentials were preserved. Open the instance to confirm owner sign-in.\n");
}

/** Guided fresh setup, conservative adoption, and resume from private checkpoints. */
export async function setupSite(runtime: SiteRuntime, yes: boolean): Promise<void> {
  const { accounts, api } = await cloudflareDiscovery(runtime);
  let config = await runtime.readConfig();
  if (config) {
    if (!accounts.some(account => account.id === config!.accountId)) throw new CliError("The saved Cloudflare account is not available to the current authentication.");
    const scripts = await api(`/accounts/${config.accountId}/workers/scripts`);
    if (!Array.isArray(scripts)) throw new CliError("Cloudflare did not list Workers for the saved account.");
    const exists = scripts.some(item => object(item).id === config!.workerName);
    if (!exists && config.stage !== "selected") throw new CliError("The saved Worker no longer exists. Setup will not silently recreate its instance data.");
    if (exists) {
      const target = await inspectWorkerTarget(runtime, config);
      config = { ...config, namespaceId: target.namespaceId };
    }
    const secrets = exists ? await remoteSecrets(api, config) : new Set<string>();
    if (configuredSecrets(secrets)) {
      if (config.stage === "selected") { await adopt(runtime, api, config); return; }
      if (config.stage === "bootstrap" && await runtime.readPrivate("credentials.json")) {
        throw new CliError("App credentials appeared on the Worker during registration. Pending credentials were retained; setup will not replace or assume ownership of that App.");
      }
      await verifyExistingSite(runtime, config);
      config = { ...config, stage: "configured" };
      await runtime.writeConfig(config);
      await runtime.removePrivate("credentials.json");
      await runtime.removePrivate("registration.json");
      process.stdout.write("This instance is already configured. Use seshat site update to deploy this checkout, or seshat site open to sign in.\n");
      return;
    }
    if (exists && config.stage === "selected" && !partialSecrets(secrets)) {
      await runtime.confirm(`Worker ${config.workerName} now exists at the saved target. Adopt this unconfigured bootstrap and preserve its state?`, false);
      await verifySite(runtime, config, false);
      config = { ...config, stage: "bootstrap" };
      await runtime.writeConfig(config);
    }
    if (config.stage === "configured" || (partialSecrets(secrets) && !(await runtime.readPrivate("credentials.json")))) {
      throw new CliError("The saved instance has incomplete App secrets. Setup will not replace them; restore its existing credentials using the advanced runbook.");
    }
  } else {
    const accountId = await choose(runtime, "Cloudflare accounts", accounts.map(account => ({ label: `${account.name} (${account.id})`, value: account.id })));
    const scripts = await api(`/accounts/${accountId}/workers/scripts`);
    if (!Array.isArray(scripts)) throw new CliError("Cloudflare did not list Workers for the selected account.");
    const names = scripts.flatMap(item => text(object(item).id) ? [object(item).id as string] : []);
    let workerName = "seshat";
    if (names.includes(workerName)) {
      const origin = await originFor(runtime, api, accountId, workerName, true);
      await adopt(runtime, api, { format: 1, accountId, workerName, origin, stage: "selected" });
      return;
    }
    if (names.length > 0) {
      process.stdout.write(`Existing Workers: ${names.join(", ")}\n`);
      workerName = await runtime.prompt("Worker to adopt, or a new Worker name", "seshat");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) throw new CliError("Use a Worker name with lowercase letters, digits and hyphens, at most 63 characters.");
    const existing = names.includes(workerName);
    const origin = await originFor(runtime, api, accountId, workerName, existing);
    config = { format: 1, accountId, workerName, origin, stage: "selected" };
    if (existing) { await adopt(runtime, api, config); return; }
    await runtime.writeConfig(config);
  }
  if (config.stage === "selected") {
    // This cannot be skipped by --yes: account billing/quotas are not established by whoami.
    await runtime.confirm(`Provision Worker ${config.workerName}, frontend assets and a SQLite Durable Object namespace in Cloudflare account ${config.accountId}, serving ${config.origin}? Cloudflare usage may be billable under this account's plan; check its plan and usage in the dashboard before confirming.`, false);
    await deploySite(runtime, config, { yes: true, bootstrap: true });
    config = await runtime.readConfig();
    if (!config || config.stage !== "bootstrap") throw new CliError("The bootstrap deployment is unverified; inspect seshat site status before resuming setup.");
  }
  let pending = await runtime.readPrivate("credentials.json");
  let ownerId = config.ownerId;
  if (!pending) {
    const started = await runtime.readPrivate("registration.json");
    if (started) {
      const answer = await runtime.prompt("A previous registration may have created a GitHub App. Check https://github.com/settings/apps first. To deliberately begin another registration, type REGISTER");
      if (answer !== "REGISTER") throw new CliError("Registration was left unchanged. Finish or recover the existing App before restarting setup.");
    }
    ownerId = ownerId ?? await expectedOwner(runtime);
    config = { ...config, ...(ownerId ? { ownerId } : {}) };
    await runtime.writeConfig(config);
    const name = await runtime.prompt("GitHub App name (globally unique, at most 34 characters)", "Seshat for me");
    if (name.trim().length < 1 || name.trim().length > 34 || /[\u0000-\u001f]/.test(name)) throw new CliError("Use a GitHub App name of 1 to 34 characters without control characters.");
    await runtime.confirm(`Register private GitHub App ${name.trim()} for ${config.origin}? GitHub will ask you to approve it in your browser.`, yes);
    await runtime.writePrivate("registration.json", { origin: config.origin, ownerId: ownerId ?? null, startedAt: new Date().toISOString() });
    pending = await registerGithubApp(runtime, config.origin, name.trim());
  }
  const credentials = parseCredentials(pending);
  if (credentials.origin !== config.origin) throw new CliError("The pending App credentials belong to another instance origin. They were preserved; setup will not upload them to this Worker.");
  if (credentials.ownerType !== "User" || (ownerId !== undefined && credentials.ownerId !== ownerId)) {
    throw new CliError("The registered App belongs to a different account than expected, or to an organization. Credentials were retained privately; no secrets were uploaded. Check the browser account and recover the existing App before retrying.");
  }
  // Recheck after browser interaction: never replace another registration's values.
  const target = await inspectWorkerTarget(runtime, config);
  config = { ...config, namespaceId: target.namespaceId };
  const secrets = await remoteSecrets(api, config);
  if (partialSecrets(secrets) && config.stage !== "credentials") {
    throw new CliError("App credentials appeared on the Worker during setup. Pending credentials were retained; setup will not replace the configured App.");
  }
  if (config.stage !== "credentials") {
    await runtime.confirm(`Upload the registered App credentials to ${config.workerName} in account ${config.accountId}, making @${credentials.ownerLogin} the owner?`, yes);
    // Checkpoint before the request: a lost response is resumed with the same credentials.
    config = { ...config, ownerId: credentials.ownerId, appSlug: credentials.appSlug, stage: "credentials" };
    await runtime.writeConfig(config);
  }
  await runtime.wrangler(["secret", "bulk", "--name", config.workerName], { accountId: config.accountId, input: JSON.stringify(credentials.values) });
  await verifySite(runtime, config, true);
  config = { ...config, stage: "configured" };
  await runtime.writeConfig(config);
  await runtime.removePrivate("credentials.json");
  await runtime.removePrivate("registration.json");
  process.stdout.write("Worker and App credentials configured. Complete browser installation with All repositories, then sign in. Installation, owner sign-in and live GitHub synchronization still need browser verification.\n");
  await runtime.open(`https://github.com/apps/${encodeURIComponent(credentials.appSlug)}/installations/new`);
}
