import { describe, expect, it } from "vitest";
import { latestVersion, pendingMigrations, type Migration } from "./migrations";

const one: Migration = { version: 1, statements: ["CREATE TABLE a (x)"] };
const two: Migration = { version: 2, statements: ["CREATE TABLE b (x)"] };
const three: Migration = { version: 3, statements: ["CREATE TABLE c (x)"] };

describe("latestVersion", () => {
  it("is 0 for no migrations", () => {
    expect(latestVersion([])).toBe(0);
  });

  it("is the last migration's version", () => {
    expect(latestVersion([one, two, three])).toBe(3);
  });
});

describe("pendingMigrations", () => {
  it("returns every migration for a new database", () => {
    expect(pendingMigrations(0, [one, two, three])).toEqual([one, two, three]);
  });

  it("returns only the migrations after the stored version, in order", () => {
    expect(pendingMigrations(1, [one, two, three])).toEqual([two, three]);
  });

  it("returns nothing when the schema is current", () => {
    expect(pendingMigrations(3, [one, two, three])).toEqual([]);
  });

  it("rejects a stored version newer than the code", () => {
    expect(() => pendingMigrations(4, [one, two, three])).toThrow(/newer/);
  });

  it("rejects a negative or fractional stored version", () => {
    expect(() => pendingMigrations(-1, [one])).toThrow(/not valid/);
    expect(() => pendingMigrations(0.5, [one])).toThrow(/not valid/);
  });

  it("rejects migrations that skip or repeat a version", () => {
    expect(() => pendingMigrations(0, [one, three])).toThrow(/position 2/);
    expect(() => pendingMigrations(0, [one, one])).toThrow(/position 2/);
  });

  it("rejects migrations out of order", () => {
    expect(() => pendingMigrations(0, [two, one])).toThrow(/position 1/);
  });
});
