import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_SECONDS, pkceChallenge, sessionKey } from "../shared/auth";
import { instanceStub } from "./instance-stub";
import {
  BASE,
  CLIENT_ID,
  CLIENT_SECRET,
  OWNER_ID,
  REFRESH_TOKEN,
  SESSION_COOKIE_NAME,
  SIGN_IN_COOKIE_NAME,
  USER_TOKEN,
  beginSignIn,
  callback,
  json,
  ownerSession,
  setCookie,
  signInRoutes,
  storedRows,
  stubGitHub,
} from "./test-helpers";

const GRANT = `https://api.github.com/applications/${CLIENT_ID}/grant`;
const TOKEN = `https://api.github.com/applications/${CLIENT_ID}/token`;
const EXCHANGE = "https://github.com/login/oauth/access_token";
const USER = "https://api.github.com/user";
const CLIENT_BASIC = `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;

/** The owner's GitHub login when the tests start; a login proves nothing. */
const OWNER_LOGIN = "the-owner";
const MARKER = "instance-data-marker-7f3a";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/** Seeds instance data a refused visitor must never see. */
async function seedInstanceData(): Promise<void> {
  await instanceStub(env).health();
  await runInDurableObject(instanceStub(env), (_instance, state) => {
    state.storage.sql.exec("INSERT INTO settings (key, value) VALUES ('marker', ?)", MARKER);
    state.storage.sql.exec(
      "INSERT INTO installations (id, account_id, account_type, status, repository_selection) VALUES (555, ?, 'User', 'accepted', 'all')",
      OWNER_ID,
    );
  });
}

function sessionCookieFrom(response: Response): string | null {
  const cookie = setCookie(response, SESSION_COOKIE_NAME);
  return cookie && cookie.value !== "" ? `${SESSION_COOKIE_NAME}=${cookie.value}` : null;
}

describe("GET /auth/sign-in", () => {
  it("sends the visitor to GitHub with state and an S256 PKCE challenge", async () => {
    const { response, location, state, cookieHeader } = await beginSignIn();
    expect(response.status).toBe(303);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/callback`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cookie = setCookie(response, SIGN_IN_COOKIE_NAME);
    expect(cookie?.attributes).toMatch(/HttpOnly/);
    expect(cookie?.attributes).toMatch(/Secure/);
    expect(cookie?.attributes).toMatch(/SameSite=Lax/);
    expect(cookie?.attributes).toMatch(/Max-Age=600/);
    expect(cookieHeader).toContain(SIGN_IN_COOKIE_NAME);
  });

  it("writes nothing to storage", async () => {
    await beginSignIn();
    expect(await storedRows()).toEqual({});
  });

  it("starts fresh state on every attempt", async () => {
    const first = await beginSignIn();
    const second = await beginSignIn();
    expect(first.state).not.toBe(second.state);
  });
});

describe("GET /auth/callback state checks", () => {
  it("refuses a callback without the sign-in cookie, before calling GitHub", async () => {
    const github = stubGitHub(signInRoutes({ id: OWNER_ID, login: OWNER_LOGIN }));
    const { state } = await beginSignIn();
    const response = await callback(null, `code=abc&state=${state}`);
    expect(response.status).toBe(400);
    expect(github.calls).toEqual([]);
    expect(sessionCookieFrom(response)).toBeNull();
  });

  it("refuses a state that does not match the cookie, before calling GitHub", async () => {
    const github = stubGitHub(signInRoutes({ id: OWNER_ID, login: OWNER_LOGIN }));
    const { cookieHeader } = await beginSignIn();
    const other = await beginSignIn();
    const response = await callback(cookieHeader, `code=abc&state=${other.state}`);
    expect(response.status).toBe(400);
    expect(github.calls).toEqual([]);
    expect(sessionCookieFrom(response)).toBeNull();
  });

  it("refuses a tampered cookie", async () => {
    const github = stubGitHub(signInRoutes({ id: OWNER_ID, login: OWNER_LOGIN }));
    const { state } = await beginSignIn();
    const response = await callback(`${SIGN_IN_COOKIE_NAME}=not-a-real-cookie`, `code=abc&state=${state}`);
    expect(response.status).toBe(400);
    expect(github.calls).toEqual([]);
  });

  it("stops when GitHub reports the authorization was declined", async () => {
    const github = stubGitHub(signInRoutes({ id: OWNER_ID, login: OWNER_LOGIN }));
    const { cookieHeader, state } = await beginSignIn();
    const response = await callback(cookieHeader, `error=access_denied&state=${state}`);
    expect(response.status).toBe(400);
    expect(github.calls).toEqual([]);
  });

  it("clears the sign-in cookie so it cannot be replayed", async () => {
    stubGitHub(signInRoutes({ id: OWNER_ID, login: OWNER_LOGIN }));
    const { cookieHeader, state } = await beginSignIn();
    const response = await callback(cookieHeader, `code=abc&state=${state}`);
    const cleared = setCookie(response, SIGN_IN_COOKIE_NAME);
    expect(cleared?.value).toBe("");
    expect(cleared?.attributes).toMatch(/Max-Age=0/);
  });

  it("sends the code with the PKCE verifier that matches the challenge", async () => {
    const github = stubGitHub(signInRoutes({ id: OWNER_ID, login: OWNER_LOGIN }));
    const { cookieHeader, state, location } = await beginSignIn();
    await callback(cookieHeader, `code=the-code&state=${state}`);
    const [exchange] = github.called("POST", EXCHANGE);
    const body = JSON.parse(exchange?.body ?? "{}") as Record<string, string>;
    expect(body.code).toBe("the-code");
    expect(body.client_id).toBe(CLIENT_ID);
    expect(body.client_secret).toBe(CLIENT_SECRET);
    expect(body.redirect_uri).toBe(`${BASE}/auth/callback`);
    expect(await pkceChallenge(body.code_verifier ?? "")).toBe(location.searchParams.get("code_challenge"));
  });
});

describe("a refused account (acceptance check 1)", () => {
  it("is refused when its login matches the owner's but its ID does not", async () => {
    const github = stubGitHub(signInRoutes({ id: OWNER_ID + 1, login: OWNER_LOGIN }));
    const { cookieHeader, state } = await beginSignIn();
    const response = await callback(cookieHeader, `code=abc&state=${state}`);

    expect(response.status).toBe(403);
    // The callback URL holds the code; the refusal page sends no referrer.
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain(`@${OWNER_LOGIN}`);
    expect(sessionCookieFrom(response)).toBeNull();
    // The authorization, and with it every token, is deleted on GitHub,
    // authenticated as the App's OAuth client.
    const [grant] = github.called("DELETE", GRANT);
    expect(grant?.headers.get("authorization")).toBe(CLIENT_BASIC);
    expect(JSON.parse(grant?.body ?? "{}")).toEqual({ access_token: USER_TOKEN });
    expect(github.called("DELETE", TOKEN)).toEqual([]);
  });

  it("is refused when GitHub reports the ID as a string", async () => {
    stubGitHub(signInRoutes({ id: String(OWNER_ID), login: OWNER_LOGIN }));
    const { cookieHeader, state } = await beginSignIn();
    const response = await callback(cookieHeader, `code=abc&state=${state}`);
    expect(response.status).not.toBe(303);
    expect(sessionCookieFrom(response)).toBeNull();
  });

  it("sees no instance data and leaves nothing stored", async () => {
    await seedInstanceData();
    const before = await storedRows();
    stubGitHub(signInRoutes({ id: 2002, login: "stranger" }));

    const { cookieHeader, state } = await beginSignIn();
    const response = await callback(cookieHeader, `code=abc&state=${state}`);
    const body = await response.text();
    expect(response.status).toBe(403);
    expect(body).toContain("@stranger");
    expect(body).not.toContain(MARKER);
    expect(body).not.toContain(String(OWNER_ID));
    expect(body).not.toContain("555");

    // Storage is exactly as it was: no session, no token, not even the
    // stranger's login.
    const after = await storedRows();
    expect(after).toEqual(before);
    const dump = JSON.stringify(after);
    for (const leaked of [USER_TOKEN, REFRESH_TOKEN, "stranger", "2002"]) {
      expect(dump).not.toContain(leaked);
    }

    // Whatever cookies the refused browser now holds open nothing.
    const cookies = response.headers
      .getSetCookie()
      .map((header) => header.split(";")[0])
      .filter((pair) => pair !== undefined && !pair.endsWith("="))
      .join("; ");
    const api = await exports.default.fetch(`${BASE}/api/session`, { headers: { cookie: cookies } });
    expect(api.status).toBe(401);
    expect(await api.text()).not.toContain(MARKER);
    const installed = await exports.default.fetch(`${BASE}/setup/installed`, {
      headers: { cookie: cookies },
      redirect: "manual",
    });
    expect(installed.status).toBe(303);
  });

  it("is still refused, with a warning, when GitHub will not delete the authorization", async () => {
    const github = stubGitHub(
      signInRoutes({ id: 2002, login: "stranger" }, { [`DELETE ${GRANT}`]: () => json({}, 500) }),
    );
    const { cookieHeader, state } = await beginSignIn();
    const response = await callback(cookieHeader, `code=abc&state=${state}`);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("could not remove");
    // Falls back to revoking the token itself.
    expect(github.called("DELETE", TOKEN)).toHaveLength(1);
    expect(sessionCookieFrom(response)).toBeNull();
    expect(JSON.stringify(await storedRows())).not.toContain(USER_TOKEN);
  });

  it("deletes the authorization when GitHub does not say who signed in", async () => {
    const github = stubGitHub(
      signInRoutes({ id: OWNER_ID, login: OWNER_LOGIN }, { [`GET ${USER}`]: () => json({}, 500) }),
    );
    const { cookieHeader, state } = await beginSignIn();
    const response = await callback(cookieHeader, `code=abc&state=${state}`);
    expect(response.status).toBe(502);
    expect(github.called("DELETE", GRANT)).toHaveLength(1);
    expect(sessionCookieFrom(response)).toBeNull();
  });
});

describe("the owner signing in", () => {
  it("is matched by account ID whatever the login, and the token is revoked", async () => {
    const github = stubGitHub(signInRoutes({ id: OWNER_ID, login: "renamed-owner" }));
    const { cookieHeader, state } = await beginSignIn();
    const response = await callback(cookieHeader, `code=abc&state=${state}`);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    const [revoke] = github.called("DELETE", TOKEN);
    expect(revoke?.headers.get("authorization")).toBe(CLIENT_BASIC);
    expect(JSON.parse(revoke?.body ?? "{}")).toEqual({ access_token: USER_TOKEN });
    // The grant stays, so the next sign-in needs no consent screen.
    expect(github.called("DELETE", GRANT)).toEqual([]);
    // GET /user is the only call made with the user token.
    const withToken = github.calls.filter((call) => call.headers.get("authorization") === `Bearer ${USER_TOKEN}`);
    expect(withToken.map((call) => call.url.pathname)).toEqual(["/user"]);
  });

  it("gets a session cookie that opens protected routes", async () => {
    stubGitHub(signInRoutes({ id: OWNER_ID, login: OWNER_LOGIN }));
    const { cookieHeader, state } = await beginSignIn();
    const response = await callback(cookieHeader, `code=abc&state=${state}`);
    const cookie = setCookie(response, SESSION_COOKIE_NAME);
    expect(cookie?.attributes).toMatch(/HttpOnly/);
    expect(cookie?.attributes).toMatch(/Secure/);
    expect(cookie?.attributes).toMatch(/SameSite=Lax/);
    expect(cookie?.attributes).toMatch(new RegExp(`Max-Age=${SESSION_SECONDS}`));

    const session = await exports.default.fetch(`${BASE}/api/session`, {
      headers: { cookie: sessionCookieFrom(response) ?? "" },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ signedIn: true });
  });

  it("stores only a hash of the session and no GitHub token", async () => {
    stubGitHub(signInRoutes({ id: OWNER_ID, login: OWNER_LOGIN }));
    const { cookieHeader, state } = await beginSignIn();
    const response = await callback(cookieHeader, `code=abc&state=${state}`);
    const token = setCookie(response, SESSION_COOKIE_NAME)?.value ?? "";

    const rows = await storedRows();
    expect(rows.sessions).toHaveLength(1);
    const [session] = rows.sessions as { key: string; created_at: number; expires_at: number }[];
    expect(session?.key).toBe(await sessionKey(token));
    expect(session?.expires_at).toBe((session?.created_at ?? 0) + SESSION_SECONDS * 1000);
    const dump = JSON.stringify(rows);
    for (const leaked of [token, USER_TOKEN, REFRESH_TOKEN, OWNER_LOGIN]) {
      expect(dump).not.toContain(leaked);
    }
  });

  it("returns to the page that asked for sign-in, and only to a local one", async () => {
    stubGitHub(signInRoutes({ id: OWNER_ID, login: OWNER_LOGIN }));
    const local = await beginSignIn("/setup/installed");
    const back = await callback(local.cookieHeader, `code=abc&state=${local.state}`);
    expect(back.headers.get("location")).toBe("/setup/installed");

    const crafted = await beginSignIn("//evil.example/steal");
    const home = await callback(crafted.cookieHeader, `code=abc&state=${crafted.state}`);
    expect(home.headers.get("location")).toBe("/");
  });

  it("is not signed in when the token cannot be revoked", async () => {
    const github = stubGitHub(
      signInRoutes({ id: OWNER_ID, login: OWNER_LOGIN }, { [`DELETE ${TOKEN}`]: () => json({}, 500) }),
    );
    const { cookieHeader, state } = await beginSignIn();
    const response = await callback(cookieHeader, `code=abc&state=${state}`);
    expect(response.status).toBe(502);
    expect(sessionCookieFrom(response)).toBeNull();
    expect(github.called("DELETE", GRANT)).toHaveLength(1);
    expect((await storedRows()).sessions ?? []).toEqual([]);
  });

  it("is not signed in when GitHub refuses the code", async () => {
    const github = stubGitHub(
      signInRoutes(
        { id: OWNER_ID, login: OWNER_LOGIN },
        { [`POST ${EXCHANGE}`]: () => json({ error: "bad_verification_code" }) },
      ),
    );
    const { cookieHeader, state } = await beginSignIn();
    const response = await callback(cookieHeader, `code=abc&state=${state}`);
    expect(response.status).toBe(502);
    expect(sessionCookieFrom(response)).toBeNull();
    expect(github.called("GET", USER)).toEqual([]);
  });
});

describe("sessions", () => {
  beforeEach(() => {
    stubGitHub({});
  });

  it("stop working once expired", async () => {
    const cookie = await ownerSession();
    const token = cookie.split("=")[1] ?? "";
    await runInDurableObject(instanceStub(env), async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sessions SET expires_at = ? WHERE key = ?",
        Date.now() - 1,
        await sessionKey(token),
      );
    });
    const response = await exports.default.fetch(`${BASE}/api/session`, { headers: { cookie } });
    expect(response.status).toBe(401);
  });

  it("are pruned when expired as the next one starts", async () => {
    const stub = instanceStub(env);
    const now = Date.now();
    await stub.createSession("a".repeat(64), now - SESSION_SECONDS * 1000 - 1);
    await stub.createSession("b".repeat(64), now);
    const rows = await storedRows();
    expect((rows.sessions as { key: string }[]).map((row) => row.key)).toEqual(["b".repeat(64)]);
  });

  it("end on sign-out, which clears the cookie", async () => {
    const cookie = await ownerSession();
    const response = await exports.default.fetch(`${BASE}/auth/sign-out`, {
      method: "POST",
      headers: { cookie, origin: BASE },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(setCookie(response, SESSION_COOKIE_NAME)?.attributes).toMatch(/Max-Age=0/);
    expect((await storedRows()).sessions).toEqual([]);
    const after = await exports.default.fetch(`${BASE}/api/session`, { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  it("survive a cross-site sign-out attempt", async () => {
    const cookie = await ownerSession();
    const response = await exports.default.fetch(`${BASE}/auth/sign-out`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    const after = await exports.default.fetch(`${BASE}/api/session`, { headers: { cookie } });
    expect(after.status).toBe(200);
  });

  it("are not accepted under the cookie name meant for plain HTTP", async () => {
    const cookie = await ownerSession();
    const insecureName = cookie.replace(SESSION_COOKIE_NAME, "seshat-session");
    const response = await exports.default.fetch(`${BASE}/api/session`, { headers: { cookie: insecureName } });
    expect(response.status).toBe(401);
  });
});
