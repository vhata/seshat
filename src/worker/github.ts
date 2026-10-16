/**
 * The GitHub endpoints sign-in and setup use. Each call returns a plain
 * result rather than throwing, so callers can always run their cleanup
 * (revoking a token, deleting a grant) whatever GitHub answered.
 *
 * Tokens passed in here are never logged or stored.
 */

import type { AppConfig } from "../shared/config";

export const GITHUB_WEB = "https://github.com";
export const GITHUB_API = "https://api.github.com";

const API_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "seshat",
};

/** GitHub stops a request after 10 seconds; Seshat waits no longer. */
const TIMEOUT_MS = 10_000;

async function call(url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
}

async function json(response: Response | null): Promise<unknown> {
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * HTTP Basic credentials for endpoints authenticated as the App's OAuth
 * client. Client IDs and secrets are ASCII, which `btoa` requires.
 */
function clientAuth(app: AppConfig): string {
  return `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`;
}

/**
 * Exchanges an authorization code for a user access token
 * (`POST /login/oauth/access_token`, with the PKCE verifier). Returns the
 * access token only; a refresh token in the response is dropped unread.
 */
export async function exchangeCode(
  app: AppConfig,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<string | null> {
  const response = await call(`${GITHUB_WEB}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "seshat" },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!response?.ok) return null;
  const body = await json(response);
  if (typeof body !== "object" || body === null) return null;
  const token = (body as Record<string, unknown>).access_token;
  return typeof token === "string" && token !== "" ? token : null;
}

/** `GET /user` with a user access token; the parsed body, or null on failure. */
export async function fetchUser(token: string): Promise<unknown> {
  const response = await call(`${GITHUB_API}/user`, {
    headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
  });
  if (!response?.ok) return null;
  return json(response);
}

async function deleteWithClientAuth(app: AppConfig, path: string, token: string): Promise<boolean> {
  const response = await call(`${GITHUB_API}/applications/${encodeURIComponent(app.clientId)}/${path}`, {
    method: "DELETE",
    headers: { ...API_HEADERS, authorization: clientAuth(app), "content-type": "application/json" },
    body: JSON.stringify({ access_token: token }),
  });
  return response?.status === 204;
}

/**
 * Deletes the user's authorization of the App, and with it every token the
 * App holds for them (`DELETE /applications/{client_id}/grant`).
 */
export function deleteGrant(app: AppConfig, token: string): Promise<boolean> {
  return deleteWithClientAuth(app, "grant", token);
}

/**
 * Revokes one user access token, keeping the authorization
 * (`DELETE /applications/{client_id}/token`). Checked on 2026-10-14 to
 * invalidate the paired refresh token too.
 */
export function revokeToken(app: AppConfig, token: string): Promise<boolean> {
  return deleteWithClientAuth(app, "token", token);
}

/** The credentials GitHub returns for an App registered from a manifest. */
export interface ManifestCredentials {
  readonly id: number;
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Null when the App was registered with its webhook inactive. */
  readonly webhookSecret: string | null;
  readonly pem: string;
  readonly ownerLogin: string | null;
  readonly ownerId: number | null;
}

/** Converts a manifest code (`POST /app-manifests/{code}/conversions`). */
export async function convertManifest(code: string): Promise<ManifestCredentials | null> {
  const response = await call(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: API_HEADERS,
  });
  if (response?.status !== 201) return null;
  const body = await json(response);
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const { id, slug, client_id, client_secret, webhook_secret, pem, owner } = record;
  if (typeof id !== "number" || typeof slug !== "string" || typeof client_id !== "string") {
    return null;
  }
  if (typeof client_secret !== "string" || typeof pem !== "string") return null;
  const ownerRecord = typeof owner === "object" && owner !== null ? (owner as Record<string, unknown>) : {};
  return {
    id,
    slug,
    clientId: client_id,
    clientSecret: client_secret,
    webhookSecret: typeof webhook_secret === "string" && webhook_secret !== "" ? webhook_secret : null,
    pem,
    ownerLogin: typeof ownerRecord.login === "string" ? ownerRecord.login : null,
    ownerId: typeof ownerRecord.id === "number" ? ownerRecord.id : null,
  };
}

/** Pages through `GET /app/installations`; null if any page fails. */
export async function listInstallations(jwt: string): Promise<unknown[] | null> {
  const all: unknown[] = [];
  // Ten pages of 100 is far beyond one owner's installations, and keeps the
  // loop inside the per-invocation subrequest limit.
  for (let page = 1; page <= 10; page++) {
    const response = await call(`${GITHUB_API}/app/installations?per_page=100&page=${page}`, {
      headers: { ...API_HEADERS, authorization: `Bearer ${jwt}` },
    });
    if (!response?.ok) return null;
    const body = await json(response);
    if (!Array.isArray(body)) return null;
    all.push(...body);
    if (body.length < 100) return all;
  }
  return all;
}

/** `DELETE /app/installations/{id}`, authenticated as the App. */
export async function deleteInstallation(jwt: string, id: number): Promise<boolean> {
  const response = await call(`${GITHUB_API}/app/installations/${id}`, {
    method: "DELETE",
    headers: { ...API_HEADERS, authorization: `Bearer ${jwt}` },
  });
  return response?.status === 204;
}
