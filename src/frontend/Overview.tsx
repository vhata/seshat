import { useEffect, useRef, useState } from "react";
import type { BucketId } from "../shared/overview/buckets";
import {
  INITIAL_SYNC,
  type CheckStatus,
  type OverviewRowDto,
  type OverviewSnapshot,
  type RepositoryRecord,
  type SyncFailureReason,
} from "../shared/overview/protocol";
import { freshness, isOverdue, relativeTime } from "./freshness";
import { CheckFreshness } from "./CheckFreshness";
import {
  browserEnvironment,
  startOverviewClient,
  type ChangeNote,
  type OverviewState,
} from "./overview-client";
import { AppHeader } from "./AppHeader";
import { MutedRepositories } from "./MutedRepositories";
import { RepositoryRefresh } from "./RepositoryRefresh";

const RULES: Record<BucketId, string> = {
  "ready-to-land":
    "Not draft · CI passing or none · no conflicts · no changes requested · approved at this head, or yours",
  broken: "Your PR · not draft · CI failing or merge conflicts",
  "awaiting-your-review":
    "Someone else's PR · not draft · you haven't reviewed this head",
  "changes-requested-on-yours":
    "Your PR · not draft · a trusted reviewer requested changes",
  "ci-running": "Not draft · checks still in progress",
  "waiting-on-the-author":
    "Someone else's PR · not draft · you've reviewed this head",
  draft: "Draft work in progress, whoever opened it",
};
const GLYPHS: Record<BucketId, string> = {
  "ready-to-land": "✓",
  broken: "×",
  "awaiting-your-review": "◉",
  "changes-requested-on-yours": "↶",
  "ci-running": "◌",
  "waiting-on-the-author": "…",
  draft: "◇",
};
const REASONS: Record<SyncFailureReason, string> = {
  "github-unavailable": "GitHub data could not be read.",
  "rate-limited": "The GitHub App has reached its rate limit.",
  "installation-suspended": "The GitHub App installation is suspended.",
  "installation-removed": "The GitHub App installation was removed.",
  "cloudflare-quota": "The instance has reached its Cloudflare quota.",
};
function absoluteTime(time: number | null) {
  return time === null || !Number.isFinite(time)
    ? "Unknown"
    : new Date(time).toLocaleString();
}
function Time({
  value,
  now,
  prefix = "",
}: {
  value: number | null;
  now: number;
  prefix?: string;
}) {
  return (
    <time
      dateTime={value === null ? undefined : new Date(value).toISOString()}
      title={absoluteTime(value)}
    >
      {prefix}
      {relativeTime(value, now)}
      {value === null ? "" : " ago"}
    </time>
  );
}
function ownerReview(row: OverviewRowDto, ownerId: number) {
  if (row.facts.isOwners) return null;
  const reviews = row.pr.reviews.filter(
    (r) =>
      r.author?.id === ownerId &&
      r.state !== "pending" &&
      r.submittedAt !== null,
  );
  const current = reviews
    .filter((r) => r.commitSha === row.pr.headSha)
    .map((review, index) => ({ review, index }))
    .sort(
      (a, b) =>
        (a.review.submittedAt ?? 0) - (b.review.submittedAt ?? 0) ||
        a.index - b.index,
    )
    .at(-1)?.review;
  if (current) {
    const label = {
      approved: "you approved this head",
      changes_requested: "you requested changes at this head",
      commented: "you commented at this head",
      dismissed: "your review at this head was dismissed",
      pending: "",
    }[current.state];
    return label;
  }
  return reviews.length
    ? "you: older commit"
    : "you haven't reviewed this head";
}
function PrRow({
  row,
  now,
  ownerId,
  note,
  outdated,
  repositoryStatus,
  repository,
  refreshStatus,
  prStatus,
  visibleSince,
}: {
  row: OverviewRowDto;
  now: number;
  ownerId: number;
  note?: ChangeNote;
  outdated: boolean;
  repositoryStatus?: CheckStatus;
  repository?: RepositoryRecord;
  refreshStatus?: CheckStatus;
  prStatus?: CheckStatus;
  visibleSince: number;
}) {
  const { pr, facts } = row;
  const review = {
    none: "none",
    approved: "approved",
    changes_requested: "changes requested",
  }[facts.reviewState];
  const ci = {
    none: "– no CI",
    passing: "✓ passing",
    failing: "× failing",
    pending: "◌ pending",
  }[facts.ci];
  const merge = {
    mergeable: "○ no conflicts",
    conflicting: "≠ conflicts",
    unknown: "◌ checking mergeability",
  }[facts.mergeable];
  const annotation = ownerReview(row, ownerId);
  return (
    <li className={`pr-row${note ? " changed" : ""}`} data-pr={pr.nodeId}>
      <div className="repository mono">
        <a href={`https://github.com/${pr.repository.fullName}`}>
          {pr.repository.fullName}
        </a>
        <CheckFreshness
          repositoryName={pr.repository.fullName}
          repositoryStatus={repositoryStatus}
          prStatus={prStatus}
          prNumber={pr.number}
          now={now}
          visibleSince={visibleSince}
        />
        {repository && <RepositoryRefresh
          key={`${repository.id}:${repository.ownerAccountId}:${repository.installationId}`}
          repository={repository}
          status={refreshStatus}
          now={now}
        />}
      </div>
      <div className="pr-title">
        <a href={pr.url}>{pr.title}</a>{" "}
        <span className="muted mono">#{pr.number}</span>
        <span className="badge">{pr.isDraft ? "draft" : "open"}</span>
        {row.stale && (
          <span className="badge stale" title="Inactivity: time since PR activity, independent of GitHub check freshness.">
            ◷ stale {relativeTime(row.lastActivityAt, now)}
          </span>
        )}
        {note && (
          <small className="change-note">
            {note.text} · {relativeTime(note.at, now)} ago
          </small>
        )}
        {outdated && (
          <small className="outdated-note">May be out of date</small>
        )}
      </div>
      <div className="author">
        {pr.author ? (
          <a href={`https://github.com/${encodeURIComponent(pr.author.login)}`}>
            {facts.isOwners ? "you" : pr.author.login}
          </a>
        ) : (
          "Unknown author"
        )}
        {pr.author?.isBot && <span className="badge">bot</span>}
      </div>
      <span className={`fact mono ci-${facts.ci}`}>
        <span className="mobile-label">CI </span>
        {ci}
      </span>
      <span className={`fact review-${facts.reviewState}`}>
        <span className="mobile-label">Review </span>
        {review}
        {annotation && <small>{annotation}</small>}
      </span>
      <span className={`fact mono merge-${facts.mergeable}`}>{merge}</span>
      <span className="age">
        <span className="mobile-label">Opened </span>
        <Time value={pr.activity.openedAt} now={now} />
      </span>
      <span className="active">
        <span className="mobile-label">Active </span>
        <Time value={row.lastActivityAt} now={now} />
      </span>
    </li>
  );
}
export function OverviewPage({
  state,
  onRetry,
}: {
  state: OverviewState;
  onRetry: () => void;
}) {
  const snapshot = state.snapshot;
  const status = freshness({ ...state, sync: snapshot?.sync ?? INITIAL_SYNC });
  const outdated =
    snapshot !== null &&
    (status === "Sync failed" ||
      status === "Overdue" ||
      (status === "Disconnected" && isOverdue(snapshot.sync, state.now)));
  const lastSuccess = snapshot?.sync.lastSuccessfulSweepAt ?? null;
  const attempt = snapshot?.sync.latestAttempt;
  const retryCoolingDown = state.retry !== null &&
    state.now - state.retry.requestedAt < 15_000;
  const retryButton = (
    <button type="button" onClick={onRetry} disabled={retryCoolingDown}>
      {retryCoolingDown ? "Retry requested" : "Retry now"}
    </button>
  );
  return (
    <>
      <AppHeader page="overview">
        <div
          className={`sync-pill status-${status.toLowerCase().replaceAll(" ", "-")}`}
          role="status"
        >
          ● {status}
        </div>
      </AppHeader>
      <div className="last-check">
        {lastSuccess === null ? (
          "Last full check: never"
        ) : (
          <>
            Last full check: <Time value={lastSuccess} now={state.now} />
          </>
        )}
        {snapshot?.sync.slowedByRateLimit && (
          <span>
            {" "}
            · Checking every {snapshot.sync.intervalMs / 60_000} minutes to
            conserve the GitHub App's rate limit.
          </span>
        )}
      </div>
      {(status === "Overdue" ||
        status === "Sync failed" ||
        status === "Disconnected") && (
        <aside className="sync-banner" role="alert">
          <div>
            <strong>
              {status === "Overdue"
                ? "Sync overdue — these pull requests may be out of date"
                : status === "Sync failed"
                  ? "Sync failed — the sweep and its retry both failed"
                  : "Disconnected — reconnecting to the instance"}
            </strong>
            <p>
              {status === "Sync failed" && attempt?.result === "failed" ? (
                REASONS[attempt.reason]
              ) : status === "Overdue" ? (
                lastSuccess === null
                  ? "No GitHub check has completed successfully yet. The instance is being asked to check again."
                  : "The last successful check is more than five minutes old. The instance is being asked to check again."
              ) : (
                <>
                  Last message:{" "}
                  {state.lastMessageAt === null ? (
                    "none received"
                  ) : (
                    <Time value={state.lastMessageAt} now={state.now} />
                  )}
                  . Changes will resume when the connection returns.
                </>
              )}
              {status === "Sync failed" &&
                attempt?.result === "failed" &&
                attempt.unreadableRepositoryIds.length > 0 && (
                  <>
                    {" "}
                    Could not read:{" "}
                    {attempt.unreadableRepositoryIds
                      .map(
                        (id) =>
                          snapshot?.repositories.find((repo) => repo.id === id)
                            ?.fullName ?? `repository ${id}`,
                      )
                      .join(", ")}
                    .
                  </>
                )}
            </p>
          </div>
          {retryButton}
        </aside>
      )}
      {status === "Checking" && (
        <p className="checking" role="status">
          Checking with GitHub
          {snapshot?.sync.lastSuccessfulSweepAt === null
            ? " — loading the first overview…"
            : "…"}
        </p>
      )}
      {state.retry && (
        <p className="retry-feedback" role="status">
          {state.retry.phase === "checking-session" ? (
            <>Retry queued — checking your session before reconnecting.</>
          ) : state.retry.phase === "connecting" ? (
            <>Retry queued — reconnecting to the instance.</>
          ) : (
            <>Retry request sent.</>
          )}
          {" "}Requested <Time value={state.retry.requestedAt} now={state.now} />.
          {state.retry.phase === "sent" && " Sending a request does not confirm that the check has completed."}
        </p>
      )}
      {status !== "Live" && (
        <section className="sync-details" aria-label="Sync details">
          {status === "Checking" && (
            <p>
              Waiting for a completed GitHub check for{" "}
              {relativeTime(state.visibleSince, state.now)} since this page
              became visible. After a minute, an unfinished check is marked
              overdue.
            </p>
          )}
          <p>
            {attempt?.result === "running" ? (
              <>
                Last reported check started{" "}
                <Time value={attempt.startedAt} now={state.now} />. No
                completion has been reported.
              </>
            ) : attempt?.result === "failed" ? (
              <>
                The last reported check and its retry failed. Check started{" "}
                <Time value={attempt.startedAt} now={state.now} />. {REASONS[attempt.reason]}{" "}
                A new check has not yet confirmed recovery.
              </>
            ) : attempt?.result === "success" ? (
              <>No newer GitHub check has been reported.</>
            ) : (
              <>The instance has not reported a GitHub check starting yet.</>
            )}
          </p>
          <p>
            Last overview update from the instance:{" "}
            {state.lastMessageAt === null ? (
              "none received"
            ) : (
              <Time value={state.lastMessageAt} now={state.now} />
            )}
            . An update does not by itself mean a GitHub check completed.
          </p>
          {status === "Checking" && (
            retryButton
          )}
          <details>
            <summary>Why is this taking so long?</summary>
            <p>
              Repository and PR details show their own checks. To investigate
              a delay, run <code>seshat site logs</code>{" "}
              from your configured checkout, then keep this overview visible
              and choose Retry now. Logs show new events only; look for{" "}
              <code>seshat.github.failure</code> for a failure reason and the
              step that failed. A quiet log does not confirm progress. Stop
              with Ctrl-C when finished.
            </p>
          </details>
        </section>
      )}
      <main id="overview">
        {!snapshot ? (
          <div className="empty">
            <h1>Loading your PR overview</h1>
            <p>Waiting for the instance to send its snapshot.</p>
          </div>
        ) : (
          <>
            <RepositoryChecks snapshot={snapshot} now={state.now} visibleSince={state.visibleSince} />
            <SnapshotContent
              snapshot={snapshot}
              state={state}
              outdated={outdated}
            />
          </>
        )}
      </main>
      <footer>Pull requests and status come from GitHub's API.</footer>
    </>
  );
}
function RepositoryChecks({ snapshot, now, visibleSince }: {
  snapshot: OverviewSnapshot;
  now: number;
  visibleSince: number;
}) {
  const monitored = snapshot.repositories.filter((repo) => repo.monitored);
  if (monitored.length === 0) return null;
  const failed = monitored.filter((repo) => snapshot.freshness?.repositories[String(repo.id)]?.latestAttempt?.result === "failed").length;
  return (
    <details className="repository-checks">
      <summary>
        Repository checks · {monitored.length} monitored{failed > 0 ? ` · ${failed} failed` : ""}
      </summary>
      <p>Complete repository checks include repositories with no open PRs.</p>
      <ul>
        {monitored.map((repo) => (
          <li key={repo.id}>
            <a href={`https://github.com/${repo.fullName}`} className="mono">{repo.fullName}</a>
            <CheckFreshness
              repositoryName={repo.fullName}
              repositoryStatus={snapshot.freshness?.repositories[String(repo.id)]}
              now={now}
              visibleSince={visibleSince}
            />
            <RepositoryRefresh
              key={`${repo.id}:${repo.ownerAccountId}:${repo.installationId}`}
              repository={repo}
              status={snapshot.freshness?.repositoryRefreshes?.[String(repo.id)]}
              now={now}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}
function SnapshotContent({
  snapshot,
  state,
  outdated,
}: {
  snapshot: OverviewSnapshot;
  state: OverviewState;
  outdated: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const monitoredRepositories = snapshot.repositories.filter((repo) => repo.monitored);
  const mutedRepositories = monitoredRepositories.filter((repo) => repo.muted);
  const mutedIds = new Set(mutedRepositories.map((repo) => repo.id));
  const activeBuckets = snapshot.buckets.map((bucket) => ({
    ...bucket, rows: bucket.rows.filter((row) => !mutedIds.has(row.pr.repositoryId)),
  }));
  const mutedBuckets = snapshot.buckets.map((bucket) => ({
    ...bucket, rows: bucket.rows.filter((row) => mutedIds.has(row.pr.repositoryId)),
  }));
  const count = activeBuckets.reduce((n, b) => n + b.rows.length, 0);
  const mutedCount = mutedBuckets.reduce((n, b) => n + b.rows.length, 0);
  const monitored = monitoredRepositories.length;
  const activeRepositories = monitored - mutedRepositories.length;
  const initial = snapshot.sync.lastSuccessfulSweepAt === null;
  function jump(id: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
    requestAnimationFrame(() =>
      document
        .getElementById(id)
        ?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  }
  if (initial && count + mutedCount === 0)
    return (
      <div className="empty">
        <h1>Loading your first overview</h1>
        <p>
          The first successful GitHub check will fill this page. Stored data
          will stay visible during later checks.
        </p>
      </div>
    );
  if (monitored === 0)
    return (
      <div className="empty">
        <h1>No repositories monitored yet</h1>
        <p>
          Owned repositories are monitored by default, unless they are forks or
          archived. Choose repositories to include here.
        </p>
        <a href="/repositories">Choose repositories</a>
      </div>
    );
  return (
    <>
      <div className="summary" aria-label="Bucket summary">
        {(["needs-you", "waiting"] as const).map((group) => (
          <div key={group} className="summary-group">
            <div className="eyebrow">
              {group === "needs-you" ? "Needs you" : "Waiting"} ·{" "}
              {activeBuckets
                .filter((b) => b.bucket.group === group)
                .reduce((n, b) => n + b.rows.length, 0)}
            </div>
            <div className="chips">
              {activeBuckets
                .filter((b) => b.bucket.group === group)
                .map(({ bucket, rows }) => (
                  <button
                    type="button"
                    key={bucket.id}
                    onClick={() => jump(bucket.id)}
                    className={
                      rows.some((r) => state.changes.has(r.pr.nodeId))
                        ? "chip changed-chip"
                        : "chip"
                    }
                  >
                    <span className={`glyph ${bucket.id}`}>
                      {GLYPHS[bucket.id]}
                    </span>
                    <strong>{rows.length}</strong>
                    {bucket.title}
                  </button>
                ))}
            </div>
          </div>
        ))}
        <span className="count-line mono">
          {outdated ? (
            <>
              As of {absoluteTime(snapshot.sync.lastSuccessfulSweepAt)} · may be
              out of date
            </>
          ) : (
            <>
              {count} open PRs · {activeRepositories} repositories
            </>
          )}
        </span>
      </div>
      {count === 0 && (
        <div className="empty">
          <h1>{mutedCount > 0 ? "No active pull requests" : "No open pull requests"}</h1>
          <p>
            {mutedCount > 0
              ? "All open pull requests are in Muted repositories below."
              : "No open pull requests were reported on your monitored repositories at the last successful check."}
          </p>
          <a href="/repositories">Manage repositories</a>
        </div>
      )}
      <div className={`buckets${outdated ? " outdated" : ""}`}>
        <div className="column-head">
          <span>Repository</span>
          <span>Pull request</span>
          <span>Author</span>
          <span>CI</span>
          <span>Review</span>
          <span>Merge</span>
          <span>Age</span>
          <span>Active</span>
        </div>
        {(["needs-you", "waiting"] as const).map((group) => {
          const buckets = activeBuckets.filter(
            (b) => b.bucket.group === group,
          );
          const groupCount = buckets.reduce((n, b) => n + b.rows.length, 0);
          return (
            <section
              className="group"
              key={group}
              aria-label={group === "needs-you" ? "Needs you" : "Waiting"}
            >
              <div className="group-heading">
                <h2>
                  {group === "needs-you" ? "Needs you" : "Waiting"}{" "}
                  <span className="muted">{groupCount}</span>
                </h2>
                <span>
                  Order:{" "}
                  {group === "needs-you"
                    ? "longest waiting first"
                    : "latest activity first"}
                </span>
              </div>
              {group === "needs-you" && groupCount === 0 && count > 0 && (
                <div className="all-clear">
                  <strong>✓ Nothing needs you</strong>
                  <p>
                    The remaining pull requests are waiting on checks, their
                    authors, or are drafts.
                  </p>
                </div>
              )}
              {buckets.map(({ bucket, rows }) => (
                <section className="bucket" id={bucket.id} key={bucket.id}>
                  <h3>
                    <button
                      type="button"
                      aria-expanded={!collapsed.has(bucket.id)}
                      aria-controls={`rows-${bucket.id}`}
                      onClick={() =>
                        setCollapsed((previous) => {
                          const next = new Set(previous);
                          if (next.has(bucket.id)) next.delete(bucket.id);
                          else next.add(bucket.id);
                          return next;
                        })
                      }
                    >
                      <span className={`glyph ${bucket.id}`}>
                        {GLYPHS[bucket.id]}
                      </span>
                      <strong>{bucket.title}</strong>
                      <span className="mono">{rows.length}</span>
                      <span className="rule">{RULES[bucket.id]}</span>
                      <span className="chevron">
                        {collapsed.has(bucket.id) ? "▸" : "▾"}
                      </span>
                    </button>
                  </h3>
                  <div
                    id={`rows-${bucket.id}`}
                    hidden={collapsed.has(bucket.id)}
                  >
                    {rows.length === 0 ? (
                      <p className="none">None right now</p>
                    ) : (
                      <ul className="pr-list">
                        {rows.map((row) => (
                          <PrRow
                            key={row.pr.nodeId}
                            row={row}
                            ownerId={snapshot.ownerId}
                            now={state.now}
                            note={state.changes.get(row.pr.nodeId)}
                            outdated={outdated}
                            repositoryStatus={snapshot.freshness?.repositories[String(row.pr.repositoryId)]}
                            repository={snapshot.repositories.find((repo) => repo.id === row.pr.repositoryId)}
                            refreshStatus={snapshot.freshness?.repositoryRefreshes?.[String(row.pr.repositoryId)]}
                            prStatus={snapshot.freshness?.pullRequests[row.pr.nodeId]}
                            visibleSince={state.visibleSince}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
              ))}
            </section>
          );
        })}
      </div>
      <MutedRepositories
        repositories={mutedRepositories}
        buckets={mutedBuckets}
        renderRow={(row) => <PrRow
          key={row.pr.nodeId}
          row={row}
          ownerId={snapshot.ownerId}
          now={state.now}
          note={state.changes.get(row.pr.nodeId)}
          outdated={outdated}
          repositoryStatus={snapshot.freshness?.repositories[String(row.pr.repositoryId)]}
          repository={snapshot.repositories.find((repo) => repo.id === row.pr.repositoryId)}
          refreshStatus={snapshot.freshness?.repositoryRefreshes?.[String(row.pr.repositoryId)]}
          prStatus={snapshot.freshness?.pullRequests[row.pr.nodeId]}
          visibleSince={state.visibleSince}
        />}
      />
    </>
  );
}
export function Overview({ onSessionEnded }: { onSessionEnded: () => void }) {
  const [state, setState] = useState<OverviewState>({
    snapshot: null,
    connected: false,
    now: Date.now(),
    visibleSince: Date.now(),
    lastMessageAt: null,
    retry: null,
    changes: new Map(),
  });
  const client = useRef<ReturnType<typeof startOverviewClient> | null>(null);
  useEffect(() => {
    client.current = startOverviewClient(
      browserEnvironment(),
      setState,
      onSessionEnded,
    );
    return () => {
      client.current?.stop();
      client.current = null;
    };
  }, [onSessionEnded]);
  return <OverviewPage state={state} onRetry={() => client.current?.retry()} />;
}
