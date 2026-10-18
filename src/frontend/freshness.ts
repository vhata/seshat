import type { SyncStatus } from "../shared/overview/protocol";

export const MINUTE = 60_000;
export type Freshness = "Disconnected" | "Checking" | "Sync failed" | "Overdue" | "Live";
export interface FreshnessInput {
  sync: SyncStatus;
  connected: boolean;
  now: number;
  visibleSince: number;
}
export function isOverdue(sync: SyncStatus, now: number): boolean {
  return sync.lastSuccessfulSweepAt === null || now - sync.lastSuccessfulSweepAt > 5 * MINUTE;
}
/** Input times are on the object's clock; the page corrects its own clock. */
export function freshness({ sync, connected, now, visibleSince }: FreshnessInput): Freshness {
  if (!connected) return "Disconnected";
  const failed = sync.latestAttempt?.result === "failed";
  const failedSinceVisible = failed && sync.latestAttempt.startedAt >= visibleSince;
  if (now - visibleSince < MINUTE && isOverdue(sync, now) && !failedSinceVisible) return "Checking";
  if (failed) return "Sync failed";
  if (isOverdue(sync, now)) return "Overdue";
  return "Live";
}
export function relativeTime(timestamp: number | null, now: number): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
