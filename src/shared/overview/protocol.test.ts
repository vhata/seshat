import { describe, expect, it } from "vitest";
import { buildSnapshot, fromPrDto, INITIAL_SYNC, parseClientMessage, toPrDto, type PullRequestRecord, type RepositoryRecord } from "./protocol";
import { NOW, pr } from "./testing";

export const repository: RepositoryRecord = {
  id: 12, nodeId: "R_12", installationId: 9, fullName: "vhata/seshat",
  ownerAccountId: 1001, ownerLogin: "vhata", visibility: "private",
  isFork: false, isArchived: false, ownerPermission: "admin",
  monitorOverride: null, monitored: true, listedAt: NOW,
};
export function record(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return { ...pr(), id: 3, nodeId: "PR_3", repositoryId: 12, title: "A PR", url: "https://github.com/vhata/seshat/pull/1", updatedAt: NOW,
    observations: { reviews: [], checks: [] }, ...overrides };
}
describe("overview protocol", () => {
  it("round-trips Maps and unknown activity through JSON", () => {
    const input = record({ activity: { openedAt: NaN, lastCommitAt: NaN, lastCommentAt: null, lastStateChangeAt: null } });
    const dto = JSON.parse(JSON.stringify(toPrDto(input)));
    expect(dto.reviewerPermissions).toEqual([[2002, "write"], [4004, "read"]]);
    const decoded = fromPrDto(dto);
    expect(decoded.reviewerPermissions).toEqual(input.reviewerPermissions);
    expect(Number.isNaN(decoded.activity.openedAt)).toBe(true);
    expect(decoded.activity.lastCommitAt).toBeNull();
    expect(toPrDto(decoded)).toEqual(dto);
  });
  it("derives bucket facts and excludes unmonitored PRs without serializing predicates", () => {
    const snapshot = buildSnapshot([repository, { ...repository, id: 13, monitored: false }], [record(), record({ nodeId: "PR_hidden", repositoryId: 13 })], INITIAL_SYNC, 1001, NOW);
    const wire = JSON.parse(JSON.stringify(snapshot));
    const rows = wire.buckets.flatMap((bucket: { rows: unknown[] }) => bucket.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ facts: { isOwners: false }, pr: { nodeId: "PR_3", title: "A PR" } });
    expect(wire.buckets[0].bucket).not.toHaveProperty("matches");
  });
  it.each([null, {}, "null", "[]", "{", '{"type":"visibility"}', '{"type":"visibility","visible":1}', '{"type":"other","visible":true}', new ArrayBuffer(4)])("refuses malformed client input %j", (input) => {
    expect(parseClientMessage(input)).toBeNull();
  });
  it.each(["visibility", "retry-now", "overdue"])("accepts %s with a visibility report", (type) => {
    expect(parseClientMessage(JSON.stringify({ type, visible: true, reportedAt: -1 }))).toEqual({ type, visible: true });
  });
});

describe("server message decoder", () => {
  it("validates private repository CI records without rejecting legacy snapshots", async () => {
    const { fixtureSnapshot } = await import("./fixtures");
    const { parseServerMessage } = await import("./protocol");
    const snapshot = fixtureSnapshot();
    const ci = { repositoryId: 12, installationId: 9, ownerAccountId: 1001, defaultBranch: "trunk", coverage: "complete" as const, streams: [],
      check: { lastSuccessfulCheckAt: NOW, latestAttempt: null }, issue: null };
    const encode = (repositoryCi: unknown) => JSON.stringify({ type: "snapshot", snapshot: { ...snapshot, repositoryCi } });
    expect(parseServerMessage(encode(undefined))).not.toBeNull();
    expect(parseServerMessage(encode([ci]))).toMatchObject({ snapshot: { repositoryCi: [ci] } });
    for (const repositoryCi of [null, {}, [{ ...ci, repositoryId: 0 }], [{ ...ci, issue: "raw secret" }], [{ ...ci, check: {} }], [{ ...ci, streams: [{ workflowId: 1, name: "CI", state: "active", trigger: "push", pending: null, completed: { id: 1, attempt: 1, number: 1, createdAt: NOW, updatedAt: NOW, startedAt: null, status: "completed", conclusion: "success", headSha: "head", url: "javascript:alert(1)" } }] }]]) {
      expect(parseServerMessage(encode(repositoryCi))).toBeNull();
    }
    expect(buildSnapshot([repository], [], INITIAL_SYNC, 1001, NOW, undefined, [ci, { ...ci, repositoryId: 13 }]).repositoryCi).toEqual([ci]);
    expect(buildSnapshot([{ ...repository, monitored: false }], [], INITIAL_SYNC, 1001, NOW, undefined, [ci]).repositoryCi).toEqual([]);
  });
  it("accepts legacy unknown evidence and validates additive scoped evidence", async () => {
    const { fixtureSnapshot } = await import("./fixtures");
    const { parseServerMessage } = await import("./protocol");
    const snapshot = fixtureSnapshot();
    const evidence = { repositories: { "12": { lastSuccessfulCheckAt: 10, latestAttempt: { id: 1, startedAt: 10, result: "success" } } }, pullRequests: {} };
    const encoded = (freshness: unknown) => JSON.stringify({ type: "snapshot", snapshot: { ...snapshot, freshness } });
    expect(parseServerMessage(encoded(evidence))).toMatchObject({ snapshot: { freshness: evidence } });
    const requested = { ...evidence, repositoryRefreshes: { "12": { lastSuccessfulCheckAt: null, latestAttempt: { id: 2, startedAt: 20, result: "queued" } } } };
    expect(parseServerMessage(encoded(requested))).toMatchObject({ snapshot: { freshness: requested } });
    for (const repositoryRefreshes of [null, [], { "12": { lastSuccessfulCheckAt: null, latestAttempt: { id: 0, startedAt: 20, result: "queued" } } }]) {
      expect(parseServerMessage(encoded({ ...evidence, repositoryRefreshes }))).toBeNull();
    }
    for (const invalid of [null, {}, { ...evidence, pullRequests: [] }, { ...evidence, repositories: { "12": { lastSuccessfulCheckAt: "today", latestAttempt: null } } }, { ...evidence, repositories: { "12": { lastSuccessfulCheckAt: null, latestAttempt: { id: 0, startedAt: 10, result: "success" } } } }]) {
      expect(parseServerMessage(encoded(invalid))).toBeNull();
    }
  });
  it("round-trips snapshots, authoritative bucket changes, and sync updates", async () => {
    const { fixtureSnapshot, SYNC_FIXTURES } = await import("./fixtures");
    const { parseServerMessage } = await import("./protocol");
    const snapshot = fixtureSnapshot();
    const messages = [
      { type: "snapshot", snapshot },
      { type: "pr-changes", buckets: snapshot.buckets, removed: ["PR_gone"], serverTime: NOW },
      { type: "sync", sync: SYNC_FIXTURES.failed, serverTime: NOW },
    ];
    for (const message of messages) expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });
  it("accepts legacy repositories and the additive mute preference but rejects malformed values", async () => {
    const { fixtureSnapshot } = await import("./fixtures");
    const { parseServerMessage } = await import("./protocol");
    const snapshot = fixtureSnapshot();
    for (const muted of [undefined, false, true]) {
      const value = { ...snapshot, repositories: snapshot.repositories.map((repo) => ({ ...repo, muted })) };
      expect(parseServerMessage(JSON.stringify({ type: "snapshot", snapshot: value }))).not.toBeNull();
    }
    for (const muted of [null, "true", 1]) {
      const value = { ...snapshot, repositories: snapshot.repositories.map((repo) => ({ ...repo, muted })) };
      expect(parseServerMessage(JSON.stringify({ type: "snapshot", snapshot: value }))).toBeNull();
    }
  });
  it("rejects wrong versions, raw Maps, invalid permissions, missing facts and bad sync state", async () => {
    const { fixtureSnapshot } = await import("./fixtures");
    const { parseServerMessage } = await import("./protocol");
    const snapshot = fixtureSnapshot();
    const broken = [
      { ...snapshot, version: 2 },
      { ...snapshot, sync: { ...snapshot.sync, intervalMs: 0 } },
      { ...snapshot, buckets: [{ ...snapshot.buckets[0], rows: [{ ...snapshot.buckets[0]!.rows[0], facts: null }] }] },
      { ...snapshot, buckets: [{ ...snapshot.buckets[0], rows: [{ ...snapshot.buckets[0]!.rows[0], pr: { ...snapshot.buckets[0]!.rows[0]!.pr, reviewerPermissions: {} } }] }] },
      { ...snapshot, buckets: [{ ...snapshot.buckets[0], rows: [{ ...snapshot.buckets[0]!.rows[0], pr: { ...snapshot.buckets[0]!.rows[0]!.pr, reviewerPermissions: [[1, "owner"]] } }] }] },
    ];
    for (const bad of broken) expect(parseServerMessage(JSON.stringify({ type: "snapshot", snapshot: bad }))).toBeNull();
    expect(parseServerMessage("pong")).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(8))).toBeNull();
  });
});
