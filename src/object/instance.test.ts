import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { latestVersion } from "../shared/migrations";
import { MIGRATIONS } from "./schema";

/** Tables the object created, leaving out the runtime's own `_cf_` tables. */
function userTables(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
    )
    .toArray()
    .map((row) => row.name);
}

describe("InstanceObject", () => {
  it("writes nothing when constructed", async () => {
    const stub = env.INSTANCE.getByName("constructor-writes-nothing");
    const tables = await runInDurableObject(stub, (_instance, state) =>
      userTables(state.storage.sql),
    );
    expect(tables).toEqual([]);
  });

  it("migrates a new database on first use", async () => {
    const stub = env.INSTANCE.getByName("migrates-on-first-use");
    expect(await stub.health()).toEqual({
      schemaVersion: latestVersion(MIGRATIONS),
    });
    const tables = await runInDurableObject(stub, (_instance, state) =>
      userTables(state.storage.sql),
    );
    expect(tables).toEqual(["schema_version", "settings"]);
  });

  it("only reads once its schema is current, even after a restart", async () => {
    const stub = env.INSTANCE.getByName("reads-only-when-current");
    await stub.health();
    await evictDurableObject(stub);

    const statements = await runInDurableObject(stub, async (instance, state) => {
      const exec = vi.spyOn(state.storage.sql, "exec");
      expect(await instance.health()).toEqual({
        schemaVersion: latestVersion(MIGRATIONS),
      });
      return exec.mock.calls.map(([query]) => query);
    });
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.trimStart()).toMatch(/^SELECT /);
    }
  });
});
