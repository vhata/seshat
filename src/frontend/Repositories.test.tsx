import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FIXTURE_OWNER_ID, FIXTURE_REPOSITORY } from "../shared/overview/fixtures";
import type { RepositorySettings } from "../shared/repositories";
import { RepositoryGroup, RepositorySections } from "./Repositories";
import { repositoryView } from "./repository-sections";

const repositories = [
  { ...FIXTURE_REPOSITORY, fullName: "example/z-active" },
  { ...FIXTURE_REPOSITORY, id: 42, fullName: "example/a-quiet", monitored: false, monitorOverride: false, muted: true },
  { ...FIXTURE_REPOSITORY, id: 43, fullName: "example/b-muted", muted: true },
  { ...FIXTURE_REPOSITORY, id: 44, fullName: "example/fork", isFork: true, monitored: false },
  { ...FIXTURE_REPOSITORY, id: 45, fullName: "team/active", ownerAccountId: 2001, ownerLogin: "team", installationId: 10 },
];
const settings: RepositorySettings = {
  ownerId: FIXTURE_OWNER_ID,
  installations: [
    { id: 9, accountId: FIXTURE_OWNER_ID, accountType: "User", status: "accepted", repositorySelection: "all" },
    { id: 10, accountId: 2001, accountType: "Organization", status: "accepted", repositorySelection: "all" },
  ],
  repositories,
};

function renderSections(view = repositoryView(settings)) {
  return renderToStaticMarkup(<RepositorySections view={view} logins={{ 10: "team" }} busy={false} change={() => {}} mute={() => {}} />);
}

function sections(html: string) {
  const [on, off] = html.split('<section class="repository-section" aria-labelledby="repositories-off">');
  return { on: on!, off: off! };
}

describe("repository monitoring sections", () => {
  it("puts all monitored repositories first, including muted repositories and organizations", () => {
    const { on, off } = sections(renderSections());
    expect(on).toContain('id="repositories-on">Monitored</h2>');
    expect(off).toContain('id="repositories-off">Not monitored</h2>');
    expect(on).toContain("example/z-active");
    expect(on).toContain("example/b-muted");
    expect(on).toContain("team/active");
    expect(on).not.toContain("example/a-quiet");
    expect(off).toContain("example/a-quiet");
    expect(off).toContain("Your forks");
    expect(off).not.toContain("team/active");
    expect(on.indexOf("example/b-muted")).toBeLessThan(on.indexOf("example/z-active"));
  });

  it("keeps rows in their original sections while showing the latest monitoring and mute controls", () => {
    const initial = repositoryView(settings);
    const updated = { ...settings, repositories: settings.repositories.map((repository) => ({
      ...repository, monitored: !repository.monitored, muted: !repository.muted, monitorOverride: !repository.monitored,
    })) };
    // Covers successful actions, recovery rereads and the final initialization
    // reread: none should reset the page's original section assignments.
    const stable = repositoryView(updated, repositoryView(updated, initial));
    const { on, off } = sections(renderSections(stable));
    expect(on).toContain('aria-label="Monitor example/z-active"');
    expect(on).toContain('aria-label="Unmute example/z-active"');
    expect(on).not.toContain('aria-label="Monitor example/z-active" checked');
    expect(off).toContain('aria-label="Monitor example/a-quiet" checked');
    expect(off).toContain('aria-label="Mute example/a-quiet"');
    expect(stable.monitoringAtLoad.get(42)).toBe(false);
    expect(stable.monitoringAtLoad.get(FIXTURE_REPOSITORY.id)).toBe(true);

    // Explicit refresh and remount both start a new classification snapshot.
    const regrouped = sections(renderSections(repositoryView(updated)));
    expect(regrouped.on).toContain("example/a-quiet");
    expect(regrouped.on).not.toContain("example/z-active");
    expect(regrouped.off).toContain("example/z-active");
  });

  it("places newly discovered repositories without moving existing rows and drops removed repositories", () => {
    const initial = repositoryView(settings);
    const next = repositoryView({ ...settings, repositories: [
      { ...repositories[0]!, monitored: false },
      { ...FIXTURE_REPOSITORY, id: 99, fullName: "example/new", monitored: false },
    ] }, initial);
    expect([...next.monitoringAtLoad]).toEqual([[FIXTURE_REPOSITORY.id, true], [99, false]]);
    expect(renderSections(next)).not.toContain("example/a-quiet");
  });

  it.each([true, false])("shows an empty section when all repositories are monitored=%s", (monitored) => {
    const html = renderSections(repositoryView({ ...settings, repositories: [{ ...FIXTURE_REPOSITORY, monitored }] }));
    const { on, off } = sections(html);
    expect(monitored ? off : on).toContain("No repositories in this section.");
    expect(monitored ? on : off).toContain("example/observatory");
  });
});

describe("repository mute controls", () => {
  it("offers a separate explicit mute choice even when monitoring is off", () => {
    const repositories = [
      FIXTURE_REPOSITORY,
      { ...FIXTURE_REPOSITORY, id: 42, fullName: "example/quiet", monitored: false, muted: true },
    ];
    const html = renderToStaticMarkup(<RepositoryGroup
      title="Owned repositories" description="Choose repositories"
      repositories={repositories}
      settings={{ ownerId: FIXTURE_OWNER_ID, installations: [], repositories }}
      busy={false} change={() => {}} mute={() => {}}
    />);
    expect(html).toContain('aria-label="Mute example/observatory"');
    expect(html).toContain('aria-label="Unmute example/quiet"');
    expect(html).toContain('aria-label="Monitor example/quiet"');
    expect(html).toContain('>Unmute</button>');
    expect(html).not.toContain('aria-label="Unmute example/quiet" disabled');
  });
});
