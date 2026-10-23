import { signAppJwt } from "../shared/app-jwt";
import type { AppConfig } from "../shared/config";
import { githubRequest, rateLimited, record, responseJson } from "./github-http";

export type InstallationTokenResult =
  | { readonly ok: true; readonly token: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: "invalid-installation" | "signing-failed" | "github-failed" | "rate-limited" | "installation-suspended" | "installation-removed" };

/** Memory-only, per-App cache. Construct once per object; never serialize it. */
export class InstallationTokens {
  private readonly cached = new Map<number, { token: string; expiresAt: number }>();
  private readonly pending = new Map<number, Promise<InstallationTokenResult>>();

  constructor(private readonly app: Pick<AppConfig, "clientId" | "privateKey">) {}

  get(installationId: number, now = Date.now()): Promise<InstallationTokenResult> {
    if (!Number.isSafeInteger(installationId) || installationId <= 0 || !Number.isFinite(now)) {
      return Promise.resolve({ ok: false, reason: "invalid-installation" });
    }
    const cached = this.cached.get(installationId);
    if (cached && cached.expiresAt > now + 180_000) {
      return Promise.resolve({ ok: true, ...cached });
    }
    const pending = this.pending.get(installationId);
    if (pending) return pending;
    const minting = this.mint(installationId, now).finally(() => this.pending.delete(installationId));
    this.pending.set(installationId, minting);
    return minting;
  }

  /** Forget a revoked token before retrying a 401, or after installation removal. */
  forget(installationId: number): void {
    this.cached.delete(installationId);
  }

  private async mint(installationId: number, now: number): Promise<InstallationTokenResult> {
    let jwt: string;
    try {
      jwt = await signAppJwt(this.app.clientId, this.app.privateKey, Math.floor(now / 1000));
    } catch {
      return { ok: false, reason: "signing-failed" };
    }
    const response = await githubRequest(jwt, `/app/installations/${installationId}/access_tokens`, { method: "POST" });
    const body = record(await responseJson(response));
    if (response?.status === 401 || response?.status === 404) return { ok: false, reason: "installation-removed" };
    if (rateLimited(response)) return { ok: false, reason: "rate-limited" };
    if (response?.status === 403 && typeof body?.message === "string" && body.message.toLowerCase().includes("suspend")) return { ok: false, reason: "installation-suspended" };
    const expiresAt = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (response?.status !== 201 || typeof body?.token !== "string" || !body.token || expiresAt <= now + 180_000 || !Number.isFinite(expiresAt)) {
      return { ok: false, reason: "github-failed" };
    }
    const token = { token: body.token, expiresAt };
    this.cached.set(installationId, token);
    return { ok: true, ...token };
  }
}
