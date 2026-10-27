import type {
  Account, CheckRunConclusion, CheckRunStatus, CiResult, CommitStatusState,
  Review,
} from "../shared/overview/types";
import type { PullRequestRecord } from "../shared/overview/protocol";
import { githubRequest, rateLimited, record, reportGithubFailure, responseJson, type GithubFailureOperation } from "./github-http";
import { readReviewerPermission, type PermissionCacheEntry } from "./github-permissions";
import {
  CHECK_PAGE_QUERY, COUNT_QUERY, PR_PAGE_QUERY, REPOSITORIES_QUERY,
  REREAD_QUERY, REVIEW_PAGE_QUERY,
} from "./github-pr-queries";

export type ReadPr = PullRequestRecord;

export type ReadFailure = "github-failed" | "graphql-errors" | "malformed" | "unavailable" | "request-limit" | "permission-failed" | "changed-during-read" | "rate-limited" | "interrupted";
export interface ReadIssue { readonly nodeId: string; readonly reason: ReadFailure }
export interface RateLimit { readonly remaining: number; readonly resetAt: number; readonly cost: number; readonly limit?: number }
export interface HeadCommitDate {
  readonly repositoryId: number;
  readonly headSha: string;
  readonly committedAt: number;
}
/**
 * Owner-private, JSON-safe progress for one logical read. Replay it only with
 * the same installation, operation and inputs. It contains selected API facts,
 * never authorization headers or tokens. Discard on a non-budget failure or
 * when starting a new sweep, so cached responses cannot mask future changes.
 */
export interface ReaderContinuation {
  readonly version: 1;
  readonly responses: readonly (readonly [string, unknown])[];
  readonly permissionCache: readonly PermissionCacheEntry[];
  readonly headCommitDates: readonly HeadCommitDate[];
  readonly refreshedPermissionKeys: readonly string[];
  readonly rateLimit: RateLimit | null;
}
export interface ReadMeta {
  readonly status: "complete" | "partial" | "failed";
  readonly issues: readonly ReadIssue[];
  readonly rateLimit: RateLimit | null;
  /** Includes REST fallback and permission calls, excluding token minting. */
  readonly requestsUsed: number;
  readonly permissionCache: readonly PermissionCacheEntry[];
  /** Immutable head commit dates; safe to carry into the next invocation. */
  readonly headCommitDates: readonly HeadCommitDate[];
  readonly continuation: ReaderContinuation | null;
}
export type PrNodeRead =
  | { readonly kind: "open"; readonly pr: ReadPr; readonly visibility?: "public" | "private" | "internal" }
  | { readonly kind: "closed" | "merged"; readonly nodeId: string; readonly repositoryId: number; readonly number: number }
  | { readonly kind: "unavailable"; readonly nodeId: string; readonly reason: ReadFailure };
export interface RepositoryRead {
  readonly repositoryId: number;
  readonly nodeId: string;
  readonly visibility: "public" | "private" | "internal";
  readonly complete: boolean;
  readonly prs: readonly ReadPr[];
}
export interface RepositoryCount {
  readonly repositoryId: number;
  readonly nodeId: string;
  readonly visibility: "public" | "private" | "internal";
  readonly count: number;
}

class ReadError extends Error {
  constructor(readonly reason: ReadFailure) { super(reason); }
}
function fail(reason: ReadFailure = "malformed"): never { throw new ReadError(reason); }
function obj(value: unknown): Record<string, unknown> { return record(value) ?? fail(); }
function text(value: unknown): string { return typeof value === "string" && value !== "" ? value : fail(); }
function integer(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(); }
function id(value: unknown): number { const number = integer(value); return number > 0 ? number : fail(); }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : fail(); }
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : fail(); }
function time(value: unknown): number { const result = Date.parse(text(value)); return Number.isFinite(result) ? result : fail(); }
function nullableTime(value: unknown): number | null { return value === null ? null : time(value); }
function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  const lowered = text(value).toLowerCase();
  return allowed.includes(lowered as T) ? lowered as T : fail();
}
function account(value: unknown): Account | null {
  if (value === null) return null;
  const actor = obj(value);
  return { id: id(actor.databaseId), login: text(actor.login), isBot: text(actor.__typename) !== "User" };
}
function repository(value: unknown): RepositoryCount & { fullName: string; ownerAccountId: number } {
  const repo = obj(value);
  return {
    repositoryId: id(repo.databaseId), nodeId: text(repo.id),
    visibility: repo.visibility === "PUBLIC" ? "public" : repo.visibility === "INTERNAL" ? "internal" : "private",
    fullName: text(repo.nameWithOwner), ownerAccountId: id(obj(repo.owner).databaseId), count: 0,
  };
}
function latestComment(connection: unknown): number | null {
  const nodes = list(obj(connection).nodes);
  return nodes.length === 0 ? null : time(obj(nodes.at(-1)).createdAt);
}
function later(...values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? Math.max(...known) : null;
}
function checks(value: Record<string, unknown>): unknown {
  return value.statusCheckRollup === null ? null : obj(value.statusCheckRollup).contexts;
}

interface Page { nodes: unknown[]; count: number; next: string | null }
function page(value: unknown): Page {
  const connection = obj(value);
  const info = obj(connection.pageInfo);
  const nodes = list(connection.nodes);
  const count = integer(connection.totalCount);
  const next = bool(info.hasNextPage) ? text(info.endCursor) : null;
  if (nodes.length > count || (next !== null && nodes.length === 0)) fail();
  return { nodes, count, next };
}

/**
 * One invocation's reader. Share this instance across count/read/re-read calls
 * so the request cap covers the whole invocation. Every query has one token,
 * hence one installation; callers must not mix installations' repository IDs.
 * Keep an incomplete repository's stored rows; never infer closure from a
 * missing node or from a partial listing. A new instance gets a fresh budget.
 */
export class GithubPrReader {
  private used = 0;
  private rate: RateLimit | null = null;
  private readonly permissions = new Map<string, PermissionCacheEntry>();
  private readonly refreshedPermissions = new Set<string>();
  private readonly completedPermissions = new Set<string>();
  private readonly commitDates = new Map<string, HeadCommitDate>();
  private readonly responses = new Map<string, unknown>();
  private readonly requestLimit: number;
  private readonly refreshPermissions: boolean;
  private readonly verifyMergeability: boolean;
  private readonly shouldContinue: () => boolean;

  constructor(private readonly token: string, options: {
    readonly permissionCache?: readonly PermissionCacheEntry[];
    readonly requestLimit?: number;
    readonly refreshPermissions?: boolean;
    /** Trigger REST computation even when GraphQL returns an old known value. */
    readonly verifyMergeability?: boolean;
    /** Stop before another HTTP call when a visible sweep loses its reader. */
    readonly shouldContinue?: () => boolean;
    readonly headCommitDates?: readonly HeadCommitDate[];
    readonly continuation?: ReaderContinuation | null;
  } = {}) {
    const requested = options.requestLimit ?? 40;
    this.requestLimit = Number.isFinite(requested) ? Math.min(40, Math.max(0, Math.floor(requested))) : 40;
    this.refreshPermissions = options.refreshPermissions ?? false;
    this.verifyMergeability = options.verifyMergeability ?? false;
    this.shouldContinue = options.shouldContinue ?? (() => true);
    for (const entry of options.continuation?.permissionCache ?? options.permissionCache ?? []) this.permissions.set(`${entry.repositoryId}:${entry.accountId}`, entry);
    for (const entry of options.continuation?.headCommitDates ?? options.headCommitDates ?? []) {
      if (Number.isFinite(entry.committedAt)) this.commitDates.set(`${entry.repositoryId}:${entry.headSha}`, entry);
    }
    for (const key of options.continuation?.refreshedPermissionKeys ?? []) {
      this.refreshedPermissions.add(key);
      this.completedPermissions.add(key);
    }
    for (const [key, value] of options.continuation?.responses ?? []) this.responses.set(key, value);
    this.rate = options.continuation?.rateLimit ?? null;
  }

  private consume(): void {
    if (!this.shouldContinue()) fail("interrupted");
    if (this.used >= this.requestLimit) fail("request-limit");
    this.used++;
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const key = JSON.stringify([query, variables]);
    if (this.responses.has(key)) return obj(this.responses.get(key));
    this.consume();
    const response = await githubRequest(this.token, "/graphql", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }),
    });
    if (rateLimited(response)) fail("rate-limited");
    if (!response?.ok) fail("github-failed");
    const body = obj(await responseJson(response));
    const data = record(body.data);
    if (data && record(data.rateLimit)) {
      const rate = obj(data.rateLimit);
      this.rate = { remaining: integer(rate.remaining), resetAt: time(rate.resetAt), cost: integer(rate.cost), ...(rate.limit === undefined ? {} : { limit: id(rate.limit) }) };
    }
    if (Array.isArray(body.errors) && body.errors.length) fail("graphql-errors");
    if (!data) fail();
    this.responses.set(key, data);
    return data;
  }

  private async rest(path: string): Promise<{ body: unknown; link: string | null }> {
    const key = `REST ${path}`;
    if (this.responses.has(key)) {
      const cached = obj(this.responses.get(key));
      return { body: cached.body, link: cached.link === null ? null : text(cached.link) };
    }
    this.consume();
    const response = await githubRequest(this.token, path);
    if (rateLimited(response)) fail("rate-limited");
    if (!response?.ok) fail("github-failed");
    const raw = await responseJson(response);
    // Continuations keep only fields used here, excluding comment bodies,
    // commit messages and the remaining REST pull-request response.
    const body = path.includes("/timeline?")
      ? list(raw).map((value) => {
        const event = obj(value);
        return { event: event.event, sha: event.sha ?? null, committer: { date: record(event.committer)?.date ?? null } };
      })
      : path.includes("/reviews?") ? list(raw).map((value) => {
        const review = obj(value);
        return { id: id(review.id), node_id: text(review.node_id),
          commit_id: review.commit_id === null ? null : text(review.commit_id) };
      }) : path.includes("/commits?") ? list(raw).map((value) => {
        const commit = obj(value);
        return { sha: commit.sha, commit: { committer: { date: record(obj(commit.commit).committer)?.date ?? null } } };
      }) : (() => {
        const pr = obj(raw);
        return { mergeable: pr.mergeable, head: { sha: obj(pr.head).sha } };
      })();
    const result = { body, link: response.headers.get("link") };
    this.responses.set(key, result);
    return result;
  }

  private meta(issues: readonly ReadIssue[], successes: number, operation: GithubFailureOperation): ReadMeta {
    // Collapse repository fan-out into one event per fixed category. Budget
    // exhaustion and cancellation are scheduling controls. Transport details
    // are separate so this summary also identifies the logical read operation.
    for (const reason of new Set(issues.map((issue) => issue.reason))) {
      if (reason !== "request-limit" && reason !== "interrupted") reportGithubFailure(operation, reason);
    }
    const permissionCache = [...this.permissions.values()];
    const headCommitDates = [...this.commitDates.values()];
    const continuation: ReaderContinuation | null = issues.some((issue) => issue.reason === "request-limit")
      ? { version: 1, responses: [...this.responses.entries()], permissionCache, headCommitDates,
        refreshedPermissionKeys: [...this.completedPermissions], rateLimit: this.rate } : null;
    return {
      status: issues.length === 0 ? "complete" : successes > 0 ? "partial" : "failed",
      issues, rateLimit: this.rate, requestsUsed: this.used, permissionCache,
      headCommitDates, continuation,
    };
  }

  async countOpenPrs(nodeIds: readonly string[]): Promise<ReadMeta & { readonly repositories: readonly RepositoryCount[] }> {
    const repositories: RepositoryCount[] = [];
    const issues: ReadIssue[] = [];
    for (let offset = 0; offset < nodeIds.length; offset += 100) {
      const ids = nodeIds.slice(offset, offset + 100);
      try {
        const nodes = list((await this.graphql(COUNT_QUERY, { ids })).nodes);
        if (nodes.length !== ids.length) fail();
        for (let index = 0; index < ids.length; index++) {
          const nodeId = ids[index]!;
          try {
            if (nodes[index] === null) fail("unavailable");
            const node = obj(nodes[index]);
            const repo = repository(node);
            if (repo.nodeId !== nodeId) fail();
            repositories.push({ repositoryId: repo.repositoryId, nodeId, visibility: repo.visibility, count: integer(obj(node.pullRequests).totalCount) });
          } catch (error) { issues.push({ nodeId, reason: reason(error) }); }
        }
      } catch (error) { issues.push(...ids.map((nodeId) => ({ nodeId, reason: reason(error) }))); }
    }
    return { ...this.meta(issues, repositories.length, "pr-count"), repositories };
  }

  async readRepositories(nodeIds: readonly string[]): Promise<ReadMeta & { readonly repositories: readonly RepositoryRead[] }> {
    const repositories: RepositoryRead[] = [];
    const issues: ReadIssue[] = [];
    for (let offset = 0; offset < nodeIds.length; offset += 10) {
      const ids = nodeIds.slice(offset, offset + 10);
      try {
        const nodes = list((await this.graphql(REPOSITORIES_QUERY, { ids })).nodes);
        if (nodes.length !== ids.length) fail();
        for (let index = 0; index < ids.length; index++) {
          const nodeId = ids[index]!;
          try {
            if (nodes[index] === null) fail("unavailable");
            let node = obj(nodes[index]);
            const repo = repository(node);
            if (repo.nodeId !== nodeId) fail();
            const prs: ReadPr[] = [];
            let complete = true;
            let seen = 0;
            const seenIds = new Set<string>();
            const cursors = new Set<string>();
            const initialIssues = issues.length;
            let expected: number | null = null;
            try {
              for (;;) {
                const current = page(node.pullRequests);
                if (expected !== null && current.count !== expected) fail("changed-during-read");
                expected = current.count;
                for (const raw of current.nodes) {
                  seen++;
                  const prId = text(obj(raw).id);
                  if (seenIds.has(prId)) fail("changed-during-read");
                  seenIds.add(prId);
                  try {
                    const result = await this.readPr(obj(raw), issues);
                    if (result.kind !== "open" || result.pr.repositoryId !== repo.repositoryId) fail("changed-during-read");
                    prs.push(result.pr);
                  } catch (error) { issues.push({ nodeId: prId, reason: reason(error) }); complete = false; }
                }
                if (current.next === null) {
                  if (seen !== expected) fail("changed-during-read");
                  break;
                }
                if (cursors.has(current.next)) fail();
                cursors.add(current.next);
                const data = await this.graphql(PR_PAGE_QUERY, { id: nodeId, after: current.next });
                node = obj(data.node);
                if (text(node.id) !== nodeId) fail();
              }
            } catch (error) { issues.push({ nodeId, reason: reason(error) }); complete = false; }
            repositories.push({ repositoryId: repo.repositoryId, nodeId, visibility: repo.visibility, complete: complete && issues.length === initialIssues, prs });
          } catch (error) { issues.push({ nodeId, reason: reason(error) }); }
        }
      } catch (error) { issues.push(...ids.map((nodeId) => ({ nodeId, reason: reason(error) }))); }
    }
    return { ...this.meta(issues, repositories.length, "pr-list"), repositories };
  }

  async rereadPrs(nodeIds: readonly string[]): Promise<ReadMeta & { readonly nodes: readonly PrNodeRead[] }> {
    const result: PrNodeRead[] = [];
    const issues: ReadIssue[] = [];
    for (let offset = 0; offset < nodeIds.length; offset += 10) {
      const ids = nodeIds.slice(offset, offset + 10);
      try {
        const nodes = list((await this.graphql(REREAD_QUERY, { ids })).nodes);
        if (nodes.length !== ids.length) fail();
        for (let index = 0; index < ids.length; index++) {
          const nodeId = ids[index]!;
          try {
            if (nodes[index] === null) fail("unavailable");
            const node = obj(nodes[index]);
            if (text(node.id) !== nodeId) fail();
            result.push(await this.readPr(node, issues));
          } catch (error) {
            const failure = reason(error);
            issues.push({ nodeId, reason: failure });
            result.push({ kind: "unavailable", nodeId, reason: failure });
          }
        }
      } catch (error) {
        for (const nodeId of ids) {
          const failure = reason(error);
          issues.push({ nodeId, reason: failure });
          result.push({ kind: "unavailable", nodeId, reason: failure });
        }
      }
    }
    return { ...this.meta(issues, result.filter((node) => node.kind !== "unavailable").length, "pr-reread"), nodes: result };
  }

  private async pages(initial: unknown, pr: Record<string, unknown>, kind: "reviews" | "checks"): Promise<unknown[]> {
    if (initial === null && kind === "checks") return [];
    let current = page(initial);
    const count = current.count;
    const all = [...current.nodes];
    const cursors = new Set<string>();
    while (current.next !== null) {
      if (cursors.has(current.next)) fail();
      cursors.add(current.next);
      const data = await this.graphql(kind === "reviews" ? REVIEW_PAGE_QUERY : CHECK_PAGE_QUERY, { id: text(pr.id), after: current.next });
      const node = obj(data.node);
      if (node.id !== pr.id || node.headRefOid !== pr.headRefOid) fail("changed-during-read");
      current = page(kind === "reviews" ? node.reviews : checks(node));
      if (current.count !== count) fail("changed-during-read");
      all.push(...current.nodes);
      if (all.length > count) fail();
    }
    if (all.length !== count) fail();
    const ids = all.map((item) => text(obj(item).id));
    if (new Set(ids).size !== ids.length) fail();
    return all;
  }

  private async readPr(raw: Record<string, unknown>, issues: ReadIssue[]): Promise<PrNodeRead> {
    const nodeId = text(raw.id);
    const repo = repository(raw.repository);
    const number = id(raw.number);
    const state = enumValue(raw.state, ["open", "closed", "merged"]);
    if (state !== "open") return { kind: state, nodeId, repositoryId: repo.repositoryId, number };
    const headSha = text(raw.headRefOid);
    const rawReviews = await this.pages(raw.reviews, raw, "reviews");
    const rawChecks = await this.pages(checks(raw), raw, "checks");
    const reviewCommits = await this.reviewCommits(rawReviews, repo.fullName, number);
    const reviews: Review[] = [];
    const observedReviews: ReadPr["observations"]["reviews"][number][] = [];
    let lastComment = latestComment(raw.comments);
    const reviewerPermissions = new Map<number, PermissionCacheEntry["permission"]>();
    for (const value of rawReviews) {
      const review = obj(value);
      const author = account(review.author);
      const state = enumValue(review.state, ["approved", "changes_requested", "commented", "dismissed", "pending"]);
      // Review.commit is inaccessible with this App's private-repository
      // permissions. Join REST identity without broadening that access.
      const commitSha = reviewCommits.get(id(review.databaseId));
      if (commitSha === undefined) fail();
      reviews.push({ author, state, commitSha, submittedAt: nullableTime(review.submittedAt) });
      observedReviews.push({ id: String(id(review.databaseId)), state, commitSha });
      lastComment = later(lastComment, latestComment(review.comments));
      if (!author || author.isBot || (state !== "approved" && state !== "changes_requested") || reviewerPermissions.has(author.id)) continue;
      const key = `${repo.repositoryId}:${author.id}`;
      let entry = this.permissions.get(key) ?? null;
      if (author.id === repo.ownerAccountId) {
        reviewerPermissions.set(author.id, "admin");
        continue;
      }
      if ((!entry || this.refreshPermissions) && !this.refreshedPermissions.has(key)) {
        this.refreshedPermissions.add(key);
        try {
          this.consume();
          const permission = await readReviewerPermission(this.token, { id: repo.repositoryId, fullName: repo.fullName }, author, entry);
          if (!permission.ok) issues.push({ nodeId, reason: permission.reason === "rate-limited" ? "rate-limited" : "permission-failed" });
          else this.completedPermissions.add(key);
          entry = permission.entry;
          if (entry) this.permissions.set(key, entry);
        } catch (error) { issues.push({ nodeId, reason: reason(error) }); }
      }
      if (entry) reviewerPermissions.set(author.id, entry.permission);
    }
    const ci: CiResult[] = [];
    const observedChecks: ReadPr["observations"]["checks"][number][] = [];
    for (const value of rawChecks) {
      const check = obj(value);
      if (check.__typename === "CheckRun") {
        const status: CheckRunStatus = enumValue(check.status, ["queued", "in_progress", "completed", "waiting", "requested", "pending"]);
        const conclusion: CheckRunConclusion | null = check.conclusion === null ? null : enumValue<CheckRunConclusion>(check.conclusion, ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "startup_failure", "stale"]);
        ci.push({ kind: "check_run", status, conclusion });
        observedChecks.push({ id: String(id(check.databaseId)), kind: "check_run", state: status, conclusion, name: text(check.name) });
      } else if (check.__typename === "StatusContext") {
        const state: CommitStatusState = enumValue(check.state, ["error", "expected", "failure", "pending", "success"]);
        ci.push({ kind: "commit_status", state });
        observedChecks.push({ id: text(check.id), kind: "commit_status", state, conclusion: null, name: text(check.context) });
      } else fail();
    }
    let mergeable = enumValue(raw.mergeable, ["mergeable", "conflicting", "unknown"]);
    if (mergeable === "unknown" || this.verifyMergeability) {
      try {
        const path = repo.fullName.split("/").map(encodeURIComponent).join("/");
        const rest = obj((await this.rest(`/repos/${path}/pulls/${number}`)).body);
        // A REST response on a newer head cannot resolve this GraphQL read.
        if (obj(rest.head).sha === headSha) {
          mergeable = rest.mergeable === true ? "mergeable" : rest.mergeable === false ? "conflicting" : "unknown";
        }
      } catch (error) { issues.push({ nodeId, reason: reason(error) }); }
    }
    const committedAt = await this.headDate(raw, repo.repositoryId, repo.fullName, headSha, number);
    return { kind: "open", visibility: repo.visibility, pr: {
      id: id(raw.databaseId), nodeId, repositoryId: repo.repositoryId,
      title: text(raw.title), url: text(raw.url), updatedAt: time(raw.updatedAt),
      repository: { fullName: repo.fullName, ownerAccountId: repo.ownerAccountId },
      number, author: account(raw.author), isDraft: bool(raw.isDraft), headSha, mergeable,
      ci, reviews, reviewerPermissions, observations: { reviews: observedReviews, checks: observedChecks },
      activity: {
        openedAt: time(raw.createdAt),
        lastCommitAt: later(committedAt, latestComment(raw.forcePush)),
        lastCommentAt: lastComment, lastStateChangeAt: latestComment(raw.stateChange),
      },
    } };
  }

  private async reviewCommits(reviews: readonly unknown[], fullName: string, number: number): Promise<Map<number, string | null>> {
    const expected = new Map<number, string>();
    for (const raw of reviews) {
      const review = obj(raw);
      const reviewId = id(review.databaseId);
      if (expected.has(reviewId)) fail();
      expected.set(reviewId, text(review.id));
    }
    const commits = new Map<number, string | null>();
    if (expected.size === 0) return commits;
    const path = `/repos/${fullName.split("/").map(encodeURIComponent).join("/")}/pulls/${number}/reviews`;
    const nodeIds = new Set<string>();
    let pageNumber = 1;
    for (;;) {
      const current = await this.rest(`${path}?per_page=100&page=${pageNumber}`);
      const nodes = list(current.body);
      if (nodes.length > 100) fail();
      for (const raw of nodes) {
        const review = obj(raw);
        const reviewId = id(review.id);
        const nodeId = text(review.node_id);
        if (commits.has(reviewId) || nodeIds.has(nodeId)) fail();
        if (expected.get(reviewId) !== nodeId) fail("changed-during-read");
        nodeIds.add(nodeId);
        commits.set(reviewId, review.commit_id === null ? null : text(review.commit_id));
      }
      const next = linkedPage(current.link, "next", path);
      if (next === null) break;
      if (nodes.length === 0 || next !== pageNumber + 1) fail();
      pageNumber = next;
    }
    if (commits.size !== expected.size) fail("changed-during-read");
    return commits;
  }

  private async headDate(raw: Record<string, unknown>, repositoryId: number, fullName: string, headSha: string, number: number): Promise<number> {
    const key = `${repositoryId}:${headSha}`;
    const cached = this.commitDates.get(key);
    if (cached) return cached.committedAt;
    const count = id(obj(raw.commits).totalCount);
    const path = fullName.split("/").map(encodeURIComponent).join("/");
    let committedAt: number;
    if (count <= 250) {
      const commits = list((await this.rest(`/repos/${path}/pulls/${number}/commits?per_page=1&page=${count}`)).body);
      if (commits.length !== 1) fail("changed-during-read");
      const commit = obj(commits[0]);
      if (commit.sha !== headSha) fail("changed-during-read");
      committedAt = time(obj(obj(commit.commit).committer).date);
    } else {
      // Unlike the PR commits endpoint's 250-commit cap, the issue timeline
      // pages committed events. It accepts Pull requests read on private PRs.
      committedAt = await this.timelineHeadDate(`/repos/${path}/issues/${number}/timeline`, headSha);
    }
    this.commitDates.set(key, { repositoryId, headSha, committedAt });
    return committedAt;
  }

  private async timelineHeadDate(path: string, headSha: string): Promise<number> {
    let current = await this.rest(`${path}?per_page=100&page=1`);
    const find = (body: unknown): number | null => {
      for (const raw of list(body)) {
        const event = obj(raw);
        if (event.event === "committed" && event.sha === headSha) return time(obj(event.committer).date);
      }
      return null;
    };
    let date = find(current.body);
    if (date !== null) return date;
    const last = linkedPage(current.link, "last", path);
    if (last === null) fail("changed-during-read");
    const visited = new Set([1]);
    let page = last;
    for (;;) {
      if (visited.has(page)) fail("changed-during-read");
      visited.add(page);
      current = await this.rest(`${path}?per_page=100&page=${page}`);
      date = find(current.body);
      if (date !== null) return date;
      const previous = linkedPage(current.link, "prev", path);
      if (previous === null || previous === 1) fail("changed-during-read");
      page = previous;
    }
  }
}

function linkedPage(link: string | null, relation: string, expectedPath: string): number | null {
  if (!link) return null;
  for (const item of link.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(item);
    if (match?.[2] !== relation) continue;
    const url = new URL(match[1]!);
    // Reconstruct the request ourselves; never send credentials to Link's URL.
    if (url.origin !== "https://api.github.com" || url.pathname !== expectedPath || url.searchParams.get("per_page") !== "100") fail();
    return id(Number(url.searchParams.get("page")));
  }
  return null;
}

function reason(error: unknown): ReadFailure { return error instanceof ReadError ? error.reason : "malformed"; }
