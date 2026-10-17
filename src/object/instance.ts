import { DurableObject } from "cloudflare:workers";
import { latestVersion, pendingMigrations } from "../shared/migrations";
import { MIGRATIONS } from "./schema";

const VERSION_TABLE = "schema_version";

/**
 * The single Durable Object that holds all of an instance's state in its
 * SQLite database.
 *
 * The constructor must not write. Writes there run on every start-up, and once
 * the account's daily rows-written quota is spent they make the object fail
 * even for reads. The schema is brought up to date on first use instead, and
 * only writes when a migration is pending.
 */
export class InstanceObject extends DurableObject<Env> {
  /** The current schema version, once this instance has checked it. */
  private schemaVersion: number | undefined;

  /** Reports that the object is reachable and its schema is current. */
  async health(): Promise<{ schemaVersion: number }> {
    return { schemaVersion: this.ensureSchema() };
  }

  /**
   * Applies any pending migrations and returns the schema version, checking
   * the database once per start-up. Synchronous, so no other request runs in
   * the object until it finishes.
   */
  private ensureSchema(): number {
    if (this.schemaVersion !== undefined) return this.schemaVersion;
    const pending = pendingMigrations(this.storedVersion(), MIGRATIONS);
    if (pending.length > 0) {
      const sql = this.ctx.storage.sql;
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          `CREATE TABLE IF NOT EXISTS ${VERSION_TABLE} (version INTEGER NOT NULL) STRICT`,
        );
        for (const migration of pending) {
          for (const statement of migration.statements) sql.exec(statement);
        }
        sql.exec(`DELETE FROM ${VERSION_TABLE}`);
        sql.exec(
          `INSERT INTO ${VERSION_TABLE} (version) VALUES (?)`,
          latestVersion(MIGRATIONS),
        );
      });
    }
    this.schemaVersion = latestVersion(MIGRATIONS);
    return this.schemaVersion;
  }

  /** Reads the schema version without writing; 0 for a new database. */
  private storedVersion(): number {
    const sql = this.ctx.storage.sql;
    const table = sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        VERSION_TABLE,
      )
      .toArray();
    if (table.length === 0) return 0;
    const [row] = sql
      .exec<{ version: number }>(`SELECT version FROM ${VERSION_TABLE}`)
      .toArray();
    return row?.version ?? 0;
  }
}
