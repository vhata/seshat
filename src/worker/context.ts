import type { InstanceConfig } from "../shared/config";

/** What a route handler gets: the request and what the router learned about it. */
export interface RouteContext {
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
  readonly config: InstanceConfig;
  /** Whether the instance is served over HTTPS; decides cookie attributes. */
  readonly secure: boolean;
  /** The owner's session, when the request carried a valid one. */
  readonly session: { readonly key: string; readonly expiresAt: number } | null;
  /** Milliseconds since the epoch, read once per request. */
  readonly now: number;
}

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const response = Response.json(body, { status, headers });
  response.headers.set("cache-control", "no-store");
  return response;
}

export function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}
