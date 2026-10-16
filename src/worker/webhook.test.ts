import { exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { utf8 } from "../shared/encoding";
import { PATHS } from "../shared/manifest";
import { signWebhookBody } from "../shared/webhook";
import { BASE, storedRows, stubGitHub } from "./test-helpers";

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
