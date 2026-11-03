import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FIXTURE_OWNER_ID, FIXTURE_REPOSITORY } from "../shared/overview/fixtures";
import { RepositoryGroup } from "./Repositories";

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
