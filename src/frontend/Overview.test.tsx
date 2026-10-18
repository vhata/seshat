import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  type OverviewSnapshot,
} from "../shared/overview/protocol";
import {
  fixturePr,
  fixtureSnapshot,
  FIXTURE_NOW as now,
  FIXTURE_OWNER_ID,
  FIXTURE_REPOSITORY,
  SYNC_FIXTURES,
} from "../shared/overview/fixtures";
import { OverviewPage } from "./Overview";
import type { OverviewState } from "./overview-client";
function render(
  snapshot: OverviewSnapshot | null,
  overrides: Partial<OverviewState> = {},
) {
  return renderToStaticMarkup(
    <OverviewPage
      state={{
        snapshot,
        connected: true,
        now,
        visibleSince: now - 120_000,
        lastMessageAt: now,
        changes: new Map(),
        ...overrides,
      }}
      onRetry={() => {}}
    />,
  );
}
describe("overview presentation", () => {
  it("annotates the owner's latest submitted review regardless of input ordering", () => {
    const owner = { id: FIXTURE_OWNER_ID, login: "example", isBot: false };
    const review = {
      author: owner,
      commitSha: "a".repeat(40),
      submittedAt: now - 1000,
      state: "commented" as const,
    };
    const pr = fixturePr({
      author: { id: 202, login: "helper", isBot: false },
      reviews: [
        review,
        { ...review, state: "approved", submittedAt: now - 2000 },
      ],
    });
    const html = render(
      buildSnapshot(
        [FIXTURE_REPOSITORY],
        [pr],
        SYNC_FIXTURES.live,
        FIXTURE_OWNER_ID,
        now,
      ),
    );
    expect(html).toContain("you commented at this head");
    expect(html).not.toContain("you approved this head");
    const tied = fixturePr({
      ...pr,
      reviews: [{ ...review, state: "approved" }, review],
    });
    expect(
      render(
        buildSnapshot(
          [FIXTURE_REPOSITORY],
          [tied],
          SYNC_FIXTURES.live,
          FIXTURE_OWNER_ID,
          now,
        ),
      ),
    ).toContain("you commented at this head");
    const unknown = fixturePr({
      ...pr,
      reviews: [{ ...review, submittedAt: null }],
    });
    expect(
      render(
        buildSnapshot(
          [FIXTURE_REPOSITORY],
          [unknown],
          SYNC_FIXTURES.live,
          FIXTURE_OWNER_ID,
          now,
        ),
      ),
    ).toContain("you haven&#x27;t reviewed this head");
  });
  it("renders every row fact, stale and bot labels, rules, buckets and safe sibling links", () => {
    const pr = fixturePr({
      title: "<Fix> & improve",
      author: { id: 202, login: "helper-bot", isBot: true },
      mergeable: "unknown",
      activity: {
        openedAt: now - 10 * 86400_000,
        lastCommitAt: null,
        lastCommentAt: null,
        lastStateChangeAt: null,
      },
    });
    const html = render(
      buildSnapshot(
        [FIXTURE_REPOSITORY],
        [pr],
        SYNC_FIXTURES.live,
        FIXTURE_OWNER_ID,
        now,
      ),
    );
    for (const text of [
      "example/observatory",
      "&lt;Fix&gt; &amp; improve",
      "helper-bot",
      ">bot<",
      ">open<",
      "stale 10d",
      "10d ago",
      "no CI",
      "none",
      "checking mergeability",
      "you haven&#x27;t reviewed this head",
      "Ready to land",
      "Broken",
      "Awaiting your review",
      "Changes requested on yours",
      "CI running",
      "Waiting on the author",
      "Draft",
      "None right now",
    ])
      expect(html).toContain(text);
    expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
    expect(html).toContain(
      'href="https://github.com/example/observatory/pull/1"',
    );
    expect(html).toContain('href="https://github.com/helper-bot"');
  });
  it("does not attribute another reviewer's approval to the owner", () => {
    const pr = fixturePr({
      author: { id: 202, login: "other", isBot: false },
      reviews: [
        {
          author: { id: FIXTURE_OWNER_ID, login: "you", isBot: false },
          state: "commented",
          commitSha: "a".repeat(40),
          submittedAt: now - 2000,
        },
        {
          author: { id: 303, login: "maintainer", isBot: false },
          state: "approved",
          commitSha: "a".repeat(40),
          submittedAt: now - 1000,
        },
      ],
      reviewerPermissions: new Map([[303, "write"]]),
    });
    const html = render(
      buildSnapshot(
        [FIXTURE_REPOSITORY],
        [pr],
        SYNC_FIXTURES.live,
        FIXTURE_OWNER_ID,
        now,
      ),
    );
    expect(html).toContain("approved");
    expect(html).toContain("you commented at this head");
    expect(html).not.toContain("you approved this head");
  });
  it("shows unknown age/activity and owner review at an older head honestly", () => {
    const pr = fixturePr({
      author: null,
      activity: {
        openedAt: NaN,
        lastCommitAt: null,
        lastCommentAt: null,
        lastStateChangeAt: null,
      },
      reviews: [
        {
          author: { id: FIXTURE_OWNER_ID, login: "example", isBot: false },
          state: "pending",
          commitSha: null,
          submittedAt: null,
        },
      ],
    });
    const html = render(
      buildSnapshot(
        [FIXTURE_REPOSITORY],
        [pr],
        SYNC_FIXTURES.live,
        FIXTURE_OWNER_ID,
        now,
      ),
    );
    expect(html).toContain("Unknown author");
    expect(html).toContain("unknown");
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("NaN");
  });
  it("distinguishes initial loading, no repositories, no open PRs and nothing needing you", () => {
    expect(render(null)).toContain("Loading your PR overview");
    expect(render(null)).toContain("Sync overdue");
    expect(render(null, { visibleSince: now })).toContain(
      "Checking with GitHub",
    );
    expect(
      render(
        buildSnapshot([], [], SYNC_FIXTURES.initial, FIXTURE_OWNER_ID, now),
      ),
    ).toContain("Loading your first overview");
    expect(
      render(buildSnapshot([], [], SYNC_FIXTURES.live, FIXTURE_OWNER_ID, now)),
    ).toContain("No repositories monitored yet");
    expect(
      render(
        buildSnapshot(
          [FIXTURE_REPOSITORY],
          [],
          SYNC_FIXTURES.live,
          FIXTURE_OWNER_ID,
          now,
        ),
      ),
    ).toContain("No open pull requests");
    expect(
      render(
        buildSnapshot(
          [FIXTURE_REPOSITORY],
          [fixturePr({ isDraft: true })],
          SYNC_FIXTURES.live,
          FIXTURE_OWNER_ID,
          now,
        ),
      ),
    ).toContain("Nothing needs you");
  });
  it("always shows check time, masks old failure during catch-up and flags stale rows", () => {
    expect(render(fixtureSnapshot())).toContain("Checked with GitHub");
    expect(render(fixtureSnapshot(SYNC_FIXTURES.failed))).toContain(
      "Could not read: example/observatory",
    );
    expect(
      render(fixtureSnapshot(SYNC_FIXTURES.failed), { visibleSince: now }),
    ).toContain("Checking with GitHub");
    expect(
      render(fixtureSnapshot(SYNC_FIXTURES.failed), { visibleSince: now }),
    ).not.toContain('role="alert"');
    const html = render(fixtureSnapshot(SYNC_FIXTURES.overdue));
    expect(html).toContain("Sync overdue");
    expect(html).toContain("May be out of date");
    expect(html).toContain("Retry now");
    expect(render(fixtureSnapshot(), { connected: false })).toContain(
      "Disconnected",
    );
    expect(render(fixtureSnapshot(SYNC_FIXTURES.rateLimited))).toContain(
      "Checking every 4 minutes",
    );
  });
});
