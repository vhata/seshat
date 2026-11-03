import { useRef, useState, type ReactNode } from "react";
import type { OverviewSnapshot, OverviewRowDto, RepositoryRecord } from "../shared/overview/protocol";
import { setRepositoryMuted } from "./repository-muting";

/** Muting is a display preference; the complete snapshot keeps updating. */
export function MutedRepositories({ repositories, buckets, renderRow }: {
  repositories: readonly RepositoryRecord[];
  buckets: OverviewSnapshot["buckets"];
  renderRow: (row: OverviewRowDto) => ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const summary = useRef<HTMLElement>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const count = buckets.reduce((total, bucket) => total + bucket.rows.length, 0);
  async function unmute(repository: RepositoryRecord) {
    setBusy(true);
    setFeedback(null);
    try {
      await setRepositoryMuted(repository, false);
      setFeedback({ error: false, text: `Unmuted ${repository.fullName}.` });
      // The socket removes this repository's button; keep keyboard focus in
      // the disclosure instead of losing it with the removed control.
      summary.current?.focus();
    } catch (reason) {
      setFeedback({ error: true, text: reason instanceof Error ? reason.message : String(reason) });
    } finally { setBusy(false); }
  }
  return <details className="muted-repositories">
    <summary ref={summary}>Muted repositories · {repositories.length} repositories · {count} PRs</summary>
    <p>Muted repositories keep updating at the normal frequency. New activity keeps them muted until you choose Unmute.</p>
    {feedback && <p role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
    {repositories.length === 0 ? <p>No muted repositories are monitored.</p> : <>
      <ul className="muted-repository-controls">
        {[...repositories].sort((a, b) => a.fullName.localeCompare(b.fullName)).map((repository) => <li key={repository.id}>
          <a href={`https://github.com/${repository.fullName}`}>{repository.fullName}</a>
          <button type="button" disabled={busy} aria-label={`Unmute ${repository.fullName}`} onClick={() => void unmute(repository)}>Unmute</button>
        </li>)}
      </ul>
      {count === 0 && <p>No open pull requests in muted repositories.</p>}
      {buckets.filter(({ rows }) => rows.length > 0).map(({ bucket, rows }) => <section className="bucket" key={bucket.id} aria-label={`Muted: ${bucket.title}`}>
        <h3>{bucket.title} <span className="mono">{rows.length}</span></h3>
        <ul className="pr-list">{rows.map(renderRow)}</ul>
      </section>)}
    </>}
  </details>;
}
