import { CliError } from "./settings.ts";
import type { SiteConfig, SiteRuntime } from "./site-types.ts";

const CF = "https://api.cloudflare.com/client/v4";
const APP_SECRETS = ["OWNER_ID", "GITHUB_APP_SLUG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"];
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("Cloudflare returned an unexpected response.");
  return value as JsonObject;
}
function json(value: string): JsonObject {
  try { return object(JSON.parse(value)); } catch { throw new CliError("Wrangler returned an unexpected response; update the locked dependencies and retry."); }
}
function text(value: unknown): string | undefined { return typeof value === "string" && value !== "" ? value : undefined; }

export async function cloudflareDiscovery(runtime: SiteRuntime): Promise<{ accounts: { id: string; name: string }[]; api: (path: string) => Promise<unknown> }> {
  let identity: JsonObject;
  try {
    identity = json(await runtime.wrangler(["whoami", "--json"]));
    if (identity.loggedIn !== true) throw new Error("not authenticated");
  }
  catch {
    await runtime.confirm("Open Cloudflare login in your browser?", false);
    await runtime.wrangler(["login"], { interactive: true });
    identity = json(await runtime.wrangler(["whoami", "--json"]));
    if (identity.loggedIn !== true) throw new CliError("Cloudflare login did not finish; run setup again after approving it in the browser.");
  }
  const accounts = Array.isArray(identity.accounts) ? identity.accounts.flatMap((item: unknown) => {
    const account = object(item);
    return typeof account.id === "string" && /^[a-f0-9]{32}$/.test(account.id) && typeof account.name === "string"
      ? [{ id: account.id, name: account.name }] : [];
  }) : [];
  // Capture only in memory; never persist or echo the management credential.
  const authentication = json(await runtime.wrangler(["auth", "token", "--json"]));
  const headers: Record<string, string> = {};
  if ((authentication.type === "oauth" || authentication.type === "api_token") && text(authentication.token)) {
    headers.Authorization = `Bearer ${authentication.token as string}`;
  } else if (authentication.type === "api_key" && text(authentication.key) && text(authentication.email)) {
    headers["X-Auth-Key"] = authentication.key as string;
    headers["X-Auth-Email"] = authentication.email as string;
  } else throw new CliError("Wrangler could not supply Cloudflare authentication for discovery.");
  return { accounts, api: async path => {
    const response = await runtime.request(`${CF}${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new CliError("Cloudflare discovery failed. Check your account permissions and retry setup.");
    const body = object(await response.json());
    if (body.success !== true) throw new CliError("Cloudflare discovery failed. Check your account permissions and retry setup.");
    return body.result;
  } };
}

function requireAccount(accounts: { id: string; name: string }[], accountId: string): void {
  if (!accounts.some(account => account.id === accountId)) throw new CliError("The saved Cloudflare account is not available to the current authentication.");
}

/** Confirm the live target independently of public app identity or local checkout. */
export async function inspectWorkerTarget(runtime: SiteRuntime, config: SiteConfig): Promise<{ namespaceId: string; configured: boolean }> {
  const { accounts, api } = await cloudflareDiscovery(runtime);
  requireAccount(accounts, config.accountId);
  const settings = object(await api(`/accounts/${config.accountId}/workers/scripts/${config.workerName}/settings`));
  const bindings = Array.isArray(settings.bindings) ? settings.bindings.filter(item => object(item).name === "INSTANCE") : [];
  const binding = bindings.length === 1 ? object(bindings[0]) : null;
  if (!binding || binding.type !== "durable_object_namespace" || binding.class_name !== "InstanceObject" ||
    (binding.script_name !== undefined && binding.script_name !== config.workerName) || binding.environment !== undefined ||
    typeof binding.namespace_id !== "string" || !/^[^\s\u0000-\u001f]{1,128}$/.test(binding.namespace_id)) {
    throw new CliError("The selected Worker does not have a locally owned Seshat INSTANCE/InstanceObject namespace. It will not be adopted or replaced.");
  }
  const namespaceId = binding.namespace_id;
  if (config.namespaceId !== undefined && config.namespaceId !== namespaceId) throw new CliError("The Worker's Durable Object namespace changed. Refusing to select different instance data.");
  let matchingOrigin = false;
  const domains = await api(`/accounts/${config.accountId}/workers/domains`);
  if (Array.isArray(domains)) matchingOrigin = domains.some(item => {
    const domain = object(item);
    return domain.service === config.workerName && (domain.environment === undefined || domain.environment === "production") &&
      typeof domain.hostname === "string" && `https://${domain.hostname}` === config.origin;
  });
  if (!matchingOrigin) {
    const subdomain = object(await api(`/accounts/${config.accountId}/workers/subdomain`));
    const enabled = object(await api(`/accounts/${config.accountId}/workers/scripts/${config.workerName}/subdomain`));
    matchingOrigin = enabled.enabled === true && typeof subdomain.subdomain === "string" &&
      config.origin === `https://${config.workerName}.${subdomain.subdomain}.workers.dev`;
  }
  if (!matchingOrigin) throw new CliError("The saved origin does not map to the selected Cloudflare Worker. Refusing to use a different target.");
  const secrets = await api(`/accounts/${config.accountId}/workers/scripts/${config.workerName}/secrets`);
  if (!Array.isArray(secrets)) throw new CliError("Cloudflare did not list the Worker's secret names.");
  const names = new Set(secrets.map(item => object(item).name));
  return { namespaceId, configured: APP_SECRETS.every(name => names.has(name)) };
}

/** A bootstrap must never replace a Worker created before or during its build. */
export async function assertWorkerAbsent(runtime: SiteRuntime, config: SiteConfig): Promise<void> {
  const { accounts, api } = await cloudflareDiscovery(runtime);
  requireAccount(accounts, config.accountId);
  const scripts = await api(`/accounts/${config.accountId}/workers/scripts`);
  if (!Array.isArray(scripts)) throw new CliError("Cloudflare did not list Workers for the selected account.");
  if (scripts.some(item => object(item).id === config.workerName)) throw new CliError("A Worker already exists at the bootstrap target. Run seshat site setup to inspect and adopt it before deploying.");
}
