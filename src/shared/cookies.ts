/**
 * Cookie parsing and the attributes every Seshat cookie uses: HttpOnly,
 * SameSite=Lax and Path=/. Over HTTPS the name carries the `__Host-` prefix,
 * which makes the browser insist on Secure, Path=/ and no Domain, so a
 * sibling host cannot plant one. Over plain HTTP, which only local
 * development uses, the prefix and Secure are dropped because some browsers
 * refuse Secure cookies from http://localhost.
 */

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    // The first occurrence wins, as browsers send the most specific first.
    if (name !== "" && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export function cookieName(base: string, secure: boolean): string {
  return secure ? `__Host-${base}` : base;
}

export interface CookieOptions {
  readonly secure: boolean;
  /** Lifetime in seconds; 0 deletes the cookie. */
  readonly maxAge: number;
}

/** Serializes a cookie. `value` must already be cookie-safe (base64url). */
export function serializeCookie(base: string, value: string, options: CookieOptions): string {
  if (!/^[A-Za-z0-9._~-]*$/.test(value)) {
    throw new Error("cookie value must be base64url or similar");
  }
  const attributes = [
    `${cookieName(base, options.secure)}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearCookie(base: string, secure: boolean): string {
  return serializeCookie(base, "", { secure, maxAge: 0 });
}

export function readCookie(
  header: string | null,
  base: string,
  secure: boolean,
): string | null {
  return parseCookies(header).get(cookieName(base, secure)) ?? null;
}
