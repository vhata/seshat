import { useEffect, useState } from "react";
import type { StoredInstallation } from "../shared/installations";
import type { InstallationRefreshResult, RepositoryRecord } from "../shared/overview/protocol";
import { canMonitorRepository, REPOSITORIES_PATH, type RepositorySettings } from "../shared/repositories";
import "./Repositories.css";
import { setRepositoryMuted } from "./repository-muting";
import { AppHeader } from "./AppHeader";
import { repositoryView, type RepositoryView } from "./repository-sections";

async function refreshInstallation(installationId: number): Promise<void> {
  for (;;) {
    const result = await settingsRequest("/refresh", { installationId }) as InstallationRefreshResult;
    if (result.ok) return;
    if (result.reason !== "continuation") throw new Error("Could not refresh the complete repository listing.");
    // Continue in a fresh Worker invocation so large organizations fit the
    // free-tier subrequest limit without exposing a partial repository set.
  }
}

async function settingsRequest(path = "", data?: unknown): Promise<unknown> {
  const response = await fetch(`${REPOSITORIES_PATH}${path}`, data === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "Your session ended. Sign in again." : "GitHub could not update the repository settings. Your previous settings have been kept.");
  return response.json();
}

/** Private repository choices; installation permission alone never grants access. */
export function Repositories() {
  const [view, setView] = useState<RepositoryView | null>(null);
  const settings = view?.settings ?? null;
  function setSettings(next: RepositorySettings, regroup = false) {
    setView((previous) => repositoryView(next, regroup ? null : previous));
  }
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
        await refreshInstallation(installationId);
      }
      setSettings(await settingsRequest() as RepositorySettings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      try { setSettings(await settingsRequest() as RepositorySettings); } catch { /* keep the last view */ }
    }
    finally { setBusy(false); }
  }
  async function mute(repository: RepositoryRecord) {
    setBusy(true); setError(null);
    try {
      await setRepositoryMuted(repository, !repository.muted);
      setSettings(await settingsRequest() as RepositorySettings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      try { setSettings(await settingsRequest() as RepositorySettings); } catch { /* keep the last view */ }
    } finally { setBusy(false); }
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
        await refreshInstallation(installation.id);
      }
      setSettings(await settingsRequest() as RepositorySettings, true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      // A successful earlier listing is useful even if a later one failed.
      try { setSettings(await settingsRequest() as RepositorySettings); } catch { /* keep the last view */ }
    } finally { setBusy(false); }
  }

  const selectedPersonal = settings?.installations.some((installation) => installation.accountType === "User"
    && installation.accountId === settings.ownerId && installation.repositorySelection === "selected");
  return <>
    <AppHeader page="repositories" />
    <main className="repository-page">
    <div className="repository-intro"><div><h1>Repositories</h1><p>Choose where Seshat watches for open pull requests.</p></div>
      <button type="button" disabled={busy || !settings} onClick={() => void refresh()}>{busy ? "Updating…" : "Refresh listings"}</button></div>
    {error && <p role="alert" className="repository-warning">{error}</p>}
    {!settings && !error && <p role="status">Loading repository settings…</p>}
    {selectedPersonal && <aside className="repository-warning" role="alert"><strong>New repositories will not be monitored automatically.</strong><p>Your personal GitHub App installation is set to selected repositories. Switch it back to <strong>All repositories</strong> in GitHub, then refresh the listings.</p><a href="https://github.com/settings/installations">Manage GitHub App installations</a></aside>}
    {settings && <>
      {settings.installations.filter((installation) => installation.status === "pending").map((installation) => <PendingOrganization key={installation.id} installation={installation} login={logins[installation.id]} busy={busy} decide={(accept) => void action("/organization", { installationId: installation.id, accept })} />)}
      {settings.installations.length === 0 && <p>No GitHub App installations are available. <a href="/setup/installed">Check the installation</a>.</p>}
      <p className="repository-section-note">Repositories stay in their section while you make changes. Refresh listings or reload this page to regroup them.</p>
      {view && <RepositorySections view={view} logins={logins} busy={busy} mute={(repository) => void mute(repository)} change={(repositoryId, override) => void action("/monitoring", { repositoryId, override })} />}
      <p className="repository-footnote">Changes apply to the overview immediately. Switching monitoring off removes that repository’s pull requests. Muting keeps monitoring on at the normal frequency and moves its PRs to the collapsed Muted repositories section. New activity does not unmute it.</p>
    </>}
    </main>
  </>;
}

export function RepositorySections({ view, logins, busy, change, mute }: {
  view: RepositoryView; logins: Readonly<Record<number, string>>; busy: boolean;
  change: (repositoryId: number, override: boolean | null) => void;
  mute: (repository: RepositoryRecord) => void;
}) {
  const { settings, monitoringAtLoad } = view;
  return <>{[true, false].map((on) => {
    const repositories = settings.repositories.filter((repository) => monitoringAtLoad.get(repository.id) === on);
    const groups = [
      { key: "owned", title: "Owned repositories", description: "Your own repositories are monitored automatically, except forks and archives.", repositories: repositories.filter((repository) => repository.ownerAccountId === settings.ownerId && !repository.isFork) },
      { key: "forks", title: "Your forks", description: "Forks stay off until you choose to monitor them.", repositories: repositories.filter((repository) => repository.ownerAccountId === settings.ownerId && repository.isFork) },
      ...settings.installations.filter((installation) => installation.accountType === "Organization" && installation.status === "accepted").map((installation) => {
        const organizationRepositories = repositories.filter((repository) => repository.installationId === installation.id);
        return { key: `organization-${installation.id}`, title: logins[installation.id] ?? organizationRepositories[0]?.ownerLogin ?? `Organization ${installation.accountId}`, description: "Organization repositories are monitored only when you switch them on. Only repositories you can access are listed.", repositories: organizationRepositories };
      }),
    ];
    const id = on ? "repositories-on" : "repositories-off";
    return <section key={id} className="repository-section" aria-labelledby={id}>
      <div className="repository-section-heading"><h2 id={id}>{on ? "Monitored" : "Not monitored"}</h2><span>{repositories.length} {repositories.length === 1 ? "repository" : "repositories"}</span></div>
      {repositories.length === 0 && <p className="repository-empty">No repositories in this section.</p>}
      {groups.filter((group) => group.repositories.length > 0).map((group) => <RepositoryGroup key={group.key} title={group.title} description={group.description} repositories={group.repositories} settings={settings} busy={busy} change={change} mute={mute} />)}
    </section>;
  })}</>;
}

export function PendingOrganization({ installation, login, busy, decide }: { installation: StoredInstallation; login?: string | undefined; busy: boolean; decide: (accept: boolean) => void }) {
  return <aside className="repository-pending"><h2>Organization installation awaiting acceptance</h2><p>GitHub organization {login ?? `account ${installation.accountId}`}, installation {installation.id}. No repositories are read until you accept. Accepting lets you choose individual repositories; it monitors none automatically.</p>{login && <a href={`https://github.com/${encodeURIComponent(login)}`}>View organization on GitHub</a>}<div><button disabled={busy} onClick={() => decide(true)}>Accept organization</button><button disabled={busy} onClick={() => decide(false)}>Refuse and uninstall</button></div></aside>;
}

export function RepositoryGroup({ title, description, repositories, settings, busy, change, mute }: {
  title: string; description: string; repositories: readonly RepositoryRecord[]; settings: RepositorySettings;
  busy: boolean; change: (repositoryId: number, override: boolean | null) => void;
  mute: (repository: RepositoryRecord) => void;
}) {
  return <section className="repository-group"><div className="repository-group-heading"><h3>{title}</h3><span>{repositories.filter((repository) => repository.monitored).length} monitored · {repositories.length} available</span></div><p>{description}</p>
    {repositories.length === 0 ? <p className="repository-empty">No repositories listed. Refresh listings to check GitHub.</p> : <ul>{[...repositories].sort((a, b) => a.fullName.localeCompare(b.fullName)).map((repository) => <li key={repository.id}>
      <div><a className="repository-name" href={`https://github.com/${repository.fullName.split("/").map(encodeURIComponent).join("/")}`}>{repository.fullName}</a><span className="repository-visibility">{repository.visibility}</span><p>{repository.isArchived ? "Archived · Not monitored" : repository.isFork ? "Fork · Opt in to monitor" : repository.monitorOverride === null && repository.ownerAccountId === settings.ownerId ? "Monitored by default" : repository.monitored ? "Monitoring on" : "Not monitored"}</p></div>
      <div className="repository-controls"><button type="button" disabled={busy} aria-label={`${repository.muted ? "Unmute" : "Mute"} ${repository.fullName}`} onClick={() => mute(repository)}>{repository.muted ? "Unmute" : "Mute"}</button><label className="repository-toggle"><input type="checkbox" role="switch" aria-label={`Monitor ${repository.fullName}`} checked={repository.monitored} disabled={busy || !canMonitorRepository(repository, settings)} onChange={(event) => change(repository.id, event.target.checked)} /><span>{repository.monitored ? "On" : "Off"}</span></label>{repository.monitorOverride !== null && !repository.isArchived && <button className="repository-reset" disabled={busy} onClick={() => change(repository.id, null)}>Use default</button>}</div>
    </li>)}</ul>}
  </section>;
}
