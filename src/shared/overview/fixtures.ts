/** Deterministic, token-free fixtures for page development and integration. */
import { buildSnapshot, INITIAL_SYNC, type PullRequestRecord, type RepositoryRecord, type SyncStatus } from "./protocol";

export const FIXTURE_NOW = Date.UTC(2026, 9, 17, 12);
export const FIXTURE_OWNER_ID = 1001;
export const FIXTURE_REPOSITORY: RepositoryRecord = {
  id: 12, nodeId: "R_example", installationId: 9,
  fullName: "example/observatory", ownerAccountId: FIXTURE_OWNER_ID,
  ownerLogin: "example", visibility: "public", isFork: false,
  isArchived: false, ownerPermission: "admin", monitored: true,
  monitorOverride: null, listedAt: FIXTURE_NOW,
};
export function fixturePr(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    id: 3, nodeId: "PR_example", repositoryId: FIXTURE_REPOSITORY.id,
    repository: { fullName: FIXTURE_REPOSITORY.fullName, ownerAccountId: FIXTURE_OWNER_ID },
    number: 1, title: "Keep the overview current", url: "https://github.com/example/observatory/pull/1",
    author: { id: FIXTURE_OWNER_ID, login: "example", isBot: false },
    isDraft: false, headSha: "a".repeat(40), mergeable: "mergeable",
    ci: [], reviews: [], reviewerPermissions: new Map(),
    activity: { openedAt: FIXTURE_NOW - 86_400_000, lastCommitAt: FIXTURE_NOW - 3_600_000, lastCommentAt: null, lastStateChangeAt: null },
    updatedAt: FIXTURE_NOW - 3_600_000, observations: { reviews: [], checks: [] },
    ...overrides,
  };
}
export const SYNC_FIXTURES = {
  initial: INITIAL_SYNC,
  checking: { ...INITIAL_SYNC, latestAttempt: { startedAt: FIXTURE_NOW, result: "running" } },
  live: { ...INITIAL_SYNC, lastSuccessfulSweepAt: FIXTURE_NOW - 30_000, latestAttempt: { startedAt: FIXTURE_NOW - 30_000, result: "success" } },
  overdue: { ...INITIAL_SYNC, lastSuccessfulSweepAt: FIXTURE_NOW - 360_000, latestAttempt: { startedAt: FIXTURE_NOW - 360_000, result: "success" } },
  failed: { ...INITIAL_SYNC, latestAttempt: { startedAt: FIXTURE_NOW - 15_000, result: "failed", reason: "github-unavailable", unreadableRepositoryIds: [12] } },
  rateLimited: { ...INITIAL_SYNC, intervalMs: 240_000, slowedByRateLimit: true, lastSuccessfulSweepAt: FIXTURE_NOW - 30_000 },
} satisfies Record<string, SyncStatus>;
export function fixtureSnapshot(sync: SyncStatus = SYNC_FIXTURES.live) {
  return buildSnapshot([FIXTURE_REPOSITORY], [fixturePr()], sync, FIXTURE_OWNER_ID, FIXTURE_NOW);
}
