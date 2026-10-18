import type { RepositoryPermission } from "../shared/overview/types";
import { githubRequest, record, responseJson } from "./github-http";

/** Safe to persist separately from tokens, keyed by repository and account ID. */
export interface PermissionCacheEntry {
  readonly repositoryId: number;
  readonly accountId: number;
  readonly login: string;
  readonly permission: RepositoryPermission;
  readonly etag: string | null;
}

export type PermissionRead = {
  readonly ok: boolean;
  readonly entry: PermissionCacheEntry | null;
};

/**
 * GitHub's `permission` gives the base role, including custom roles. A failed
 * lookup preserves the previous entry; 404 is the documented no-access case.
 * ETags are tied to identity and login: never reuse one after an account rename.
 */
export async function readReviewerPermission(
  token: string,
  repository: { readonly id: number; readonly fullName: string },
  account: { readonly id: number; readonly login: string },
  previous: PermissionCacheEntry | null = null,
): Promise<PermissionRead> {
  const matching = previous?.repositoryId === repository.id && previous.accountId === account.id ? previous : null;
  const conditional = matching?.login === account.login ? matching.etag : null;
  const path = repository.fullName.split("/").map(encodeURIComponent).join("/");
  const response = await githubRequest(token, `/repos/${path}/collaborators/${encodeURIComponent(account.login)}/permission`, {
    headers: conditional ? { "if-none-match": conditional } : {},
  });
  if (response?.status === 304 && conditional) return { ok: true, entry: matching };
  if (response?.status === 404) {
    return { ok: true, entry: { repositoryId: repository.id, accountId: account.id, login: account.login, permission: "none", etag: null } };
  }
  if (!response?.ok) return { ok: false, entry: matching };
  const body = record(await responseJson(response));
  const value = body?.permission;
  const builtin = body?.role_name;
  const permission = value === "admin" || value === "write" || value === "read" || value === "none"
    ? value : value === "maintain" && builtin === "maintain" ? "write"
      : value === "triage" && builtin === "triage" ? "read" : null;
  if (!permission) return { ok: false, entry: matching };
  return {
    ok: true,
    entry: { repositoryId: repository.id, accountId: account.id, login: account.login, permission, etag: response.headers.get("etag") },
  };
}
