/**
 * The Worker's routes and the gate in front of them.
 *
 * Every route needs the owner's session except those on `PUBLIC_PATHS`, one
 * explicit list, so a later public route is an addition there rather than
 * an exception inside a handler. Static assets (the built frontend, which
 * holds no instance data) are served before the Worker runs and are public
 * too. A path that is neither public nor a route is treated as protected,
 * so an unauthenticated visitor cannot tell which routes exist.
 */

import { PATHS } from "../shared/manifest";
import { finishSignIn, signOut, startSignIn } from "./auth";
import { jsonResponse, type RouteContext } from "./context";
import { health } from "./health";
import { overviewSnapshot, overviewSocket, SNAPSHOT_PATH, SOCKET_PATH } from "./overview";
import { checkInstallation, finishRegistration, setupForm, startRegistration } from "./setup";
import { receiveWebhook } from "./webhook";
import { repositorySettings, refreshInstallations, refreshRepositories, changeMonitoring, decideOrganization, REPOSITORIES_PATH } from "./repositories";

type Handler = (context: RouteContext) => Promise<Response>;

/** Each path maps its methods to handlers; HEAD is served by GET. */
export const ROUTES: Readonly<Record<string, Readonly<Record<string, Handler>>>> = {
  [PATHS.health]: { GET: health },
  [PATHS.session]: { GET: session },
  [SNAPSHOT_PATH]: { GET: overviewSnapshot },
  [REPOSITORIES_PATH]: { GET: repositorySettings },
  [`${REPOSITORIES_PATH}/installations`]: { POST: refreshInstallations },
  [`${REPOSITORIES_PATH}/refresh`]: { POST: refreshRepositories },
  [`${REPOSITORIES_PATH}/monitoring`]: { POST: changeMonitoring },
  [`${REPOSITORIES_PATH}/organization`]: { POST: decideOrganization },
  [SOCKET_PATH]: { GET: overviewSocket },
  [PATHS.signIn]: { GET: startSignIn },
  [PATHS.callback]: { GET: finishSignIn },
  [PATHS.signOut]: { POST: signOut },
  [PATHS.setup]: { GET: setupForm, POST: startRegistration },
  [PATHS.registered]: { GET: finishRegistration },
  [PATHS.installed]: { GET: checkInstallation },
  [PATHS.webhook]: { POST: receiveWebhook },
};

/**
 * The only routes that answer without the owner's session.
 *
 * - Health reports the schema version and nothing else.
 * - Sign-in, its callback and sign-out are how a session starts and ends.
 * - Setup and its registration callback work only while the App is not yet
 *   configured, and only with the setup secret.
 * - The webhook authenticates GitHub by signature instead.
 *
 * `/setup/installed` is not here: it needs the owner's session.
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  PATHS.health,
  PATHS.signIn,
  PATHS.callback,
  PATHS.signOut,
  PATHS.setup,
  PATHS.registered,
  PATHS.webhook,
]);

/**
 * Routes that accept cross-site unsafe requests. GitHub posts webhooks
 * without an Origin header and is authenticated by signature; every other
 * unsafe request must come from this instance's own pages.
 */
const CROSS_SITE_ALLOWED: ReadonlySet<string> = new Set([PATHS.webhook]);

async function session(context: RouteContext): Promise<Response> {
  // The gate has already required the session.
  return jsonResponse({ signedIn: true, expiresAt: context.session?.expiresAt ?? null, serverTime: context.now });
}

export function isPublic(path: string): boolean {
  return PUBLIC_PATHS.has(path);
}

/** Answers a request that needs the owner's session and has none. */
export function unauthenticated(url: URL, method: string): Response {
  const api = url.pathname === "/api" || url.pathname.startsWith("/api/");
  if (api || (method !== "GET" && method !== "HEAD")) {
    return jsonResponse({ error: "sign-in required" }, 401);
  }
  const signIn = new URL(PATHS.signIn, url.origin);
  signIn.searchParams.set("return_to", url.pathname);
  return new Response(null, {
    status: 303,
    headers: { location: `${signIn.pathname}${signIn.search}`, "cache-control": "no-store" },
  });
}

export function sameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("origin") === url.origin;
}

export async function dispatch(context: RouteContext): Promise<Response> {
  const { request, url } = context;
  const path = url.pathname;
  const unsafe = request.method !== "GET" && request.method !== "HEAD";
  const methods = ROUTES[path];
  if (!methods) return jsonResponse({ error: "not found" }, 404);
  const handler = methods[request.method === "HEAD" ? "GET" : request.method];
  if (!handler) {
    const allow = Object.keys(methods).flatMap((method) => (method === "GET" ? ["GET", "HEAD"] : [method]));
    return jsonResponse({ error: "method not allowed" }, 405, { allow: allow.join(", ") });
  }
  if (unsafe && !CROSS_SITE_ALLOWED.has(path) && !sameOrigin(request, url)) {
    return jsonResponse({ error: "cross-site request refused" }, 403);
  }
  return handler(context);
}
