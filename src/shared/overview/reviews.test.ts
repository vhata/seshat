import { describe, expect, it } from "vitest";
import {
  deriveReviewState,
  isTrustedReviewer,
  latestOpinions,
  ownerReviewedHead,
} from "./reviews";
import {
  HEAD,
  OLD,
  dependabot,
  impostor,
  maintainer,
  orgRepo,
  owner,
  passerBy,
  permissions,
  pr,
  reader,
  review,
} from "./testing";
import type { RepositoryPermission } from "./types";

const ownerId = owner.id;

describe("isTrustedReviewer", () => {
  const cases: [RepositoryPermission, boolean][] = [
    ["admin", true],
    ["maintain", true],
    ["write", true],
    ["triage", false],
    ["read", false],
    ["none", false],
  ];

  it.each(cases)("treats %s permission as trusted: %s", (permission, want) => {
    const subject = pr({
      reviewerPermissions: permissions({ [passerBy.id]: permission }),
    });
    expect(isTrustedReviewer(passerBy, subject, ownerId)).toBe(want);
  });

  it("does not trust an account with no reported permission", () => {
    const subject = pr({ reviewerPermissions: permissions({}) });
    expect(isTrustedReviewer(passerBy, subject, ownerId)).toBe(false);
  });

  it("does not trust a bot, whatever its permission", () => {
    const subject = pr({
      reviewerPermissions: permissions({ [dependabot.id]: "admin" }),
    });
    expect(isTrustedReviewer(dependabot, subject, ownerId)).toBe(false);
  });

  it("does not trust a missing author", () => {
    expect(isTrustedReviewer(null, pr(), ownerId)).toBe(false);
  });

  it("trusts the owner on their own repository with no permission lookup", () => {
    const subject = pr({ reviewerPermissions: permissions({}) });
    expect(isTrustedReviewer(owner, subject, ownerId)).toBe(true);
  });

  it("trusts the owner on an organization repository only with write", () => {
    const withRead = pr({
      repository: orgRepo,
      reviewerPermissions: permissions({ [owner.id]: "read" }),
    });
    const withWrite = pr({
      repository: orgRepo,
      reviewerPermissions: permissions({ [owner.id]: "write" }),
    });
    const unknown = pr({
      repository: orgRepo,
      reviewerPermissions: permissions({}),
    });
    expect(isTrustedReviewer(owner, withRead, ownerId)).toBe(false);
    expect(isTrustedReviewer(owner, withWrite, ownerId)).toBe(true);
    expect(isTrustedReviewer(owner, unknown, ownerId)).toBe(false);
  });

  it("matches the owner by ID, not login", () => {
    const subject = pr({ reviewerPermissions: permissions({}) });
    expect(isTrustedReviewer(impostor, subject, ownerId)).toBe(false);
  });
});

describe("deriveReviewState", () => {
  const state = (...reviews: ReturnType<typeof review>[]) =>
    deriveReviewState(pr({ reviews }), ownerId);

  it("is none with no reviews", () => {
    expect(state()).toBe("none");
  });

  it("is approved by a trusted approval on the current head", () => {
    expect(state(review(maintainer, "approved"))).toBe("approved");
  });

  it("is none when the only approval is on an earlier commit", () => {
    expect(state(review(maintainer, "approved", OLD))).toBe("none");
  });

  it("is none when the approval's commit is not reported", () => {
    expect(state(review(maintainer, "approved", null))).toBe("none");
  });

  it("is changes requested by a trusted request on the current head", () => {
    expect(state(review(maintainer, "changes_requested"))).toBe(
      "changes_requested",
    );
  });

  it("keeps a request for changes made on an earlier commit", () => {
    expect(state(review(maintainer, "changes_requested", OLD))).toBe(
      "changes_requested",
    );
  });

  it("puts changes requested ahead of another reviewer's approval", () => {
    expect(
      state(
        review(owner, "approved"),
        review(maintainer, "changes_requested", OLD),
      ),
    ).toBe("changes_requested");
  });

  it("is approved when one approval is current and another has lapsed", () => {
    expect(
      state(review(owner, "approved", OLD), review(maintainer, "approved")),
    ).toBe("approved");
  });

  it("ignores comment-only reviews", () => {
    expect(state(review(maintainer, "commented"))).toBe("none");
    // A comment does not withdraw an earlier request for changes...
    expect(
      state(
        review(maintainer, "changes_requested"),
        review(maintainer, "commented"),
      ),
    ).toBe("changes_requested");
    // ...or an earlier approval.
    expect(
      state(review(maintainer, "approved"), review(maintainer, "commented")),
    ).toBe("approved");
  });

  it("lets a later approval replace the same reviewer's request", () => {
    expect(
      state(
        review(maintainer, "changes_requested", OLD),
        review(maintainer, "approved"),
      ),
    ).toBe("approved");
  });

  it("lets a later request replace the same reviewer's approval", () => {
    expect(
      state(
        review(maintainer, "approved"),
        review(maintainer, "changes_requested"),
      ),
    ).toBe("changes_requested");
  });

  it("drops a request for changes once it is dismissed", () => {
    expect(state(review(maintainer, "dismissed"))).toBe("none");
  });

  it("does not revive an earlier review when a later one is dismissed", () => {
    // Requested changes, then approved; the approval was dismissed.
    expect(
      state(
        review(maintainer, "changes_requested"),
        review(maintainer, "dismissed"),
      ),
    ).toBe("none");
    // Approved, then requested changes; the request was dismissed.
    expect(
      state(review(maintainer, "approved"), review(maintainer, "dismissed")),
    ).toBe("none");
  });

  it("orders reviews by submission time, not input order", () => {
    const later = review(maintainer, "approved");
    const earlier = review(maintainer, "changes_requested");
    const swapped = { ...earlier, submittedAt: (later.submittedAt ?? 0) - 1 };
    expect(state(later, swapped)).toBe("approved");
  });

  it("keeps input order between reviews submitted at the same time", () => {
    const a = review(maintainer, "changes_requested");
    const b = { ...review(maintainer, "approved"), submittedAt: a.submittedAt };
    expect(state(a, b)).toBe("approved");
    expect(state(b, a)).toBe("changes_requested");
  });

  it("ignores pending reviews", () => {
    expect(state(review(maintainer, "approved", HEAD, null))).toBe("none");
    expect(
      state({ ...review(maintainer, "changes_requested"), state: "pending" }),
    ).toBe("none");
  });

  it.each([
    ["a reviewer with read permission", reader],
    ["a reviewer with no reported permission", passerBy],
    ["a bot", dependabot],
    ["a missing author", null],
  ])("ignores approvals and requests from %s", (_label, author) => {
    expect(state(review(author, "approved"))).toBe("none");
    expect(state(review(author, "changes_requested"))).toBe("none");
  });

  it("ignores a bot even when GitHub reports write permission for it", () => {
    const subject = pr({
      reviews: [review(dependabot, "changes_requested")],
      reviewerPermissions: permissions({ [dependabot.id]: "write" }),
    });
    expect(deriveReviewState(subject, ownerId)).toBe("none");
  });

  it("withdraws a reviewer's reviews when their permission drops", () => {
    const reviews = [review(maintainer, "approved")];
    const before = pr({
      reviews,
      reviewerPermissions: permissions({ [maintainer.id]: "write" }),
    });
    const after = pr({
      reviews,
      reviewerPermissions: permissions({ [maintainer.id]: "read" }),
    });
    expect(deriveReviewState(before, ownerId)).toBe("approved");
    expect(deriveReviewState(after, ownerId)).toBe("none");
  });

  it("counts the owner's approval on an organization repository only with write", () => {
    const reviews = [review(owner, "approved")];
    const withRead = pr({
      repository: orgRepo,
      reviews,
      reviewerPermissions: permissions({ [owner.id]: "read" }),
    });
    const withAdmin = pr({
      repository: orgRepo,
      reviews,
      reviewerPermissions: permissions({ [owner.id]: "admin" }),
    });
    expect(deriveReviewState(withRead, ownerId)).toBe("none");
    expect(deriveReviewState(withAdmin, ownerId)).toBe("approved");
  });
});

describe("latestOpinions", () => {
  it("keeps one review per trusted reviewer", () => {
    const first = review(maintainer, "changes_requested");
    const untrusted = review(passerBy, "approved");
    const last = review(maintainer, "approved");
    const comment = review(maintainer, "commented");
    const opinions = latestOpinions(
      pr({ reviews: [first, untrusted, last, comment] }),
      ownerId,
    );
    expect([...opinions.entries()]).toEqual([[maintainer.id, last]]);
  });
});

describe("ownerReviewedHead", () => {
  const reviewed = (...reviews: ReturnType<typeof review>[]) =>
    ownerReviewedHead(pr({ reviews }), ownerId);

  it.each(["approved", "changes_requested", "commented"] as const)(
    "is true for an owner's %s review on the head",
    (state) => {
      expect(reviewed(review(owner, state))).toBe(true);
    },
  );

  it("is true for an owner's review on the head that was dismissed", () => {
    expect(reviewed(review(owner, "dismissed"))).toBe(true);
  });

  it("is false with no reviews", () => {
    expect(reviewed()).toBe(false);
  });

  it("is false when the owner's reviews are on an earlier commit", () => {
    expect(
      reviewed(review(owner, "approved", OLD), review(owner, "commented", OLD)),
    ).toBe(false);
  });

  it("is false when the owner's review commit is not reported", () => {
    expect(reviewed(review(owner, "approved", null))).toBe(false);
  });

  it("is false for a pending review", () => {
    expect(reviewed(review(owner, "pending", HEAD, null))).toBe(false);
  });

  it("is false for other people's reviews on the head", () => {
    expect(
      reviewed(review(maintainer, "approved"), review(impostor, "commented")),
    ).toBe(false);
  });

  it("counts the owner's review whatever their permission", () => {
    const subject = pr({
      repository: orgRepo,
      reviews: [review(owner, "commented")],
      reviewerPermissions: permissions({ [owner.id]: "read" }),
    });
    expect(ownerReviewedHead(subject, ownerId)).toBe(true);
  });
});
