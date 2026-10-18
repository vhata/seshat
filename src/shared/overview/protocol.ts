import type { BucketGroup, BucketId, PrFacts } from "./buckets";
import { buildOverview } from "./overview";
import type { PrInput, RepositoryPermission, ReviewSubmissionState } from "./types";

/** The private owner protocol. Non-public GitHub visibility stays private. */
export type RepositoryVisibility = "public" | "private" | "internal";
export interface RepositoryRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly installationId: number;
  readonly fullName: string;
  readonly ownerAccountId: number;
  readonly ownerLogin: string;
  readonly visibility: RepositoryVisibility;
  readonly isFork: boolean;
  readonly isArchived: boolean;
  readonly ownerPermission: RepositoryPermission;
  readonly monitorOverride: boolean | null;
  readonly monitored: boolean;
  readonly listedAt: number;
}

/** Facts used to verify that a re-read has caught up with a delivery. */
export interface PrObservations {
  readonly reviews: readonly {
    readonly id: string;
    readonly state: ReviewSubmissionState;
    readonly commitSha: string | null;
  }[];
  readonly checks: readonly {
    readonly id: string;
    readonly kind: "check_run" | "commit_status";
    readonly state: string;
    readonly conclusion: string | null;
    readonly name: string;
  }[];
}

/** Reader and store share one representation of a fully read open PR. */
export interface PullRequestRecord extends PrInput {
  readonly id: number;
  readonly nodeId: string;
  readonly repositoryId: number;
  readonly title: string;
  readonly url: string;
  readonly updatedAt: number;
  readonly observations: PrObservations;
}

export type SyncFailureReason =
  | "github-unavailable"
  | "rate-limited"
  | "installation-suspended"
  | "installation-removed"
  | "cloudflare-quota";
export type SweepAttempt =
  | { readonly startedAt: number; readonly result: "running" | "success" }
  | {
      readonly startedAt: number;
      readonly result: "failed";
      readonly reason: SyncFailureReason;
      readonly unreadableRepositoryIds: readonly number[];
    };
export interface SyncStatus {
  readonly lastSuccessfulSweepAt: number | null;
  readonly latestAttempt: SweepAttempt | null;
  readonly intervalMs: number;
  readonly slowedByRateLimit: boolean;
}
export const INITIAL_SYNC: SyncStatus = {
  lastSuccessfulSweepAt: null,
  latestAttempt: null,
  intervalMs: 120_000,
  slowedByRateLimit: false,
};

/** Explicit wire/storage shape: null means an unknown, non-finite time. */
export type PrDto = Omit<PullRequestRecord, "reviewerPermissions" | "activity" | "reviews" | "updatedAt"> & {
  readonly reviewerPermissions: readonly (readonly [number, RepositoryPermission])[];
  readonly activity: {
    readonly openedAt: number | null;
    readonly lastCommitAt: number | null;
    readonly lastCommentAt: number | null;
    readonly lastStateChangeAt: number | null;
  };
  readonly reviews: readonly (Omit<PrInput["reviews"][number], "submittedAt"> & {
    readonly submittedAt: number | null;
  })[];
  readonly updatedAt: number | null;
};

export interface OverviewRowDto {
  readonly pr: PrDto;
  readonly facts: PrFacts;
  readonly lastActivityAt: number | null;
  readonly stale: boolean;
}
export interface OverviewBucketDto {
  readonly bucket: { readonly id: BucketId; readonly group: BucketGroup; readonly title: string };
  readonly rows: readonly OverviewRowDto[];
}
export interface OverviewSnapshot {
  readonly version: 1;
  readonly serverTime: number;
  readonly repositories: readonly RepositoryRecord[];
  readonly buckets: readonly OverviewBucketDto[];
  readonly sync: SyncStatus;
}
export type ServerMessage =
  | { readonly type: "snapshot"; readonly snapshot: OverviewSnapshot }
  | { readonly type: "pr-changes"; readonly changed: readonly PrDto[]; readonly removed: readonly string[]; readonly serverTime: number }
  | { readonly type: "sync"; readonly sync: SyncStatus; readonly serverTime: number };
export type ClientMessage = {
  readonly type: "visibility" | "retry-now" | "overdue";
  readonly visible: boolean;
};
export interface SocketAttachment {
  readonly sessionKey: string;
  readonly expiresAt: number;
  readonly visibility: { readonly visible: boolean; readonly reportedAt: number } | null;
}
export const SOCKET_PATH = "/api/overview/socket";
export const SNAPSHOT_PATH = "/api/overview";
export const KEEP_ALIVE_REQUEST = "ping";
export const KEEP_ALIVE_RESPONSE = "pong";

function finite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}
export function toPrDto(pr: PullRequestRecord): PrDto {
  return {
    ...pr,
    updatedAt: finite(pr.updatedAt),
    reviewerPermissions: [...pr.reviewerPermissions].sort(([a], [b]) => a - b),
    activity: {
      openedAt: finite(pr.activity.openedAt),
      lastCommitAt: finite(pr.activity.lastCommitAt),
      lastCommentAt: finite(pr.activity.lastCommentAt),
      lastStateChangeAt: finite(pr.activity.lastStateChangeAt),
    },
    reviews: pr.reviews.map((review) => ({ ...review, submittedAt: finite(review.submittedAt) })),
  };
}
export function fromPrDto(pr: PrDto): PullRequestRecord {
  return {
    ...pr,
    updatedAt: pr.updatedAt ?? NaN,
    reviewerPermissions: new Map(pr.reviewerPermissions),
    activity: { ...pr.activity, openedAt: pr.activity.openedAt ?? NaN },
  };
}

/** Build rules run in one place; executable bucket predicates never cross JSON. */
export function buildSnapshot(
  repositories: readonly RepositoryRecord[],
  prs: readonly PullRequestRecord[],
  sync: SyncStatus,
  ownerId: number,
  now: number,
): OverviewSnapshot {
  const monitored = new Set(repositories.filter((repo) => repo.monitored).map((repo) => repo.id));
  return {
    version: 1,
    serverTime: now,
    repositories,
    buckets: buildOverview(prs.filter((pr) => monitored.has(pr.repositoryId)), { ownerId, now })
      .map(({ bucket, rows }) => ({
        bucket: { id: bucket.id, group: bucket.group, title: bucket.title },
        rows: rows.map((row) => ({
          pr: toPrDto(row.pr), facts: row.facts,
          lastActivityAt: finite(row.lastActivityAt), stale: row.stale,
        })),
      })),
    sync,
  };
}

/** Client timestamps are not trusted; the object timestamps accepted reports. */
export function parseClientMessage(data: unknown): ClientMessage | null {
  if (typeof data !== "string" || data.length > 1024) return null;
  try {
    const value: unknown = JSON.parse(data);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const message = value as Record<string, unknown>;
    if (!(["visibility", "retry-now", "overdue"] as unknown[]).includes(message.type)
      || typeof message.visible !== "boolean") return null;
    return { type: message.type as ClientMessage["type"], visible: message.visible };
  } catch {
    return null;
  }
}
