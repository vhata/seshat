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
        retry: null,
        changes: new Map(),
        ...overrides,
      }}
      onRetry={() => {}}
    />,
  );
}
describe("overview presentation", () => {
  it("separates muted PRs and counts while preserving bucket labels and freshness", () => {
    const muted = { ...FIXTURE_REPOSITORY, id: 42, fullName: "example/quiet", muted: true };
    const emptyMuted = { ...muted, id: 43, fullName: "example/empty" };
    const disabled = { ...muted, id: 44, fullName: "example/off", monitored: false };
    const html = render(buildSnapshot(
      [FIXTURE_REPOSITORY, muted, emptyMuted, disabled],
      [fixturePr({ title: "Active work" }), fixturePr({
        nodeId: "PR_muted", repositoryId: muted.id, title: "Quiet work", isDraft: true,
      })],
      SYNC_FIXTURES.live, FIXTURE_OWNER_ID, now,
    ));
    const [active, hidden] = html.split('<details class="muted-repositories">');
    expect(active).toContain("Active work");
    expect(active).not.toContain("Quiet work");
    expect(active).toContain("Needs you · 1");
    expect(active).toContain("Waiting · 0");
    expect(active).toContain("1 open PRs · 1 repositories");
    expect(active).toContain("Checked with GitHub");
    expect(hidden).toContain("Muted repositories · 2 repositories · 1 PR");
    expect(hidden).toContain("Quiet work");
    expect(hidden).toContain('aria-label="Muted: Draft"');
    expect(hidden).toContain('aria-label="Unmute example/empty"');
    expect(hidden).not.toContain("example/off");
    expect(html).not.toContain('<details class="muted-repositories" open');
    expect((html.match(/data-pr="PR_muted"/g) ?? []).length).toBe(1);
  });
  it("distinguishes all-muted, muted-without-PRs and no-muted empty states", () => {
    const repository = { ...FIXTURE_REPOSITORY, muted: true };
    const snapshot = (prs: Parameters<typeof buildSnapshot>[1]) => buildSnapshot(
      [repository], prs, SYNC_FIXTURES.live, FIXTURE_OWNER_ID, now,
    );
    const allMuted = render(snapshot([fixturePr()]));
    expect(allMuted).toContain("No active pull requests");
    expect(allMuted).toContain("All open pull requests are in Muted repositories below.");
    expect(allMuted).toContain("0 open PRs · 0 repositories");
    expect(allMuted).not.toContain("No repositories monitored yet");
    const emptyMuted = render(snapshot([]));
    expect(emptyMuted).toContain("Muted repositories · 1 repository · 0 PRs");
    expect(emptyMuted).toContain("No open pull requests in muted repositories.");
    expect(emptyMuted).toContain('aria-label="Unmute example/observatory"');
    expect(render(fixtureSnapshot())).toContain("No muted repositories are monitored.");
  });
  it("continues rendering updated muted facts and marks them out of date on failure", () => {
    const html = render(buildSnapshot(
      [{ ...FIXTURE_REPOSITORY, muted: true }],
      [fixturePr({ title: "New muted activity", mergeable: "conflicting" })],
      SYNC_FIXTURES.failed, FIXTURE_OWNER_ID, now,
    ));
    const hidden = html.split('<details class="muted-repositories">')[1];
    expect(hidden).toContain("New muted activity");
    expect(hidden).toContain("conflicts");
    expect(hidden).toContain("May be out of date");
    expect(html).toContain("Sync failed");
    expect(html).toContain("Could not read: example/observatory");
  });
  it("acknowledges retry immediately and briefly disables duplicate clicks", () => {
    const snapshot = fixtureSnapshot(SYNC_FIXTURES.overdue);
    const html = render(snapshot, {
      retry: { requestedAt: now, phase: "sent" },
    });
    expect(html).toContain("Retry request sent.");
    expect(html).toContain("Requested <time");
    expect(html).toContain("0s ago");
    expect(html).toContain('disabled=""');
    expect(html).toContain(">Retry requested</button>");
    const later = render(snapshot, {
      retry: { requestedAt: now - 15_000, phase: "sent" },
    });
    expect(later).not.toContain('disabled=""');
    expect(later).toContain(">Retry now</button>");
    expect(later).toContain("15s ago");
    const failed = render(fixtureSnapshot({
      ...SYNC_FIXTURES.failed,
      latestAttempt: { result: "failed", startedAt: now, reason: "github-unavailable", unreadableRepositoryIds: [] },
    }), { retry: { requestedAt: now - 1000, phase: "sent" } });
    expect(failed).toContain("Sync failed");
    expect(failed).toContain("Retry request sent.");
    expect(failed).not.toContain("Waiting for a GitHub check result");
  });
  it("distinguishes queued retries from sent requests", () => {
    for (const phase of ["checking-session", "connecting"] as const) {
      const html = render(null, {
        connected: false,
        retry: { requestedAt: now, phase },
      });
      expect(html).toContain("Retry queued");
      expect(html).toContain(phase === "checking-session"
        ? "checking your session" : "reconnecting to the instance");
      expect(html).not.toContain("Retry request sent.");
    }
  });
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
  it("shows attempt age and diagnostic guidance while waiting for GitHub", () => {
    const html = render(fixtureSnapshot({
      ...SYNC_FIXTURES.checking,
      latestAttempt: { result: "running", startedAt: now - 120_000 },
    }), { visibleSince: now - 30_000, lastMessageAt: now - 15_000 });
    expect(html).toContain("Waiting for a completed GitHub check for 30s");
    expect(html).toContain("Last reported check started");
    expect(html).toContain("2m ago");
    expect(html).toContain("No completion has been reported.");
    expect(html).toContain("Last overview update from the instance:");
    expect(html).toContain("15s ago");
    expect(html).toContain("Retry now");
    expect(html).toContain("seshat site logs");
    expect(html).toContain("seshat.github.failure");
    expect(html).toContain("A quiet log does not confirm progress.");
    expect(html).not.toContain('role="alert"');
  });
  it("keeps known failure feedback during catch-up without claiming recovery", () => {
    const html = render(fixtureSnapshot(SYNC_FIXTURES.failed), {
      visibleSince: now,
    });
    expect(html).toContain("Checking with GitHub");
    expect(html).toContain("The last reported check and its retry failed.");
    expect(html).toContain("GitHub data could not be read.");
    expect(html).toContain("A new check has not yet confirmed recovery.");
    expect(html).not.toContain("No completion has been reported.");
    expect(render(fixtureSnapshot())).not.toContain('aria-label="Sync details"');
  });
  it("distinguishes missing reports from an active check and handles first-sync overdue", () => {
    const loading = render(null, { visibleSince: now, lastMessageAt: null });
    expect(loading).toContain("has not reported a GitHub check starting yet");
    expect(loading).toContain("none received");
    const overdue = render(fixtureSnapshot(SYNC_FIXTURES.initial));
    expect(overdue).toContain("No GitHub check has completed successfully yet.");
    expect(overdue).not.toContain("more than five minutes old");
    const stale = render(fixtureSnapshot(SYNC_FIXTURES.overdue));
    expect(stale).toContain("No newer GitHub check has been reported.");
    expect(stale).toContain("more than five minutes old");
  });
  it("always shows check time, masks old failure during catch-up and flags stale rows", () => {
    expect(render(fixtureSnapshot())).toContain("Checked with GitHub");
    expect(render(fixtureSnapshot(SYNC_FIXTURES.failed))).toContain(
      "Could not read: example/observatory",
    );
    expect(render(fixtureSnapshot(SYNC_FIXTURES.failed))).toContain(
      "GitHub data could not be read.",
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
