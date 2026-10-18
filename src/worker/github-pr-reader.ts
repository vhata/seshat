import type {
  Account, CheckRunConclusion, CheckRunStatus, CiResult, CommitStatusState,
  Review,
} from "../shared/overview/types";
import type { PullRequestRecord } from "../shared/overview/protocol";
import { githubRequest, record, responseJson } from "./github-http";
import { readReviewerPermission, type PermissionCacheEntry } from "./github-permissions";
import {
  CHECK_PAGE_QUERY, COUNT_QUERY, PR_PAGE_QUERY, REPOSITORIES_QUERY,
  REREAD_QUERY, REVIEW_PAGE_QUERY,
} from "./github-pr-queries";

export type ReadPr = PullRequestRecord;

export type ReadFailure = "github-failed" | "graphql-errors" | "malformed" | "unavailable" | "request-limit" | "permission-failed" | "changed-during-read";
export interface ReadIssue { readonly nodeId: string; readonly reason: ReadFailure }
export interface RateLimit { readonly remaining: number; readonly resetAt: number; readonly cost: number }
export interface HeadCommitDate {
  readonly repositoryId: number;
  readonly headSha: string;
  readonly committedAt: number;
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
}
export type PrNodeRead =
  | { readonly kind: "open"; readonly pr: ReadPr }
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
  private readonly commitDates = new Map<string, HeadCommitDate>();
  private readonly requestLimit: number;
  private readonly refreshPermissions: boolean;

  constructor(private readonly token: string, options: {
    readonly permissionCache?: readonly PermissionCacheEntry[];
    readonly requestLimit?: number;
    readonly refreshPermissions?: boolean;
    readonly headCommitDates?: readonly HeadCommitDate[];
  } = {}) {
    const requested = options.requestLimit ?? 40;
    this.requestLimit = Number.isFinite(requested) ? Math.min(40, Math.max(0, Math.floor(requested))) : 40;
    this.refreshPermissions = options.refreshPermissions ?? false;
    for (const entry of options.permissionCache ?? []) this.permissions.set(`${entry.repositoryId}:${entry.accountId}`, entry);
    for (const entry of options.headCommitDates ?? []) {
      if (Number.isFinite(entry.committedAt)) this.commitDates.set(`${entry.repositoryId}:${entry.headSha}`, entry);
    }
  }

  private consume(): void {
    if (this.used >= this.requestLimit) fail("request-limit");
    this.used++;
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.consume();
    const response = await githubRequest(this.token, "/graphql", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }),
    });
    if (!response?.ok) fail("github-failed");
    const body = obj(await responseJson(response));
    const data = record(body.data);
    if (data && record(data.rateLimit)) {
      const rate = obj(data.rateLimit);
      this.rate = { remaining: integer(rate.remaining), resetAt: time(rate.resetAt), cost: integer(rate.cost) };
    }
    if (Array.isArray(body.errors) && body.errors.length) fail("graphql-errors");
    return data ?? fail();
  }

  private meta(issues: readonly ReadIssue[], successes: number): ReadMeta {
    return {
      status: issues.length === 0 ? "complete" : successes > 0 ? "partial" : "failed",
      issues, rateLimit: this.rate, requestsUsed: this.used, permissionCache: [...this.permissions.values()],
      headCommitDates: [...this.commitDates.values()],
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
    return { ...this.meta(issues, repositories.length), repositories };
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
    return { ...this.meta(issues, repositories.length), repositories };
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
    return { ...this.meta(issues, result.filter((node) => node.kind !== "unavailable").length), nodes: result };
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
    const reviews: Review[] = [];
    const observedReviews: ReadPr["observations"]["reviews"][number][] = [];
    let lastComment = latestComment(raw.comments);
    const reviewerPermissions = new Map<number, PermissionCacheEntry["permission"]>();
    for (const value of rawReviews) {
      const review = obj(value);
      const author = account(review.author);
      const state = enumValue(review.state, ["approved", "changes_requested", "commented", "dismissed", "pending"]);
      const commitSha = review.commit === null ? null : text(obj(review.commit).oid);
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
          if (!permission.ok) issues.push({ nodeId, reason: "permission-failed" });
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
    if (mergeable === "unknown") {
      try {
        this.consume();
        const path = repo.fullName.split("/").map(encodeURIComponent).join("/");
        const response = await githubRequest(this.token, `/repos/${path}/pulls/${number}`);
        const rest = record(await responseJson(response));
        if (!response?.ok || !rest) fail("github-failed");
        // A REST response on a newer head cannot resolve this GraphQL read.
        if (obj(rest.head).sha === headSha) {
          mergeable = rest.mergeable === true ? "mergeable" : rest.mergeable === false ? "conflicting" : "unknown";
        }
      } catch (error) { issues.push({ nodeId, reason: reason(error) }); }
    }
    const committedAt = await this.headDate(raw, repo.repositoryId, repo.fullName, headSha, number);
    return { kind: "open", pr: {
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

  private async headDate(raw: Record<string, unknown>, repositoryId: number, fullName: string, headSha: string, number: number): Promise<number> {
    const key = `${repositoryId}:${headSha}`;
    const cached = this.commitDates.get(key);
    if (cached) return cached.committedAt;
    const count = id(obj(raw.commits).totalCount);
    // The PR commits endpoint exposes at most 250 commits. Beyond that, it
    // cannot prove the head date with our permissions. Keep the old PR rather
    // than manufacture an activity time and potentially show a false stale flag.
    if (count > 250) fail("unavailable");
    this.consume();
    const path = fullName.split("/").map(encodeURIComponent).join("/");
    const response = await githubRequest(this.token, `/repos/${path}/pulls/${number}/commits?per_page=1&page=${count}`);
    if (!response?.ok) fail("github-failed");
    const commits = list(await responseJson(response));
    if (commits.length !== 1) fail("changed-during-read");
    const commit = obj(commits[0]);
    if (commit.sha !== headSha) fail("changed-during-read");
    const committedAt = time(obj(obj(commit.commit).committer).date);
    this.commitDates.set(key, { repositoryId, headSha, committedAt });
    return committedAt;
  }
}

function reason(error: unknown): ReadFailure { return error instanceof ReadError ? error.reason : "malformed"; }
