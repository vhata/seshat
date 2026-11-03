import type { SyncFailureReason } from "./overview/protocol";

export const MONITORING_PATH = "/api/monitoring";

/** Allowlisted scheduling evidence, never job identities or cached content. */
export interface SchedulerStatus {
  readonly alarmAt: number | null;
  /** Volatile invocation state, not persisted across an object restart. */
  readonly running: boolean;
  readonly nextSweepAt: number | null;
  readonly sweep: {
    readonly phase: "listing" | "count" | "read";
    readonly startedAt: number;
    readonly retry: number;
  } | null;
  readonly rereadActive: boolean;
  readonly rereadCachedResponseCount: number;
  readonly rereadSelectedItemCount: number;
  readonly pending: {
    readonly guard: number;
    readonly refresh: number;
    readonly marks: number;
  };
  readonly selectionConfigured: boolean;
}

/** Owner-only diagnostics. No repository identifiers or private content. */
export interface MonitoringStatus {
  readonly version: 1;
  readonly serverTime: number;
  readonly activeSince: number | null;
  readonly sync: {
    readonly lastSuccessfulSweepAt: number | null;
    readonly latestAttempt: {
      readonly startedAt: number;
      readonly result: "running" | "success" | "failed";
      readonly reason?: SyncFailureReason;
    } | null;
    readonly intervalMs: number;
    readonly slowedByRateLimit: boolean;
  };
  readonly oldestPendingAt: number | null;
  readonly lastEventFailureAt: number | null;
  readonly githubRateLimited: boolean;
  /** Only the account's usage view can establish remaining capacity. */
  readonly cloudflareCapacity: "unknown";
  /** Additive version-1 diagnostics; older deployments may omit this field. */
  readonly scheduler?: SchedulerStatus;
}
