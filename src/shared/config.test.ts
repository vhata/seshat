import { describe, expect, it } from "vitest";
import { parseAccountId, readConfig, setupOpen, signInReady } from "./config";

const APP = {
  GITHUB_APP_SLUG: "seshat-test",
  GITHUB_CLIENT_ID: "Iv23test",
  GITHUB_CLIENT_SECRET: "secret",
  GITHUB_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "hook",
};

describe("parseAccountId", () => {
  it("accepts a positive decimal account ID", () => {
    expect(parseAccountId("1001")).toBe(1001);
    expect(parseAccountId(" 583231 \n")).toBe(583231);
  });

  it("refuses usernames and anything else that is not a plain ID", () => {
    for (const value of ["octocat", "", "0", "01", "-1", "+1", "1e3", "1.0", "1001 octocat", "12345678901234567"]) {
      expect(parseAccountId(value)).toBeNull();
    }
    expect(parseAccountId(1001)).toBeNull();
    expect(parseAccountId(undefined)).toBeNull();
  });
});

describe("readConfig", () => {
  it("reads a fully configured instance", () => {
    const config = readConfig({ OWNER_ID: "1001", SETUP_SECRET: "s", ...APP });
    expect(config.ownerId).toBe(1001);
    expect(config.app?.clientId).toBe("Iv23test");
    expect(signInReady(config)).toBe(true);
    expect(setupOpen(config)).toBe(false);
  });

  it("treats the App as unconfigured until every credential is set", () => {
    for (const missing of Object.keys(APP)) {
      const partial: Record<string, string> = { OWNER_ID: "1001", SETUP_SECRET: "s", ...APP };
      partial[missing] = "  ";
      const config = readConfig(partial);
      expect(config.app).toBeNull();
      expect(signInReady(config)).toBe(false);
      expect(setupOpen(config)).toBe(true);
    }
  });

  it("keeps setup locked without a setup secret", () => {
    expect(setupOpen(readConfig({ OWNER_ID: "1001" }))).toBe(false);
  });

  it("cannot sign anyone in without a valid owner ID", () => {
    expect(signInReady(readConfig({ OWNER_ID: "octocat", ...APP }))).toBe(false);
    expect(signInReady(readConfig({ ...APP }))).toBe(false);
  });
});
