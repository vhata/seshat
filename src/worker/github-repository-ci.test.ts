import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryCiData, RepositoryCiRun, RepositoryCiStream } from "../shared/overview/repository-ci";
import { CI_WORKFLOW_PAGES, readRepositoryCi, type RepositoryCiContinuation } from "./github-repository-ci";
import { json, stubGitHub } from "./test-helpers";

const REPO = { id: 12, ownerAccountId: 1001, fullName: "example/observatory" };
const API = "https://api.github.com/repos/example/observatory";
const NOW = Date.parse("2026-11-04T10:00:00Z");
const WHEN = "2026-11-04T09:00:00Z";
const metadata = (changes: Record<string, unknown> = {}) => ({
  id: REPO.id, owner: { id: REPO.ownerAccountId }, full_name: REPO.fullName, default_branch: "trunk", ...changes,
});
const workflow = (id = 1, changes: Record<string, unknown> = {}) => ({ id, name: `Workflow ${id}`, state: "active", ...changes });
function run(changes: Record<string, unknown> = {}) {
  return {
    id: 11, run_attempt: 1, run_number: 1, workflow_id: 1, event: "push", head_branch: "trunk",
    head_sha: "abc123", html_url: "https://github.com/example/observatory/actions/runs/11",
    status: "completed", conclusion: "failure", created_at: WHEN, updated_at: WHEN, run_started_at: WHEN,
    repository: metadata(), ...changes,
  };
}
function wireRun(id: number, changes: Record<string, unknown> = {}) {
  return run({ id, run_number: id, html_url: `https://github.com/example/observatory/actions/runs/${id}`, ...changes });
}
function routes(options: {
  metadata?: () => Response;
  inventory?: (page: number) => Response;
  workflows?: readonly ReturnType<typeof workflow>[];
  runs?: (workflowId: number, trigger: string, completedOnly: boolean) => Response;
} = {}) {
  const inventory = options.workflows ?? [workflow()];
  return stubGitHub({
    [`GET ${API}`]: options.metadata ?? (() => json(metadata())),
    [`GET ${API}/actions/workflows`]: (call) => options.inventory?.(Number(call.url.searchParams.get("page")))
      ?? json({ total_count: inventory.length, workflows: inventory }),
    ...Object.fromEntries(inventory.map((item) => [`GET ${API}/actions/workflows/${item.id}/runs`, (call: { url: URL; headers: Headers }) => {
      expect(call.url.searchParams.get("branch")).toBe("trunk");
      expect(call.url.searchParams.get("per_page")).toBe("100");
      expect(call.headers.get("authorization")).toBe("Bearer test-token");
      return options.runs?.(item.id, call.url.searchParams.get("event")!, call.url.searchParams.get("status") === "completed")
        ?? json({ total_count: 0, workflow_runs: [] });
    }])),
  });
}
function selected(id: number, changes: Partial<RepositoryCiRun> = {}): RepositoryCiRun {
  return { id, attempt: 1, number: id, createdAt: Date.parse(WHEN), updatedAt: Date.parse(WHEN), startedAt: Date.parse(WHEN),
    headSha: "abc123", url: `https://github.com/example/observatory/actions/runs/${id}`, status: "completed", conclusion: "failure", ...changes };
}
function previous(streams: readonly Partial<RepositoryCiStream>[], defaultBranch = "trunk"): RepositoryCiData {
  return { defaultBranch, coverage: "complete", streams: streams.map((changes) => ({
    workflowId: 1, name: "Workflow 1", state: "active", trigger: "push", completed: selected(11), pending: null, ...changes,
  })) };
}
afterEach(() => vi.restoreAllMocks());

describe("repository CI reader", () => {
  it("reads workflow and trigger streams independently on the actual default branch", async () => {
    const github = routes({ workflows: [workflow(), workflow(2)], runs: (id, trigger) => {
      const result = id === 1 && trigger === "push" ? [run({ conclusion: "success" })]
        : id === 2 && trigger === "schedule" ? [run({ workflow_id: 2, event: "schedule" })] : [];
      return json({ total_count: result.length, workflow_runs: result });
    } });
    const result = await readRepositoryCi("test-token", REPO);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("expected complete read");
    expect(result.requestsUsed).toBe(6);
    expect(result.data).toMatchObject({ defaultBranch: "trunk", coverage: "complete", streams: [
      { workflowId: 1, trigger: "push", completed: { conclusion: "success" } },
      { workflowId: 1, trigger: "schedule", completed: null },
      { workflowId: 2, trigger: "push", completed: null },
      { workflowId: 2, trigger: "schedule", completed: { conclusion: "failure" } },
    ] });
    expect(github.calls).toHaveLength(6);
  });

  it("orders by creation rather than completion time and shows only newer pending runs", async () => {
    routes({ runs: (_id, trigger) => json({ total_count: trigger === "push" ? 4 : 0, workflow_runs: trigger === "push" ? [
      wireRun(10, { created_at: "2026-11-03T09:00:00Z", updated_at: "2026-11-04T09:59:00Z" }),
      wireRun(12, { conclusion: "success" }),
      wireRun(9, { created_at: "2026-11-03T08:00:00Z", status: "in_progress", conclusion: null }),
      wireRun(13, { created_at: "2026-11-04T09:01:00Z", status: "queued", conclusion: null, run_started_at: null }),
    ] : [] }) });
    const result = await readRepositoryCi("test-token", REPO);
    expect(result.kind === "complete" && result.data.streams[0]).toMatchObject({ completed: { id: 12, conclusion: "success" }, pending: { id: 13, startedAt: null } });
  });

  it("finds the last completed outcome behind more than 100 pending runs without scanning push history", async () => {
    const github = routes({ runs: (_id, trigger, completedOnly) => {
      if (trigger === "schedule") return json({ total_count: 0, workflow_runs: [] });
      if (completedOnly) return json({ total_count: 9_000, workflow_runs: Array.from({ length: 100 }, (_, index) => wireRun(100 - index)) });
      return json({ total_count: 10_000, workflow_runs: Array.from({ length: 100 }, (_, index) => wireRun(10_000 - index, {
        status: "queued", conclusion: null, created_at: "2026-11-04T09:01:00Z",
      })) });
    } });
    const result = await readRepositoryCi("test-token", REPO);
    expect(result.kind === "complete" && result.data.streams[0]).toMatchObject({ completed: { id: 100 }, pending: { id: 10_000 } });
    expect(github.calls).toHaveLength(5);
    expect(github.calls.filter((call) => call.url.searchParams.get("status") === "completed")).toHaveLength(1);
  });

  it("persists budget continuations as selected facts and resumes without replaying requests", async () => {
    const github = routes({ runs: (_id, trigger) => json({ total_count: trigger === "push" ? 1 : 0, workflow_runs: trigger === "push" ? [run({ arbitrary_secret: "must-not-persist" })] : [] }) });
    let continuation: RepositoryCiContinuation | null = null;
    for (let index = 0; index < 4; index++) {
      const result = await readRepositoryCi("test-token", REPO, { requestLimit: 1, continuation });
      expect(result.requestsUsed).toBe(1);
      if (result.kind === "continuation") {
        expect(JSON.stringify(result)).not.toContain("test-token");
        expect(JSON.stringify(result)).not.toContain("must-not-persist");
        continuation = JSON.parse(JSON.stringify(result.continuation)) as RepositoryCiContinuation;
      } else {
        expect(index).toBe(3);
        expect(result.kind === "complete" && result.data.streams[0]?.completed?.conclusion).toBe("failure");
      }
    }
    expect(github.calls).toHaveLength(4);
  });

  it("resumes a completed-only query after a budget boundary", async () => {
    routes({ runs: (_id, trigger, completedOnly) => trigger === "schedule" ? json({ total_count: 0, workflow_runs: [] })
      : completedOnly ? json({ total_count: 1, workflow_runs: [run()] })
        : json({ total_count: 101, workflow_runs: Array.from({ length: 100 }, (_, index) => wireRun(index + 100, { status: "in_progress", conclusion: null })) }) });
    const first = await readRepositoryCi("test-token", REPO, { requestLimit: 3 });
    expect(first.kind).toBe("continuation");
    if (first.kind !== "continuation") throw new Error("expected continuation");
    expect(first.continuation.current?.pending?.id).toBe(199);
    const saved = JSON.stringify(first.continuation);
    const result = await readRepositoryCi("test-token", REPO, { continuation: first.continuation });
    expect(JSON.stringify(first.continuation)).toBe(saved);
    expect(result.kind === "complete" && result.data.streams[0]).toMatchObject({ completed: { id: 11 }, pending: { id: 199 } });
    expect(result.requestsUsed).toBe(2);
  });

  it("retains a completed failure while its same-run rerun is pending", async () => {
    routes({ runs: (_id, trigger) => json({ total_count: trigger === "push" ? 2 : 0, workflow_runs: trigger === "push" ? [
      wireRun(11, { run_attempt: 2, status: "in_progress", conclusion: null }),
      wireRun(10, { conclusion: "success", created_at: "2026-11-03T09:00:00Z" }),
    ] : [] }) });
    const result = await readRepositoryCi("test-token", REPO, { previous: previous([{}]) });
    expect(result.kind === "complete" && result.data.streams[0]).toMatchObject({ completed: { id: 11, attempt: 1, conclusion: "failure" }, pending: { id: 11, attempt: 2 } });
  });

  it("records an unknown start time for a queued run without run_started_at", async () => {
    routes({ runs: (_id, trigger) => json({ total_count: trigger === "push" ? 1 : 0,
      workflow_runs: trigger === "push" ? [run({ status: "queued", conclusion: null, run_started_at: undefined })] : [] }) });
    const result = await readRepositoryCi("test-token", REPO);
    expect(result.kind === "complete" && result.data.streams[0]?.pending).toMatchObject({ status: "queued", startedAt: null });
  });

  it("does not roll a previously completed rerun back to an older successful attempt", async () => {
    routes({ runs: (_id, trigger) => json({ total_count: trigger === "push" ? 1 : 0,
      workflow_runs: trigger === "push" ? [run({ conclusion: "success", run_attempt: 1 })] : [] }) });
    const result = await readRepositoryCi("test-token", REPO, { previous: previous([{ completed: selected(11, { attempt: 2 }) }]) });
    expect(result.kind === "complete" && result.data.streams[0]).toMatchObject({ completed: { id: 11, attempt: 2, conclusion: "failure" }, pending: null });
  });

  it("does not erase a known pending rerun when the API replays its older completed attempt", async () => {
    routes({ runs: (_id, trigger) => json({ total_count: trigger === "push" ? 1 : 0,
      workflow_runs: trigger === "push" ? [run()] : [] }) });
    const result = await readRepositoryCi("test-token", REPO, { previous: previous([{ pending: selected(11, { attempt: 2, status: "in_progress", conclusion: null }) }]) });
    expect(result.kind === "complete" && result.data.streams[0]).toMatchObject({ completed: { id: 11, attempt: 1, conclusion: "failure" }, pending: { id: 11, attempt: 2 } });
  });

  it("lets a newer successful run clear the previous failure", async () => {
    routes({ runs: (_id, trigger) => json({ total_count: trigger === "push" ? 1 : 0,
      workflow_runs: trigger === "push" ? [wireRun(12, { conclusion: "success", created_at: "2026-11-04T09:01:00Z" })] : [] }) });
    const result = await readRepositoryCi("test-token", REPO, { previous: previous([{}]) });
    expect(result.kind === "complete" && result.data.streams[0]?.completed).toMatchObject({ id: 12, conclusion: "success" });
  });

  it("never retains prior-branch evidence after the default branch changes", async () => {
    routes({ runs: (_id, trigger) => json({ total_count: trigger === "push" ? 1 : 0,
      workflow_runs: trigger === "push" ? [wireRun(11, { run_attempt: 2, status: "queued", conclusion: null })] : [] }) });
    const result = await readRepositoryCi("test-token", REPO, { previous: previous([{}], "old-main") });
    expect(result.kind === "complete" && result.data.streams[0]).toMatchObject({ completed: null, pending: { id: 11, attempt: 2 } });
  });

  it("paginates authoritative inventory and treats disabled workflows as inactive", async () => {
    const github = routes({ inventory: (page) => json({ total_count: 101, workflows: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => workflow((page - 1) * 100 + index + 1, { state: "disabled_inactivity" })) }) });
    const result = await readRepositoryCi("test-token", REPO);
    expect(result.kind === "complete" && result.data.coverage).toBe("complete");
    expect(result.kind === "complete" && result.data.streams).toHaveLength(202);
    expect(result.kind === "complete" && result.data.streams.every((stream) => stream.state === "disabled_inactivity" && stream.completed === null && stream.pending === null)).toBe(true);
    expect(github.calls).toHaveLength(3);
  });

  it("retains unseen prior workflows when inventory exceeds its page cap", async () => {
    const lastId = CI_WORKFLOW_PAGES * 100 + 1;
    const github = routes({ inventory: (page) => json({ total_count: lastId, workflows: Array.from({ length: 100 }, (_, index) => workflow((page - 1) * 100 + index + 1, { state: "disabled_manually" })) }) });
    const result = await readRepositoryCi("test-token", REPO, { previous: previous([{ workflowId: lastId }]) });
    expect(result.kind === "complete" && result.data.coverage).toBe("incomplete");
    expect(result.kind === "complete" && result.data.streams.at(-1)).toMatchObject({ workflowId: lastId, completed: { conclusion: "failure" } });
    expect(github.calls).toHaveLength(CI_WORKFLOW_PAGES + 1);
  });

  it("drops deleted workflows only after a complete inventory", async () => {
    routes({ workflows: [] });
    expect(await readRepositoryCi("test-token", REPO, { previous: previous([{}]) })).toMatchObject({ kind: "complete", data: { coverage: "complete", streams: [] } });
  });

  for (const status of [403, 404]) it(`reports actionable missing Actions permission for HTTP ${status}`, async () => {
    routes({ inventory: () => json({}, status) });
    expect(await readRepositoryCi("test-token", REPO)).toEqual({ kind: "failed", issue: "permission-required", requestsUsed: 2, defaultBranch: "trunk" });
  });

  it("reports primary and secondary throttle deadlines before permission errors", async () => {
    routes({ inventory: () => new Response(null, { status: 403, headers: { "retry-after": "90", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 60_000) / 1000) } }) });
    expect(await readRepositoryCi("test-token", REPO, { now: NOW })).toEqual({ kind: "failed", issue: "rate-limited", requestsUsed: 2, retryAt: NOW + 90_000, defaultBranch: "trunk" });
  });

  it("retains known branch identity when a later read fails", async () => {
    routes({ inventory: () => json({}, 500) });
    expect(await readRepositoryCi("test-token", REPO)).toEqual({ kind: "failed", issue: "github-unavailable", requestsUsed: 2, defaultBranch: "trunk" });
  });

  for (const changes of [{ id: 99 }, { owner: { id: 99 } }, { full_name: "example/another" }]) it(`rejects changed repository identity ${JSON.stringify(changes)}`, async () => {
    routes({ metadata: () => json(metadata(changes)) });
    expect(await readRepositoryCi("test-token", REPO)).toEqual({ kind: "failed", issue: "github-unavailable", requestsUsed: 1 });
  });

  for (const changes of [
    { workflow_id: 2 }, { event: "pull_request" }, { head_branch: "other" },
    { repository: metadata({ owner: { id: 99 } }) }, { created_at: "invalid" },
    { html_url: "javascript:alert(1)" }, { html_url: "https://evil.example/actions/runs/11" },
    { html_url: "https://secret@github.com/example/observatory/actions/runs/11" },
    { html_url: "https://github.com/example/another/actions/runs/11" },
  ]) it(`rejects malformed or cross-scope run fields ${JSON.stringify(changes)}`, async () => {
    routes({ runs: () => json({ total_count: 1, workflow_runs: [run(changes)] }) });
    expect(await readRepositoryCi("test-token", REPO)).toMatchObject({ kind: "failed", issue: "github-unavailable", requestsUsed: 3 });
  });

  it("does not turn unknown completed conclusions into success", async () => {
    routes({ runs: (_id, trigger) => json({ total_count: trigger === "push" ? 1 : 0,
      workflow_runs: trigger === "push" ? [run({ conclusion: "new_unknown_conclusion" })] : [] }) });
    const result = await readRepositoryCi("test-token", REPO);
    expect(result.kind === "complete" && result.data.streams[0]?.completed?.conclusion).toBe("new_unknown_conclusion");
  });

  it("does no work when the request budget is zero or observation is canceled", async () => {
    expect(await readRepositoryCi("test-token", REPO, { requestLimit: 0 })).toMatchObject({ kind: "continuation", requestsUsed: 0 });
    expect(await readRepositoryCi("test-token", REPO, { shouldContinue: () => false })).toMatchObject({ kind: "continuation", requestsUsed: 0 });
  });

  it("caps a caller's oversized invocation budget at twenty requests", async () => {
    const github = routes({ workflows: Array.from({ length: 20 }, (_, index) => workflow(index + 1)) });
    expect(await readRepositoryCi("test-token", REPO, { requestLimit: 100 })).toMatchObject({ kind: "continuation", requestsUsed: 20 });
    expect(github.calls).toHaveLength(20);
  });

  it("rejects continuations from another repository or owner without sending requests", async () => {
    const first = await readRepositoryCi("test-token", REPO, { requestLimit: 0 });
    if (first.kind !== "continuation") throw new Error("expected continuation");
    expect(await readRepositoryCi("test-token", { ...REPO, ownerAccountId: 99 }, { continuation: first.continuation })).toEqual({ kind: "failed", issue: "github-unavailable", requestsUsed: 0 });
    expect(await readRepositoryCi("test-token", { ...REPO, fullName: "example/another" }, { continuation: first.continuation })).toEqual({ kind: "failed", issue: "github-unavailable", requestsUsed: 0 });
  });

  it("rejects repository paths with a traversal segment before sending requests", async () => {
    expect(await readRepositoryCi("test-token", { ...REPO, fullName: "example/.." })).toEqual({ kind: "failed", issue: "github-unavailable", requestsUsed: 0 });
  });

  for (const body of [
    { total_count: 2, workflows: [workflow()] },
    { total_count: 2, workflows: [workflow(), workflow()] },
    { total_count: 1, workflows: [workflow(1, { state: null })] },
  ]) it("rejects incomplete or malformed inventory without deleting previous evidence", async () => {
    routes({ inventory: () => json(body) });
    expect(await readRepositoryCi("test-token", REPO, { previous: previous([{}]) })).toMatchObject({ kind: "failed", issue: "github-unavailable" });
  });
});
