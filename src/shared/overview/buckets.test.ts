import { describe, expect, it } from "vitest";
import {
  BUCKETS,
  bucketFor,
  deriveFacts,
  hasConflicts,
  type BucketId,
  type PrFacts,
} from "./buckets";
import type { CiState } from "./ci";
import type { ReviewState } from "./reviews";
import {
  OLD,
  dependabot,
  failing,
  impostor,
  maintainer,
  orgRepo,
  owner,
  passerBy,
  passing,
  permissions,
  pr,
  reader,
  review,
  running,
} from "./testing";
import type { CiResult, Mergeability, PrInput, Review } from "./types";

const ownerId = owner.id;
const bucketOf = (input: PrInput): BucketId =>
  bucketFor(deriveFacts(input, ownerId)).id;

describe("deriveFacts", () => {
  it("identifies the owner's PR by account ID, not login", () => {
    expect(deriveFacts(pr({ author: owner }), ownerId).isOwners).toBe(true);
    expect(deriveFacts(pr({ author: impostor }), ownerId).isOwners).toBe(false);
  });

  it("treats a bot's PR and a PR with no author as someone else's", () => {
    expect(deriveFacts(pr({ author: dependabot }), ownerId).isOwners).toBe(
      false,
    );
    expect(deriveFacts(pr({ author: null }), ownerId).isOwners).toBe(false);
  });

  it.each<[Mergeability, boolean]>([
    ["mergeable", false],
    ["conflicting", true],
    ["unknown", false],
  ])("counts %s as conflicts: %s", (mergeable, want) => {
    expect(hasConflicts(deriveFacts(pr({ mergeable }), ownerId))).toBe(want);
  });
});

// Fixed sample PRs, at least one per rule. Each is a whole input, so the CI
// and review derivations run too.
describe("sample PRs", () => {
  const samples: [string, PrInput, BucketId][] = [
    [
      "the owner's PR with passing CI and no reviews",
      pr({ author: owner, ci: [passing] }),
      "ready-to-land",
    ],
    [
      "the owner's PR with no CI at all",
      pr({ author: owner }),
      "ready-to-land",
    ],
    [
      "someone else's PR approved on its head by a co-maintainer",
      pr({ ci: [passing], reviews: [review(maintainer, "approved")] }),
      "ready-to-land",
    ],
    [
      "a Dependabot PR the owner approved on its head",
      pr({
        author: dependabot,
        ci: [passing],
        reviews: [review(owner, "approved")],
      }),
      "ready-to-land",
    ],
    [
      "the owner's PR with failing CI",
      pr({ author: owner, ci: [passing, failing] }),
      "broken",
    ],
    [
      "the owner's PR with conflicts",
      pr({ author: owner, ci: [passing], mergeable: "conflicting" }),
      "broken",
    ],
    [
      "someone else's PR nobody has reviewed",
      pr({ ci: [passing] }),
      "awaiting-your-review",
    ],
    [
      "a Dependabot PR with no reviews",
      pr({ author: dependabot, ci: [passing] }),
      "awaiting-your-review",
    ],
    [
      "the owner's PR where a co-maintainer requested changes",
      pr({
        author: owner,
        ci: [passing],
        reviews: [review(maintainer, "changes_requested")],
      }),
      "changes-requested-on-yours",
    ],
    [
      "the owner's PR with CI running",
      pr({ author: owner, ci: [passing, running] }),
      "ci-running",
    ],
    [
      "someone else's PR the owner commented on, with CI running",
      pr({ ci: [running], reviews: [review(owner, "commented")] }),
      "ci-running",
    ],
    [
      "someone else's PR the owner commented on at its head",
      pr({ ci: [passing], reviews: [review(owner, "commented")] }),
      "waiting-on-the-author",
    ],
    [
      "someone else's PR where the owner requested changes",
      pr({ ci: [passing], reviews: [review(owner, "changes_requested")] }),
      "waiting-on-the-author",
    ],
    ["the owner's draft", pr({ author: owner, isDraft: true }), "draft"],
    [
      "someone else's draft",
      pr({ isDraft: true, ci: [passing] }),
      "draft",
    ],
  ];

  it.each(samples)("puts %s in %s", (_label, input, want) => {
    expect(bucketOf(input)).toBe(want);
  });

  it("has a sample for every bucket", () => {
    const covered = new Set(samples.map(([, , bucket]) => bucket));
    expect([...covered].sort()).toEqual(BUCKETS.map((b) => b.id).sort());
  });
});

// Cases where more than one rule matches, or where an earlier rule only just
// fails, so the order of the table decides.
describe("precedence", () => {
  const cases: [string, PrInput, BucketId][] = [
    // Ready to land before everything after it.
    [
      "someone else's approved PR the owner has not reviewed: ready, not awaiting",
      pr({ reviews: [review(maintainer, "approved")] }),
      "ready-to-land",
    ],
    [
      "someone else's approved PR the owner also approved: ready, not waiting",
      pr({ reviews: [review(owner, "approved")] }),
      "ready-to-land",
    ],
    [
      "the owner's own approved PR: ready",
      pr({ author: owner, reviews: [review(maintainer, "approved")] }),
      "ready-to-land",
    ],
    [
      "mergeability being checked counts as no conflicts",
      pr({ author: owner, ci: [passing], mergeable: "unknown" }),
      "ready-to-land",
    ],
    // Broken before changes requested and CI running.
    [
      "the owner's PR with failing CI and changes requested: broken",
      pr({
        author: owner,
        ci: [failing],
        reviews: [review(maintainer, "changes_requested")],
      }),
      "broken",
    ],
    [
      "the owner's PR with conflicts and CI running: broken",
      pr({ author: owner, ci: [running], mergeable: "conflicting" }),
      "broken",
    ],
    [
      "the owner's approved PR with conflicts: broken, not ready",
      pr({
        author: owner,
        mergeable: "conflicting",
        reviews: [review(maintainer, "approved")],
      }),
      "broken",
    ],
    // Awaiting your review before CI running and waiting on the author.
    [
      "someone else's unreviewed PR with CI running: awaiting, not CI running",
      pr({ ci: [running] }),
      "awaiting-your-review",
    ],
    [
      "someone else's approved PR with CI running, owner not reviewed: awaiting",
      pr({ ci: [running], reviews: [review(maintainer, "approved")] }),
      "awaiting-your-review",
    ],
    [
      "someone else's approved PR with conflicts, owner not reviewed: awaiting",
      pr({
        mergeable: "conflicting",
        reviews: [review(maintainer, "approved")],
      }),
      "awaiting-your-review",
    ],
    [
      "someone else's PR with failing CI, owner not reviewed: awaiting",
      pr({ ci: [failing] }),
      "awaiting-your-review",
    ],
    [
      "someone else's PR approved, then pushed to: back to awaiting",
      pr({ reviews: [review(maintainer, "approved", OLD)] }),
      "awaiting-your-review",
    ],
    [
      "someone else's PR the owner approved, then pushed to: back to awaiting",
      pr({ reviews: [review(owner, "approved", OLD)] }),
      "awaiting-your-review",
    ],
    [
      "someone else's PR approved by a reviewer with read permission: awaiting",
      pr({ reviews: [review(reader, "approved")] }),
      "awaiting-your-review",
    ],
    [
      "someone else's PR approved by a passer-by: awaiting",
      pr({ reviews: [review(passerBy, "approved")] }),
      "awaiting-your-review",
    ],
    [
      "someone else's PR changes-requested by a co-maintainer, owner not reviewed: awaiting",
      pr({ reviews: [review(maintainer, "changes_requested")] }),
      "awaiting-your-review",
    ],
    // Changes requested on yours before CI running.
    [
      "the owner's PR with changes requested and CI running: changes requested",
      pr({
        author: owner,
        ci: [running],
        reviews: [review(maintainer, "changes_requested")],
      }),
      "changes-requested-on-yours",
    ],
    [
      "the owner's PR with a request for changes made on an older commit",
      pr({
        author: owner,
        reviews: [review(maintainer, "changes_requested", OLD)],
      }),
      "changes-requested-on-yours",
    ],
    [
      "the owner's PR with a passer-by's request for changes: still ready",
      pr({ author: owner, reviews: [review(passerBy, "changes_requested")] }),
      "ready-to-land",
    ],
    [
      "the owner's PR on an organization repository where a co-maintainer requested changes",
      pr({
        repository: orgRepo,
        author: owner,
        reviews: [review(maintainer, "changes_requested")],
      }),
      "changes-requested-on-yours",
    ],
    // CI running before waiting on the author.
    [
      "someone else's PR the owner reviewed, with CI running: CI running",
      pr({ ci: [running], reviews: [review(owner, "changes_requested")] }),
      "ci-running",
    ],
    [
      "someone else's approved PR the owner reviewed, with CI running",
      pr({ ci: [running], reviews: [review(owner, "approved")] }),
      "ci-running",
    ],
    // Waiting on the author once nothing earlier applies.
    [
      "someone else's PR with failing CI that the owner reviewed: waiting",
      pr({ ci: [failing], reviews: [review(owner, "commented")] }),
      "waiting-on-the-author",
    ],
    [
      "someone else's approved PR with conflicts that the owner reviewed: waiting",
      pr({
        mergeable: "conflicting",
        reviews: [review(owner, "approved")],
      }),
      "waiting-on-the-author",
    ],
    [
      "someone else's PR approved by the owner but blocked by a co-maintainer: waiting",
      pr({
        reviews: [
          review(owner, "approved"),
          review(maintainer, "changes_requested"),
        ],
      }),
      "waiting-on-the-author",
    ],
    // Draft is last but catches every draft.
    [
      "the owner's draft that would otherwise be ready",
      pr({ author: owner, isDraft: true, ci: [passing] }),
      "draft",
    ],
    [
      "the owner's draft with failing CI and conflicts",
      pr({
        author: owner,
        isDraft: true,
        ci: [failing],
        mergeable: "conflicting",
      }),
      "draft",
    ],
    [
      "someone else's approved draft",
      pr({ isDraft: true, reviews: [review(maintainer, "approved")] }),
      "draft",
    ],
    [
      "someone else's draft with CI running, unreviewed",
      pr({ isDraft: true, ci: [running] }),
      "draft",
    ],
  ];

  it.each(cases)("%s", (_label, input, want) => {
    expect(bucketOf(input)).toBe(want);
  });

  it("gives a reviewer write permission on an organization repository the same weight", () => {
    const input = pr({
      repository: orgRepo,
      reviews: [review(passerBy, "approved")],
      reviewerPermissions: permissions({ [passerBy.id]: "maintain" }),
    });
    expect(bucketOf(input)).toBe("ready-to-land");
  });
});

// Every combination of the inputs the rules read: author, draft state, CI,
// mergeability, review state and whether the owner reviewed the head.
describe("every combination", () => {
  const ciStates: CiState[] = ["failing", "pending", "passing", "none"];
  const mergeabilities: Mergeability[] = ["mergeable", "conflicting", "unknown"];
  const reviewStates: ReviewState[] = ["changes_requested", "approved", "none"];
  const booleans = [false, true];

  const combinations: PrFacts[] = booleans.flatMap((isOwners) =>
    booleans.flatMap((isDraft) =>
      ciStates.flatMap((ci) =>
        mergeabilities.flatMap((mergeable) =>
          reviewStates.flatMap((reviewState) =>
            booleans.map((ownerReviewedHead) => ({
              isOwners,
              isDraft,
              ci,
              mergeable,
              reviewState,
              ownerReviewedHead,
            })),
          ),
        ),
      ),
    ),
  );

  // The table restated as a decision tree, written independently of the
  // rule list so a mistake in either shows up as a disagreement.
  function expected(f: PrFacts): BucketId {
    if (f.isDraft) return "draft";
    const conflicts = f.mergeable === "conflicting";
    const green = f.ci === "passing" || f.ci === "none";
    if (f.isOwners) {
      if (green && !conflicts && f.reviewState !== "changes_requested") {
        return "ready-to-land";
      }
      if (f.ci === "failing" || conflicts) return "broken";
      if (f.reviewState === "changes_requested") {
        return "changes-requested-on-yours";
      }
      return "ci-running";
    }
    if (green && !conflicts && f.reviewState === "approved") {
      return "ready-to-land";
    }
    if (!f.ownerReviewedHead) return "awaiting-your-review";
    if (f.ci === "pending") return "ci-running";
    return "waiting-on-the-author";
  }

  // A whole input that derives to the given facts. Comments from the owner
  // record a review of the head without changing review state.
  function inputFor(f: PrFacts): PrInput {
    const ci: Record<CiState, CiResult[]> = {
      failing: [passing, failing],
      pending: [passing, running],
      passing: [passing],
      none: [],
    };
    const reviews: Review[] = [];
    if (f.reviewState === "approved") reviews.push(review(maintainer, "approved"));
    if (f.reviewState === "changes_requested") {
      reviews.push(review(maintainer, "changes_requested"));
    }
    if (f.ownerReviewedHead) reviews.push(review(owner, "commented"));
    return pr({
      author: f.isOwners ? owner : passerBy,
      isDraft: f.isDraft,
      ci: ci[f.ci],
      mergeable: f.mergeable,
      reviews,
    });
  }

  it("enumerates all 288 combinations", () => {
    expect(combinations).toHaveLength(2 * 2 * 4 * 3 * 3 * 2);
    expect(new Set(combinations.map((c) => JSON.stringify(c))).size).toBe(288);
  });

  it("puts every combination in exactly one bucket, the first that matches", () => {
    for (const facts of combinations) {
      const label = JSON.stringify(facts);
      const matching = BUCKETS.filter((b) => b.matches(facts));
      expect(matching.length, label).toBeGreaterThan(0);
      expect(bucketFor(facts), label).toBe(matching[0]);
      expect(bucketFor(facts).id, label).toBe(expected(facts));
    }
  });

  it("reaches every bucket", () => {
    const reached = new Set(combinations.map((f) => bucketFor(f).id));
    expect(reached.size).toBe(BUCKETS.length);
  });

  it("derives each combination from a whole input and buckets it the same", () => {
    for (const facts of combinations) {
      const input = inputFor(facts);
      expect(deriveFacts(input, ownerId), JSON.stringify(facts)).toEqual(facts);
      expect(bucketOf(input), JSON.stringify(facts)).toBe(expected(facts));
    }
  });

  it("never lets a draft out of Draft or a non-draft into it", () => {
    for (const facts of combinations) {
      expect(bucketFor(facts).id === "draft").toBe(facts.isDraft);
    }
  });

  it("treats mergeability being checked exactly like mergeable", () => {
    for (const facts of combinations) {
      if (facts.mergeable !== "unknown") continue;
      expect(bucketFor(facts)).toBe(
        bucketFor({ ...facts, mergeable: "mergeable" }),
      );
    }
  });
});

describe("BUCKETS", () => {
  it("lists the table's buckets in order, Needs you before Waiting", () => {
    expect(BUCKETS.map((b) => [b.group, b.title])).toEqual([
      ["needs-you", "Ready to land"],
      ["needs-you", "Broken"],
      ["needs-you", "Awaiting your review"],
      ["needs-you", "Changes requested on yours"],
      ["waiting", "CI running"],
      ["waiting", "Waiting on the author"],
      ["waiting", "Draft"],
    ]);
  });
});
