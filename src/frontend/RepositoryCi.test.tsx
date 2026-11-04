import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildSnapshot, type RepositoryRecord } from "../shared/overview/protocol";
import type { RepositoryCiRecord, RepositoryCiRun, RepositoryCiStream } from "../shared/overview/repository-ci";
import { FIXTURE_NOW as now, FIXTURE_OWNER_ID, FIXTURE_REPOSITORY, SYNC_FIXTURES } from "../shared/overview/fixtures";
import { OverviewPage } from "./Overview";
import { RepositoryCi } from "./RepositoryCi";

function run(overrides: Partial<RepositoryCiRun> = {}): RepositoryCiRun {
  return {
    id: 51, attempt: 1, number: 7, createdAt: now - 120_000, updatedAt: now - 60_000,
    startedAt: now - 100_000, headSha: "123456789abcdef", url: "https://github.com/example/observatory/actions/runs/51",
    status: "completed", conclusion: "failure", ...overrides,
  };
}
function stream(overrides: Partial<RepositoryCiStream> = {}): RepositoryCiStream {
  return { workflowId: 3, name: "Integration", state: "active", trigger: "push", completed: run(), pending: null, ...overrides };
}
function record(overrides: Partial<RepositoryCiRecord> = {}): RepositoryCiRecord {
  return {
    repositoryId: FIXTURE_REPOSITORY.id, installationId: FIXTURE_REPOSITORY.installationId,
    ownerAccountId: FIXTURE_REPOSITORY.ownerAccountId, defaultBranch: "trunk",
    streams: [stream()], coverage: "complete", issue: null,
    check: { lastSuccessfulCheckAt: now - 20_000, latestAttempt: null }, ...overrides,
  };
}
function render(records: readonly RepositoryCiRecord[] | undefined, repositories: readonly RepositoryRecord[] = [FIXTURE_REPOSITORY]) {
  return renderToStaticMarkup(<RepositoryCi repositories={repositories} records={records} now={now} />);
}

describe("repository CI presentation", () => {
  it("shows failures before the PR buckets even when the repository has no open PRs", () => {
    const snapshot = { ...buildSnapshot([FIXTURE_REPOSITORY], [], SYNC_FIXTURES.live, FIXTURE_OWNER_ID, now), repositoryCi: [record()] };
    const html = renderToStaticMarkup(<OverviewPage state={{ snapshot, connected: true, now, visibleSince: now,
      lastMessageAt: now, retry: null, changes: new Map() }} onRetry={() => {}} />);
    expect(html).toContain('aria-labelledby="repository-ci-title"');
    expect(html).toContain("Integration");
    expect(html).toContain("Default-branch push · trunk");
    expect(html).toContain("Failed");
    expect(html).toContain('href="https://github.com/example/observatory/actions/runs/51"');
    expect(html).toContain("1234567");
    expect(html.indexOf('id="repository-ci-title"')).toBeLessThan(html.indexOf('aria-label="Bucket summary"'));
    expect(html).toContain("0 open PRs");
  });

  it("keeps failing scheduled evidence visible separately from a passing push run", () => {
    const html = render([record({ streams: [stream({ completed: run({ conclusion: "success" }) }), stream({ trigger: "schedule" })] })]);
    const [visible, others] = html.split('<details class="repository-ci-other">');
    expect(visible).toContain("1 workflow needs attention");
    expect(visible).toContain('aria-label="Scheduled CI needing attention"');
    expect(visible).toContain("Scheduled · trunk");
    expect(visible).not.toContain('aria-label="Default-branch push CI needing attention"');
    expect(others).toContain("Passed");
    expect(others).toContain("Default-branch push · trunk");
    expect(html).toContain("Current branch head and expected schedules are not verified");
  });

  it("retains the completed failure while a new run or rerun is pending", () => {
    const html = render([record({ streams: [stream({ pending: run({ id: 52, number: 8, conclusion: null, status: "in_progress", attempt: 2 }) })] })]);
    expect(html).toContain("Latest completed outcome");
    expect(html).toContain("Failed");
    expect(html).toContain("Replacement");
    expect(html).toContain("#8</a> is running");
    expect(html).toContain("attempt 2");
    expect(html).toContain('href="https://github.com/example/observatory/actions/runs/52"');
  });

  it("shows cancellation and action-required conclusions with accurate wording", () => {
    const cancellation = render([record({ streams: [stream({ completed: run({ conclusion: "cancelled" }) })] })]);
    expect(cancellation).toContain("1 workflow needs attention");
    expect(cancellation).toContain("Cancelled");
    expect(cancellation).not.toContain("Failed");
    const required = render([record({ streams: [stream({ completed: run({ conclusion: "action_required" }) })] })]);
    expect(required).toContain("Action required");
  });

  it.each(["timed_out", "startup_failure"])("keeps %s outcomes visible", (conclusion) => {
    const html = render([record({ streams: [stream({ completed: run({ conclusion }) })] })]);
    expect(html).toContain("1 workflow needs attention");
    expect(html).not.toContain('<details class="repository-ci-other">');
  });

  it("moves recovered, skipped, unknown, running and inactive workflows into a closed disclosure", () => {
    const html = render([record({ streams: [
      stream({ workflowId: 1, completed: run({ conclusion: "success" }) }),
      stream({ workflowId: 2, completed: run({ conclusion: "skipped" }) }),
      stream({ workflowId: 3, completed: run({ conclusion: "unexpected-future-result" }) }),
      stream({ workflowId: 4, completed: null, pending: run({ status: "queued", conclusion: null }) }),
      stream({ workflowId: 5, state: "disabled_inactivity" }),
      stream({ workflowId: 6, completed: null, pending: null }),
    ] })]);
    const [visible, others] = html.split('<details class="repository-ci-other">');
    expect(visible).toContain("0 workflows need attention");
    expect(visible).not.toContain("Integration");
    expect(others).toContain("Passed");
    expect(others).toContain("Skipped");
    expect(others).toContain("Outcome unknown");
    expect(others).toContain("is queued");
    expect(others).toContain("Inactive workflow");
    expect(others).toContain("disabled inactivity");
    expect(others).toContain("No default-branch push run has been observed");
    expect(html).not.toContain('<details class="repository-ci-other" open');
  });

  it("treats missing legacy evidence and no observed runs as unknown rather than passing", () => {
    const legacy = render(undefined);
    expect(legacy).toContain("1 repository has unknown CI coverage");
    expect(legacy).toContain("CI has not been checked");
    expect(legacy).toContain("CI last checked: never");
    expect(legacy).not.toContain("Passed");
    const empty = render([record({ streams: [] })]);
    expect(empty).toContain("No workflow runs have been observed");
    expect(empty).toContain("does not establish passing CI");
  });

  it("gives existing-App upgrade instructions without registering a new App", () => {
    const html = render([record({ issue: "permission-required", coverage: "incomplete" })]);
    expect(html).toContain("CI access needs approval");
    expect(html).toContain('href="https://github.com/settings/apps"');
    expect(html).toContain("Actions to Read-only");
    expect(html).toContain("subscribe to Workflow run");
    expect(html).toContain("approve the installation permission update");
    expect(html).not.toContain('href="/setup"');
    expect(html).toContain("1 repository has unknown CI coverage");
  });

  it.each(["rate-limited", "github-unavailable", "history-limited"] as const)("warns about %s without hiding cached failures", (issue) => {
    const html = render([record({ issue, coverage: "incomplete", check: {
      lastSuccessfulCheckAt: now - 900_000,
      latestAttempt: { id: 2, startedAt: now - 10_000, result: "failed", reason: "github-unavailable" },
    } })]);
    expect(html).toContain("Failed");
    expect(html).toContain("CI read failed; cached results may be out of date");
    expect(html).toContain("CI last checked: <time");
    expect(html).toContain("15m ago");
    expect(html).toContain("1 repository has unknown CI coverage");
  });

  it("distinguishes an old run from a recent read and warns when the read gets old", () => {
    const html = render([record({ streams: [stream({ completed: run({ startedAt: now - 8 * 86_400_000, conclusion: "success" }) })] })]);
    expect(html).toContain("8d ago");
    expect(html).toContain("20s ago");
    expect(html).not.toContain("schedule is healthy");
    const overdue = render([record({ check: { lastSuccessfulCheckAt: now - 600_000, latestAttempt: null } })]);
    expect(overdue).toContain("CI evidence may be out of date");
  });

  it("keeps muted CI in a closed disclosure and excludes unmonitored or old-identity data", () => {
    const muted = { ...FIXTURE_REPOSITORY, id: 42, fullName: "example/quiet", muted: true };
    const off = { ...FIXTURE_REPOSITORY, id: 43, fullName: "example/off", monitored: false };
    const html = render([record(), record({ repositoryId: 42 }), record({ repositoryId: 43 })], [FIXTURE_REPOSITORY, muted, off]);
    const [visible, hidden] = html.split('<details class="repository-ci-muted">');
    expect(visible).toContain("1 workflow needs attention");
    expect(visible).not.toContain("example/quiet");
    expect(hidden).toContain("Muted repository CI · 1 repository");
    expect(hidden).toContain("example/quiet");
    expect(hidden).toContain("Failed");
    expect(html).not.toContain("example/off");
    expect(html).not.toContain('<details class="repository-ci-muted" open');
    const staleIdentity = render([record({ ownerAccountId: FIXTURE_REPOSITORY.ownerAccountId + 1 })]);
    expect(staleIdentity).toContain("CI has not been checked");
    expect(staleIdentity).not.toContain("Failed");
    const staleInstallation = render([record({ installationId: FIXTURE_REPOSITORY.installationId + 1 })]);
    expect(staleInstallation).not.toContain("Failed");
    expect(render([record()], [off])).toBe("");
  });

  it("uses the known repository and numeric run ID for links and escapes GitHub text", () => {
    const html = render([record({ streams: [stream({ name: "<script>workflow</script>", completed: run({ url: "javascript:alert(1)" }) })] })]);
    expect(html).toContain("&lt;script&gt;workflow&lt;/script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://github.com/example/observatory/actions/runs/51"');
  });
});
