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
 *
 * A time that is not a finite number, such as `Date.parse` of a malformed
 * timestamp (NaN), is skipped. If no time is usable the result is NaN, which
 * `isStale` never flags and `compareRows` sorts last.
 */
export function lastActivityAt(pr: Pick<PrInput, "activity" | "reviews">): number {
  const { openedAt, lastCommitAt, lastCommentAt, lastStateChangeAt } =
    pr.activity;
  const times = [openedAt, lastCommitAt, lastCommentAt, lastStateChangeAt];
  for (const review of pr.reviews) {
    if (review.state !== "pending") times.push(review.submittedAt);
  }
  let latest = Number.NaN;
  for (const at of times) {
    if (at === null || !Number.isFinite(at)) continue;
    if (Number.isNaN(latest) || at > latest) latest = at;
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
  // False when either time is NaN, since every comparison with NaN is.
  return now - lastActivity >= STALE_AFTER_MS;
}
