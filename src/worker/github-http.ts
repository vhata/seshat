/** Bounded, secret-free transport shared by installation-authenticated reads. */
export const GITHUB_API = "https://api.github.com";
export const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "seshat",
};

export async function githubRequest(token: string, path: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    return await fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
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
