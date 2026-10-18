import { SNAPSHOT_PATH, SOCKET_PATH } from "../shared/overview/protocol";
import { jsonResponse, type RouteContext } from "./context";
import { instanceStub } from "./instance-stub";

export async function overviewSnapshot(context: RouteContext): Promise<Response> {
  return jsonResponse(await instanceStub(context.env).overviewSnapshot(context.now));
}

export async function overviewSocket(context: RouteContext): Promise<Response> {
  const { request, url, session, env } = context;
  if (request.method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);
  if (request.headers.get("origin") !== url.origin) return jsonResponse({ error: "cross-site request refused" }, 403);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return jsonResponse({ error: "websocket required" }, 426);
  if (!session) return jsonResponse({ error: "sign-in required" }, 401);
  // Never trust a caller-supplied internal key. The Worker forwards the hash
  // from its checked cookie; the object checks the persisted session again.
  const headers = new Headers(request.headers);
  headers.set("x-seshat-session-key", session.key);
  return instanceStub(env).fetch(new Request(new URL(SOCKET_PATH, url), { method: "GET", headers }));
}

export { SNAPSHOT_PATH, SOCKET_PATH };
