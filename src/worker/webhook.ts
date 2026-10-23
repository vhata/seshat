import { reduceDelivery } from "../shared/overview/webhook-marks";
import { instanceStub } from "./instance-stub";
import { verifyWebhookSignature } from "../shared/webhook";
import { jsonResponse, type RouteContext } from "./context";

/** GitHub's own cap on a delivery is 25 MB; Seshat's events are far smaller. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Reads a body, giving up as soon as it passes `max` bytes, whatever the
 * Content-Length header claimed. Returns null when it is too large.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * `POST /api/github/webhook`: the App's webhook. Deliveries are verified
 * against the webhook secret, reduced to marks, and acknowledged only after
 * the object persists those marks. This path never reads GitHub.
 */
export async function receiveWebhook(context: RouteContext): Promise<Response> {
  const { config, request } = context;
  if (config.app === null) return jsonResponse({ error: "not configured" }, 503);
  // A declared length over the cap is refused before reading; the cap is
  // enforced again while reading, since the header may be absent or wrong.
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return jsonResponse({ error: "too large" }, 413);
  const body = await readCapped(request.body, MAX_BODY_BYTES);
  if (body === null) return jsonResponse({ error: "too large" }, 413);
  const valid = await verifyWebhookSignature(
    config.app.webhookSecret,
    body,
    request.headers.get("x-hub-signature-256"),
  );
  if (!valid) return jsonResponse({ error: "invalid signature" }, 401);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(body)); }
  catch { return jsonResponse({ error: "invalid payload" }, 400); }
  const delivery = reduceDelivery(request.headers.get("x-github-event") ?? "", payload, context.now);
  if (delivery) {
    try { await instanceStub(context.env).receiveDelivery(delivery, context.now); }
    catch { return jsonResponse({ error: "delivery not stored" }, 503); }
  }
  return new Response(null, { status: 202 });
}
