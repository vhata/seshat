import { DurableObject } from "cloudflare:workers";
import { signAppJwt } from "../shared/app-jwt";
import { CallbackLimiter } from "./callback-limiter";
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
import {
  buildSnapshot, KEEP_ALIVE_REQUEST, KEEP_ALIVE_RESPONSE, parseClientMessage,
  SOCKET_PATH, type OverviewSnapshot, type ServerMessage, type SocketAttachment,
} from "../shared/overview/protocol";
import { OverviewStore } from "./overview-store";
import { RepositorySelection } from "./repository-selection";
import { RepositoryDiscoveryStore } from "./repository-discovery-store";
import type { RepositorySettings } from "../shared/repositories";
import type { InstallationRefreshResult, MonitoringMutationResult } from "../shared/overview/protocol";
import { MIGRATIONS } from "./schema";
import { OverviewSync } from "./overview-sync";
import type { ReducedDelivery } from "../shared/overview/webhook-marks";
import type { MonitoringStatus } from "../shared/monitoring";

const VERSION_TABLE = "schema_version";

/** What the installation check reports to the owner's setup page. */
export type InstallationCheck =
  | {
      readonly ok: false;
      readonly reason: "not-configured" | "github-failed" | "too-many-installations";
    }
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
  private selection: RepositorySelection | undefined;
  private sync: OverviewSync | undefined;
  private readonly callbackLimiter = new CallbackLimiter();
  private readonly installationDecisions = new Set<number>();

  /** Reports that the object is reachable and its schema is current. */
  async health(): Promise<{ schemaVersion: number }> {
    const schemaVersion = this.ensureSchema();
    await this.syncScheduler().rearm(Date.now());
    return { schemaVersion };
  }

  /** Owner-gated by the Worker; diagnostics never expose the underlying jobs. */
  async monitoringStatus(now: number): Promise<MonitoringStatus> {
    this.ensureSchema();
    return this.syncScheduler().monitoringStatus(now);
  }

  /**
   * Starts an owner session. The caller has already checked the visitor's
   * account ID; `key` is the SHA-256 of the cookie value. Expired sessions
   * are pruned here, so the table stays bounded without writes on reads.
   * Returns the expiry time in milliseconds.
   */
  async createSession(key: string, nowMs: number, ownerId: number): Promise<number> {
    if (ownerId !== this.configuredOwner() || !Number.isSafeInteger(ownerId) || ownerId <= 0) {
      throw new Error("Session owner no longer configured");
    }
    this.ensureSchema();
    await this.syncScheduler().rearm(nowMs);
    const expiresAt = nowMs + SESSION_SECONDS * 1000;
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM sessions WHERE expires_at <= ?", nowMs);
      sql.exec(
        "INSERT INTO sessions (key, created_at, expires_at, owner_id) VALUES (?, ?, ?, ?)",
        key,
        nowMs,
        expiresAt,
        ownerId,
      );
    });
    return expiresAt;
  }

  /** The session's expiry if it exists and has not expired; reads only. */
  async sessionExpiry(key: string, nowMs: number, ownerId = this.configuredOwner()): Promise<number | null> {
    if (ownerId === null || ownerId !== this.configuredOwner()) return null;
    this.ensureSchema();
    await this.syncScheduler().rearm(nowMs);
    const [row] = this.ctx.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT expires_at FROM sessions WHERE key = ? AND expires_at > ? AND owner_id = ?",
        key,
        nowMs,
        ownerId,
      )
      .toArray();
    return row?.expires_at ?? null;
  }

  private configuredOwner(): number | null {
    return readConfig(this.env as unknown as Record<string, unknown>).ownerId;
  }

  /** Anonymous attempts use bounded volatile counters, never database rows. */
  signInAllowance(client: string, now: number): number {
    return this.callbackLimiter.attempt(client, now);
  }

  /** Ends a session. Writes only if the session exists. */
  async endSession(key: string): Promise<void> {
    this.ensureSchema();
    await this.syncScheduler().rearm(Date.now());
    const sql = this.ctx.storage.sql;
    const exists = sql.exec("SELECT 1 FROM sessions WHERE key = ?", key).toArray().length > 0;
    if (exists) sql.exec("DELETE FROM sessions WHERE key = ?", key);
    for (const socket of this.ctx.getWebSockets()) {
      if (this.socketAttachment(socket)?.sessionKey === key) socket.close(1008, "session ended");
    }
  }

  /**
   * Runs the installation guard against the App's own list of
   * installations: keeps the owner's personal one, holds organization ones
   * as pending, deletes any other on GitHub, and forgets installations that
   * no longer exist. Writes only what changed.
   */
  async checkInstallations(nowMs: number): Promise<InstallationCheck> {
    this.ensureSchema();
    await this.syncScheduler().rearm(nowMs);
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
    if (!listed.ok) {
      // Nothing is kept, deleted or forgotten from a partial list.
      return {
        ok: false,
        reason: listed.reason === "truncated" ? "too-many-installations" : "github-failed",
      };
    }
    const reported = listed.installations
      .map(parseInstallation)
      .filter((installation): installation is ReportedInstallation => installation !== null);

    const stored = this.storedInstallations();
    const refused = this.refusedInstallations();
    const actions = guardInstallations(reported.filter((installation) => !refused.has(installation.id)), stored, config.ownerId);
    const logins = new Map(reported.map((installation) => [installation.id, installation.accountLogin]));
    let kept: (StoredInstallation & { accountLogin: string })[] = [];
    const deleted: ReportedInstallation[] = [];
    const undeleted: ReportedInstallation[] = [];
    // listInstallations uses at most ten calls. Deletions share the remaining
    // forty, including refused deletions, so even an untrusted App installation
    // burst cannot exceed Free's fifty subrequests. The alarm retries the rest.
    let deletionAllowance = 40;
    for (const action of actions) {
      if (action.kind === "keep") {
        kept.push({ ...action.installation, accountLogin: logins.get(action.installation.id) ?? "" });
      } else if (deletionAllowance-- > 0 && await deleteInstallation(jwt, action.installation.id)) {
        deleted.push(action.installation);
      } else {
        undeleted.push(action.installation);
      }
    }

    // A decision can finish while a stranger's uninstall request is in
    // flight. Preserve current acceptance and never resurrect a refusal.
    const current = this.storedInstallations();
    const currentlyRefused = this.refusedInstallations();
    kept = kept.filter((installation) => !currentlyRefused.has(installation.id)).map((installation) => {
      const latest = current.find((entry) => entry.id === installation.id);
      return installation.accountType === "Organization" && latest?.status === "accepted"
        ? { ...installation, status: "accepted" as const } : installation;
    });
    const previous = new Map(current.map((installation) => [installation.id, installation]));
    const keptIds = new Set(kept.map((installation) => installation.id));
    const sql = this.ctx.storage.sql;
    const changed = kept.filter((installation) => {
      const before = previous.get(installation.id);
      return before === undefined || !sameInstallation(before, installation);
    });
    const gone = current.filter((installation) => !keptIds.has(installation.id));
    if (changed.length > 0 || gone.length > 0) {
      this.ctx.storage.transactionSync(() => {
        for (const installation of gone) {
          for (const repository of this.overviewStore().repositories(installation.id)) {
            this.overviewStore().removeRepository(repository.id);
          }
          this.selection?.forget(installation.id);
          new RepositoryDiscoveryStore(this.ctx.storage).forget(installation.id);
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
    if (gone.length > 0) {
      await this.publishOverview({ type: "snapshot", snapshot: await this.overviewSnapshot(nowMs) });
    }
    if (undeleted.length > 0) this.syncScheduler().requestGuard(nowMs + 15_000);
    await this.syncScheduler().rearm(nowMs);
    return { ok: true, kept, deleted, undeleted };
  }

  /** Owner-only settings; listing reads are explicit mutations, never a GET. */
  async repositorySettings(): Promise<RepositorySettings> {
    const store = this.overviewStore();
    await this.syncScheduler().rearm(Date.now());
    const ownerId = readConfig(this.env as unknown as Record<string, unknown>).ownerId ?? 0;
    return { ownerId, installations: this.storedInstallations(), repositories: store.repositories() };
  }

  async refreshInstallation(installationId: number, now: number, requestBudget = 25): Promise<InstallationRefreshResult> {
    const selection = this.repositorySelection();
    const result = selection ? await selection.refreshInstallation(installationId, now, requestBudget) : { ok: false as const, reason: "github-unavailable" as const, requestsUsed: 0 };
    if (result.ok) this.syncScheduler().discoveryChanged(installationId, now);
    else if (result.reason === "continuation") this.syncScheduler().refresh(installationId, now, false);
    await this.syncScheduler().rearm(now);
    return result;
  }

  async setMonitoringOverride(repositoryId: number, override: boolean | null, now: number): Promise<MonitoringMutationResult> {
    const selection = this.repositorySelection();
    const result = selection ? await selection.setMonitoringOverride(repositoryId, override, now) : { ok: false as const, reason: "not-allowed" as const };
    if (result.ok && result.repository.monitored) this.syncScheduler().discoveryChanged(result.repository.installationId, now);
    await this.syncScheduler().rearm(now);
    return result;
  }

  async decideOrganization(installationId: number, accept: boolean, now: number): Promise<{ ok: boolean }> {
    await this.syncScheduler().rearm(now);
    if (this.installationDecisions.has(installationId)) return { ok: false };
    this.installationDecisions.add(installationId);
    try { return await this.applyOrganizationDecision(installationId, accept, now); }
    finally { this.installationDecisions.delete(installationId); await this.syncScheduler().rearm(now); }
  }

  private async applyOrganizationDecision(installationId: number, accept: boolean, now: number): Promise<{ ok: boolean }> {
    this.ensureSchema();
    const installation = this.storedInstallations().find((entry) => entry.id === installationId);
    const config = readConfig(this.env as unknown as Record<string, unknown>);
    if (!installation || installation.accountType !== "Organization" || installation.status !== "pending" || !config.app) return { ok: false };
    if (accept) {
      this.ctx.storage.sql.exec("UPDATE installations SET status = 'accepted' WHERE id = ?", installationId);
      this.syncScheduler().refresh(installationId, now);
      return { ok: true };
    }
    let jwt: string;
    try { jwt = await signAppJwt(config.app.clientId, config.app.privateKey, Math.floor(now / 1000)); }
    catch { return { ok: false }; }
    if (!await deleteInstallation(jwt, installationId)) return { ok: false };
    // Installation IDs are immutable. Remember a successful refusal so a
    // concurrent guard's earlier GitHub response cannot re-add it as pending.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO settings (key, value) VALUES (?, 'true') ON CONFLICT (key) DO NOTHING", `installation-refused:${installationId}`);
      this.ctx.storage.sql.exec("DELETE FROM installations WHERE id = ? AND status = 'pending'", installationId);
      new RepositoryDiscoveryStore(this.ctx.storage).forget(installationId);
    });
    this.selection?.forget(installationId);
    return { ok: true };
  }

  private repositorySelection(): RepositorySelection | null {
    if (this.selection) return this.selection;
    const config = readConfig(this.env as unknown as Record<string, unknown>);
    if (!config.app || config.ownerId === null) return null;
    const store = this.overviewStore();
    this.selection = new RepositorySelection({
      ownerId: config.ownerId, app: config.app, store, discovery: new RepositoryDiscoveryStore(this.ctx.storage),
      installations: () => this.storedInstallations(),
      publish: async (now) => this.publishOverview({ type: "snapshot", snapshot: await this.overviewSnapshot(now) }),
    });
    return this.selection;
  }

  private syncScheduler(): OverviewSync {
    if (this.sync) return this.sync;
    this.sync = new OverviewSync({
      storage: this.ctx.storage, store: this.overviewStore(),
      selection: this.repositorySelection(),
      installations: () => this.storedInstallations(),
      visible: (now) => this.ctx.getWebSockets().some((socket) => {
        const attachment = this.socketAttachment(socket);
        if (!attachment || socket.readyState !== WebSocket.OPEN || attachment.expiresAt <= now
          || !attachment.visibility?.visible || now - attachment.visibility.reportedAt >= 900_000) return false;
        return this.ctx.storage.sql.exec("SELECT 1 FROM sessions WHERE key = ? AND expires_at > ? AND owner_id = ?", attachment.sessionKey, now, this.configuredOwner()).toArray().length > 0;
      }),
      guard: async (now) => {
        const result = await this.checkInstallations(now);
        return result.ok && result.undeleted.length === 0;
      },
      publish: async (now) => this.publishOverview({ type: "snapshot", snapshot: await this.overviewSnapshot(now) }),
    });
    return this.sync;
  }

  /** Verified webhook facts are persisted before the Worker acknowledges them. */
  async receiveDelivery(delivery: ReducedDelivery, now: number): Promise<boolean> {
    this.ensureSchema();
    return this.syncScheduler().receive(delivery, now);
  }

  override async alarm(): Promise<void> {
    this.ensureSchema();
    await this.syncScheduler().alarm(Date.now());
  }

  /** RPC callers are owner-gated by the Worker; no private snapshot is public. */
  async overviewSnapshot(nowMs: number): Promise<OverviewSnapshot> {
    const store = this.overviewStore();
    await this.syncScheduler().rearm(nowMs);
    const ownerId = readConfig(this.env as unknown as Record<string, unknown>).ownerId;
    return buildSnapshot(store.repositories(), store.pullRequests(), store.syncStatus(), ownerId ?? 0, nowMs);
  }

  /** Only the Worker forwards this request after its owner session gate. */
  override async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    await this.syncScheduler().rearm(Date.now());
    const url = new URL(request.url);
    if (url.pathname !== SOCKET_PATH) return new Response(null, { status: 404 });
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (request.headers.get("origin") !== url.origin) return new Response(null, { status: 403 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    const sessionKey = request.headers.get("x-seshat-session-key");
    const now = Date.now();
    const expiresAt = sessionKey === null ? null : await this.sessionExpiry(sessionKey, now);
    if (sessionKey === null || expiresAt === null) return new Response(null, { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Configure on connection, never in the constructor. The runtime handles
    // pings without invoking webSocketMessage or writing the database.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEP_ALIVE_REQUEST, KEEP_ALIVE_RESPONSE));
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sessionKey, expiresAt, visibility: null } satisfies SocketAttachment);
    server.send(JSON.stringify({ type: "snapshot", snapshot: await this.overviewSnapshot(now) } satisfies ServerMessage));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const now = Date.now();
    if (!await this.authorizedSocket(socket, now)) return;
    const message = parseClientMessage(data);
    if (!message) {
      socket.close(1008, "invalid message");
      return;
    }
    const attachment = this.socketAttachment(socket)!;
    socket.serializeAttachment({ ...attachment, visibility: { visible: message.visible, reportedAt: now } } satisfies SocketAttachment);
    await this.syncScheduler().visibility(now, message.type === "retry-now");
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    socket.close(code, reason);
    await this.syncScheduler().visibility(Date.now(), false);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "socket error");
    await this.syncScheduler().visibility(Date.now(), false);
  }

  /** All future sync publications use this session-checking boundary. */
  async publishOverview(message: ServerMessage): Promise<void> {
    await this.syncScheduler().rearm(Date.now());
    const encoded = JSON.stringify(message);
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      if (await this.authorizedSocket(socket, now)) {
        try { socket.send(encoded); }
        catch { socket.close(1011, "send failed"); }
      }
    }
  }

  private socketAttachment(socket: WebSocket): SocketAttachment | null {
    return socket.deserializeAttachment() as SocketAttachment | null;
  }

  private async authorizedSocket(socket: WebSocket, now: number): Promise<boolean> {
    const attachment = this.socketAttachment(socket);
    if (attachment === null || attachment.expiresAt <= now
      || await this.sessionExpiry(attachment.sessionKey, now) === null) {
      socket.close(1008, "session ended");
      return false;
    }
    return true;
  }

  private overviewStore(): OverviewStore {
    this.ensureSchema();
    return new OverviewStore(this.ctx.storage);
  }

  private refusedInstallations(): Set<number> {
    const rows = this.ctx.storage.sql.exec<{ key: string }>("SELECT key FROM settings WHERE key LIKE 'installation-refused:%'").toArray();
    return new Set(rows.map(({ key }) => Number(key.slice("installation-refused:".length))));
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
