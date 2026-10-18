import { describe, expect, it, vi } from "vitest";
import { GithubPrReader, type ReaderContinuation } from "./github-pr-reader";
import { CHECK_PAGE_QUERY, COUNT_QUERY, PR_FIELDS, REPOSITORIES_QUERY, REREAD_QUERY } from "./github-pr-queries";

const WHEN = "2026-10-17T00:00:00Z";
const RATE = { remaining: 4900, resetAt: "2026-10-17T01:00:00Z", cost: 1 };
const actor = (id = 2, typename = "User") => ({ databaseId: id, login: `user${id}`, __typename: typename });
const tail = (at: string | null = null) => ({ nodes: at ? [{ createdAt: at }] : [] });
const connection = (nodes: unknown[], totalCount = nodes.length, next: string | null = null) => ({
  nodes, totalCount, pageInfo: { hasNextPage: next !== null, endCursor: next },
});
const repo = (id = "R1") => ({ id, databaseId: Number(id.slice(1)), nameWithOwner: `owner/repo${id}`, visibility: "PUBLIC", owner: { databaseId: 1, login: "owner" } });
const review = (id = 1, state = "COMMENTED", user: ReturnType<typeof actor> | null = actor()) => ({
  id: `REV${id}`, databaseId: id, state, submittedAt: WHEN, commit: { oid: "head" }, author: user, comments: tail(),
});
const check = (id = 1) => ({ __typename: "CheckRun", id: `CHK${id}`, databaseId: id, name: `check${id}`, status: "COMPLETED", conclusion: "SUCCESS" });
function pr(id = "P1", overrides: Record<string, unknown> = {}) {
  return { id, databaseId: Number(id.slice(1)), number: Number(id.slice(1)), state: "OPEN", title: "A change", url: `https://github.com/owner/repo/pull/${id.slice(1)}`,
    createdAt: WHEN, updatedAt: WHEN, isDraft: false, headRefOid: "head", mergeable: "MERGEABLE", author: actor(), repository: repo(),
    comments: tail(), forcePush: tail(), stateChange: tail(), reviews: connection([]), commits: { totalCount: 1 }, statusCheckRollup: { contexts: connection([]) }, ...overrides };
}
function github(handler: (query: string, variables: Record<string, unknown>) => unknown, rest?: (url: string, init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/graphql")) {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      const value = handler(request.query, request.variables);
      if (value instanceof Response) return value;
      return Response.json({ data: { rateLimit: RATE, ...value as object } });
    }
    if (String(url).includes("/commits?")) return Response.json([{ sha: "head", commit: { committer: { date: WHEN } } }]);
    if (rest) return rest(String(url), init);
    throw new Error("Unexpected REST request");
  });
}

describe("PR counts", () => {
  it("counts by repository node ID, reports visibility and batches at 100", async () => {
    const calls = github((query, variables) => {
      expect(query).toBe(COUNT_QUERY);
      const ids = variables.ids as string[];
      expect(ids.length).toBeLessThanOrEqual(100);
      return { nodes: ids.map((nodeId) => ({ ...repo(nodeId), visibility: "INTERNAL", pullRequests: { totalCount: 0 } })) };
    });
    const result = await new GithubPrReader("token").countOpenPrs(Array.from({ length: 101 }, (_, i) => `R${i + 1}`));
    expect(result.status).toBe("complete");
    expect(result.repositories).toHaveLength(101);
    expect(result.repositories[0]).toMatchObject({ count: 0, visibility: "internal" });
    expect(result.rateLimit).toEqual({ remaining: 4900, resetAt: Date.parse(RATE.resetAt), cost: 1 });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("keeps unavailable nodes separate from a confirmed empty repository", async () => {
    github(() => ({ nodes: [null, { ...repo("R2"), pullRequests: { totalCount: 0 } }] }));
    const result = await new GithubPrReader("token").countOpenPrs(["R1", "R2"]);
    expect(result.status).toBe("partial");
    expect(result.issues).toEqual([{ nodeId: "R1", reason: "unavailable" }]);
    expect(result.repositories.map((item) => item.nodeId)).toEqual(["R2"]);
  });

  it("rejects a GraphQL partial error instead of treating missing data as no PRs", async () => {
    github(() => Response.json({ data: { rateLimit: RATE, nodes: [null] }, errors: [{ message: "permission denied" }] }));
    const result = await new GithubPrReader("token").countOpenPrs(["R1"]);
    expect(result.status).toBe("failed");
    expect(result.repositories).toEqual([]);
    expect(result.issues[0]?.reason).toBe("graphql-errors");
    expect(result.rateLimit?.remaining).toBe(4900);
  });
});

describe("shared PR mapping", () => {
  it("maps all row facts, review/check identifiers, activity and ghost/bot authors", async () => {
    github((query) => {
      expect(query).toBe(REREAD_QUERY);
      return { nodes: [pr("P1", {
        author: actor(3, "Bot"), reviews: connection([review(12, "APPROVED", actor(1)), review(13, "COMMENTED", null)]),
        comments: tail("2026-10-17T01:00:00Z"), forcePush: tail("2026-10-17T02:00:00Z"), stateChange: tail("2026-10-17T03:00:00Z"),
        statusCheckRollup: { contexts: connection([check(45), { __typename: "StatusContext", id: "SC1", context: "deploy", state: "PENDING" }]) },
      })] };
    });
    const result = await new GithubPrReader("token").rereadPrs(["P1"]);
    expect(result.status).toBe("complete");
    const node = result.nodes[0];
    expect(node?.kind).toBe("open");
    if (node?.kind !== "open") return;
    expect(node.pr).toMatchObject({ title: "A change", repositoryId: 1, author: { id: 3, isBot: true },
      activity: { openedAt: Date.parse(WHEN), lastCommitAt: Date.parse("2026-10-17T02:00:00Z"), lastCommentAt: Date.parse("2026-10-17T01:00:00Z"), lastStateChangeAt: Date.parse("2026-10-17T03:00:00Z") } });
    expect(node.pr.observations).toEqual({
      reviews: [{ id: "12", state: "approved", commitSha: "head" }, { id: "13", state: "commented", commitSha: "head" }],
      checks: [{ id: "45", kind: "check_run", state: "completed", conclusion: "success", name: "check45" }, { id: "SC1", kind: "commit_status", state: "pending", conclusion: null, name: "deploy" }],
    });
    expect(node.pr.reviewerPermissions.get(1)).toBe("admin");
    expect(node.pr.reviews[1]?.author).toBeNull();
  });

  it("reads every review/check page and includes inline review comments in last activity", async () => {
    const firstReviews = Array.from({ length: 30 }, (_, i) => review(i + 1));
    const firstChecks = Array.from({ length: 50 }, (_, i) => check(i + 1));
    const finalReview = { ...review(31), comments: tail("2026-10-18T00:00:00Z") };
    github((query, variables) => {
      if (query.includes("query SeshatReviewPage")) {
        expect(variables.after).toBe("reviews-after");
        return { node: { id: "P1", headRefOid: "head", reviews: connection([finalReview], 31) } };
      }
      if (query === CHECK_PAGE_QUERY) return { node: { id: "P1", headRefOid: "head", statusCheckRollup: { contexts: connection([check(51)], 51) } } };
      return { nodes: [pr("P1", { reviews: connection(firstReviews, 31, "reviews-after"), statusCheckRollup: { contexts: connection(firstChecks, 51, "checks-after") } })] };
    });
    const result = await new GithubPrReader("token").rereadPrs(["P1"]);
    expect(result.status).toBe("complete");
    const node = result.nodes[0];
    if (node?.kind !== "open") throw new Error("expected PR");
    expect(node.pr.reviews).toHaveLength(31);
    expect(node.pr.observations.reviews.map((item) => item.id)).toEqual(Array.from({ length: 31 }, (_, i) => String(i + 1)));
    expect(node.pr.ci).toHaveLength(51);
    expect(node.pr.activity.lastCommentAt).toBe(Date.parse("2026-10-18T00:00:00Z"));
    expect(result.requestsUsed).toBe(4);
  });

  it("refuses partial, duplicate or head-changing nested pages", async () => {
    for (const variant of ["missing", "duplicate", "changed"]) {
      github((query) => {
        if (query.includes("query SeshatReviewPage")) return { node: { id: "P1", headRefOid: variant === "changed" ? "new-head" : "head", reviews: connection([review(1)], 2) } };
        return { nodes: [pr("P1", { reviews: connection([review(1)], 2, variant === "missing" ? null : "after") })] };
      });
      const result = await new GithubPrReader("token").rereadPrs(["P1"]);
      expect(result.status).toBe("failed");
      expect(result.nodes[0]?.kind).toBe("unavailable");
      expect(result.issues[0]?.reason).toBe(variant === "changed" ? "changed-during-read" : "malformed");
    }
  });

  it("distinguishes confirmed closed and merged PRs from inaccessible nodes", async () => {
    github(() => ({ nodes: [pr("P1", { state: "CLOSED" }), pr("P2", { state: "MERGED" }), null] }));
    const result = await new GithubPrReader("token").rereadPrs(["P1", "P2", "P3"]);
    expect(result.nodes).toEqual([
      { kind: "closed", nodeId: "P1", repositoryId: 1, number: 1 },
      { kind: "merged", nodeId: "P2", repositoryId: 1, number: 2 },
      { kind: "unavailable", nodeId: "P3", reason: "unavailable" },
    ]);
  });

  it("uses REST to start UNKNOWN computation, accepting a result only for the same head", async () => {
    let restSha = "head";
    github(() => ({ nodes: [pr("P1", { mergeable: "UNKNOWN" })] }), (url) => {
      expect(url).toBe("https://api.github.com/repos/owner/repoR1/pulls/1");
      return Response.json({ mergeable: false, head: { sha: restSha } });
    });
    const first = await new GithubPrReader("token").rereadPrs(["P1"]);
    expect(first.nodes[0]?.kind === "open" && first.nodes[0].pr.mergeable).toBe("conflicting");
    restSha = "newer";
    const second = await new GithubPrReader("token").rereadPrs(["P1"]);
    expect(second.nodes[0]?.kind === "open" && second.nodes[0].pr.mergeable).toBe("unknown");
  });

  it("preserves permission during errors, deduplicates pairs, and refreshes with an ETag", async () => {
    const permission = { repositoryId: 1, accountId: 2, login: "user2", permission: "write" as const, etag: '"old"' };
    let permissionCalls = 0;
    github(() => ({ nodes: [pr("P1", { reviews: connection([review(1, "APPROVED")]) }), pr("P2", { reviews: connection([review(2, "CHANGES_REQUESTED")]) })] }), (_url, init) => {
      permissionCalls++;
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"old"');
      return Response.json({}, { status: 500 });
    });
    const result = await new GithubPrReader("token", { permissionCache: [permission], refreshPermissions: true }).rereadPrs(["P1", "P2"]);
    expect(result.status).toBe("partial");
    expect(permissionCalls).toBe(1);
    for (const node of result.nodes) expect(node.kind === "open" && node.pr.reviewerPermissions.get(2)).toBe("write");
    expect(result.permissionCache).toEqual([permission]);
  });

  it("ignores bot approvals for permissions and supports nullable CI and deleted authors", async () => {
    github(() => ({ nodes: [pr("P1", { author: null, reviews: connection([review(1, "APPROVED", actor(3, "Bot"))]), statusCheckRollup: null })] }));
    const result = await new GithubPrReader("token").rereadPrs(["P1"]);
    expect(result.requestsUsed).toBe(2);
    const node = result.nodes[0];
    expect(node?.kind === "open" && node.pr.author).toBeNull();
    expect(node?.kind === "open" && node.pr.ci).toEqual([]);
  });

  it("rejects unrecognized check/review states rather than silently reporting a good PR", async () => {
    github(() => ({ nodes: [pr("P1", { statusCheckRollup: { contexts: connection([{ ...check(), conclusion: "NEW_STATE" }]) } })] }));
    const result = await new GithubPrReader("token").rereadPrs(["P1"]);
    expect(result.nodes[0]?.kind).toBe("unavailable");
    expect(result.status).toBe("failed");
  });

  it("shares request budget across operations and reports pending work without fetching", async () => {
    const calls = github(() => ({ nodes: [{ ...repo(), pullRequests: { totalCount: 0 } }] }));
    const reader = new GithubPrReader("token", { requestLimit: 1 });
    await reader.countOpenPrs(["R1"]);
    const result = await reader.rereadPrs(["P1"]);
    expect(result.issues).toEqual([{ nodeId: "P1", reason: "request-limit" }]);
    expect(result.requestsUsed).toBe(1);
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

describe("repository reads", () => {
  it("pages PR listings, with the exact same mapping as re-reads", async () => {
    github((query, variables) => {
      if (query === REPOSITORIES_QUERY) return { nodes: [{ ...repo(), pullRequests: connection([pr("P1")], 2, "next") }] };
      expect(variables.after).toBe("next");
      return { node: { ...repo(), pullRequests: connection([pr("P2")], 2) } };
    });
    const result = await new GithubPrReader("token").readRepositories(["R1"]);
    expect(result.status).toBe("complete");
    expect(result.repositories[0]?.complete).toBe(true);
    expect(result.repositories[0]?.prs.map((item) => item.nodeId)).toEqual(["P1", "P2"]);
  });

  it("keeps failed continuation distinct from empty or complete listings", async () => {
    github((query) => query === REPOSITORIES_QUERY
      ? { nodes: [{ ...repo(), pullRequests: connection([pr("P1")], 2, "next") }] }
      : Response.json({}, { status: 503 }));
    const result = await new GithubPrReader("token").readRepositories(["R1"]);
    expect(result.status).toBe("partial");
    expect(result.repositories[0]).toMatchObject({ complete: false, prs: [{ nodeId: "P1" }] });
    expect(result.issues).toEqual([{ nodeId: "R1", reason: "github-failed" }]);
  });

  it("caps repository and PR batches at ten", async () => {
    const calls = github((_query, variables) => {
      const ids = variables.ids as string[];
      expect(ids.length).toBeLessThanOrEqual(10);
      return { nodes: ids.map((nodeId) => ({ ...repo(nodeId), pullRequests: connection([]) })) };
    });
    expect((await new GithubPrReader("token").readRepositories(Array.from({ length: 11 }, (_, i) => `R${i + 1}`))).status).toBe("complete");
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("does not declare a shrinking or duplicate paged listing complete", async () => {
    github((query) => query === REPOSITORIES_QUERY
      ? { nodes: [{ ...repo(), pullRequests: connection([pr("P1")], 2, "next") }] }
      : { node: { ...repo(), pullRequests: connection([pr("P1")], 2) } });
    const result = await new GithubPrReader("token").readRepositories(["R1"]);
    expect(result.repositories[0]?.complete).toBe(false);
    expect(result.issues[0]?.reason).toBe("changed-during-read");
  });

  it("requests the activity fields in both production reads without Contents permission", () => {
    expect(PR_FIELDS).toContain("commits { totalCount }");
    expect(PR_FIELDS).toContain("statusCheckRollup { contexts");
    expect(PR_FIELDS).not.toContain("committedDate");
    expect(PR_FIELDS).not.toContain("pushedDate");
    expect(PR_FIELDS).toContain("HEAD_REF_FORCE_PUSHED_EVENT");
    expect(PR_FIELDS).toContain("REOPENED_EVENT, CONVERT_TO_DRAFT_EVENT, READY_FOR_REVIEW_EVENT");
  });
});

describe("bounded reads across invocations", () => {
  it("makes forward progress through more than 40 nested pages without repeating HTTP requests", async () => {
    const calls = github((query, variables) => {
      if (query.includes("query SeshatReviewPage")) {
        const next = Number(String(variables.after).slice(1)) + 1;
        return { node: { id: "P1", headRefOid: "head", reviews: connection([review(next)], 45, next === 45 ? null : `r${next}`) } };
      }
      if (query === CHECK_PAGE_QUERY) {
        const next = Number(String(variables.after).slice(1)) + 1;
        return { node: { id: "P1", headRefOid: "head", statusCheckRollup: { contexts: connection([check(next)], 45, next === 45 ? null : `c${next}`) } } };
      }
      return { nodes: [pr("P1", { reviews: connection([review(1)], 45, "r1"), statusCheckRollup: { contexts: connection([check(1)], 45, "c1") } })] };
    });
    let continuation: ReaderContinuation | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await new GithubPrReader("secret-token", { continuation }).rereadPrs(["P1"]);
      expect(result.requestsUsed).toBeLessThanOrEqual(40);
      if (attempt < 2) {
        expect(result.status).toBe("failed");
        expect(result.continuation).not.toBeNull();
        expect(JSON.stringify(result.continuation)).not.toContain("secret-token");
        continuation = JSON.parse(JSON.stringify(result.continuation)) as ReaderContinuation;
      } else {
        expect(result.status).toBe("complete");
        expect(result.continuation).toBeNull();
        const node = result.nodes[0];
        expect(node?.kind === "open" && node.pr.reviews.length).toBe(45);
        expect(node?.kind === "open" && node.pr.ci.length).toBe(45);
      }
    }
    expect(calls).toHaveBeenCalledTimes(90);
  });

  it("does not repeat successful permission refreshes when a repository needs more than one invocation", async () => {
    const reviews = Array.from({ length: 41 }, (_, i) => review(i + 1, "APPROVED", actor(i + 2)));
    let permissionCalls = 0;
    const calls = github((query) => query.includes("query SeshatReviewPage")
      ? { node: { id: "P1", headRefOid: "head", reviews: connection(reviews.slice(30), 41) } }
      : { nodes: [{ ...repo(), pullRequests: connection([pr("P1", { reviews: connection(reviews.slice(0, 30), 41, "after") })]) }] }, (url) => {
      permissionCalls++;
      const accountId = Number(/user(\d+)\/permission/.exec(url)?.[1]);
      return Response.json({ user: { id: accountId }, permission: "write" });
    });
    const first = await new GithubPrReader("token", { refreshPermissions: true }).readRepositories(["R1"]);
    expect(first.continuation).not.toBeNull();
    const second = await new GithubPrReader("token", { refreshPermissions: true, continuation: first.continuation }).readRepositories(["R1"]);
    expect(second.status).toBe("complete");
    expect(second.repositories[0]?.prs[0]?.reviewerPermissions.size).toBe(41);
    expect(permissionCalls).toBe(41);
    expect(calls).toHaveBeenCalledTimes(44);
  });

  it("reads >250-commit PR head dates through the timeline and resumes backwards paging", async () => {
    const calls = github(() => ({ nodes: [pr("P1", { commits: { totalCount: 300 } })] }), (url) => {
      const path = "https://api.github.com/repos/owner/repoR1/issues/1/timeline";
      expect(url.startsWith(path)).toBe(true);
      const page = new URL(url).searchParams.get("page");
      if (page === "1") return Response.json([{ event: "committed", sha: "old", committer: { date: WHEN } }], { headers: { link: `<${path}?per_page=100&page=3>; rel="last"` } });
      if (page === "3") return Response.json([{ event: "commented", body: "private text" }], { headers: { link: `<${path}?per_page=100&page=2>; rel="prev"` } });
      return Response.json([{ event: "committed", sha: "head", committer: { date: WHEN, email: "private@example.com" } }]);
    });
    const first = await new GithubPrReader("token", { requestLimit: 2 }).rereadPrs(["P1"]);
    expect(first.continuation).not.toBeNull();
    const second = await new GithubPrReader("token", { requestLimit: 2, continuation: first.continuation }).rereadPrs(["P1"]);
    expect(second.status).toBe("complete");
    expect(second.nodes[0]?.kind === "open" && second.nodes[0].pr.activity.lastCommitAt).toBe(Date.parse(WHEN));
    expect(calls).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(first.continuation)).not.toContain("private@example.com");
  });

  it("caches head dates by repository and immutable SHA across fresh sweeps", async () => {
    const calls = github(() => ({ nodes: [pr()] }));
    const first = await new GithubPrReader("token").rereadPrs(["P1"]);
    const second = await new GithubPrReader("token", { headCommitDates: first.headCommitDates }).rereadPrs(["P1"]);
    expect(second.status).toBe("complete");
    expect(second.requestsUsed).toBe(1);
    expect(calls).toHaveBeenCalledTimes(3);
  });
});


describe("rate-limited reviewer permissions", () => {
  it("retains the throttle reason when a reviewer's collaborator lookup is rate limited", async () => {
    github(() => ({ nodes: [pr("P1", { reviews: connection([review(1, "APPROVED")]) })] }), () => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    const result = await new GithubPrReader("token").rereadPrs(["P1"]);
    expect(result.issues).toContainEqual({ nodeId: "P1", reason: "rate-limited" });
  });
});
