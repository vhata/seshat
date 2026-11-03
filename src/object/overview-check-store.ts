import {
  isCheckStatus,
  type CheckAttempt, type CheckScope, type CheckStatus, type FreshnessEvidence,
  type SyncFailureReason,
} from "../shared/overview/protocol";

const PREFIX = "overview-check:";
const SEQUENCE = "overview-check-sequence";
const UNKNOWN: CheckStatus = { lastSuccessfulCheckAt: null, latestAttempt: null };

/** Independent of discovery metadata and PR facts, including unchanged reads. */
export class OverviewCheckStore {
  constructor(private readonly checkStorage: DurableObjectStorage) {}

  private key(scope: CheckScope, key: string): string { return `${PREFIX}${scope}:${key}`; }
  private read(scope: CheckScope, key: string): CheckStatus {
    const row = this.checkStorage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", this.key(scope, key)).toArray()[0];
    if (!row) return UNKNOWN;
    const value: unknown = JSON.parse(row.value);
    if (!isCheckStatus(value)) throw new Error("invalid check evidence");
    return value;
  }
  private write(scope: CheckScope, key: string, status: CheckStatus): void {
    this.checkStorage.sql.exec("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", this.key(scope, key), JSON.stringify(status));
  }

  beginCheck(scope: CheckScope, key: string, now: number, result: "queued" | "running" = "queued"): CheckAttempt {
    if (!Number.isFinite(now)) throw new Error("invalid check time");
    return this.checkStorage.transactionSync(() => {
      const row = this.checkStorage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", SEQUENCE).toArray()[0];
      const id = Number(row?.value ?? 0) + 1;
      if (!Number.isSafeInteger(id)) throw new Error("check sequence exhausted");
      this.checkStorage.sql.exec("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", SEQUENCE, String(id));
      const attempt: CheckAttempt = { id, startedAt: now, result };
      const before = this.read(scope, key);
      // A delayed observer cannot replace a check begun on newer evidence.
      if (now >= (before.latestAttempt?.startedAt ?? -Infinity)) this.write(scope, key, { ...before, latestAttempt: attempt });
      return attempt;
    });
  }

  private current(scope: CheckScope, key: string, attempt: CheckAttempt): CheckStatus | null {
    const before = this.read(scope, key);
    const latest = before.latestAttempt;
    return latest?.id === attempt.id && latest.startedAt === attempt.startedAt
      && (latest.result === "queued" || latest.result === "running") ? before : null;
  }

  runCheck(scope: CheckScope, key: string, attempt: CheckAttempt): void {
    const before = this.current(scope, key, attempt);
    if (before && before.latestAttempt?.result !== "running") this.write(scope, key, { ...before, latestAttempt: { ...attempt, result: "running" } });
  }

  /** A complete PR observation may succeed while a webhook fact still waits. */
  recordCheckSuccess(scope: CheckScope, key: string, attempt: CheckAttempt): void {
    const before = this.current(scope, key, attempt);
    if (before && (before.lastSuccessfulCheckAt === null || attempt.startedAt > before.lastSuccessfulCheckAt)) {
      this.write(scope, key, { ...before, lastSuccessfulCheckAt: attempt.startedAt });
    }
  }

  finishCheck(scope: CheckScope, key: string, attempt: CheckAttempt, result: "success" | "failed" | "interrupted", reason?: SyncFailureReason): void {
    const before = this.current(scope, key, attempt);
    if (!before) return;
    this.write(scope, key, {
      lastSuccessfulCheckAt: result === "success"
        ? Math.max(before.lastSuccessfulCheckAt ?? -Infinity, attempt.startedAt) : before.lastSuccessfulCheckAt,
      latestAttempt: { id: attempt.id, startedAt: attempt.startedAt, result, ...(reason === undefined ? {} : { reason }) },
    });
  }

  forget(scope: CheckScope, key: string): void {
    this.checkStorage.sql.exec("DELETE FROM settings WHERE key = ?", this.key(scope, key));
  }

  /** Only currently monitored identities cross the owner protocol boundary. */
  evidence(repositoryIds: readonly number[], prIds: readonly string[]): FreshnessEvidence {
    return {
      repositories: Object.fromEntries(repositoryIds.map((id) => [String(id), this.read("repository", String(id))])),
      pullRequests: Object.fromEntries(prIds.map((id) => [id, this.read("pr", id)])),
    };
  }
}
