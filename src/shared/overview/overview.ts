import { isStale, lastActivityAt } from "./activity";
import {
  BUCKETS,
  bucketFor,
  deriveFacts,
  type Bucket,
  type BucketGroup,
  type PrFacts,
} from "./buckets";
import type { PrInput } from "./types";

/** One PR as the overview shows it: the input plus everything derived. */
export interface OverviewRow<T extends PrInput = PrInput> {
  readonly pr: T;
  readonly facts: PrFacts;
  readonly bucket: Bucket;
  /**
   * Milliseconds since the Unix epoch, or NaN when none of the PR's activity
   * times could be read (see `lastActivityAt`). The page should show NaN as
   * unknown rather than as a date, and likewise show the PR's age as unknown
   * when `pr.activity.openedAt` is NaN.
   */
  readonly lastActivityAt: number;
  readonly stale: boolean;
}

export interface OverviewBucket<T extends PrInput = PrInput> {
  readonly bucket: Bucket;
  /** In display order; empty when nothing is in the bucket. */
  readonly rows: readonly OverviewRow<T>[];
}

export interface OverviewOptions {
  /** The owner's GitHub account ID, configured at deploy time. */
  readonly ownerId: number;
  /** The current time, in milliseconds since the Unix epoch. */
  readonly now: number;
}

/** Derives a PR's facts, bucket, last activity and stale flag. */
export function overviewRow<T extends PrInput>(
  pr: T,
  { ownerId, now }: OverviewOptions,
): OverviewRow<T> {
  const facts = deriveFacts(pr, ownerId);
  const last = lastActivityAt(pr);
  return {
    pr,
    facts,
    bucket: bucketFor(facts),
    lastActivityAt: last,
    stale: isStale(last, now),
  };
}

/**
 * Orders repositories by `owner/name`, ignoring case as GitHub does for
 * names, then by exact name so the order never depends on the input's.
 *
 * Reading of DELIVERABLE.md#order-within-a-bucket: "repository name" is the
 * full name, since repositories with the same name can belong to different
 * owners.
 */
export function compareRepositoryNames(a: string, b: string): number {
  return compareStrings(a.toLowerCase(), b.toLowerCase()) || compareStrings(a, b);
}

/** Code-unit order, which unlike `localeCompare` is the same everywhere. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Row order within a bucket of the given group: in Needs you, longest
 * waiting (oldest last activity) first; in Waiting, latest activity first;
 * ties by repository name, then PR number.
 */
export function compareRows(
  group: BucketGroup,
): (a: OverviewRow, b: OverviewRow) => number {
  const direction = group === "needs-you" ? 1 : -1;
  return (a, b) =>
    compareActivity(a.lastActivityAt, b.lastActivityAt, direction) ||
    compareRepositoryNames(a.pr.repository.fullName, b.pr.repository.fullName) ||
    a.pr.number - b.pr.number;
}

/**
 * Compares activity times in the given direction. A time that is not finite
 * (NaN when no activity time could be read) sorts after every known time in
 * either group, and such rows fall back to the tie-break among themselves.
 * Subtracting NaN would instead give a comparator that is not consistent, and
 * the order would depend on the sort's input.
 */
function compareActivity(a: number, b: number, direction: 1 | -1): number {
  const aKnown = Number.isFinite(a);
  const bKnown = Number.isFinite(b);
  if (aKnown && bKnown) return direction * (a - b);
  if (aKnown === bKnown) return 0;
  return aKnown ? -1 : 1;
}

/**
 * Every bucket in table order, each with its rows in display order. Every PR
 * given appears exactly once. The caller passes only open PRs on monitored
 * repositories; extra fields on the input (title, URL and so on) are kept on
 * each row's `pr`.
 */
export function buildOverview<T extends PrInput>(
  prs: readonly T[],
  options: OverviewOptions,
): OverviewBucket<T>[] {
  const rows = prs.map((pr) => overviewRow(pr, options));
  return BUCKETS.map((bucket) => ({
    bucket,
    rows: rows
      .filter((row) => row.bucket === bucket)
      .sort(compareRows(bucket.group)),
  }));
}
