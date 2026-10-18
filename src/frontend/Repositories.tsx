import { useEffect, useState } from "react";
import type { StoredInstallation } from "../shared/installations";
import type { RepositoryRecord } from "../shared/overview/protocol";
import { canMonitorRepository, REPOSITORIES_PATH, type RepositorySettings } from "../shared/repositories";
import "./Repositories.css";

async function settingsRequest(path = "", data?: unknown): Promise<unknown> {
  const response = await fetch(`${REPOSITORIES_PATH}${path}`, data === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "Your session ended. Sign in again." : "GitHub could not update the repository settings. Your previous settings have been kept.");
  return response.json();
}

/** Private repository choices; installation permission alone never grants access. */
export function Repositories() {
  const [settings, setSettings] = useState<RepositorySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logins, setLogins] = useState<Record<number, string>>({});
  useEffect(() => {
    let cancelled = false;
    settingsRequest().then((body) => {
      if (!cancelled) setSettings(body as RepositorySettings);
      return settingsRequest("/installations", {});
    }).then((result) => {
      if (!cancelled) setLogins(Object.fromEntries((result as { kept: (StoredInstallation & { accountLogin: string })[] }).kept.map((entry) => [entry.id, entry.accountLogin])));
      return settingsRequest();
    }).then((body) => { if (!cancelled) setSettings(body as RepositorySettings); })
      .catch((reason: unknown) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, []);

  async function action(path: string, data: unknown) {
    setBusy(true); setError(null);
    try {
      await settingsRequest(path, data);
      if (path === "/organization" && (data as { accept: boolean }).accept) {
        const installationId = (data as { installationId: number }).installationId;
        await settingsRequest("/refresh", { installationId });
      }
      setSettings(await settingsRequest() as RepositorySettings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      try { setSettings(await settingsRequest() as RepositorySettings); } catch { /* keep the last view */ }
    }
    finally { setBusy(false); }
  }
  async function refresh() {
    if (!settings) return;
    setBusy(true); setError(null);
    try {
      // Re-check installations first to notice selected/all switches and new
      // pending organizations through the existing setup guard.
      const result = await settingsRequest("/installations", {}) as { kept: (StoredInstallation & { accountLogin: string })[] };
      setLogins(Object.fromEntries(result.kept.map((entry) => [entry.id, entry.accountLogin])));
      const current = await settingsRequest() as RepositorySettings;
      for (const installation of current.installations.filter((entry) => entry.status === "accepted")) {
        await settingsRequest("/refresh", { installationId: installation.id });
      }
      setSettings(await settingsRequest() as RepositorySettings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      // A successful earlier listing is useful even if a later one failed.
      try { setSettings(await settingsRequest() as RepositorySettings); } catch { /* keep the last view */ }
    } finally { setBusy(false); }
  }

  const selectedPersonal = settings?.installations.some((installation) => installation.accountType === "User"
    && installation.accountId === settings.ownerId && installation.repositorySelection === "selected");
  return <main className="repository-page">
    <header className="repository-header"><a href="/" className="repository-brand">Seshat</a><nav aria-label="Main"><a href="/">PR overview</a><a href="/repositories" aria-current="page">Repositories</a></nav></header>
    <div className="repository-intro"><div><p className="repository-kicker">YOUR GITHUB APP</p><h1>Repositories</h1><p>Choose where Seshat watches for open pull requests.</p></div>
      <button type="button" disabled={busy || !settings} onClick={() => void refresh()}>{busy ? "Updating…" : "Refresh listings"}</button></div>
    {error && <p role="alert" className="repository-warning">{error}</p>}
    {!settings && !error && <p role="status">Loading repository settings…</p>}
    {selectedPersonal && <aside className="repository-warning" role="alert"><strong>New repositories will not be monitored automatically.</strong><p>Your personal GitHub App installation is set to selected repositories. Switch it back to <strong>All repositories</strong> in GitHub, then refresh the listings.</p><a href="https://github.com/settings/installations">Manage GitHub App installations</a></aside>}
    {settings && <>
      {settings.installations.filter((installation) => installation.status === "pending").map((installation) => <PendingOrganization key={installation.id} installation={installation} login={logins[installation.id]} busy={busy} decide={(accept) => void action("/organization", { installationId: installation.id, accept })} />)}
      {settings.installations.length === 0 && <p>No GitHub App installations are available. <a href="/setup/installed">Check the installation</a>.</p>}
      <RepositoryGroup title="Owned repositories" description="Your own repositories are monitored automatically, except forks and archives." repositories={settings.repositories.filter((repository) => repository.ownerAccountId === settings.ownerId && !repository.isFork)} settings={settings} busy={busy} change={(repositoryId, override) => void action("/monitoring", { repositoryId, override })} />
      <RepositoryGroup title="Your forks" description="Forks stay off until you choose to monitor them." repositories={settings.repositories.filter((repository) => repository.ownerAccountId === settings.ownerId && repository.isFork)} settings={settings} busy={busy} change={(repositoryId, override) => void action("/monitoring", { repositoryId, override })} />
      {settings.installations.filter((installation) => installation.accountType === "Organization" && installation.status === "accepted").map((installation) => {
        const repositories = settings.repositories.filter((repository) => repository.installationId === installation.id);
        return <RepositoryGroup key={installation.id} title={logins[installation.id] ?? repositories[0]?.ownerLogin ?? `Organization ${installation.accountId}`} description="Organization repositories are monitored only when you switch them on. Only repositories you can access are listed." repositories={repositories} settings={settings} busy={busy} change={(repositoryId, override) => void action("/monitoring", { repositoryId, override })} />;
      })}
      <p className="repository-footnote">Changes apply to the overview immediately. Switching monitoring off removes that repository’s pull requests.</p>
    </>}
  </main>;
}

export function PendingOrganization({ installation, login, busy, decide }: { installation: StoredInstallation; login?: string | undefined; busy: boolean; decide: (accept: boolean) => void }) {
  return <aside className="repository-pending"><h2>Organization installation awaiting acceptance</h2><p>GitHub organization {login ?? `account ${installation.accountId}`}, installation {installation.id}. No repositories are read until you accept. Accepting lets you choose individual repositories; it monitors none automatically.</p>{login && <a href={`https://github.com/${encodeURIComponent(login)}`}>View organization on GitHub</a>}<div><button disabled={busy} onClick={() => decide(true)}>Accept organization</button><button disabled={busy} onClick={() => decide(false)}>Refuse and uninstall</button></div></aside>;
}

export function RepositoryGroup({ title, description, repositories, settings, busy, change }: {
  title: string; description: string; repositories: readonly RepositoryRecord[]; settings: RepositorySettings;
  busy: boolean; change: (repositoryId: number, override: boolean | null) => void;
}) {
  return <section className="repository-group"><div className="repository-group-heading"><h2>{title}</h2><span>{repositories.filter((repository) => repository.monitored).length} monitored · {repositories.length} available</span></div><p>{description}</p>
    {repositories.length === 0 ? <p className="repository-empty">No repositories listed. Refresh listings to check GitHub.</p> : <ul>{[...repositories].sort((a, b) => a.fullName.localeCompare(b.fullName)).map((repository) => <li key={repository.id}>
      <div><a className="repository-name" href={`https://github.com/${repository.fullName.split("/").map(encodeURIComponent).join("/")}`}>{repository.fullName}</a><span className="repository-visibility">{repository.visibility}</span><p>{repository.isArchived ? "Archived · Not monitored" : repository.isFork ? "Fork · Opt in to monitor" : repository.monitorOverride === null && repository.ownerAccountId === settings.ownerId ? "Monitored by default" : repository.monitored ? "Monitoring on" : "Not monitored"}</p></div>
      <div className="repository-controls"><label className="repository-toggle"><input type="checkbox" role="switch" aria-label={`Monitor ${repository.fullName}`} checked={repository.monitored} disabled={busy || !canMonitorRepository(repository, settings)} onChange={(event) => change(repository.id, event.target.checked)} /><span>{repository.monitored ? "On" : "Off"}</span></label>{repository.monitorOverride !== null && !repository.isArchived && <button className="repository-reset" disabled={busy} onClick={() => change(repository.id, null)}>Use default</button>}</div>
    </li>)}</ul>}
  </section>;
}
