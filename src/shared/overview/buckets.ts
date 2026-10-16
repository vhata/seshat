import { deriveCi, type CiState } from "./ci";
import {
  deriveReviewState,
  ownerReviewedHead,
  type ReviewState,
} from "./reviews";
import type { Mergeability, PrInput } from "./types";

/**
 * The facts a PR's bucket depends on, derived from its input. Rows show them
 * too, so bucketing is never the only way to see why a PR is where it is.
 */
export interface PrFacts {
  /** The PR's author is the owner's account, compared by ID. */
  readonly isOwners: boolean;
  readonly isDraft: boolean;
  readonly ci: CiState;
  /**
   * As GitHub reports it. Only `conflicting` counts as conflicts; `unknown`,
   * while GitHub computes mergeability, counts as none and the row says it is
   * being checked.
   */
  readonly mergeable: Mergeability;
  readonly reviewState: ReviewState;
  readonly ownerReviewedHead: boolean;
}

export function hasConflicts(facts: Pick<PrFacts, "mergeable">): boolean {
  return facts.mergeable === "conflicting";
}

export function deriveFacts(pr: PrInput, ownerId: number): PrFacts {
  return {
    isOwners: pr.author?.id === ownerId,
    isDraft: pr.isDraft,
    ci: deriveCi(pr.ci),
    mergeable: pr.mergeable,
    reviewState: deriveReviewState(pr, ownerId),
    ownerReviewedHead: ownerReviewedHead(pr, ownerId),
  };
}

export type BucketGroup = "needs-you" | "waiting";

export type BucketId =
  | "ready-to-land"
  | "broken"
  | "awaiting-your-review"
  | "changes-requested-on-yours"
  | "ci-running"
  | "waiting-on-the-author"
  | "draft";

export interface Bucket {
  readonly id: BucketId;
  readonly group: BucketGroup;
  readonly title: string;
  /** The bucket's rule, applied only after every earlier bucket's failed. */
  readonly matches: (facts: PrFacts) => boolean;
}

/**
 * The bucket table in docs/DELIVERABLE.md#buckets, in order. A PR goes in the
 * first bucket whose rule matches; each rule is written as the table states
 * it, without relying on the rules before it.
 */
export const BUCKETS: readonly Bucket[] = [
  {
    id: "ready-to-land",
    group: "needs-you",
    title: "Ready to land",
    matches: (f) =>
      !f.isDraft &&
      (f.ci === "passing" || f.ci === "none") &&
      !hasConflicts(f) &&
      f.reviewState !== "changes_requested" &&
      (f.reviewState === "approved" || f.isOwners),
  },
  {
    id: "broken",
    group: "needs-you",
    title: "Broken",
    matches: (f) =>
      f.isOwners && !f.isDraft && (f.ci === "failing" || hasConflicts(f)),
  },
  {
    id: "awaiting-your-review",
    group: "needs-you",
    title: "Awaiting your review",
    matches: (f) => !f.isOwners && !f.isDraft && !f.ownerReviewedHead,
  },
  {
    id: "changes-requested-on-yours",
    group: "needs-you",
    title: "Changes requested on yours",
    matches: (f) =>
      f.isOwners && !f.isDraft && f.reviewState === "changes_requested",
  },
  {
    id: "ci-running",
    group: "waiting",
    title: "CI running",
    matches: (f) => !f.isDraft && f.ci === "pending",
  },
  {
    id: "waiting-on-the-author",
    group: "waiting",
    title: "Waiting on the author",
    matches: (f) => !f.isOwners && !f.isDraft && f.ownerReviewedHead,
  },
  {
    id: "draft",
    group: "waiting",
    title: "Draft",
    matches: (f) => f.isDraft,
  },
];

/** The first bucket whose rule matches. */
export function bucketFor(facts: PrFacts): Bucket {
  const bucket = BUCKETS.find((candidate) => candidate.matches(facts));
  // The rules cover every combination of facts (the tests enumerate them), so
  // this is unreachable unless a rule is changed without that coverage.
  if (bucket === undefined) {
    throw new Error(`no bucket matches ${JSON.stringify(facts)}`);
  }
  return bucket;
}
