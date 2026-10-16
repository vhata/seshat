import type { Account, PrInput, RepositoryPermission, Review } from "./types";

/** The review state defined under Terms in docs/DELIVERABLE.md. */
export type ReviewState = "changes_requested" | "approved" | "none";

const TRUSTED: ReadonlySet<RepositoryPermission> = new Set([
  "admin",
  "maintain",
  "write",
]);

/**
 * Whether an account's reviews count towards review state: a person, not a
 * bot or app, with write permission or higher as GitHub reports it now. The
 * owner is trusted on every repository their account owns; elsewhere they need
 * write like anyone else.
 */
export function isTrustedReviewer(
  account: Account | null,
  pr: Pick<PrInput, "repository" | "reviewerPermissions">,
  ownerId: number,
): boolean {
  if (account === null || account.isBot) return false;
  if (account.id === ownerId && pr.repository.ownerAccountId === ownerId) {
    return true;
  }
  const permission = pr.reviewerPermissions.get(account.id);
  return permission !== undefined && TRUSTED.has(permission);
}

/** Submitted reviews, oldest first; equal times keep their input order. */
function chronological(reviews: readonly Review[]): Review[] {
  return reviews
    .filter((review) => review.state !== "pending" && review.submittedAt !== null)
    .map((review, index) => ({ review, index }))
    .sort(
      (a, b) =>
        (a.review.submittedAt ?? 0) - (b.review.submittedAt ?? 0) ||
        a.index - b.index,
    )
    .map(({ review }) => review);
}

/**
 * Each trusted reviewer's latest approval or request for changes, keyed by
 * account ID.
 *
 * Reading of Terms, "Review state": a dismissed review is ignored in that it
 * neither approves nor requests changes, but it still replaces the reviewer's
 * earlier reviews. Otherwise, after a request for changes, an approval and the
 * approval's dismissal, the old request would stand again, though Terms says a
 * request for changes stands only "until that reviewer reviews again". GitHub
 * reports a dismissed review only as `dismissed`, so whether it approved or
 * requested changes is not known. Comment-only reviews replace nothing.
 */
export function latestOpinions(
  pr: Pick<PrInput, "repository" | "reviewerPermissions" | "reviews">,
  ownerId: number,
): Map<number, Review> {
  const latest = new Map<number, Review>();
  for (const review of chronological(pr.reviews)) {
    if (review.state === "commented") continue;
    const author = review.author;
    if (author === null || !isTrustedReviewer(author, pr, ownerId)) continue;
    if (review.state === "dismissed") latest.delete(author.id);
    else latest.set(author.id, review);
  }
  return latest;
}

/**
 * Changes requested if any trusted reviewer's latest opinion requests
 * changes, wherever it was submitted; otherwise approved if any trusted
 * reviewer's latest opinion approves the current head; otherwise none. An
 * approval of an earlier commit has lapsed.
 */
export function deriveReviewState(
  pr: Pick<
    PrInput,
    "repository" | "reviewerPermissions" | "reviews" | "headSha"
  >,
  ownerId: number,
): ReviewState {
  const opinions = [...latestOpinions(pr, ownerId).values()];
  if (opinions.some((review) => review.state === "changes_requested")) {
    return "changes_requested";
  }
  if (
    opinions.some(
      (review) => review.state === "approved" && review.commitSha === pr.headSha,
    )
  ) {
    return "approved";
  }
  return "none";
}

/**
 * Whether the owner submitted any review (approval, request for changes or
 * comment) on the current head commit. Trust plays no part here.
 *
 * Reading of Terms, "Reviewed the current head": a review that was later
 * dismissed still counts, because the owner did submit it on this head; the
 * dismissal changes review state, not whether the owner has looked.
 */
export function ownerReviewedHead(
  pr: Pick<PrInput, "reviews" | "headSha">,
  ownerId: number,
): boolean {
  return pr.reviews.some(
    (review) =>
      review.author?.id === ownerId &&
      review.state !== "pending" &&
      review.submittedAt !== null &&
      review.commitSha === pr.headSha,
  );
}
