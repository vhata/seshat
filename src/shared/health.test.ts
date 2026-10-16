import { describe, expect, it } from "vitest";
import { isHealthResponse } from "./health";

describe("isHealthResponse", () => {
  it("accepts a well-formed body", () => {
    expect(isHealthResponse({ ok: true, schemaVersion: 1 })).toBe(true);
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
});
