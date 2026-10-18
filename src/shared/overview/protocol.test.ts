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
