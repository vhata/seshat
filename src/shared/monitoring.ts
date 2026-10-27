import type { SyncFailureReason } from "./overview/protocol";

export const MONITORING_PATH = "/api/monitoring";

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
}
