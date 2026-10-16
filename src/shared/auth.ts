/**
 * Pure parts of owner sign-in: the OAuth state carried in a cookie, PKCE,
 * the owner check and session lifetimes.
 *
 * Nothing about a sign-in attempt is stored on the instance until the
 * visitor is known to be the owner. The state, PKCE verifier and return
 * path travel in a short-lived HttpOnly cookie instead, so a stranger's
 * attempt, refused or abandoned, writes nothing.
 */

import {
  base64UrlDecode,
  base64UrlEncode,
  hex,
  randomToken,
  sha256,
  utf8,
} from "./encoding";

/** GitHub's authorization codes expire after 10 minutes. */
export const SIGN_IN_COOKIE_SECONDS = 10 * 60;

/** An owner session lasts seven days from sign-in and is not extended. */
export const SESSION_SECONDS = 7 * 24 * 60 * 60;

export const SIGN_IN_COOKIE = "seshat-sign-in";
export const SESSION_COOKIE = "seshat-session";

export interface SignInState {
  /** Sent to GitHub as `state` and checked on the callback. */
  readonly state: string;
  /** The PKCE code verifier; GitHub gets only its S256 challenge. */
  readonly verifier: string;
  /** Local path to return to after signing in. */
  readonly returnTo: string;
}

export function newSignInState(returnTo: string): SignInState {
  return { state: randomToken(32), verifier: randomToken(32), returnTo };
}

export function encodeSignInState(value: SignInState): string {
  return base64UrlEncode(utf8(JSON.stringify(value)));
}

export function decodeSignInState(cookie: string | null): SignInState | null {
  if (!cookie) return null;
  const bytes = base64UrlDecode(cookie);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const { state, verifier, returnTo } = record;
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
  if (typeof verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) return null;
  if (typeof returnTo !== "string" || safeReturnPath(returnTo) !== returnTo) return null;
  return { state, verifier, returnTo };
}

/** The S256 PKCE challenge for a verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256(utf8(verifier)));
}

/**
 * Reduces a requested return path to a local one, or `/`. Only plain
 * absolute paths are kept, so a crafted value cannot send the owner to
 * another site after signing in.
 */
export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith("/")) return "/";
  // Segments of unreserved characters only: no `//`, scheme, query,
  // fragment, backslash or percent-encoding.
  if (!/^(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(value)) return "/";
  return value;
}

/** What GitHub's `GET /user` said about the visitor, as far as Seshat uses it. */
export interface GitHubIdentity {
  readonly id: number;
  readonly login: string;
}

/** Reads `id` and `login` from a `GET /user` body, refusing anything malformed. */
export function parseIdentity(body: unknown): GitHubIdentity | null {
  if (typeof body !== "object" || body === null) return null;
  const { id, login } = body as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof login !== "string" || login === "") return null;
  return { id, login };
}

/**
 * The owner check. Only the numeric account ID counts: a login is a display
 * name that can be renamed and then claimed by someone else.
 */
export function isOwner(identity: GitHubIdentity, ownerId: number): boolean {
  return identity.id === ownerId;
}

/**
 * Sessions are stored by the SHA-256 of their cookie value, so a copy of
 * the database does not contain a usable session.
 */
export async function sessionKey(token: string): Promise<string> {
  return hex(await sha256(utf8(token)));
}

/** A session cookie value: 32 random bytes, base64url encoded. */
export function isSessionToken(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{43}$/.test(value);
}
