import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FIXTURE_NOW as now, FIXTURE_REPOSITORY } from "../shared/overview/fixtures";
import type { CheckStatus } from "../shared/overview/protocol";
import { RepositoryRefresh } from "./RepositoryRefresh";

function render(result?: NonNullable<CheckStatus["latestAttempt"]>["result"], reason?: "rate-limited") {
  return renderToStaticMarkup(<RepositoryRefresh repository={FIXTURE_REPOSITORY} now={now} status={result ? {
    lastSuccessfulCheckAt: now - 120_000,
    latestAttempt: { id: 8, startedAt: now - 30_000, result, ...(reason ? { reason } : {}) },
  } : undefined} />);
}

describe("repository refresh presentation", () => {
  it("labels the action with the selected repository and disables queued or running duplicates", () => {
    expect(render()).toContain('aria-label="Refresh example/observatory"');
    expect(render()).toContain('title="Reconcile all open pull requests in example/observatory"');
    expect(render()).not.toContain('disabled=""');
    for (const phase of ["queued", "running"] as const) {
      const html = render(phase);
      expect(html).toContain('disabled=""');
      expect(html).toContain(`Refresh ${phase}`);
      expect(html).toContain('role="status"');
      expect(html).toContain("30s ago");
      expect(html).not.toContain("completed.");
    }
  });
  it("distinguishes completed work from failed and interrupted work and retains cache feedback", () => {
    const completed = render("success");
    expect(completed).toContain("Refresh completed.");
    expect(completed).not.toContain('disabled=""');
    const failed = render("failed", "rate-limited");
    expect(failed).toContain("Refresh failed.");
    expect(failed).toContain("The GitHub App has reached its rate limit.");
    expect(failed).toContain("Cached data retained.");
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain("completed.");
    const interrupted = render("interrupted");
    expect(interrupted).toContain("interrupted before completion");
    expect(interrupted).toContain("Cached data retained.");
  });
});
