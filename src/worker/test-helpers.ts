/**
 * Helpers for the Workers tests: a stand-in for GitHub, owner sessions and
 * a view of everything the instance has stored. Imported only by tests.
 */

import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { sessionKey } from "../shared/auth";
import { randomToken } from "../shared/encoding";
import { refuseRequest } from "../test/fetch-guard";
import { instanceStub } from "./instance-stub";
import worker from "./index";

export const BASE = "https://seshat.test";
export const OWNER_ID = 1001;
export const CLIENT_ID = "Iv23test";
export const CLIENT_SECRET = "test-client-secret";
export const SESSION_COOKIE_NAME = "__Host-seshat-session";
export const SIGN_IN_COOKIE_NAME = "__Host-seshat-sign-in";

/** Tokens the stubbed GitHub hands out, searched for in storage afterwards. */
export const USER_TOKEN = "ghu_stubbedUserAccessToken0123456789";
export const REFRESH_TOKEN = "ghr_stubbedRefreshToken0123456789abcdef";

export interface GitHubCall {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
}

type Reply = (call: GitHubCall) => Response | Promise<Response>;

/**
 * Replaces `fetch` with a fake GitHub. `routes` maps `METHOD URL` (without
 * the query string) to a reply. Any other request is refused and fails the
 * test through the fetch guard, so nothing reaches GitHub or anywhere else.
 */
export function stubGitHub(routes: Record<string, Reply>) {
  const calls: GitHubCall[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const call: GitHubCall = {
      method: request.method,
      url,
      headers: request.headers,
      body: request.body ? await request.text() : "",
    };
    calls.push(call);
    const reply = routes[`${request.method} ${url.origin}${url.pathname}`];
    if (!reply) return refuseRequest(request.method, url.href);
    return reply(call);
  });
  return {
    spy,
    calls,
    called(method: string, url: string): GitHubCall[] {
      return calls.filter((call) => call.method === method && `${call.url.origin}${call.url.pathname}` === url);
    },
  };
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** GitHub's routes for a sign-in by the given account. */
export function signInRoutes(user: unknown, overrides: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    "POST https://github.com/login/oauth/access_token": () =>
      json({
        access_token: USER_TOKEN,
        token_type: "bearer",
        scope: "",
        expires_in: 28800,
        refresh_token: REFRESH_TOKEN,
        refresh_token_expires_in: 15897600,
      }),
    "GET https://api.github.com/user": () => json(user),
    [`DELETE https://api.github.com/applications/${CLIENT_ID}/token`]: () => noContent(),
    [`DELETE https://api.github.com/applications/${CLIENT_ID}/grant`]: () => noContent(),
    ...overrides,
  };
}

/** Reads one cookie from a response's Set-Cookie headers. */
export function setCookie(response: Response, name: string): { value: string; attributes: string } | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split(";");
    const index = pair.indexOf("=");
    if (pair.slice(0, index).trim() === name) {
      return { value: pair.slice(index + 1), attributes: attributes.join(";") };
    }
  }
  return null;
}

/** Starts sign-in and returns what the browser would hold afterwards. */
export async function beginSignIn(returnTo?: string) {
  const path = returnTo === undefined ? "/auth/sign-in" : `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`;
  const response = await exports.default.fetch(`${BASE}${path}`, { redirect: "manual" });
  const cookie = setCookie(response, SIGN_IN_COOKIE_NAME);
  const location = new URL(response.headers.get("location") ?? "about:blank");
  if (!cookie) throw new Error("sign-in set no cookie");
  return {
    response,
    location,
    state: location.searchParams.get("state") ?? "",
    cookieHeader: `${SIGN_IN_COOKIE_NAME}=${cookie.value}`,
  };
}

/** Completes sign-in at the callback with the browser's cookie. */
export async function callback(cookieHeader: string | null, query: string, ip = "192.0.2.1"): Promise<Response> {
  return exports.default.fetch(`${BASE}/auth/callback?${query}`, {
    headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}), "cf-connecting-ip": ip },
    redirect: "manual",
  });
}

/** Gives the test an owner session directly, as a cookie header. */
export async function ownerSession(): Promise<string> {
  const token = randomToken(32);
  await instanceStub(env).createSession(await sessionKey(token), Date.now(), OWNER_ID);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/** Every row of every table the instance created, for leak checks. */
export async function storedRows(): Promise<Record<string, unknown[]>> {
  return runInDurableObject(instanceStub(env), (_instance, state) => {
    const sql = state.storage.sql;
    const tables = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
      )
      .toArray()
      .map((row) => row.name);
    return Object.fromEntries(tables.map((table) => [table, sql.exec(`SELECT * FROM "${table}"`).toArray()]));
  });
}

/** Calls the Worker with a different configuration from the test default. */
export async function fetchWithConfig(
  config: Record<string, string | undefined>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const testEnv = {
    INSTANCE: env.INSTANCE,
    INSTANCE_LOCATION_HINT: env.INSTANCE_LOCATION_HINT,
    ...config,
  } as unknown as Env;
  const handler = worker.fetch as (request: Request, env: Env) => Promise<Response>;
  return handler(new Request(`${BASE}${path}`, init), testEnv);
}
