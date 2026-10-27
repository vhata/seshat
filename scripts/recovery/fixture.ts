/** Dedicated synthetic recovery fixture. Never bind this class to production. */
import { InstanceObject } from "../../src/object/instance";
import { MIGRATIONS } from "../../src/object/schema";
import { OverviewStore } from "../../src/object/overview-store";
import { RepositoryDiscoveryStore } from "../../src/object/repository-discovery-store";
import { FIXTURE_REPOSITORY, fixturePr } from "../../src/shared/overview/fixtures";

declare const RECOVERY_BUILD: { account: string; name: string; mode: string; source: string };
if (RECOVERY_BUILD.mode === "migration") {
  // Deliberately incompatible schema, in this disposable bundle only.
  (MIGRATIONS as { version: number; statements: string[] }[]).push({
    version: MIGRATIONS.length + 1,
    statements: ["ALTER TABLE settings ADD COLUMN recovery_marker TEXT"],
  });
}
type FixtureEnv = Env & {
  RECOVERY: DurableObjectNamespace<RecoveryFixture>;
  RECOVERY_TOKEN: string;
  RECOVERY_ACCOUNT: string;
  RECOVERY_NAME: string;
  RECOVERY_MAINTENANCE: string;
  RECOVERY_NATIVE_PITR: string;
  CF_VERSION_METADATA?: { id: string };
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const sessionKey = "a".repeat(64); // Synthetic hash, never a real browser credential.
const bookmarkPattern = /^[a-zA-Z0-9-]{16,256}$/;

async function authorized(request: Request, env: FixtureEnv): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!/^[a-f0-9]{64}$/.test(env.RECOVERY_TOKEN ?? "") || token.length > 256) return false;
  const hash = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [actual, expected] = await Promise.all([hash(token), hash(env.RECOVERY_TOKEN)]);
  return crypto.subtle.timingSafeEqual(actual, expected);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); throw new Error("body-too-large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-body");
  return parsed as Record<string, unknown>;
}

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    if (env.RECOVERY_MAINTENANCE !== "enabled" || env.RECOVERY_ACCOUNT !== RECOVERY_BUILD.account || env.RECOVERY_NAME !== RECOVERY_BUILD.name) return json({ error: "fixture-binding-mismatch" }, 503);
    if (!new URL(request.url).pathname.startsWith("/recovery/")) return json({ error: "synthetic-fixture-maintenance" }, 503);
    if (!await authorized(request, env)) return json({ error: "unauthorized" }, 401);
    if (request.method !== "POST") return json({ error: "method" }, 405);
    let input: Record<string, unknown>;
    try { input = await body(request); }
    catch (error) { return json({ error: error instanceof Error && error.message === "body-too-large" ? "body-too-large" : "invalid-body" }, 400); }
    const target = input.target as { account?: unknown; name?: unknown } | undefined;
    if (target?.account !== RECOVERY_BUILD.account || target?.name !== RECOVERY_BUILD.name) return json({ error: "target-mismatch" }, 409);
    return env.RECOVERY.getByName("synthetic-instance").fetch(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(input) });
  },
};

export class RecoveryFixture extends InstanceObject {
  private pendingUndo: string | undefined;
  private restorePhase: "idle" | "preparing" | "prepared" | "unknown" = "idle";
  // This fixture intentionally never runs production alarms or WebSockets.
  override async alarm(): Promise<void> { await this.ctx.storage.deleteAlarm(); }
  override async webSocketMessage(socket: WebSocket): Promise<void> { socket.close(1012, "fixture maintenance"); }
  override async webSocketClose(socket: WebSocket): Promise<void> { socket.close(); }
  override async webSocketError(socket: WebSocket): Promise<void> { socket.close(); }

  override async fetch(request: Request): Promise<Response> {
    const env = this.env as FixtureEnv;
    if (env.RECOVERY_MAINTENANCE !== "enabled" || env.RECOVERY_ACCOUNT !== RECOVERY_BUILD.account || env.RECOVERY_NAME !== RECOVERY_BUILD.name) return json({ error: "fixture-binding-mismatch" }, 503);
    if (!await authorized(request, env)) return json({ error: "unauthorized" }, 401);
    const input = await body(request);
    const target = input.target as { account?: unknown; name?: unknown } | undefined;
    if (target?.account !== RECOVERY_BUILD.account || target?.name !== RECOVERY_BUILD.name) return json({ error: "target-mismatch" }, 409);
    const op = new URL(request.url).pathname.slice("/recovery/".length);
    const sql = this.ctx.storage.sql;
    if (op === "status") return json({ ...RECOVERY_BUILD, maintenance: true, syntheticOnly: true, objectId: this.ctx.id.toString(), versionId: env.CF_VERSION_METADATA?.id ?? null, restorePhase: this.restorePhase, pendingRestart: this.pendingUndo !== undefined });
    if (op === "inspect") {
      // Raw inspection must work even when older code refuses a future schema.
      const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' ORDER BY name").toArray();
      return json(Object.fromEntries(tables.map(({ name }) => [String(name), sql.exec('SELECT * FROM "' + String(name).replaceAll('"', '""') + '" ORDER BY 1').toArray()])));
    }
    if (op === "bookmark" || op === "prepare-restore") {
      if (env.RECOVERY_NATIVE_PITR !== "hosted-only") return json({ error: "native-pitr-disabled-local", localProof: false }, 501);
      try {
        if (op === "bookmark") return json({ bookmark: await this.ctx.storage.getCurrentBookmark() });
        if (this.restorePhase !== "idle") return json({ error: "restore-already-prepared" }, 409);
        if (typeof input.bookmark !== "string" || !bookmarkPattern.test(input.bookmark)) return json({ error: "invalid-bookmark" }, 400);
        // Preserve this response privately BEFORE invoking restart. Incidental
        // eviction may restore earlier; a lost response is not safe to retry.
        // Close admission before the native await; do not assume input gates.
        this.restorePhase = "preparing";
        this.pendingUndo = await this.ctx.storage.onNextSessionRestoreBookmark(input.bookmark);
        this.restorePhase = "prepared";
        return json({ undoBookmark: this.pendingUndo, warning: "Persist this undo bookmark before restart. Lost response: stop; do not blindly retry." });
      } catch {
        if (op === "prepare-restore") this.restorePhase = "unknown";
        return json({ error: "native-pitr-unavailable", outcomeUnknown: op === "prepare-restore" }, 501);
      }
    }
    if (op === "restart") {
      if (this.restorePhase !== "prepared" || this.pendingUndo === undefined || input.undoBookmark !== this.pendingUndo) return json({ error: "undo-bookmark-ack-required" }, 409);
      // The abort intentionally breaks the connection. Reconnect and inspect.
      this.ctx.abort("synthetic recovery fixture restart");
      return json({ error: "restart" }, 503);
    }
    if (this.restorePhase !== "idle") return json({ error: "restore-pending-use-inspect-or-acknowledged-restart" }, 409);
    if (op === "invalidate-sessions") {
      sql.exec("DELETE FROM sessions");
      await this.ctx.storage.deleteAlarm();
      return json({ sessions: 0 });
    }
    if (op === "damage") {
      sql.exec("DELETE FROM settings");
      sql.exec("UPDATE installations SET status='pending' WHERE id=20");
      sql.exec("DELETE FROM pull_requests");
      sql.exec("DELETE FROM sessions");
      return json({ damaged: true });
    }
    if (op === "health") {
      if (RECOVERY_BUILD.mode === "broken") return json({ error: "synthetic-code-regression" }, 503);
      try { return json(await super.health()); }
      catch { return json({ error: "schema-refused" }, 500); }
    }
    if (op === "seed") {
      if (sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").toArray().length) return json({ error: "already-initialized" }, 409);
      await super.health();
      await this.createSession(sessionKey, 1793000000000, 1001);
      sql.exec("INSERT INTO installations VALUES (9,1001,'User','accepted','all'), (20,2002,'Organization','accepted','selected'), (21,2003,'Organization','pending','all')");
      // Specify columns so this also works in the synthetic future bundle.
      sql.exec("INSERT INTO settings (key,value) VALUES ('installation-refused:22','true')");
      new RepositoryDiscoveryStore(this.ctx.storage).saveMonitoringOverride(99, 1001, false);
      const store = new OverviewStore(this.ctx.storage);
      store.putRepository({ ...FIXTURE_REPOSITORY, monitorOverride: true });
      store.putPullRequest(fixturePr());
      return json({ seeded: true, sessionKey });
    }
    return json({ error: "unknown-control" }, 404);
  }
}
