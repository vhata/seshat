import { describe, expect, it } from "vitest";
import { utf8 } from "./encoding";
import { signWebhookBody, verifyWebhookSignature } from "./webhook";

// GitHub's documented test values for validating webhook deliveries.
const SECRET = "It's a Secret to Everybody";
const PAYLOAD = utf8("Hello, World!");
const SIGNATURE = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

describe("webhook signatures", () => {
  it("match GitHub's documented example", async () => {
    expect(await signWebhookBody(SECRET, PAYLOAD)).toBe(SIGNATURE);
    expect(await verifyWebhookSignature(SECRET, PAYLOAD, SIGNATURE)).toBe(true);
  });

  it("are refused when anything differs", async () => {
    expect(await verifyWebhookSignature("other", PAYLOAD, SIGNATURE)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, utf8("Hello, World?"), SIGNATURE)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, PAYLOAD, null)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, PAYLOAD, SIGNATURE.replace("sha256=", "sha1="))).toBe(false);
    expect(await verifyWebhookSignature(SECRET, PAYLOAD, `${SIGNATURE.slice(0, -2)}zz`)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, PAYLOAD, "sha256=")).toBe(false);
  });
});
