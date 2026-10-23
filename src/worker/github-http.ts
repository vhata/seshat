/** Bounded, secret-free transport shared by installation-authenticated reads. */
export const GITHUB_API = "https://api.github.com";
export const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "seshat",
};

export async function githubRequest(token: string, path: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    const headers = new Headers(GITHUB_HEADERS);
    headers.set("authorization", `Bearer ${token}`);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    return await fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10_000),
      // workerd supports follow/manual; manual also keeps credentials away
      // from redirected hosts. Every reader rejects the resulting 3xx.
      redirect: "manual",
    });
  } catch {
    return null;
  }
}

export async function responseJson(response: Response | null): Promise<unknown> {
  try {
    return response ? await response.json() : null;
  } catch {
    return null;
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
