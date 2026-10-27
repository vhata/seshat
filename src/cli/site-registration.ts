import { randomBytes, timingSafeEqual, createPrivateKey } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildManifest } from "../shared/manifest.ts";
import { CliError } from "./settings.ts";
import type { SiteRuntime } from "./site-types.ts";

export interface SiteCredentials {
  origin: string;
  appId: number;
  appSlug: string;
  ownerId: number;
  ownerLogin: string;
  ownerType: string;
  values: Record<string, string>;
}

/** Accept only a complete conversion response, never partial Worker secrets. */
export function parseCredentials(value: unknown): SiteCredentials {
  if (!value || typeof value !== "object") throw new CliError("The saved App credentials are incomplete; no secrets were uploaded.");
  const item = value as Partial<SiteCredentials>;
  const values = item.values;
  if (typeof item.origin !== "string" || !/^https:\/\/[^/]+$/.test(item.origin) || !Number.isSafeInteger(item.appId) || item.appId! <= 0 || !Number.isSafeInteger(item.ownerId) || item.ownerId! <= 0 ||
    typeof item.appSlug !== "string" || !/^[a-z0-9-]+$/.test(item.appSlug) ||
    typeof item.ownerLogin !== "string" || typeof item.ownerType !== "string" || !values ||
    ["OWNER_ID", "GITHUB_APP_SLUG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]
      .some(key => typeof values[key] !== "string" || values[key]!.trim() === "") ||
    values.OWNER_ID !== String(item.ownerId) || values.GITHUB_APP_SLUG !== item.appSlug) {
    throw new CliError("The saved App credentials are incomplete; no secrets were uploaded.");
  }
  try {
    if (createPrivateKey(values.GITHUB_PRIVATE_KEY!).asymmetricKeyType !== "rsa") throw new Error();
  } catch { throw new CliError("The App private key is invalid; no secrets were uploaded."); }
  // Do not pass arbitrary keys from a modified local file to secret bulk.
  const allowed = ["OWNER_ID", "GITHUB_APP_SLUG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"];
  return { origin: item.origin, appId: item.appId!, appSlug: item.appSlug, ownerId: item.ownerId!, ownerLogin: item.ownerLogin,
    ownerType: item.ownerType, values: Object.fromEntries(allowed.map(key => [key, values[key]!])) };
}

function converted(body: unknown, origin: string): SiteCredentials {
  const data = body as Record<string, unknown> | null;
  const owner = data?.owner as Record<string, unknown> | undefined;
  return parseCredentials({ origin, appId: data?.id, appSlug: data?.slug, ownerId: owner?.id,
    ownerLogin: owner?.login, ownerType: owner?.type,
    values: { OWNER_ID: String(owner?.id), GITHUB_APP_SLUG: data?.slug, GITHUB_CLIENT_ID: data?.client_id,
      GITHUB_CLIENT_SECRET: data?.client_secret, GITHUB_PRIVATE_KEY: data?.pem,
      GITHUB_WEBHOOK_SECRET: data?.webhook_secret } });
}

function equal(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
function reply(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'" });
  response.end(`<!doctype html><html><title>Seshat setup</title><body>${body}</body></html>`);
}

/** Browser approves GitHub registration; only this local process receives credentials. */
export async function registerGithubApp(runtime: SiteRuntime, origin: string, name: string,
  options: { timeoutMs?: number } = {}): Promise<SiteCredentials> {
  const state = randomBytes(32).toString("hex");
  const browser = randomBytes(32).toString("hex");
  const startPath = `/start/${randomBytes(24).toString("hex")}`;
  const callbackPath = "/registered";
  let host = "";
  let consumed = false;
  let settled = false;
  let resolveResult!: (credentials: SiteCredentials) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<SiteCredentials>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Browser-opening can fail before the caller starts awaiting the result.
  void result.catch(() => {});
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.host !== host || request.method !== "GET") { reply(response, 403, "Request refused."); return; }
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname === startPath && !settled) {
      const manifest = { ...buildManifest(new URL(origin), name), redirect_url: `http://${host}${callbackPath}` };
      response.setHeader("Set-Cookie", `seshat-site=${browser}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`);
      reply(response, 200, `<h1>Register your Seshat GitHub App</h1><p>Confirm the personal GitHub account on the next page.</p><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form>`);
      return;
    }
    const cookie = request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith("seshat-site="))?.slice("seshat-site=".length);
    if (url.pathname !== callbackPath || consumed || !equal(cookie, browser) || !equal(url.searchParams.get("state") ?? undefined, state)) {
      reply(response, 403, "This registration did not start in this browser, or has finished."); return;
    }
    const code = url.searchParams.get("code");
    if (!code || !/^[a-zA-Z0-9_-]{1,100}$/.test(code)) { reply(response, 400, "GitHub returned no registration code."); return; }
    consumed = true;
    try {
      const conversion = await runtime.request(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST", headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.timeout(30_000),
      });
      if (conversion.status !== 201) throw new CliError("GitHub did not return App credentials. Check your GitHub Apps before restarting registration.");
      const credentials = converted(await conversion.json(), origin);
      // This one-use response must survive interruption before any upload.
      await runtime.writePrivate("credentials.json", credentials);
      settled = true;
      reply(response, 200, "<h1>GitHub App registered</h1><p>Return to your terminal to finish setup. You can close this page.</p>");
      resolveResult(credentials);
    } catch {
      settled = true;
      reply(response, 502, "<h1>Registration could not finish</h1><p>Return to the terminal. Check your GitHub Apps before starting another registration.</p>");
      rejectResult(new CliError("App registration could not finish. The App may already exist; check GitHub settings before restarting setup."));
    }
  }
  const server = createServer((request, response) => { void handle(request, response).catch(() => {
    reply(response, 500, "Setup failed. Return to the terminal.");
    rejectResult(new CliError("Local registration could not finish."));
  }); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new CliError("Could not start the local setup browser callback.");
    host = `127.0.0.1:${address.port}`;
    const timer = setTimeout(() => {
      settled = true;
      rejectResult(new CliError("GitHub registration timed out. Run seshat site setup to resume; check GitHub Apps before creating another App."));
    }, options.timeoutMs ?? 55 * 60_000);
    timer.unref();
    try {
      await runtime.open(`http://${host}${startPath}`);
      return await result;
    } finally { clearTimeout(timer); }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
