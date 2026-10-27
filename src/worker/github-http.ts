/** Bounded, secret-free transport shared by installation-authenticated reads. */
export const GITHUB_API = "https://api.github.com";
export const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "seshat",
};

const FAILURE_OPERATIONS = [
  "transport", "response-json", "pr-count", "pr-list", "pr-reread",
  "sync-listing", "sync-count", "sync-read", "sync-unexpected",
] as const;
const FAILURE_REASONS = [
  "http", "timeout", "network", "invalid-json", "unexpected",
  "github-failed", "graphql-errors", "malformed", "unavailable",
  "request-limit", "permission-failed", "changed-during-read",
  "rate-limited", "interrupted", "github-unavailable",
  "installation-removed", "installation-suspended", "cloudflare-quota",
] as const;
export type GithubFailureOperation = typeof FAILURE_OPERATIONS[number];
export type GithubFailureReason = typeof FAILURE_REASONS[number];

/** Fixed diagnostic vocabulary only: upstream data and errors stay private. */
export function reportGithubFailure(operation: GithubFailureOperation, reason: GithubFailureReason,
  status?: number, context: { readonly attempt?: 1 | 2 } = {}): void {
  console.warn("seshat.github.failure", {
    operation: FAILURE_OPERATIONS.includes(operation) ? operation : "unknown",
    reason: FAILURE_REASONS.includes(reason) ? reason : "unexpected",
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(context.attempt === 1 || context.attempt === 2 ? { attempt: context.attempt } : {}),
  });
}

export async function githubRequest(token: string, path: string, init: RequestInit = {},
  options: { readonly expectedStatus?: 404 } = {}): Promise<Response | null> {
  let signal: AbortSignal | undefined;
  try {
    const headers = new Headers(GITHUB_HEADERS);
    headers.set("authorization", `Bearer ${token}`);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    signal = AbortSignal.timeout(10_000);
    const response = await fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers,
      signal,
      // workerd supports follow/manual; manual also keeps credentials away
      // from redirected hosts. Every reader rejects the resulting 3xx.
      redirect: "manual",
    });
    const conditional = (init.method ?? "GET").toUpperCase() === "GET"
      && (headers.has("if-none-match") || headers.has("if-modified-since"));
    const expectedNotFound = response.status === 404 && options.expectedStatus === 404;
    if (!response.ok && !expectedNotFound && !(response.status === 304 && conditional)) reportGithubFailure("transport", "http", response.status);
    return response;
  } catch {
    // Only our own timeout signal identifies a timeout. Upstream exception
    // names and messages are untrusted and never become diagnostic fields.
    reportGithubFailure("transport", signal?.aborted ? "timeout" : "network");
    return null;
  }
}

export async function responseJson(response: Response | null): Promise<unknown> {
  try {
    return response ? await response.json() : null;
  } catch {
    reportGithubFailure("response-json", "invalid-json", response?.status);
    return null;
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Both primary and secondary throttles must remain visible to sync. */
export function rateLimited(response: Response | null): boolean {
  return response?.status === 429 || response?.status === 403
    && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"));
}
