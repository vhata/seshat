import type { RepositoryRecord } from "../shared/overview/protocol";
import type {
  RepositoryCiRecord,
  RepositoryCiRun,
  RepositoryCiStream,
  RepositoryCiTrigger,
} from "../shared/overview/repository-ci";
import { relativeTime } from "./freshness";
import "./RepositoryCi.css";

const ATTENTION = new Set(["failure", "timed_out", "startup_failure", "action_required", "cancelled"]);
const OUTCOMES: Record<string, string> = {
  success: "Passed",
  failure: "Failed",
  timed_out: "Timed out",
  startup_failure: "Startup failed",
  action_required: "Action required",
  cancelled: "Cancelled",
  skipped: "Skipped",
  neutral: "Neutral",
  stale: "Stale result",
};
const TRIGGERS: Record<RepositoryCiTrigger, string> = {
  push: "Default-branch push",
  schedule: "Scheduled",
};
interface RepositoryEvidence {
  repository: RepositoryRecord;
  record: RepositoryCiRecord | undefined;
}
function needsAttention(stream: RepositoryCiStream): boolean {
  return stream.state === "active" && ATTENTION.has(stream.completed?.conclusion ?? "");
}
function Time({ value, now }: { value: number; now: number }) {
  return <time dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString()}>
    {relativeTime(value, now)} ago
  </time>;
}
function runLink(repository: RepositoryRecord, run: RepositoryCiRun): string {
  // Construct a GitHub URL from the known repository and numeric run ID;
  // upstream text is displayed, never interpreted as a link destination.
  const path = repository.fullName.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${path}/actions/runs/${run.id}`;
}
function Freshness({ record, now }: { record: RepositoryCiRecord | undefined; now: number }) {
  const checkedAt = record?.check.lastSuccessfulCheckAt ?? null;
  const attempt = record?.check.latestAttempt;
  return <p className="repository-ci-freshness">
    CI last checked: {checkedAt === null ? "never" : <Time value={checkedAt} now={now} />}
    {attempt?.result === "queued" ? " · CI read queued" : attempt?.result === "running" ? " · Checking CI" :
      attempt?.result === "failed" ? " · CI read failed; cached results may be out of date" :
        attempt?.result === "interrupted" ? " · CI read interrupted" : ""}
    {checkedAt !== null && now - checkedAt > 300_000 && attempt?.result !== "failed" &&
      " · CI evidence may be out of date"}
  </p>;
}
function Issue({ record }: { record: RepositoryCiRecord | undefined }) {
  if (record?.issue === "permission-required") return <p className="repository-ci-warning">
    CI access needs approval. In <a href="https://github.com/settings/apps">GitHub App settings</a>,
    choose Permissions &amp; events, set Actions to Read-only and subscribe to Workflow run.
    Then approve the installation permission update.
  </p>;
  if (record?.issue === "rate-limited") return <p className="repository-ci-warning">
    GitHub has rate-limited CI reads. Cached outcomes do not confirm current CI status.
  </p>;
  if (record?.issue === "github-unavailable") return <p className="repository-ci-warning">
    CI could not be read from GitHub. Cached outcomes do not confirm current CI status.
  </p>;
  if (record?.issue === "history-limited" || record?.coverage === "incomplete") return <p className="repository-ci-warning">
    CI coverage is incomplete. Unread workflow history may contain other outcomes.
  </p>;
  return null;
}
function Workflow({ repository, record, stream, now }: RepositoryEvidence & {
  stream: RepositoryCiStream;
  now: number;
}) {
  const completed = stream.completed;
  const pending = stream.pending;
  const inactive = stream.state !== "active";
  const outcome = completed ? OUTCOMES[completed.conclusion ?? ""] ?? "Outcome unknown" : null;
  return <li className={`repository-ci-workflow${needsAttention(stream) ? " repository-ci-attention" : ""}`}
    data-repository-ci={`${repository.id}:${stream.workflowId}:${stream.trigger}`}>
    <div className="repository-ci-workflow-heading">
      <a className="mono repository-ci-repository" href={`https://github.com/${repository.fullName}`}>{repository.fullName}</a>
      <strong>{stream.name}</strong>
      <span className="repository-ci-trigger">{TRIGGERS[stream.trigger]} · {record?.defaultBranch ?? "branch unknown"}</span>
      <span className={`repository-ci-outcome${completed?.conclusion === "success" && !inactive ? " repository-ci-passed" : ""}`}>
        {inactive ? "Inactive workflow" : outcome ?? (pending ? "Running" : "No observed run")}
      </span>
    </div>
    {inactive && <p>Workflow state: {stream.state.replaceAll("_", " ")}.</p>}
    {completed && <p>
      {inactive ? "Last observed outcome" : "Latest completed outcome"}: {outcome}{" · "}
      <a href={runLink(repository, completed)}>Run #{completed.number}</a>{" · "}
      <code title={completed.headSha}>{completed.headSha.slice(0, 7)}</code>{" · "}
      started <Time value={completed.startedAt ?? completed.createdAt} now={now} />
      {completed.attempt > 1 ? ` · attempt ${completed.attempt}` : ""}
    </p>}
    {pending && <p className="repository-ci-pending">
      {completed ? "Replacement" : "Latest run"}{" "}
      <a href={runLink(repository, pending)}>#{pending.number}</a>{" "}
      {pending.status === "in_progress" ? "is running" : pending.status === "queued" ? "is queued" : "is pending"}
      {" · "}<code title={pending.headSha}>{pending.headSha.slice(0, 7)}</code>{" · "}
      requested <Time value={pending.createdAt} now={now} />
      {pending.attempt > 1 ? ` · attempt ${pending.attempt}` : ""}
    </p>}
    {!completed && !pending && <p>No {stream.trigger === "schedule" ? "scheduled" : "default-branch push"} run has been observed.</p>}
    <Freshness record={record} now={now} />
  </li>;
}
function OtherResults({ evidence, now }: { evidence: readonly RepositoryEvidence[]; now: number }) {
  return <>
    {evidence.map(({ repository, record }) => <div className="repository-ci-other-repository" key={repository.id}>
      <h4><a href={`https://github.com/${repository.fullName}`}>{repository.fullName}</a></h4>
      <Issue record={record} />
      <Freshness record={record} now={now} />
      {!record && <p>CI has not been checked for this repository.</p>}
      {record && record.streams.length === 0 && <p>No workflow runs have been observed. This does not establish passing CI or expected schedule coverage.</p>}
      {record && record.streams.length > 0 && <ul className="repository-ci-workflows">
        {record.streams.filter((stream) => !needsAttention(stream)).map((stream) =>
          <Workflow key={`${stream.workflowId}:${stream.trigger}`} repository={repository} record={record} stream={stream} now={now} />)}
      </ul>}
    </div>)}
  </>;
}
function AttentionResults({ evidence, now }: { evidence: readonly RepositoryEvidence[]; now: number }) {
  return <>{(["push", "schedule"] as const).map((trigger) => {
    const rows = evidence.flatMap(({ repository, record }) => (record?.streams ?? [])
      .filter((stream) => stream.trigger === trigger && needsAttention(stream))
      .map((stream) => ({ repository, record, stream })));
    return rows.length > 0 && <section className="repository-ci-attention-group" aria-label={`${TRIGGERS[trigger]} CI needing attention`} key={trigger}>
      <h3>{TRIGGERS[trigger]}</h3>
      <ul className="repository-ci-workflows">{rows.map((row) =>
        <Workflow key={`${row.repository.id}:${row.stream.workflowId}`} {...row} now={now} />)}</ul>
    </section>;
  })}</>;
}
/** Repository health includes monitored repositories with no open PRs. */
export function RepositoryCi({ repositories, records, now }: {
  repositories: readonly RepositoryRecord[];
  records?: readonly RepositoryCiRecord[];
  now: number;
}) {
  const monitored = repositories.filter((repository) => repository.monitored);
  if (monitored.length === 0) return null;
  const evidence = monitored.map((repository): RepositoryEvidence => ({
    repository,
    record: records?.find((record) => record.repositoryId === repository.id
      && record.installationId === repository.installationId && record.ownerAccountId === repository.ownerAccountId),
  })).sort((a, b) => a.repository.fullName.localeCompare(b.repository.fullName));
  const active = evidence.filter(({ repository }) => !repository.muted);
  const muted = evidence.filter(({ repository }) => repository.muted);
  const attentionCount = active.reduce((count, { record }) => count + (record?.streams.filter(needsAttention).length ?? 0), 0);
  const unknownCount = active.filter(({ record }) => !record || record.coverage === "incomplete"
    || record.issue !== null || record.check.lastSuccessfulCheckAt === null || record.check.latestAttempt?.result === "failed").length;
  const other = active.filter(({ record }) => !record || record.issue !== null || record.coverage === "incomplete"
    || record.streams.length === 0 || record.streams.some((stream) => !needsAttention(stream)));
  return <section className="repository-ci" aria-labelledby="repository-ci-title">
    <div className="repository-ci-heading">
      <h2 id="repository-ci-title">Repository CI</h2>
      <span>{attentionCount} {attentionCount === 1 ? "workflow needs" : "workflows need"} attention</span>
      {unknownCount > 0 && <span className="repository-ci-warning">{unknownCount} {unknownCount === 1 ? "repository has" : "repositories have"} unknown CI coverage</span>}
    </div>
    <p className="repository-ci-explanation">Latest observed GitHub Actions runs for default-branch pushes and schedules. Current branch head and expected schedules are not verified.</p>
    {active.filter(({ record }) => record?.issue || record?.coverage === "incomplete").map(({ repository, record }) =>
      <div className="repository-ci-access" key={repository.id}><strong>{repository.fullName}</strong><Issue record={record} /></div>)}
    {attentionCount === 0 && <p className="repository-ci-quiet">{active.length === 0
      ? "All monitored repositories are muted; their CI results are below."
      : "No observed runs in unmuted repositories need attention."}</p>}
    <AttentionResults evidence={active} now={now} />
    {other.length > 0 && <details className="repository-ci-other">
      <summary>Other CI results · {other.length} {other.length === 1 ? "repository" : "repositories"}</summary>
      <OtherResults evidence={other} now={now} />
    </details>}
    {muted.length > 0 && <details className="repository-ci-muted">
      <summary>Muted repository CI · {muted.length} {muted.length === 1 ? "repository" : "repositories"}</summary>
      <p>Muted repositories keep updating. Their CI outcomes stay here until you unmute them.</p>
      <AttentionResults evidence={muted} now={now} />
      <OtherResults evidence={muted} now={now} />
    </details>}
  </section>;
}
