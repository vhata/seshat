/**
 * Owner sign-in through the GitHub App's user authorization (web flow with
 * `state` and PKCE), as the GitHub integration decision specifies:
 *
 * 1. `/auth/sign-in` sends the visitor to GitHub with a fresh state and
 *    PKCE challenge, kept in a short-lived cookie rather than in storage.
 * 2. `/auth/callback` checks the state, exchanges the code for a user token
 *    and calls `GET /user`.
 * 3. Any account whose numeric ID is not the configured owner's has its
 *    authorization of the App deleted on GitHub (which deletes its tokens),
 *    and is shown a refusal naming only its own login. Nothing about it is
 *    written to storage.
 * 4. The owner's token is revoked, keeping the authorization so the next
 *    sign-in needs no consent screen, and a Seshat session starts.
 *
 * No user token or refresh token is ever stored, the owner's included.
 */

import {
  SESSION_COOKIE,
  SESSION_SECONDS,
  SIGN_IN_COOKIE,
  SIGN_IN_COOKIE_SECONDS,
  decodeSignInState,
  encodeSignInState,
  isOwner,
  isSessionToken,
  newSignInState,
  parseIdentity,
  pkceChallenge,
  safeReturnPath,
  sessionKey,
} from "../shared/auth";
import { signInReady } from "../shared/config";
import { clearCookie, readCookie, serializeCookie } from "../shared/cookies";
import { hex, sha256, utf8, randomToken, secretsEqual } from "../shared/encoding";
import { PATHS } from "../shared/manifest";
import { redirect, type RouteContext } from "./context";
import { instanceStub } from "./instance-stub";
import {
  GITHUB_WEB,
  deleteGrant,
  exchangeCode,
  fetchUser,
  revokeToken,
} from "./github";
import { notSetUpPage, refusedPage, signInFailedPage } from "./pages";

export function callbackUrl(url: URL): string {
  return `${url.origin}${PATHS.callback}`;
}

/** `GET /auth/sign-in`: start GitHub's authorization with state and PKCE. */
export async function startSignIn(context: RouteContext): Promise<Response> {
  const { config, url, secure } = context;
  if (!signInReady(config)) return notSetUpPage();
  const state = newSignInState(safeReturnPath(url.searchParams.get("return_to")));
  const authorize = new URL(`${GITHUB_WEB}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", config.app.clientId);
  authorize.searchParams.set("redirect_uri", callbackUrl(url));
  authorize.searchParams.set("state", state.state);
  authorize.searchParams.set("code_challenge", await pkceChallenge(state.verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("allow_signup", "false");
  return redirect(authorize.toString(), [
    serializeCookie(SIGN_IN_COOKIE, encodeSignInState(state), {
      secure,
      maxAge: SIGN_IN_COOKIE_SECONDS,
    }),
  ]);
}

/** `GET /auth/callback`: check the visitor's identity and refuse all but the owner. */
export async function finishSignIn(context: RouteContext): Promise<Response> {
  const { config, url, secure, request, env, now } = context;
  // The sign-in cookie is single-use, whatever happens next.
  const clearState = clearCookie(SIGN_IN_COOKIE, secure);
  const respond = (response: Response): Response => {
    response.headers.append("set-cookie", clearState);
    return response;
  };

  if (!signInReady(config)) return respond(notSetUpPage());
  const { app, ownerId } = config;

  const stored = decodeSignInState(readCookie(request.headers.get("cookie"), SIGN_IN_COOKIE, secure));
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!stored || state === null || !(await secretsEqual(state, stored.state))) {
    return respond(
      signInFailedPage(
        "This sign-in did not start here or has expired. Start again from this instance.",
      ),
    );
  }
  if (url.searchParams.has("error") || code === null || code === "") {
    return respond(signInFailedPage("GitHub did not authorize the sign-in."));
  }

  // Cloudflare supplies this header at ingress. Do not accept forwarded IP
  // alternatives or a browser cookie as the rate-limit identity.
  const local = !secure && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const ip = request.headers.get("cf-connecting-ip") ?? (local ? "local-development" : null);
  if (!ip || ip.length > 64) {
    return respond(signInFailedPage("The instance could not identify this sign-in client. Try again through its Cloudflare address.", 503));
  }
  const retryAfter = await instanceStub(env).signInAllowance(hex(await sha256(utf8(ip))), now);
  if (retryAfter > 0) {
    const response = signInFailedPage("Too many sign-in attempts. Wait a few minutes before starting again.", 429);
    response.headers.set("retry-after", String(retryAfter));
    return respond(response);
  }

  const token = await exchangeCode(app, code, callbackUrl(url), stored.verifier);
  if (token === null) {
    return respond(signInFailedPage("GitHub did not accept the sign-in. Try again.", 502));
  }

  // From here a live user token exists; every path below disposes of it on
  // GitHub before answering.
  let disposed = false;
  try {
    const identity = parseIdentity(await fetchUser(token));
    if (identity === null) {
      disposed = await deleteGrant(app, token);
      return respond(signInFailedPage("GitHub did not say which account signed in. Try again.", 502));
    }

    if (!isOwner(identity, ownerId)) {
      const grantDeleted = await deleteGrant(app, token);
      disposed = grantDeleted || (await revokeToken(app, token));
      return respond(refusedPage(identity.login, grantDeleted));
    }

    disposed = await revokeToken(app, token);
    if (!disposed) {
      disposed = await deleteGrant(app, token);
      return respond(
        signInFailedPage("Seshat could not revoke the GitHub token it was given, so it did not sign you in. Try again.", 502),
      );
    }

    const sessionToken = randomToken(32);
    await instanceStub(env).createSession(await sessionKey(sessionToken), now, ownerId);
    return respond(
      redirect(stored.returnTo, [
        serializeCookie(SESSION_COOKIE, sessionToken, { secure, maxAge: SESSION_SECONDS }),
      ]),
    );
  } finally {
    if (!disposed) {
      // An unexpected failure before the token was dealt with: delete the
      // grant, the cleanup that removes every token for this user.
      await deleteGrant(app, token);
    }
  }
}

/** `POST /auth/sign-out`: end the session the cookie names, if any. */
export async function signOut(context: RouteContext): Promise<Response> {
  const { request, secure, env } = context;
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE, secure);
  if (isSessionToken(token)) await instanceStub(env).endSession(await sessionKey(token));
  return redirect("/", [clearCookie(SESSION_COOKIE, secure)]);
}

/** Looks up the owner's session from the request's cookie; reads only. */
export async function findSession(
  request: Request,
  env: Env,
  secure: boolean,
  now: number,
  ownerId: number | null,
): Promise<{ key: string; expiresAt: number } | null> {
  if (ownerId === null) return null;
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE, secure);
  if (!isSessionToken(token)) return null;
  const key = await sessionKey(token);
  const expiresAt = await instanceStub(env).sessionExpiry(key, now, ownerId);
  return expiresAt === null ? null : { key, expiresAt };
}
