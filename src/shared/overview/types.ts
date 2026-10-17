/**
 * Plain input for the PR overview rules in docs/DELIVERABLE.md (Terms,
 * Buckets, Order within a bucket, Stale flag). The GitHub reads described in
 * docs/specs/2026-10-14-change-detection.md#re-reads fill these in; nothing
 * here knows about GitHub's APIs. Field comments give the GitHub source where
 * the mapping is not obvious ("REST" is the REST API, "GraphQL" the GraphQL
 * API).
 *
 * All times are milliseconds since the Unix epoch, as `Date.parse` returns for
 * GitHub's ISO 8601 timestamps.
 */

/** A GitHub account: a person, a bot or a GitHub App. */
export interface Account {
  /**
   * The numeric account ID: REST `id`, GraphQL `databaseId`. Identity is
   * always compared by ID, never by login, because logins can be renamed and
   * reassigned.
   */
  readonly id: number;
  readonly login: string;
  /**
   * True for anything that is not a person: REST `type` other than `"User"`
   * (`"Bot"` covers bots and GitHub Apps), GraphQL `__typename` other than
   * `User` (`Bot`, `Mannequin` and so on).
   */
  readonly isBot: boolean;
}

/**
 * A repository permission as GitHub reports it for one account. Read it from
 * `permission` in REST's collaborator permission endpoint, which returns
 * `admin`, `write`, `read` or `none`, with maintain mapped to write, triage
 * to read and a custom role to its base role
 * (docs/specs/2026-10-12-github-integration.md#pr-signals). A 404 maps to
 * `none`. `role_name` is not a substitute: for a custom role it is the role's
 * own name, which says nothing about its base. `maintain` and `triage` are
 * accepted only for a reader that has the exact built-in role, such as a
 * `role_name` that is one of the five built-in roles.
 */
export type RepositoryPermission =
  | "admin"
  | "maintain"
  | "write"
  | "triage"
  | "read"
  | "none";

export interface RepositoryRef {
  /**
   * `owner/name` (REST `full_name`, GraphQL `nameWithOwner`), used to break
   * ordering ties.
   */
  readonly fullName: string;
  /**
   * The account ID of the repository's owner (REST `owner.id`, GraphQL
   * `owner { ... on User { databaseId } }`). When it is the owner's own ID,
   * the owner is a trusted reviewer whatever the permission lookup says.
   */
  readonly ownerAccountId: number;
}

/**
 * A submitted review's state: REST `state`, or GraphQL `PullRequestReview`
 * `state` lower-cased. GitHub sets `dismissed` on a review that was dismissed,
 * whatever it was before. Pending (unsubmitted) reviews are ignored; GitHub
 * shows them only to their author, so a reader using an installation token
 * should not see any.
 */
export type ReviewSubmissionState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed"
  | "pending";

export interface Review {
  /** Null when GitHub reports no author, such as a deleted account (ghost). */
  readonly author: Account | null;
  readonly state: ReviewSubmissionState;
  /**
   * The commit the review was submitted on: REST `commit_id`, GraphQL
   * `commit.oid`. Null when GitHub no longer reports it.
   */
  readonly commitSha: string | null;
  /** REST `submitted_at`, GraphQL `submittedAt`; null for a pending review. */
  readonly submittedAt: number | null;
}

/**
 * A check run's status: REST `status`, or GraphQL `CheckStatusState`
 * lower-cased.
 */
export type CheckRunStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "waiting"
  | "requested"
  | "pending";

/**
 * A completed check run's conclusion: REST `conclusion`, or GraphQL
 * `CheckConclusionState` lower-cased.
 */
export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "startup_failure"
  | "stale";

/**
 * A commit status's state: REST `state`, or GraphQL `StatusState` lower-cased.
 * REST never reports `expected`; GraphQL reports it for a status that branch
 * protection requires and nothing has reported yet.
 */
export type CommitStatusState =
  | "error"
  | "expected"
  | "failure"
  | "pending"
  | "success";

/**
 * One CI result on the PR's head commit. The reader supplies the latest check
 * run per check (REST `GET .../commits/{sha}/check-runs` with its default
 * `filter=latest`, GraphQL `checkRuns` with its default `LATEST` filter) and
 * the latest status per context (REST `GET .../commits/{sha}/status`, GraphQL
 * `status.contexts`), so a re-run or a later status replaces the earlier one.
 * GraphQL's `statusCheckRollup.contexts` gives both kinds in one list.
 */
export type CiResult =
  | {
      readonly kind: "check_run";
      readonly status: CheckRunStatus;
      /** Null until the run completes. */
      readonly conclusion: CheckRunConclusion | null;
    }
  | {
      readonly kind: "commit_status";
      readonly state: CommitStatusState;
    };

/**
 * Mergeability: GraphQL `mergeable` lower-cased (`MERGEABLE`, `CONFLICTING`,
 * `UNKNOWN`), or REST `mergeable` true, false or null respectively.
 */
export type Mergeability = "mergeable" | "conflicting" | "unknown";

/**
 * When things last happened on the PR, for the stale flag and ordering.
 * Review submission times come from `reviews` and are not repeated here.
 */
export interface PrActivity {
  /** REST `created_at`, GraphQL `createdAt`. */
  readonly openedAt: number;
  /**
   * When the head last changed, as near as GitHub lets the reader tell. GitHub
   * reports no push time (`Commit.pushedDate` was deprecated and removed), so
   * this is the later of the latest force-push (GraphQL `timelineItems`,
   * `HEAD_REF_FORCE_PUSHED_EVENT`, `createdAt`) and the head commit's
   * `committedDate`. The committer date is set by the client, so it can be
   * earlier than the push or wrong.
   */
  readonly lastCommitAt: number | null;
  /** The latest issue comment or review comment on the PR. */
  readonly lastCommentAt: number | null;
  /**
   * The latest state change other than opening: the latest `createdAt` among
   * GraphQL `timelineItems` of types `REOPENED_EVENT`,
   * `CONVERT_TO_DRAFT_EVENT` and `READY_FOR_REVIEW_EVENT` (Pull requests
   * read).
   */
  readonly lastStateChangeAt: number | null;
}

/**
 * One open PR and everything the rules need about it. Only open PRs are
 * bucketed; the reader drops closed and merged ones.
 */
export interface PrInput {
  readonly repository: RepositoryRef;
  readonly number: number;
  /** Null when GitHub reports no author, such as a deleted account (ghost). */
  readonly author: Account | null;
  /** REST `draft`, GraphQL `isDraft`. */
  readonly isDraft: boolean;
  /** REST `head.sha`, GraphQL `headRefOid`. */
  readonly headSha: string;
  readonly mergeable: Mergeability;
  readonly ci: readonly CiResult[];
  /**
   * Every review on the PR, in the order GitHub returns them (oldest first,
   * from REST and GraphQL alike). Reviews are ordered by `submittedAt`;
   * reviews submitted at the same millisecond keep this order.
   */
  readonly reviews: readonly Review[];
  /**
   * The current repository permission of each account that has an approval
   * or a request for changes on the PR, keyed by account ID. An account
   * missing from the map is not trusted, so a failed or rate-limited lookup
   * must keep the last known permission rather than leave the account out;
   * otherwise an approved PR would drop out of Ready to land until the next
   * successful lookup.
   */
  readonly reviewerPermissions: ReadonlyMap<number, RepositoryPermission>;
  readonly activity: PrActivity;
}
