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
    /** Stringified GitHub database ID, matching webhook review.id. */
    readonly id: string;
    readonly state: ReviewSubmissionState;
    readonly commitSha: string | null;
  }[];
  readonly checks: readonly {
    /** Stringified database ID; commit statuses also match by name/head. */
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
  readonly ownerId: number;
  readonly serverTime: number;
  readonly repositories: readonly RepositoryRecord[];
  readonly buckets: readonly OverviewBucketDto[];
  readonly sync: SyncStatus;
}
export type ServerMessage =
  | { readonly type: "snapshot"; readonly snapshot: OverviewSnapshot }
  | { readonly type: "pr-changes"; readonly buckets: readonly OverviewBucketDto[]; readonly removed: readonly string[]; readonly serverTime: number }
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
    ownerId,
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

export type InstallationRefreshResult =
  | { readonly ok: true; readonly changed: boolean; readonly repositoryIds: readonly number[] }
  | { readonly ok: false; readonly reason: Exclude<SyncFailureReason, "cloudflare-quota"> };
export type MonitoringMutationResult =
  | { readonly ok: true; readonly repository: RepositoryRecord }
  | { readonly ok: false; readonly reason: "not-found" | "not-allowed" };
/** Selection owns these operations; sync consumes the complete-list refresh. */
export interface RepositorySelectionOperations {
  refreshInstallation(installationId: number, now: number): Promise<InstallationRefreshResult>;
  setMonitoringOverride(repositoryId: number, override: boolean | null, now: number): Promise<MonitoringMutationResult>;
}

const PERMISSIONS = ["admin", "maintain", "write", "triage", "read", "none"];
const REVIEW_STATES = ["approved", "changes_requested", "commented", "dismissed", "pending"];
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function id(value: unknown): value is number {
  return number(value) && Number.isSafeInteger(value) && value > 0;
}
function time(value: unknown): value is number | null { return value === null || number(value); }
function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === "string" && choices.includes(value);
}
function array(value: unknown, check: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(check);
}
function account(value: unknown): boolean {
  return value === null || (object(value) && id(value.id) && typeof value.login === "string" && typeof value.isBot === "boolean");
}
function repositoryRecord(value: unknown): boolean {
  return object(value) && id(value.id) && typeof value.nodeId === "string"
    && id(value.installationId) && id(value.ownerAccountId)
    && typeof value.fullName === "string" && typeof value.ownerLogin === "string"
    && oneOf(value.visibility, ["public", "private", "internal"])
    && typeof value.isFork === "boolean" && typeof value.isArchived === "boolean"
    && oneOf(value.ownerPermission, PERMISSIONS)
    && (value.monitorOverride === null || typeof value.monitorOverride === "boolean")
    && typeof value.monitored === "boolean" && number(value.listedAt);
}
/** Shared storage and socket decoder rejects malformed JSON before a Map is made. */
export function isPrDto(value: unknown): value is PrDto {
  if (!object(value) || !object(value.repository) || !object(value.activity) || !object(value.observations)) return false;
  return id(value.id) && typeof value.nodeId === "string" && id(value.repositoryId)
    && typeof value.title === "string" && typeof value.url === "string" && id(value.number)
    && typeof value.repository.fullName === "string" && id(value.repository.ownerAccountId)
    && account(value.author) && typeof value.isDraft === "boolean" && typeof value.headSha === "string"
    && oneOf(value.mergeable, ["mergeable", "conflicting", "unknown"]) && time(value.updatedAt)
    && [value.activity.openedAt, value.activity.lastCommitAt, value.activity.lastCommentAt, value.activity.lastStateChangeAt].every(time)
    && array(value.reviewerPermissions, (entry) => Array.isArray(entry) && entry.length === 2 && id(entry[0]) && oneOf(entry[1], PERMISSIONS))
    && array(value.reviews, (entry) => object(entry) && account(entry.author) && oneOf(entry.state, REVIEW_STATES)
      && (entry.commitSha === null || typeof entry.commitSha === "string") && time(entry.submittedAt))
    && array(value.ci, (entry) => object(entry) && (
      entry.kind === "commit_status" ? oneOf(entry.state, ["error", "expected", "failure", "pending", "success"])
        : entry.kind === "check_run" && oneOf(entry.status, ["queued", "in_progress", "completed", "waiting", "requested", "pending"])
          && (entry.conclusion === null || oneOf(entry.conclusion, ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "startup_failure", "stale"]))))
    && array(value.observations.reviews, (entry) => object(entry) && typeof entry.id === "string"
      && oneOf(entry.state, REVIEW_STATES) && (entry.commitSha === null || typeof entry.commitSha === "string"))
    && array(value.observations.checks, (entry) => object(entry) && typeof entry.id === "string"
      && oneOf(entry.kind, ["check_run", "commit_status"]) && typeof entry.state === "string"
      && (entry.conclusion === null || typeof entry.conclusion === "string") && typeof entry.name === "string");
}
function syncStatus(value: unknown): boolean {
  if (!object(value) || !time(value.lastSuccessfulSweepAt) || !number(value.intervalMs)
    || value.intervalMs <= 0 || typeof value.slowedByRateLimit !== "boolean") return false;
  const attempt = value.latestAttempt;
  return attempt === null || (object(attempt) && number(attempt.startedAt)
    && (oneOf(attempt.result, ["running", "success"]) || (attempt.result === "failed"
      && oneOf(attempt.reason, ["github-unavailable", "rate-limited", "installation-suspended", "installation-removed", "cloudflare-quota"])
      && array(attempt.unreadableRepositoryIds, id))));
}
function bucket(value: unknown): boolean {
  return object(value) && object(value.bucket) && oneOf(value.bucket.id, ["ready-to-land", "broken", "awaiting-your-review", "changes-requested-on-yours", "ci-running", "waiting-on-the-author", "draft"])
    && oneOf(value.bucket.group, ["needs-you", "waiting"]) && typeof value.bucket.title === "string"
    && array(value.rows, (row) => object(row) && isPrDto(row.pr) && time(row.lastActivityAt) && typeof row.stale === "boolean"
      && object(row.facts) && typeof row.facts.isOwners === "boolean" && typeof row.facts.isDraft === "boolean"
      && oneOf(row.facts.ci, ["passing", "failing", "pending", "none"])
      && oneOf(row.facts.mergeable, ["mergeable", "conflicting", "unknown"])
      && oneOf(row.facts.reviewState, ["approved", "changes_requested", "none"])
      && typeof row.facts.ownerReviewedHead === "boolean");
}
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const message: unknown = JSON.parse(data);
    if (!object(message)) return null;
    if (message.type === "snapshot") {
      const snapshot = message.snapshot;
      if (!object(snapshot) || snapshot.version !== 1 || !id(snapshot.ownerId) || !number(snapshot.serverTime)
        || !array(snapshot.repositories, repositoryRecord) || !array(snapshot.buckets, bucket)
        || !syncStatus(snapshot.sync)) return null;
    } else if (message.type === "pr-changes") {
      if (!number(message.serverTime) || !array(message.buckets, bucket)
        || !array(message.removed, (entry) => typeof entry === "string")) return null;
    } else if (message.type === "sync") {
      if (!number(message.serverTime) || !syncStatus(message.sync)) return null;
    } else return null;
    return message as unknown as ServerMessage;
  } catch { return null; }
}
