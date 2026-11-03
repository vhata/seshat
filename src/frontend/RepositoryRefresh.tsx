import { useRef, useState } from "react";
import type { CheckAttempt, CheckStatus, RepositoryRecord, SyncFailureReason } from "../shared/overview/protocol";
import { relativeTime } from "./freshness";
import { repositoryRefreshAttempt, requestRepositoryRefresh } from "./repository-refresh";

const REASONS: Record<SyncFailureReason, string> = {
  "github-unavailable": "GitHub data could not be read.",
  "rate-limited": "The GitHub App has reached its rate limit.",
  "installation-suspended": "The GitHub App installation is suspended.",
  "installation-removed": "The GitHub App installation was removed.",
  "cloudflare-quota": "The instance has reached its Cloudflare quota.",
};

/** Explicit refresh feedback is independent of scheduled and webhook checks. */
export function RepositoryRefresh({ repository, status, now }: {
  repository: RepositoryRecord;
  status: CheckStatus | undefined;
  now: number;
}) {
  const [receipt, setReceipt] = useState<CheckAttempt | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<{ text: string; afterAttemptId: number } | null>(null);
  const inFlight = useRef(false);
  const attempt = repositoryRefreshAttempt(receipt, status?.latestAttempt ?? null);
  const error = failure && (attempt?.id ?? 0) <= failure.afterAttemptId ? failure.text : null;
  const pending = attempt?.result === "queued" || attempt?.result === "running";
  async function refresh() {
    if (inFlight.current || pending) return;
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    try { setReceipt(await requestRepositoryRefresh(repository)); }
    catch (reason) { setFailure({ text: reason instanceof Error ? reason.message : String(reason), afterAttemptId: attempt?.id ?? 0 }); }
    finally { inFlight.current = false; setSending(false); }
  }
  return <span className="repository-refresh">
    <button
      type="button"
      disabled={sending || pending}
      aria-label={`Refresh ${repository.fullName}`}
      onClick={() => void refresh()}
    >
      {sending ? "Requesting refresh…" : pending ? "Refresh requested" : "Refresh"}
    </button>
    {sending && <span role="status">Sending refresh request.</span>}
    {error && <span role="alert">{error}</span>}
    {attempt && !sending && !error && <span role={attempt.result === "failed" || attempt.result === "interrupted" ? "alert" : "status"}>
      {"Requested refresh: "}
      {attempt.result === "queued" && "queued."}
      {attempt.result === "running" && "running; completion has not been confirmed."}
      {attempt.result === "success" && "completed; all open PRs reconciled."}
      {attempt.result === "failed" && `failed. ${attempt.reason ? REASONS[attempt.reason] : "GitHub data could not be read."} Cached data retained.`}
      {attempt.result === "interrupted" && "interrupted before completion. Cached data retained."}
      {" Requested "}<time dateTime={new Date(attempt.startedAt).toISOString()} title={new Date(attempt.startedAt).toLocaleString()}>{relativeTime(attempt.startedAt, now)} ago</time>.
    </span>}
  </span>;
}
