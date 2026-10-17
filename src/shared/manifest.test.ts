import { describe, expect, it } from "vitest";
import { buildManifest, installUrl, validAppName } from "./manifest";

describe("buildManifest", () => {
  it("points GitHub at the instance's own routes", () => {
    const manifest = buildManifest(new URL("https://seshat.example.workers.dev/setup"), "  Seshat  ");
    expect(manifest.name).toBe("Seshat");
    expect(manifest.callback_urls).toEqual(["https://seshat.example.workers.dev/auth/callback"]);
    expect(manifest.hook_attributes).toEqual({ url: "https://seshat.example.workers.dev/api/github/webhook", active: true });
    expect(manifest.public).toBe(false);
  });

  it("subscribes a deployed instance's webhook to the overview's events", () => {
    const manifest = buildManifest(new URL("https://seshat.example.workers.dev/setup"), "Seshat");
    expect(manifest.default_events).toContain("pull_request");
  });

  it("leaves out the webhook and events on a local development server", () => {
    // GitHub refuses a manifest whose hook URL it cannot reach, even an
    // inactive one: "Hook url is not supported because it isn't reachable
    // over the public Internet (localhost)".
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:8787", "http://[::1]:5173"]) {
      const manifest = buildManifest(new URL(origin), "Seshat");
      expect(manifest).not.toHaveProperty("hook_attributes");
      expect(manifest).not.toHaveProperty("default_events");
      expect(JSON.stringify(manifest)).not.toContain("/api/github/webhook");
    }
  });
});

describe("validAppName", () => {
  it("allows 1 to 34 characters", () => {
    expect(validAppName("Seshat")).toBe(true);
    expect(validAppName("x".repeat(34))).toBe(true);
    expect(validAppName("x".repeat(35))).toBe(false);
    expect(validAppName("   ")).toBe(false);
    expect(validAppName("a\nb")).toBe(false);
  });
});

describe("installUrl", () => {
  it("is the App's public install page", () => {
    expect(installUrl("seshat-test")).toBe("https://github.com/apps/seshat-test/installations/new");
  });
});
