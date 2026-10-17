import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode, bytesEqual, randomToken, secretsEqual } from "./encoding";

describe("base64url", () => {
  it("round-trips bytes without padding", () => {
    for (const length of [0, 1, 2, 3, 31, 32]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      const encoded = base64UrlEncode(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(base64UrlDecode(encoded)).toEqual(bytes);
    }
  });

  it("refuses text that is not base64url", () => {
    for (const text of ["a+b", "a/b", "ab==", "a", "a b"]) expect(base64UrlDecode(text)).toBeNull();
  });
});

describe("randomToken", () => {
  it("is 43 characters for 32 bytes", () => {
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("comparisons", () => {
  it("compare bytes and secrets exactly", async () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(await secretsEqual("setup-secret", "setup-secret")).toBe(true);
    expect(await secretsEqual("setup-secret", "setup-secreT")).toBe(false);
    expect(await secretsEqual("", "setup-secret")).toBe(false);
  });
});
