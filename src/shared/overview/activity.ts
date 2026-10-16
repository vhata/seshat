import type { PrInput } from "./types";

/**
 * The fixed stale threshold from docs/DELIVERABLE.md#stale-flag: 7 days of
 * elapsed time, counted in milliseconds rather than calendar days, so time
 * zones and daylight saving play no part.
 */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The PR's latest activity: commits, reviews, comments or state changes,
 * opening included. Every submitted review counts, from anyone, since the
 * stale flag is about whether anything is happening rather than whose reviews
 * decide the bucket.
 */
export function lastActivityAt(pr: Pick<PrInput, "activity" | "reviews">): number {
  const { openedAt, lastCommitAt, lastCommentAt, lastStateChangeAt } =
    pr.activity;
  let latest = openedAt;
  for (const at of [lastCommitAt, lastCommentAt, lastStateChangeAt]) {
    if (at !== null && at > latest) latest = at;
  }
  for (const review of pr.reviews) {
    if (review.state === "pending" || review.submittedAt === null) continue;
    if (review.submittedAt > latest) latest = review.submittedAt;
  }
  return latest;
}

/**
 * Whether a PR whose last activity was at `lastActivity` is stale at `now`.
 *
 * Reading of DELIVERABLE.md#stale-flag: "no activity for 7 days" is met once
 * a full 7 days have passed, so a PR is stale from exactly 7 days after its
 * last activity, not only after that. Activity later than `now`, from clock
 * skew between GitHub and the instance, is never stale.
 */
export function isStale(lastActivity: number, now: number): boolean {
  return now - lastActivity >= STALE_AFTER_MS;
}
