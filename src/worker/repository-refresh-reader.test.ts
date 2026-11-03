import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubPrReader } from "./github-pr-reader";

afterEach(() => { vi.restoreAllMocks(); });
const WHEN = new Date().toISOString();
const owner = { databaseId: 2002, login: "organization", __typename: "Organization" };
const repo = { id: "R_org", databaseId: 12, nameWithOwner: "organization/project", visibility: "PRIVATE", owner };
const connection = (nodes: unknown[]) => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } });
const access = { ownerId: 1001, repositoryOwners: [{ repositoryId: 12, ownerAccountId: 2002 }] };
function rawPr() {
  return { id: "PR_org", databaseId: 3, number: 1, state: "OPEN", title: "New private facts",
    url: "https://github.com/organization/project/pull/1", repository: repo, createdAt: WHEN, updatedAt: WHEN,
    isDraft: false, headRefOid: "new-head", mergeable: "MERGEABLE", author: { databaseId: 1001, login: "example", __typename: "User" },
    reviews: connection([]), commits: { totalCount: 1 }, comments: { nodes: [] }, forcePush: { nodes: [] }, stateChange: { nodes: [] }, statusCheckRollup: { contexts: connection([]) } };
}
function stubGitHub(permission: Response, prs: unknown[] = []) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/graphql") {
      expect(JSON.parse(String(init?.body)).variables).toEqual({ ids: ["R_org"] });
      return Response.json({ data: { nodes: [{ ...repo, pullRequests: connection(prs) }] } });
    }
    if (path === "/user/1001") return Response.json({ id: 1001, login: "renamed-owner" });
    if (path === "/repos/organization/project/collaborators/renamed-owner/permission") return permission.clone();
    if (path === "/repos/organization/project/pulls/1") return Response.json({ head: { sha: "new-head" }, mergeable: false });
    if (path === "/repos/organization/project/pulls/1/commits") return Response.json([{ sha: "new-head", commit: { committer: { date: WHEN } } }]);
    throw new Error(`Unexpected request ${path}`);
  });
}
describe("targeted refresh access and current facts", () => {
  it.each([false, true])("refuses cached organization owner access even with empty=%s and readable App data", async (empty) => {
    const http = stubGitHub(new Response(null, { status: 404 }), empty ? [] : [rawPr()]);
    const reader = new GithubPrReader("synthetic-token", { repositoryAccess: access, refreshPermissions: true, verifyMergeability: true,
      permissionCache: [{ repositoryId: 12, accountId: 1001, login: "old-owner", permission: "admin", etag: "old" }] });
    const result = await reader.readRepositories(["R_org"]);
    expect(result.repositories).toEqual([]);
    expect(result.issues).toEqual([{ nodeId: "R_org", reason: "permission-failed" }]);
    expect(result.status).toBe("failed"); expect(result.requestsUsed).toBe(3);
    expect(http).toHaveBeenCalledTimes(3);
  });
  it("continues owner authorization within the same request budget and observation", async () => {
    const http = stubGitHub(Response.json({ permission: "read", user: { id: 1001 } }));
    const first = await new GithubPrReader("synthetic-token", { repositoryAccess: access, requestLimit: 2 }).readRepositories(["R_org"]);
    expect(first.repositories).toEqual([]); expect(first.requestsUsed).toBe(2); expect(first.continuation).not.toBeNull();
    const second = await new GithubPrReader("synthetic-token", { repositoryAccess: access, requestLimit: 1, continuation: first.continuation }).readRepositories(["R_org"]);
    expect(second.requestsUsed).toBe(1); expect(second.continuation).toBeNull();
    expect(second.repositories).toMatchObject([{ repositoryId: 12, complete: true, prs: [] }]);
    expect(http).toHaveBeenCalledTimes(3);
  });
  it.each([403, 429])("propagates owner permission throttling %s without publishing facts", async (status) => {
    stubGitHub(new Response(null, { status, headers: { "retry-after": "60" } }), [rawPr()]);
    const result = await new GithubPrReader("synthetic-token", { repositoryAccess: access }).readRepositories(["R_org"]);
    expect(result.repositories).toEqual([]);
    expect(result.issues).toEqual([{ nodeId: "R_org", reason: "rate-limited" }]);
    expect(result.continuation).toBeNull();
  });
  it("checks expected numeric ownership before accepting even an empty repository", async () => {
    const http = stubGitHub(Response.json({ permission: "admin", user: { id: 1001 } }));
    const result = await new GithubPrReader("synthetic-token", { repositoryAccess: { ...access, repositoryOwners: [{ repositoryId: 12, ownerAccountId: 1001 }] } }).readRepositories(["R_org"]);
    expect(result.repositories).toEqual([]); expect(result.issues).toEqual([{ nodeId: "R_org", reason: "changed-during-read" }]);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("rechecks known mergeability and owner access while reading current PR facts", async () => {
    stubGitHub(Response.json({ permission: "read", user: { id: 1001 } }), [rawPr()]);
    const result = await new GithubPrReader("synthetic-token", { repositoryAccess: access, refreshPermissions: true, verifyMergeability: true }).readRepositories(["R_org"]);
    expect(result.status).toBe("complete");
    expect(result.repositories[0]?.prs[0]).toMatchObject({ title: "New private facts", mergeable: "conflicting", headSha: "new-head" });
    expect(result.requestsUsed).toBe(5);
  });

  it("stops further HTTP work in the same manual invocation after a throttle", async () => {
    const http = stubGitHub(Response.json({ permission: "read", user: { id: 1001 } }), [rawPr()]);
    const original = http.getMockImplementation()!;
    http.mockImplementation(async (url, init) => new URL(String(url)).pathname === "/repos/organization/project/pulls/1"
      ? new Response(null, { status: 429, headers: { "retry-after": "120" } }) : original(url, init));
    const before = Date.now();
    const result = await new GithubPrReader("synthetic-token", { repositoryAccess: access, refreshPermissions: true, verifyMergeability: true }).readRepositories(["R_org"]);
    expect(result.issues.some((issue) => issue.reason === "rate-limited")).toBe(true);
    expect(result.repositories[0]?.complete).toBe(false);
    expect(result.rateLimit?.retryAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(http).toHaveBeenCalledTimes(4);
    expect(http.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith("/commits"))).toBe(false);
  });
});
