import { verifyWebhookSignature } from "../shared/webhook";
import { jsonResponse, type RouteContext } from "./context";

/** GitHub's own cap on a delivery is 25 MB; Seshat's events are far smaller. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * `POST /api/github/webhook`: the App's webhook. Deliveries are verified
 * against the webhook secret and acknowledged. Acting on them belongs to
 * change detection, which is not built yet, so a verified delivery is
 * dropped after the check.
 */
export async function receiveWebhook(context: RouteContext): Promise<Response> {
  const { config, request } = context;
  if (config.app === null) return jsonResponse({ error: "not configured" }, 503);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return jsonResponse({ error: "too large" }, 413);
  const body = new Uint8Array(await request.arrayBuffer());
  const valid = await verifyWebhookSignature(
    config.app.webhookSecret,
    body,
    request.headers.get("x-hub-signature-256"),
  );
  if (!valid) return jsonResponse({ error: "invalid signature" }, 401);
  return new Response(null, { status: 202 });
}
