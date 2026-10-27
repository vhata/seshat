import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isHealthResponse } from "../shared/health";
import { MIGRATIONS } from "../object/schema";
import { latestVersion } from "../shared/migrations";
import worker from "./index";
import { workerVersion } from "./build-identity";

const BASE = "https://seshat.test";

describe("GET /api/health", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reports the instance object's current schema version", async () => {
    const response = await exports.default.fetch(`${BASE}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body: unknown = await response.json();
    expect(isHealthResponse(body)).toBe(true);
    expect(body).toEqual({ ok: true, schemaVersion: latestVersion(MIGRATIONS), build: { commit: null, dirty: null }, version: workerVersion(env.CF_VERSION_METADATA) });
  });

  it("reports only the compiled source and serving version, including after rollback", async () => {
    const versions = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"];
    const commits = ["a".repeat(40), "b".repeat(40), "a".repeat(40)];
    for (const [index, id] of versions.entries()) {
      const build = { commit: commits[index]!, dirty: false };
      vi.stubGlobal("__SESHAT_BUILD_IDENTITY__", { ...build, privateBuildField: "must-not-leak" });
      const response = await worker.fetch(new Request(`${BASE}/api/health`), {
        ...env, CF_VERSION_METADATA: { id, tag: "private operator text", timestamp: "private timestamp" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ ok: true, schemaVersion: latestVersion(MIGRATIONS), build, version: { id } });
    }
  });

  it("marks missing or malformed version metadata unknown", async () => {
    for (const metadata of [undefined, { id: "private text", tag: "secret", timestamp: "secret" }]) {
      expect(workerVersion(metadata)).toEqual({ id: null });
    }
  });

  it("refuses other methods", async () => {
    const response = await exports.default.fetch(`${BASE}/api/health`, {
      method: "POST",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("GET /api/session", () => {
  it("needs the owner's session", async () => {
    const response = await exports.default.fetch(`${BASE}/api/session`);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
