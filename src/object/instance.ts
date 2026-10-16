import { DurableObject } from "cloudflare:workers";
import { signAppJwt } from "../shared/app-jwt";
import { SESSION_SECONDS } from "../shared/auth";
import { readConfig } from "../shared/config";
import {
  guardInstallations,
  parseInstallation,
  sameInstallation,
  type ReportedInstallation,
  type StoredInstallation,
} from "../shared/installations";
import { latestVersion, pendingMigrations } from "../shared/migrations";
import { deleteInstallation, listInstallations } from "../worker/github";
import { MIGRATIONS } from "./schema";

const VERSION_TABLE = "schema_version";

/** What the installation check reports to the owner's setup page. */
export type InstallationCheck =
  | { readonly ok: false; readonly reason: "not-configured" | "github-failed" }
  | {
      readonly ok: true;
      /** Installations kept, with the account login GitHub reported just now. */
      readonly kept: readonly (StoredInstallation & { readonly accountLogin: string })[];
      /** Installations on other accounts, deleted on GitHub. */
      readonly deleted: readonly ReportedInstallation[];
      /** Deletions GitHub refused; they are still not stored. */
      readonly undeleted: readonly ReportedInstallation[];
    };

interface InstallationRow extends Record<string, SqlStorageValue> {
  id: number;
  account_id: number;
  account_type: string;
  status: string;
  repository_selection: string;
}

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
   * Starts an owner session. The caller has already checked the visitor's
   * account ID; `key` is the SHA-256 of the cookie value. Expired sessions
   * are pruned here, so the table stays bounded without writes on reads.
   * Returns the expiry time in milliseconds.
   */
  async createSession(key: string, nowMs: number): Promise<number> {
    this.ensureSchema();
    const expiresAt = nowMs + SESSION_SECONDS * 1000;
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM sessions WHERE expires_at <= ?", nowMs);
      sql.exec(
        "INSERT INTO sessions (key, created_at, expires_at) VALUES (?, ?, ?)",
        key,
        nowMs,
        expiresAt,
      );
    });
    return expiresAt;
  }

  /** The session's expiry if it exists and has not expired; reads only. */
  async sessionExpiry(key: string, nowMs: number): Promise<number | null> {
    this.ensureSchema();
    const [row] = this.ctx.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT expires_at FROM sessions WHERE key = ? AND expires_at > ?",
        key,
        nowMs,
      )
      .toArray();
    return row?.expires_at ?? null;
  }

  /** Ends a session. Writes only if the session exists. */
  async endSession(key: string): Promise<void> {
    this.ensureSchema();
    const sql = this.ctx.storage.sql;
    const exists = sql.exec("SELECT 1 FROM sessions WHERE key = ?", key).toArray().length > 0;
    if (exists) sql.exec("DELETE FROM sessions WHERE key = ?", key);
  }

  /**
   * Runs the installation guard against the App's own list of
   * installations: keeps the owner's personal one, holds organization ones
   * as pending, deletes any other on GitHub, and forgets installations that
   * no longer exist. Writes only what changed.
   */
  async checkInstallations(nowMs: number): Promise<InstallationCheck> {
    this.ensureSchema();
    const config = readConfig(this.env as unknown as Record<string, unknown>);
    if (config.app === null || config.ownerId === null) {
      return { ok: false, reason: "not-configured" };
    }
    let jwt: string;
    try {
      jwt = await signAppJwt(config.app.clientId, config.app.privateKey, Math.floor(nowMs / 1000));
    } catch {
      return { ok: false, reason: "not-configured" };
    }
    const listed = await listInstallations(jwt);
    if (listed === null) return { ok: false, reason: "github-failed" };
    const reported = listed
      .map(parseInstallation)
      .filter((installation): installation is ReportedInstallation => installation !== null);

    const stored = this.storedInstallations();
    const actions = guardInstallations(reported, stored, config.ownerId);
    const logins = new Map(reported.map((installation) => [installation.id, installation.accountLogin]));
    const kept: (StoredInstallation & { accountLogin: string })[] = [];
    const deleted: ReportedInstallation[] = [];
    const undeleted: ReportedInstallation[] = [];
    for (const action of actions) {
      if (action.kind === "keep") {
        kept.push({ ...action.installation, accountLogin: logins.get(action.installation.id) ?? "" });
      } else if (await deleteInstallation(jwt, action.installation.id)) {
        deleted.push(action.installation);
      } else {
        undeleted.push(action.installation);
      }
    }

    const previous = new Map(stored.map((installation) => [installation.id, installation]));
    const keptIds = new Set(kept.map((installation) => installation.id));
    const sql = this.ctx.storage.sql;
    const changed = kept.filter((installation) => {
      const before = previous.get(installation.id);
      return before === undefined || !sameInstallation(before, installation);
    });
    const gone = stored.filter((installation) => !keptIds.has(installation.id));
    if (changed.length > 0 || gone.length > 0) {
      this.ctx.storage.transactionSync(() => {
        for (const installation of gone) {
          sql.exec("DELETE FROM installations WHERE id = ?", installation.id);
        }
        for (const installation of changed) {
          sql.exec(
            `INSERT INTO installations (id, account_id, account_type, status, repository_selection)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               account_id = excluded.account_id,
               account_type = excluded.account_type,
               status = excluded.status,
               repository_selection = excluded.repository_selection`,
            installation.id,
            installation.accountId,
            installation.accountType,
            installation.status,
            installation.repositorySelection,
          );
        }
      });
    }
    return { ok: true, kept, deleted, undeleted };
  }

  private storedInstallations(): StoredInstallation[] {
    return this.ctx.storage.sql
      .exec<InstallationRow>(
        "SELECT id, account_id, account_type, status, repository_selection FROM installations ORDER BY id",
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        accountId: row.account_id,
        accountType: row.account_type === "Organization" ? "Organization" : "User",
        status: row.status === "accepted" ? "accepted" : "pending",
        repositorySelection: row.repository_selection === "selected" ? "selected" : "all",
      }));
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
