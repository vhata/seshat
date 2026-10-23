import { describe, expect, it } from "vitest";
import { fixturePr } from "./fixtures";
import { coalesceFacts, factObserved, reduceDelivery, type DeliveryFact } from "./webhook-marks";

const NOW = Date.now();
const base = { installation: { id: 9 }, repository: { id: 12, owner: { id: 1001 }, visibility: "public" } };
describe("webhook reduction", () => {
  it("keeps marks and observable facts, excluding webhook titles and credentials", () => {
    const reduced = reduceDelivery("pull_request", { ...base, action: "synchronize", secret: "no", pull_request: { node_id: "PR_example", title: "no", head: { sha: "next" }, updated_at: new Date(NOW).toISOString() } }, NOW);
    expect(reduced?.marks).toEqual([{ installationId: 9, repositoryId: 12, nodeId: "PR_example", facts: [{ kind: "head", value: "next", at: NOW }] }]);
    expect(JSON.stringify(reduced)).not.toContain("secret");
    expect(JSON.stringify(reduced)).not.toContain("title");
  });
  it("holds fork check and commit status SHAs independently of missing PR references", () => {
    expect(reduceDelivery("check_run", { ...base, check_run: { id: 7, head_sha: "head", status: "completed", conclusion: "failure", pull_requests: [] } }, NOW)?.sha).toMatchObject({ value: "head", repositoryId: 12, facts: [{ kind: "check", id: "7", state: "completed" }] });
    expect(reduceDelivery("status", { ...base, sha: "head", context: "CI", state: "success" }, NOW)?.sha?.facts).toEqual([{ kind: "status", sha: "head", name: "CI", state: "success", at: NOW }]);
  });
  it("requests guard and discovery for installation changes, and treats unknown visibility as private", () => {
    expect(reduceDelivery("installation", { installation: { id: 9 } }, NOW)).toMatchObject({ guard: true, refresh: true });
    expect(reduceDelivery("repository", { ...base, repository: { id: 12 }, action: "transferred" }, NOW)?.repository).toMatchObject({ visibility: "private", transferred: true });
    expect(reduceDelivery("ping", {}, NOW)).toBeNull();
  });
  it("coalesces out-of-order checks without reverting a completed observation", () => {
    const completed: DeliveryFact = { kind: "check", id: "7", state: "completed", conclusion: "success", sha: "head", at: NOW };
    expect(coalesceFacts([completed], [{ ...completed, state: "in_progress", conclusion: null }])).toEqual([completed]);
  });
  it("accepts later check states, retired heads and dismissed reviews", () => {
    const pr = fixturePr({ headSha: "next", observations: { reviews: [{ id: "3", state: "dismissed", commitSha: null }], checks: [] } });
    expect(factObserved({ kind: "check", id: "7", state: "queued", conclusion: null, sha: "old", at: NOW }, { kind: "open", pr }, undefined)).toBe(true);
    expect(factObserved({ kind: "review", id: "3", state: "approved", at: NOW }, { kind: "open", pr }, undefined)).toBe(true);
  });
});
