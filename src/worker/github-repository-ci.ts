import type { RepositoryRecord } from "../shared/overview/protocol";
import type {
  RepositoryCiData, RepositoryCiIssue, RepositoryCiRun, RepositoryCiStream, RepositoryCiTrigger,
} from "../shared/overview/repository-ci";
import { githubRequest, githubRetryAt, rateLimited, record, responseJson } from "./github-http";

export const CI_WORKFLOW_PAGES = 10;
const PAGE_SIZE = 100;
interface Workflow { id: number; name: string; state: string }
interface RunSelection { completed: RepositoryCiRun | null; pending: RepositoryCiRun | null }

/** Selected API facts only; credentials and raw API payloads never persist. */
export interface RepositoryCiContinuation {
  readonly version: 1;
  readonly repositoryId: number;
  readonly ownerAccountId: number;
  readonly fullName: string;
  phase: "metadata" | "inventory" | "runs";
  defaultBranch?: string | null;
  inventoryPage: number;
  inventoryTotal: number | null;
  inventoryComplete: boolean;
  workflows: Workflow[];
  streamIndex: number;
  streams: RepositoryCiStream[];
  /** A completed-only query follows a latest page containing only pending runs. */
  current: RunSelection | null;
}
export type RepositoryCiReadResult =
  | { readonly kind: "complete"; readonly data: RepositoryCiData; readonly requestsUsed: number }
  | { readonly kind: "continuation"; readonly continuation: RepositoryCiContinuation; readonly requestsUsed: number }
  | { readonly kind: "failed"; readonly issue: RepositoryCiIssue; readonly retryAt?: number; readonly requestsUsed: number; readonly defaultBranch?: string | null };
interface Options {
  readonly requestLimit?: number;
  readonly continuation?: RepositoryCiContinuation | null;
  readonly previous?: RepositoryCiData;
  readonly shouldContinue?: () => boolean;
  readonly now?: number;
}
class ReadFailure extends Error {
  constructor(readonly issue: RepositoryCiIssue = "github-unavailable", readonly retryAt?: number) { super(issue); }
}
class ContinueRead extends Error {}
function fail(): never { throw new ReadFailure(); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function string(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function time(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fail();
}
function identity(value: unknown, repository: Pick<RepositoryRecord, "id" | "ownerAccountId" | "fullName">): void {
  const repo = record(value);
  if (repo?.id !== repository.id || record(repo.owner)?.id !== repository.ownerAccountId
    || typeof repo.full_name !== "string" || repo.full_name.toLowerCase() !== repository.fullName.toLowerCase()) fail();
}
function compare(a: RepositoryCiRun, b: RepositoryCiRun): number {
  return a.id === b.id ? a.attempt - b.attempt : a.createdAt - b.createdAt || a.number - b.number || a.id - b.id;
}
function latest(a: RepositoryCiRun | null, b: RepositoryCiRun): RepositoryCiRun { return a === null || compare(b, a) > 0 ? b : a; }
function run(value: unknown, repository: Pick<RepositoryRecord, "id" | "ownerAccountId" | "fullName">,
  workflowId: number, trigger: RepositoryCiTrigger, branch: string, completedOnly: boolean): RepositoryCiRun {
  const raw = record(value);
  if (!raw || !positive(raw.id) || !positive(raw.run_attempt) || !positive(raw.run_number)
    || raw.workflow_id !== workflowId || raw.event !== trigger || raw.head_branch !== branch
    || !string(raw.head_sha) || !string(raw.html_url) || !string(raw.status)
    || (raw.conclusion !== null && typeof raw.conclusion !== "string")
    || completedOnly && raw.status !== "completed") fail();
  identity(raw.repository, repository);
  let url: URL;
  try { url = new URL(raw.html_url); } catch { return fail(); }
  const expectedPath = `/${repository.fullName}/actions/runs/${raw.id}`;
  if (url.protocol !== "https:" || url.host !== "github.com" || url.username || url.password || url.search || url.hash
    || url.pathname.toLowerCase() !== expectedPath.toLowerCase()) fail();
  return {
    id: raw.id, attempt: raw.run_attempt, number: raw.run_number,
    createdAt: time(raw.created_at), updatedAt: time(raw.updated_at),
    startedAt: raw.run_started_at == null ? null : time(raw.run_started_at),
    headSha: raw.head_sha, url: url.href, status: raw.status,
    conclusion: raw.conclusion as string | null,
  };
}

/**
 * A bounded repository read, independent of whether any PR exists. GitHub's
 * newest-first run pages are read per workflow and trigger; a completed-only
 * query finds the last outcome even behind more than a page of pending runs.
 */
export async function readRepositoryCi(token: string,
  repository: Pick<RepositoryRecord, "id" | "ownerAccountId" | "fullName">,
  options: Options = {}): Promise<RepositoryCiReadResult> {
  const requestLimit = Number.isFinite(options.requestLimit)
    ? Math.max(0, Math.min(20, Math.floor(options.requestLimit!))) : 20;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const now = options.now ?? Date.now();
  let requestsUsed = 0;
  const names = repository.fullName.split("/");
  if (!positive(repository.id) || !positive(repository.ownerAccountId) || names.length !== 2
    || names.some((name) => !name || name === "." || name === "..")) {
    return { kind: "failed", issue: "github-unavailable", requestsUsed };
  }
  const input = options.continuation;
  if (input && (input.version !== 1 || input.repositoryId !== repository.id
    || input.ownerAccountId !== repository.ownerAccountId || input.fullName !== repository.fullName)) {
    return { kind: "failed", issue: "github-unavailable", requestsUsed };
  }
  // Do not mutate a persisted/caller-owned continuation while requests await.
  const progress: RepositoryCiContinuation = input ? structuredClone(input) : {
    version: 1, repositoryId: repository.id, ownerAccountId: repository.ownerAccountId, fullName: repository.fullName,
    phase: "metadata", inventoryPage: 1, inventoryTotal: null, inventoryComplete: false,
    workflows: [], streamIndex: 0, streams: [], current: null,
  };
  const path = `/repos/${names.map(encodeURIComponent).join("/")}`;
  const request = async (suffix: string): Promise<Record<string, unknown>> => {
    if (!shouldContinue() || requestsUsed >= requestLimit) throw new ContinueRead();
    requestsUsed++;
    const response = await githubRequest(token, `${path}${suffix}`, {}, { expectedStatus: 404 });
    if (rateLimited(response)) throw new ReadFailure("rate-limited", githubRetryAt(response!, now));
    if (response?.status === 403 || response?.status === 404) throw new ReadFailure("permission-required");
    if (!response?.ok) fail();
    return record(await responseJson(response)) ?? fail();
  };
  const runPage = async (workflow: Workflow, trigger: RepositoryCiTrigger, completedOnly: boolean) => {
    const query = new URLSearchParams({ branch: progress.defaultBranch!, event: trigger, per_page: String(PAGE_SIZE), page: "1" });
    if (completedOnly) query.set("status", "completed");
    const body = await request(`/actions/workflows/${workflow.id}/runs?${query}`);
    if (!count(body.total_count) || !Array.isArray(body.workflow_runs) || body.workflow_runs.length > PAGE_SIZE
      || body.workflow_runs.length !== Math.min(body.total_count, PAGE_SIZE)) fail();
    const selection: RunSelection = { completed: null, pending: null };
    const ids = new Set<number>();
    for (const value of body.workflow_runs) {
      const parsed = run(value, repository, workflow.id, trigger, progress.defaultBranch!, completedOnly);
      if (ids.has(parsed.id)) fail();
      ids.add(parsed.id);
      if (parsed.status === "completed") selection.completed = latest(selection.completed, parsed);
      else selection.pending = latest(selection.pending, parsed);
    }
    return { ...selection, total: body.total_count };
  };
  try {
    if (progress.phase === "metadata") {
      const body = await request("");
      identity(body, repository);
      if (body.default_branch !== null && !string(body.default_branch)) fail();
      progress.defaultBranch = body.default_branch as string | null;
      progress.phase = "inventory";
    }
    while (progress.phase === "inventory") {
      const body = await request(`/actions/workflows?per_page=${PAGE_SIZE}&page=${progress.inventoryPage}`);
      if (!count(body.total_count) || !Array.isArray(body.workflows) || body.workflows.length > PAGE_SIZE
        || progress.inventoryTotal !== null && progress.inventoryTotal !== body.total_count) fail();
      progress.inventoryTotal = body.total_count;
      const known = new Set(progress.workflows.map((workflow) => workflow.id));
      for (const value of body.workflows) {
        const raw = record(value);
        if (!raw || !positive(raw.id) || !string(raw.name) || !string(raw.state) || known.has(raw.id)) fail();
        known.add(raw.id);
        progress.workflows.push({ id: raw.id, name: raw.name, state: raw.state });
      }
      if (progress.workflows.length > progress.inventoryTotal) fail();
      if (progress.workflows.length === progress.inventoryTotal) {
        progress.inventoryComplete = true;
        progress.phase = "runs";
      } else {
        if (body.workflows.length !== PAGE_SIZE) fail();
        if (progress.inventoryPage === CI_WORKFLOW_PAGES) progress.phase = "runs";
        else progress.inventoryPage++;
      }
    }
    while (progress.streamIndex < progress.workflows.length * 2) {
      const workflow = progress.workflows[Math.floor(progress.streamIndex / 2)]!;
      const trigger: RepositoryCiTrigger = progress.streamIndex % 2 === 0 ? "push" : "schedule";
      let selection = progress.current;
      if (workflow.state !== "active" || progress.defaultBranch === null) selection = { completed: null, pending: null };
      else if (!selection) {
        const page = await runPage(workflow, trigger, false);
        selection = { completed: page.completed, pending: page.pending };
        // Save selected facts before a possible budget continuation.
        if (!selection.completed && page.total > PAGE_SIZE) progress.current = selection;
      }
      if (progress.current) {
        const completed = await runPage(workflow, trigger, true);
        selection.completed = completed.completed;
      }
      const previousData = options.previous;
      const previous = previousData && previousData.defaultBranch === progress.defaultBranch
        ? previousData.streams.find((stream) => stream.workflowId === workflow.id && stream.trigger === trigger) : undefined;
      // A delayed API response must not roll a known run back to an older
      // attempt, whether that newer attempt was completed or still pending.
      if (previous?.completed && selection.completed?.id === previous.completed.id
        && selection.completed.attempt < previous.completed.attempt) selection.completed = previous.completed;
      if (previous?.pending && (selection.completed?.id === previous.pending.id && selection.completed.attempt < previous.pending.attempt
        || selection.pending?.id === previous.pending.id && selection.pending.attempt < previous.pending.attempt)) {
        selection.pending = latest(selection.pending, previous.pending);
      }
      // Keep the known terminal outcome for this run. It dominates pending
      // replays at older/equal attempts, and remains visible during a newer
      // rerun. The comparison below discards pending replays it supersedes.
      if (selection.pending && previous?.completed?.id === selection.pending.id
        && (!selection.completed || compare(previous.completed, selection.completed) > 0)) selection.completed = previous.completed;
      const pending = selection.pending && (!selection.completed || compare(selection.pending, selection.completed) > 0) ? selection.pending : null;
      progress.streams.push({ workflowId: workflow.id, name: workflow.name, state: workflow.state, trigger, completed: selection.completed, pending });
      progress.current = null;
      progress.streamIndex++;
    }
    if (!shouldContinue()) throw new ContinueRead();
    const previousData = options.previous;
    if (!progress.inventoryComplete && previousData && previousData.defaultBranch === progress.defaultBranch) {
      const observed = new Set(progress.workflows.map((workflow) => workflow.id));
      progress.streams.push(...previousData.streams.filter((stream) => !observed.has(stream.workflowId)));
    }
    return { kind: "complete", requestsUsed, data: {
      defaultBranch: progress.defaultBranch ?? null, streams: progress.streams,
      coverage: progress.inventoryComplete ? "complete" : "incomplete",
    } };
  } catch (error) {
    if (error instanceof ContinueRead) return { kind: "continuation", continuation: progress, requestsUsed };
    const failure = error instanceof ReadFailure ? error : new ReadFailure();
    return { kind: "failed", issue: failure.issue, requestsUsed,
      ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }),
      ...(progress.defaultBranch === undefined ? {} : { defaultBranch: progress.defaultBranch }),
    };
  }
}
