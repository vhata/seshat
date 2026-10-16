import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isHealthResponse } from "../shared/health";
import { MIGRATIONS } from "../object/schema";
import { latestVersion } from "../shared/migrations";

const BASE = "https://seshat.test";

describe("GET /api/health", () => {
  it("reports the instance object's current schema version", async () => {
    const response = await exports.default.fetch(`${BASE}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body: unknown = await response.json();
    expect(isHealthResponse(body)).toBe(true);
    expect(body).toEqual({ ok: true, schemaVersion: latestVersion(MIGRATIONS) });
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
