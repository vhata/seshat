/**
 * Verifies GitHub's `X-Hub-Signature-256` header: `sha256=` and the hex
 * HMAC-SHA256 of the raw body under the App's webhook secret. Web Crypto's
 * `verify` compares in constant time.
 */

import { hex, utf8 } from "./encoding";

function fromHex(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(text)) return null;
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export async function verifyWebhookSignature(
  secret: string,
  body: Uint8Array<ArrayBuffer>,
  header: string | null,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const signature = fromHex(header.slice("sha256=".length));
  if (!signature || signature.length !== 32) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, body);
}

/** Computes the header value GitHub would send; used by tests and tools. */
export async function signWebhookBody(
  secret: string,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `sha256=${hex(mac)}`;
}
