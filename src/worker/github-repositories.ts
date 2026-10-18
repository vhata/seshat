import type { RepositoryRecord } from "../shared/overview/protocol";
import { githubRequest, rateLimited, record, responseJson } from "./github-http";
import { readReviewerPermission, type PermissionCacheEntry, type PermissionRead } from "./github-permissions";

export const REPOSITORY_PAGES = 10;
export type ListedRepository = Omit<RepositoryRecord, "installationId" | "ownerPermission" | "monitorOverride" | "monitored" | "listedAt">;
export interface RepositoryPage { readonly etag: string | null; readonly total: number; readonly repositories: readonly ListedRepository[] }
export type RepositoryListing =
  | { readonly ok: true; readonly repositories: readonly ListedRepository[] }
  | { readonly ok: false; readonly reason: "github-unavailable" | "rate-limited" | "installation-removed" };

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function parseRepository(value: unknown): ListedRepository | null {
  const repository = record(value);
  const owner = record(repository?.owner);
  if (!repository || !owner || !positiveId(repository.id) || !positiveId(owner.id)
    || typeof owner.login !== "string" || !owner.login || typeof repository.node_id !== "string"
    || !repository.node_id || typeof repository.full_name !== "string"
    || repository.full_name.split("/").length !== 2
    || typeof repository.fork !== "boolean" || typeof repository.archived !== "boolean"
    || !["public", "private", "internal"].includes(String(repository.visibility))) return null;
  return {
    id: repository.id, nodeId: repository.node_id, fullName: repository.full_name,
    ownerAccountId: owner.id, ownerLogin: owner.login,
    visibility: repository.visibility as ListedRepository["visibility"],
    isFork: repository.fork, isArchived: repository.archived,
  };
}

/** Conditional page caches are memory only; incomplete listings never replace state. */
export class GitHubRepositoryListing {
  private readonly pages = new Map<number, readonly RepositoryPage[]>();
  private readonly permissions = new Map<string, PermissionCacheEntry>();

  async list(token: string, installationId: number): Promise<RepositoryListing> {
    const before = this.pages.get(installationId);
    const pages: RepositoryPage[] = [];
    const repositories: ListedRepository[] = [];
    let total: number | undefined;
    for (let index = 0; index < REPOSITORY_PAGES; index++) {
      const cached = before?.[index];
      const read = await this.readPage(token, index + 1, cached);
      if (!read.ok) return read;
      const page = read.page;
      total ??= page.total;
      if (total !== page.total) return { ok: false, reason: "github-unavailable" };
      pages.push(page);
      repositories.push(...page.repositories);
      if (repositories.length > total || new Set(repositories.map((repository) => repository.id)).size !== repositories.length) {
        return { ok: false, reason: "github-unavailable" };
      }
      if (repositories.length === total) {
        this.pages.set(installationId, pages);
        return { ok: true, repositories };
      }
      if (page.repositories.length !== 100) return { ok: false, reason: "github-unavailable" };
    }
    return { ok: false, reason: "github-unavailable" };
  }

  async readPage(token: string, pageNumber: number, cached?: RepositoryPage): Promise<
    | { readonly ok: true; readonly page: RepositoryPage }
    | Extract<RepositoryListing, { ok: false }>
  > {
    const response = await githubRequest(token, `/installation/repositories?per_page=100&page=${pageNumber}`, {
      headers: cached?.etag ? { "if-none-match": cached.etag } : {},
    });
    if (response?.status === 401 || response?.status === 404) return { ok: false, reason: "installation-removed" };
    if (rateLimited(response)) {
      return { ok: false, reason: "rate-limited" };
    }
    if (response?.status === 304 && cached?.etag) return { ok: true, page: cached };
    if (!response?.ok) return { ok: false, reason: "github-unavailable" };
    const body = record(await responseJson(response));
    if (!body || !Number.isSafeInteger(body.total_count) || (body.total_count as number) < 0
      || !Array.isArray(body.repositories) || body.repositories.length > 100) {
      return { ok: false, reason: "github-unavailable" };
    }
    const parsed = body.repositories.map(parseRepository);
    if (parsed.some((repository) => repository === null)) return { ok: false, reason: "github-unavailable" };
    return { ok: true, page: { etag: response.headers.get("etag"), total: body.total_count as number, repositories: parsed as ListedRepository[] } };
  }

  readOwnerPermission(token: string, repository: ListedRepository, ownerId: number, login: string, previous: PermissionCacheEntry | null): Promise<PermissionRead> {
    return readReviewerPermission(token, repository, { id: ownerId, login }, previous);
  }

  async readOwnerLogin(token: string, ownerId: number): Promise<{ ok: true; login: string } | { ok: false; reason: "rate-limited" | "github-unavailable" }> {
    const response = await githubRequest(token, `/user/${ownerId}`);
    if (rateLimited(response)) return { ok: false, reason: "rate-limited" };
    const body = record(await responseJson(response));
    return response?.ok && body?.id === ownerId && typeof body.login === "string" && body.login
      ? { ok: true, login: body.login } : { ok: false, reason: "github-unavailable" };
  }

  async ownerLogin(token: string, ownerId: number): Promise<string | null> {
    const result = await this.readOwnerLogin(token, ownerId);
    return result.ok ? result.login : null;
  }

  async ownerPermission(token: string, repository: ListedRepository, ownerId: number, login: string): Promise<RepositoryRecord["ownerPermission"] | null> {
    if (repository.ownerAccountId === ownerId) return "admin";
    const key = `${repository.id}:${repository.fullName}:${ownerId}`;
    const previous = this.permissions.get(key);
    // Name changes must not send a conditional validator for a different URL.
    const cached = previous && previous.login === login ? previous : null;
    const result = await readReviewerPermission(token, repository, { id: ownerId, login }, cached);
    if (!result.ok || !result.entry) return null;
    this.permissions.set(key, result.entry);
    return result.entry.permission;
  }

  forget(installationId: number): void { this.pages.delete(installationId); }
}
