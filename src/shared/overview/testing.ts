/**
 * Builders for fixed sample PR data in the overview tests. Not imported by
 * application code.
 */
import type {
  Account,
  CiResult,
  PrInput,
  RepositoryPermission,
  Review,
  ReviewSubmissionState,
} from "./types";

export const DAY = 24 * 60 * 60 * 1000;

/** A fixed "now" for tests: 2026-10-15T12:00:00Z. */
export const NOW = Date.UTC(2026, 9, 15, 12);

export const owner: Account = { id: 1001, login: "vhata", isBot: false };
/** The owner's login on a different account ID: never the owner. */
export const impostor: Account = { id: 9999, login: "vhata", isBot: false };
export const maintainer: Account = { id: 2002, login: "comaint", isBot: false };
export const passerBy: Account = { id: 3003, login: "drive-by", isBot: false };
export const reader: Account = { id: 4004, login: "triager", isBot: false };
export const dependabot: Account = {
  id: 49699333,
  login: "dependabot[bot]",
  isBot: true,
};

export const HEAD = "head000000000000000000000000000000000000";
export const OLD = "old0000000000000000000000000000000000000";

export const ownedRepo = { fullName: "vhata/seshat", ownerAccountId: owner.id };
export const orgRepo = { fullName: "acme/widgets", ownerAccountId: 5005 };

export const passing: CiResult = {
  kind: "check_run",
  status: "completed",
  conclusion: "success",
};
export const failing: CiResult = {
  kind: "check_run",
  status: "completed",
  conclusion: "failure",
};
export const running: CiResult = {
  kind: "check_run",
  status: "in_progress",
  conclusion: null,
};

let clock = NOW - 10 * DAY;

/** A submitted review; each call is later than the one before. */
export function review(
  author: Account | null,
  state: ReviewSubmissionState,
  commitSha: string | null = HEAD,
  submittedAt: number | null = (clock += 1000),
): Review {
  return { author, state, commitSha, submittedAt };
}

/**
 * A PR on the owner's repository with defaults that put it nowhere special:
 * someone else's, not a draft, mergeable, no CI, no reviews, active an hour
 * ago. The maintainer has write permission and the reader has read.
 */
export function pr(overrides: Partial<PrInput> = {}): PrInput {
  return {
    repository: ownedRepo,
    number: 1,
    author: passerBy,
    isDraft: false,
    headSha: HEAD,
    mergeable: "mergeable",
    ci: [],
    reviews: [],
    reviewerPermissions: permissions({
      [maintainer.id]: "write",
      [reader.id]: "read",
    }),
    activity: {
      openedAt: NOW - 3 * DAY,
      lastCommitAt: NOW - 60 * 60 * 1000,
      lastCommentAt: null,
      lastStateChangeAt: null,
    },
    ...overrides,
  };
}

export function permissions(
  entries: Record<number, RepositoryPermission>,
): ReadonlyMap<number, RepositoryPermission> {
  return new Map(
    Object.entries(entries).map(([id, permission]) => [Number(id), permission]),
  );
}
