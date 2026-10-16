import { exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { utf8 } from "../shared/encoding";
import { PATHS } from "../shared/manifest";
import { signWebhookBody } from "../shared/webhook";
import { BASE, storedRows, stubGitHub } from "./test-helpers";
import { MAX_BODY_BYTES, readCapped } from "./webhook";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const BODY = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });

function deliver(signature: string | null) {
  return exports.default.fetch(`${BASE}${PATHS.webhook}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "ping",
      ...(signature ? { "x-hub-signature-256": signature } : {}),
    },
    body: BODY,
  });
}

describe("POST /api/github/webhook", () => {
  it("acknowledges a delivery signed with the webhook secret, with no Origin header", async () => {
    stubGitHub({});
    const response = await deliver(await signWebhookBody("test-webhook-secret", utf8(BODY)));
    expect(response.status).toBe(202);
    expect(await storedRows()).toEqual({});
  });

  it("refuses a delivery signed with another secret", async () => {
    const response = await deliver(await signWebhookBody("wrong-secret", utf8(BODY)));
    expect(response.status).toBe(401);
  });

  it("refuses an unsigned delivery", async () => {
    const response = await deliver(null);
    expect(response.status).toBe(401);
  });
});

describe("readCapped", () => {
  function stream(chunks: number[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const size of chunks) controller.enqueue(new Uint8Array(size).fill(7));
        controller.close();
      },
    });
  }

  it("reads a body within the cap", async () => {
    expect(await readCapped(stream([3, 4]), 7)).toEqual(new Uint8Array(7).fill(7));
    expect(await readCapped(null, 7)).toEqual(new Uint8Array());
  });

  it("gives up once the body passes the cap, without any length header", async () => {
    expect(await readCapped(stream([4, 4]), 7)).toBeNull();
  });
});

describe("an oversized delivery", () => {
  it("is refused when it declares its size", async () => {
    const response = await exports.default.fetch(`${BASE}${PATHS.webhook}`, {
      method: "POST",
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
      body: "{}",
    });
    expect(response.status).toBe(413);
  });
});
