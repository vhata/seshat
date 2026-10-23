import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubRepositoryListing, REPOSITORY_PAGES } from "./github-repositories";
import { json, OWNER_ID, stubGitHub } from "./test-helpers";

export function listedRepository(id: number, changes: Record<string, unknown> = {}) {
  return { id, node_id: `R_${id}`, full_name: `owner/repo-${id}`, owner: { id: OWNER_ID, login: "owner" }, visibility: "public", fork: false, archived: false, ...changes };
}
const LIST = "GET https://api.github.com/installation/repositories";
afterEach(() => vi.restoreAllMocks());

describe("installation repository listings", () => {
  it("uses an installation token and 100-entry pages, returning stable IDs and visibility", async () => {
    const github = stubGitHub({ [LIST]: (call) => {
      expect(call.headers.get("authorization")).toBe("Bearer installation-token");
      expect(call.url.searchParams.get("per_page")).toBe("100");
      return json({ total_count: 101, repositories: Number(call.url.searchParams.get("page")) === 1 ? Array.from({ length: 100 }, (_, index) => listedRepository(index + 1)) : [listedRepository(101, { visibility: "internal" })] });
    } });
    const result = await new GitHubRepositoryListing().list("installation-token", 10);
    expect(result.ok && result.repositories.length).toBe(101);
    expect(result.ok && result.repositories[100]).toMatchObject({ id: 101, nodeId: "R_101", visibility: "internal" });
    expect(github.calls).toHaveLength(2);
  });
  it("retains complete page bodies for 304 and does not assume page one validates later pages", async () => {
    let conditional = false;
    stubGitHub({ [LIST]: (call) => {
      const page = Number(call.url.searchParams.get("page"));
      if (conditional) {
        expect(call.headers.get("if-none-match")).toBe(`"page-${page}"`);
        return new Response(null, { status: 304 });
      }
      const response = json({ total_count: 101, repositories: page === 1 ? Array.from({ length: 100 }, (_, index) => listedRepository(index + 1)) : [listedRepository(101)] });
      response.headers.set("etag", `"page-${page}"`); return response;
    } });
    const listing = new GitHubRepositoryListing();
    const first = await listing.list("token", 10);
    expect(first.ok).toBe(true);
    conditional = true;
    expect(await listing.list("token", 10)).toEqual(first);
  });
  it("does not replace the conditional cache on a failed later page", async () => {
    let attempt = 0;
    stubGitHub({ [LIST]: (call) => {
      const page = Number(call.url.searchParams.get("page"));
      if (attempt === 1 && page === 2) return json({}, 500);
      if (attempt === 2) {
        expect(call.headers.get("if-none-match")).toBe(`"original-${page}"`);
        return new Response(null, { status: 304 });
      }
      const response = json({ total_count: 101, repositories: page === 1 ? Array.from({ length: 100 }, (_, index) => listedRepository(index + 1)) : [listedRepository(101)] });
      response.headers.set("etag", `"${attempt === 0 ? "original" : "changed"}-${page}"`); return response;
    } });
    const listing = new GitHubRepositoryListing(); const first = await listing.list("token", 10);
    expect(first.ok).toBe(true);
    attempt = 1; expect((await listing.list("token", 10)).ok).toBe(false);
    attempt = 2; expect(await listing.list("token", 10)).toEqual(first);
  });
  for (const [name, body] of [
    ["short partial page", { total_count: 2, repositories: [listedRepository(1)] }],
    ["duplicate IDs", { total_count: 2, repositories: [listedRepository(1), listedRepository(1)] }],
    ["malformed repository", { total_count: 1, repositories: [listedRepository(1, { visibility: undefined })] }],
    ["malformed total", { total_count: -1, repositories: [] }],
  ] as const) it(`rejects a ${name}`, async () => {
    stubGitHub({ [LIST]: () => json(body) });
    expect(await new GitHubRepositoryListing().list("token", 10)).toEqual({ ok: false, reason: "github-unavailable" });
  });
  it("fails explicitly when the page cap leaves repositories unread", async () => {
    const github = stubGitHub({ [LIST]: (call) => json({ total_count: REPOSITORY_PAGES * 100 + 1, repositories: Array.from({ length: 100 }, (_, index) => listedRepository(Number(call.url.searchParams.get("page")) * 100 + index + 1)) }) });
    expect((await new GitHubRepositoryListing().list("token", 10)).ok).toBe(false);
    expect(github.calls).toHaveLength(REPOSITORY_PAGES);
  });
  it("fails when total_count changes between pages", async () => {
    stubGitHub({ [LIST]: (call) => json(Number(call.url.searchParams.get("page")) === 1 ? { total_count: 101, repositories: Array.from({ length: 100 }, (_, index) => listedRepository(index + 1)) } : { total_count: 102, repositories: [listedRepository(101), listedRepository(102)] }) });
    expect((await new GitHubRepositoryListing().list("token", 10)).ok).toBe(false);
  });
  for (const status of [401, 404, 429, 500]) it(`distinguishes HTTP ${status}`, async () => {
    stubGitHub({ [LIST]: () => json({}, status) });
    expect(await new GitHubRepositoryListing().list("token", 10)).toEqual({ ok: false, reason: status === 401 || status === 404 ? "installation-removed" : status === 429 ? "rate-limited" : "github-unavailable" });
  });
  it("checks the owner's identity and own collaborator permission rather than installation permissions", async () => {
    stubGitHub({
      [`GET https://api.github.com/user/${OWNER_ID}`]: () => json({ id: OWNER_ID, login: "owner" }),
      "GET https://api.github.com/repos/org/repo/collaborators/owner/permission": () => json({ permission: "read", user: { id: OWNER_ID } }),
    });
    const listing = new GitHubRepositoryListing();
    expect(await listing.ownerLogin("token", OWNER_ID)).toBe("owner");
    expect(await listing.ownerPermission("token", { id: 4, nodeId: "R4", fullName: "org/repo", ownerAccountId: 9, ownerLogin: "org", visibility: "private", isFork: false, isArchived: false }, OWNER_ID, "owner")).toBe("read");
  });
});
