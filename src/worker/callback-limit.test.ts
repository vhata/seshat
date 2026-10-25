import { env, exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instanceStub } from "./instance-stub";
import { BASE, OWNER_ID, SIGN_IN_COOKIE_NAME, beginSignIn, callback, setCookie, signInRoutes, storedRows, stubGitHub } from "./test-helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
async function attempt(ip: string) {
  const { cookieHeader, state } = await beginSignIn();
  return callback(cookieHeader, `code=abc&state=${state}`, ip);
}

describe("callback exchange limit", () => {
  it("limits fresh valid-state exchanges before GitHub, clears cookies, and leaves other clients independent", async () => {
    const github = stubGitHub(signInRoutes({ id: 2002, login: "stranger" }));
    const before = await storedRows();
    for (let i = 0; i < 10; i++) expect((await attempt("192.0.2.1")).status).toBe(403);
    const calls = github.calls.length;
    const refused = await attempt("192.0.2.1");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(setCookie(refused, SIGN_IN_COOKIE_NAME)?.attributes).toContain("Max-Age=0");
    expect(github.calls).toHaveLength(calls);
    expect(await storedRows()).toEqual(before);
    stubGitHub(signInRoutes({ id: OWNER_ID, login: "owner" }));
    expect((await attempt("192.0.2.2")).status).toBe(303);
  });
  it("does not consume allowance for invalid state", async () => {
    const github = stubGitHub(signInRoutes({ id: OWNER_ID, login: "owner" }));
    for (let i = 0; i < 12; i++) expect((await callback(null, "code=a&state=wrong", "192.0.2.3")).status).toBe(400);
    expect(github.calls).toHaveLength(0);
    expect((await attempt("192.0.2.3")).status).toBe(303);
  });
  it("refuses missing trusted IP on a hosted URL even with spoofed forwarded headers", async () => {
    const github = stubGitHub(signInRoutes({ id: OWNER_ID, login: "owner" }));
    const { cookieHeader, state } = await beginSignIn();
    const response = await exports.default.fetch(`${BASE}/auth/callback?code=a&state=${state}`, {
      headers: { cookie: cookieHeader, "x-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.1" },
    });
    expect(response.status).toBe(503);
    expect(github.calls).toHaveLength(0);
  });
  it("allows plain HTTP loopback development without a trusted header", async () => {
    const github = stubGitHub(signInRoutes({ id: OWNER_ID, login: "owner" }));
    const base = "http://localhost:5173";
    const start = await exports.default.fetch(`${base}/auth/sign-in`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const cookie = setCookie(start, "seshat-sign-in")!;
    const response = await exports.default.fetch(`${base}/auth/callback?code=a&state=${state}`, {
      headers: { cookie: `seshat-sign-in=${cookie.value}` },
    });
    expect(response.status).toBe(303);
    expect(github.called("POST", "https://github.com/login/oauth/access_token")).toHaveLength(1);
  });
  it("does not treat HTTPS localhost as local development", async () => {
    const github = stubGitHub(signInRoutes({ id: OWNER_ID, login: "owner" }));
    const { cookieHeader, state } = await beginSignIn();
    const response = await exports.default.fetch(`https://localhost/auth/callback?code=a&state=${state}`, {
      headers: { cookie: cookieHeader },
    });
    expect(response.status).toBe(503);
    expect(github.calls).toHaveLength(0);
  });
  it("does not initialize SQL storage for an anonymous limiter request", async () => {
    expect(await instanceStub(env).signInAllowance("anonymous-hash", Date.now())).toBe(0);
    expect(await storedRows()).toEqual({});
  });
});
