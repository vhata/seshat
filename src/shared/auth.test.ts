import { describe, expect, it } from "vitest";
import {
  decodeSignInState,
  encodeSignInState,
  isOwner,
  isSessionToken,
  newSignInState,
  parseIdentity,
  pkceChallenge,
  safeReturnPath,
  sessionKey,
} from "./auth";
import { base64UrlEncode, utf8 } from "./encoding";

describe("sign-in state", () => {
  it("round-trips through its cookie", () => {
    const state = newSignInState("/setup/installed");
    expect(decodeSignInState(encodeSignInState(state))).toEqual(state);
  });

  it("is random on every attempt", () => {
    const a = newSignInState("/");
    const b = newSignInState("/");
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(a.verifier);
  });

  it("refuses malformed or tampered cookies", () => {
    const good = newSignInState("/");
    const forged = (value: unknown) => base64UrlEncode(utf8(JSON.stringify(value)));
    for (const cookie of [
      null,
      "",
      "%%%",
      forged("text"),
      forged({ ...good, state: "short" }),
      forged({ ...good, verifier: 42 }),
      forged({ ...good, returnTo: "https://evil.example/" }),
    ]) {
      expect(decodeSignInState(cookie)).toBeNull();
    }
  });
});

describe("pkceChallenge", () => {
  it("matches the S256 example in RFC 7636, appendix B", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("safeReturnPath", () => {
  it("keeps plain local paths", () => {
    for (const path of ["/", "/setup/installed", "/repositories/"]) expect(safeReturnPath(path)).toBe(path);
  });

  it("sends anything else home", () => {
    for (const path of [
      null,
      "",
      "setup",
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "https://evil.example/",
      "/path?next=https://evil.example",
      "/path#fragment",
      "/%2F%2Fevil.example",
      "/a//b",
    ]) {
      expect(safeReturnPath(path)).toBe("/");
    }
  });
});

describe("the owner check", () => {
  it("reads id and login from GET /user", () => {
    expect(parseIdentity({ id: 1001, login: "the-owner", type: "User" })).toEqual({ id: 1001, login: "the-owner" });
  });

  it("refuses a body without a numeric ID", () => {
    for (const body of [null, "text", {}, { login: "the-owner" }, { id: "1001", login: "the-owner" }, { id: 0, login: "x" }, { id: 1.5, login: "x" }, { id: 1001 }]) {
      expect(parseIdentity(body)).toBeNull();
    }
  });

  it("compares account IDs, never logins", () => {
    expect(isOwner({ id: 1001, login: "anyone" }, 1001)).toBe(true);
    expect(isOwner({ id: 1002, login: "the-owner" }, 1001)).toBe(false);
  });
});

describe("session tokens", () => {
  it("are stored by a hash that differs from the cookie value", async () => {
    const token = "A".repeat(43);
    const key = await sessionKey(token);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain(token);
  });

  it("must be 32 bytes of base64url", () => {
    expect(isSessionToken("A".repeat(43))).toBe(true);
    for (const value of [null, "", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`]) {
      expect(isSessionToken(value)).toBe(false);
    }
  });
});
