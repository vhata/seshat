import { describe, expect, it } from "vitest";
import { isHealthResponse } from "./health";

const HEALTH = { ok: true, schemaVersion: 1, build: { commit: null, dirty: null }, version: { id: null } };

describe("isHealthResponse", () => {
  it("accepts a well-formed body", () => {
    expect(isHealthResponse(HEALTH)).toBe(true);
    expect(isHealthResponse({ ...HEALTH, build: { commit: "a".repeat(40), dirty: false }, version: { id: "11111111-1111-4111-8111-111111111111" } })).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "ok"],
    ["ok false", { ok: false, schemaVersion: 1 }],
    ["a missing version", { ok: true }],
    ["a string version", { ok: true, schemaVersion: "1" }],
    ["a fractional version", { ok: true, schemaVersion: 1.5 }],
    ["a negative version", { ok: true, schemaVersion: -1 }],
  ])("rejects %s", (_label, value) => {
    expect(isHealthResponse(value)).toBe(false);
  });

  it.each([
    { ...HEALTH, build: { commit: "not-a-commit", dirty: false } },
    { ...HEALTH, build: { commit: null, dirty: false } },
    { ...HEALTH, build: { commit: "a".repeat(40), dirty: null } },
    { ...HEALTH, version: { id: "private arbitrary text" } },
    { ...HEALTH, version: null },
  ])("rejects invalid identity fields: %j", (value) => {
    expect(isHealthResponse(value)).toBe(false);
  });
});
