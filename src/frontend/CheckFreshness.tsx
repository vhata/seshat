import { useId, useState } from "react";
import type { CheckStatus, SyncFailureReason } from "../shared/overview/protocol";
import { checkFreshness, relativeTime } from "./freshness";

const REASONS: Record<SyncFailureReason, string> = {
  "github-unavailable": "GitHub data could not be read.",
  "rate-limited": "The GitHub App has reached its rate limit.",
  "installation-suspended": "The GitHub App installation is suspended.",
  "installation-removed": "The GitHub App installation was removed.",
  "cloudflare-quota": "The instance has reached its Cloudflare quota.",
};

function CheckedTime({ value, now }: { value: number | null; now: number }) {
  return value === null ? <>Not yet confirmed</> : (
    <time dateTime={new Date(value).toISOString()}>
      {relativeTime(value, now)} ago ({new Date(value).toLocaleString()})
    </time>
  );
}

function ScopeDetails({
  label, status, now, visibleSince,
}: {
  label: "Repository fully checked" | "This PR checked";
  status: CheckStatus | undefined;
  now: number;
  visibleSince: number;
}) {
  const attempt = status?.latestAttempt;
  return (
    <span className="check-scope">
      <strong>{label}</strong>
      <span><CheckedTime value={status?.lastSuccessfulCheckAt ?? null} now={now} /></span>
      <span>{checkFreshness(status, now, visibleSince)}</span>
      {attempt && (
        <span>
          Latest attempt started <CheckedTime value={attempt.startedAt} now={now} />.
          {attempt.result === "queued" && " Waiting to run."}
          {attempt.result === "running" && " Completion has not been confirmed."}
          {attempt.result === "failed" && ` ${attempt.reason ? REASONS[attempt.reason] : "GitHub data could not be read."}`}
          {attempt.result === "interrupted" && " Interrupted before completion."}
        </span>
      )}
    </span>
  );
}

/** Hover and keyboard focus reveal the same noninteractive details. */
export function CheckFreshness({
  repositoryName, repositoryStatus, prStatus, prNumber, now, visibleSince,
}: {
  repositoryName: string;
  repositoryStatus: CheckStatus | undefined;
  prStatus?: CheckStatus;
  prNumber?: number;
  now: number;
  visibleSince: number;
}) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  const repositoryLabel = checkFreshness(repositoryStatus, now, visibleSince);
  const prLabel = checkFreshness(prStatus, now, visibleSince);
  const label = prNumber !== undefined && prLabel !== "Checked" && prLabel !== repositoryLabel
    ? `${repositoryLabel} · PR ${prLabel.toLowerCase()}` : repositoryLabel;
  const tone = label.toLowerCase().includes("failed") ? "failed"
    : label.toLowerCase().includes("overdue") ? "overdue"
      : label.toLowerCase().includes("checking") ? "checking" : "quiet";
  return (
    <span
      className={`check-indicator check-${tone}${dismissed ? " check-dismissed" : ""}`}
      onMouseEnter={() => setDismissed(false)}
    >
      <button
        type="button"
        className="check-trigger"
        aria-label={`${repositoryName}${prNumber === undefined ? "" : ` PR #${prNumber}`}: ${label}. Check details`}
        aria-describedby={id}
        onFocus={() => setDismissed(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDismissed(true);
        }}
      >
        <span aria-hidden="true">◷</span> {label}
      </button>
      <span className="check-tooltip" role="tooltip" id={id}>
        <ScopeDetails label="Repository fully checked" status={repositoryStatus} now={now} visibleSince={visibleSince} />
        {prNumber !== undefined && (
          <ScopeDetails label="This PR checked" status={prStatus} now={now} visibleSince={visibleSince} />
        )}
        <span className="check-explanation">
          A repository check reconciles all open PRs. An individual PR check
          does not confirm the repository's complete PR list.
        </span>
      </span>
    </span>
  );
}
