import type { PrNodeRead } from "../../worker/github-pr-reader";
import type { PullRequestRecord } from "./protocol";

/** Reduced, owner-private event facts. Never a raw webhook payload. */
export type DeliveryFact =
  | { kind: "state"; value: "open" | "closed" | "merged"; at: number }
  | { kind: "draft"; value: boolean; at: number }
  | { kind: "head"; value: string; at: number }
  | { kind: "review"; id: string; state: string; at: number }
  | { kind: "check"; id: string; state: string; conclusion: string | null; sha: string; at: number }
  | { kind: "status"; name: string; state: string; sha: string; at: number };
export interface PrMark {
  nodeId: string;
  repositoryId: number;
  installationId: number;
  facts: DeliveryFact[];
}
export interface ReducedDelivery {
  installationId: number;
  guard: boolean;
  refresh: boolean;
  marks: PrMark[];
  sha: { repositoryId: number; value: string; facts: DeliveryFact[] } | null;
  repository: { id: number; visibility: "public" | "private" | "internal"; ownerId: number | null; deleted: boolean; transferred: boolean } | null;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function id(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function string(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function timestamp(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function reduceDelivery(event: string, input: unknown, now: number): ReducedDelivery | null {
  const payload = record(input);
  const installationId = id(record(payload.installation).id);
  if (installationId === null || !["installation", "installation_repositories", "repository", "pull_request", "pull_request_review", "pull_request_review_comment", "check_run", "check_suite", "status"].includes(event)) return null;
  const repo = record(payload.repository);
  const repositoryId = id(repo.id);
  const action = payload.action;
  const result: ReducedDelivery = {
    installationId, guard: event === "installation" || event === "installation_repositories",
    refresh: ["installation", "installation_repositories", "repository"].includes(event), marks: [], sha: null,
    repository: repositoryId === null ? null : {
      id: repositoryId, visibility: repo.visibility === "public" ? "public" : repo.visibility === "internal" ? "internal" : "private",
      ownerId: id(record(repo.owner).id), deleted: event === "repository" && action === "deleted", transferred: event === "repository" && action === "transferred",
    },
  };
  if (repositoryId === null) return result;
  const mark = (raw: unknown, facts: DeliveryFact[]) => {
    const nodeId = string(record(raw).node_id);
    if (nodeId) result.marks.push({ nodeId, repositoryId, installationId, facts });
    // A missing node ID is recovered by an authoritative repository read.
    else result.refresh = true;
  };
  const pr = record(payload.pull_request);
  const at = timestamp(pr.updated_at, now);
  const facts: DeliveryFact[] = [];
  if (event.startsWith("pull_request")) {
    if (event === "pull_request") {
      if (["opened", "reopened", "closed"].includes(String(action))) facts.push({ kind: "state", value: action === "closed" ? pr.merged === true ? "merged" : "closed" : "open", at });
      if (action === "converted_to_draft" || action === "ready_for_review") facts.push({ kind: "draft", value: action === "converted_to_draft", at });
      const sha = string(record(pr.head).sha);
      if (action === "synchronize" && sha) facts.push({ kind: "head", value: sha, at });
    }
    if (event === "pull_request_review" && ["submitted", "dismissed"].includes(String(action))) {
      const review = record(payload.review);
      const reviewId = id(review.id);
      if (reviewId && typeof review.state === "string") facts.push({ kind: "review", id: String(reviewId), state: action === "dismissed" ? "dismissed" : review.state.toLowerCase(), at: timestamp(review.submitted_at, now) });
    }
    mark(pr, facts);
  } else if (event === "check_run" || event === "check_suite") {
    const check = record(payload[event]);
    const sha = string(check.head_sha);
    const checkId = id(check.id);
    if (event === "check_run" && checkId && sha && typeof check.status === "string") facts.push({ kind: "check", id: String(checkId), sha, state: check.status, conclusion: typeof check.conclusion === "string" ? check.conclusion : null, at: timestamp(check.completed_at ?? check.started_at, now) });
    const prs = Array.isArray(check.pull_requests) ? check.pull_requests : [];
    for (const item of prs) mark(item, facts);
    // Match by SHA as well: fork check payloads have no PR references.
    if (sha) result.sha = { repositoryId, value: sha, facts };
  } else if (event === "status") {
    const sha = string(payload.sha);
    if (sha) {
      if (typeof payload.context === "string" && typeof payload.state === "string") facts.push({ kind: "status", name: payload.context, sha, state: payload.state, at: timestamp(payload.updated_at ?? payload.created_at, now) });
      result.sha = { repositoryId, value: sha, facts };
    }
  }
  return result;
}

function factKey(fact: DeliveryFact): string {
  return fact.kind === "check" || fact.kind === "review" ? `${fact.kind}:${fact.id}`
    : fact.kind === "status" ? `${fact.kind}:${fact.sha}:${fact.name}` : fact.kind;
}
export function coalesceFacts(previous: readonly DeliveryFact[], added: readonly DeliveryFact[]): DeliveryFact[] {
  const facts = new Map(previous.map((fact) => [factKey(fact), fact]));
  for (const fact of added) {
    const before = facts.get(factKey(fact));
    if (!before || fact.at > before.at || (fact.at === before.at && !(before.kind === "check" && before.state === "completed" && fact.kind === "check" && fact.state !== "completed"))) facts.set(factKey(fact), fact);
  }
  return [...facts.values()];
}

export function factObserved(fact: DeliveryFact, result: PrNodeRead, previous: PullRequestRecord | undefined): boolean {
  if (result.kind === "unavailable") return false;
  if (result.kind !== "open") return fact.kind !== "state" || fact.value !== "open";
  const pr = result.pr;
  switch (fact.kind) {
    case "state": return fact.value === "open" || pr.updatedAt > fact.at;
    case "draft": return pr.isDraft === fact.value || pr.updatedAt > fact.at;
    case "head": return pr.headSha === fact.value || (pr.updatedAt > fact.at && previous?.headSha !== pr.headSha);
    case "review": return pr.observations.reviews.some((review) => review.id === fact.id && (review.state === fact.state || review.state === "dismissed"));
    case "check": return pr.headSha !== fact.sha || pr.observations.checks.some((check) => check.kind === "check_run" && check.id === fact.id && (check.state === "completed" && fact.state !== "completed" || check.state === fact.state && (fact.conclusion === null || check.conclusion === fact.conclusion)));
    case "status": return pr.headSha !== fact.sha || pr.observations.checks.some((check) => check.kind === "commit_status" && check.name === fact.name && (check.state === fact.state || fact.state === "pending" && check.state !== "pending"));
  }
}
