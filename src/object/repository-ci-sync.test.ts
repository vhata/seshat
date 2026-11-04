import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_REPOSITORY } from "../shared/overview/fixtures";
import type { RepositoryCiData } from "../shared/overview/repository-ci";
import { reduceDelivery } from "../shared/overview/webhook-marks";
import * as ciReader from "../worker/github-repository-ci";
import { GithubPrReader } from "../worker/github-pr-reader";
import type { RepositorySelection } from "./repository-selection";
import { OverviewStore } from "./overview-store";
import { OverviewSync } from "./overview-sync";

afterEach(() => vi.restoreAllMocks());
const NOW = Date.now() + 3_600_000;
const INSTALLATIONS = [{ id: 9, accountId: 1001, accountType: "User" as const, status: "accepted" as const, repositorySelection: "all" as const }];
const DATA: RepositoryCiData = {
  defaultBranch: "main", coverage: "complete", streams: [{ workflowId: 71, name: "Nightly", state: "active", trigger: "schedule",
    completed: { id: 91, attempt: 1, number: 4, createdAt: NOW - 100, updatedAt: NOW, startedAt: NOW - 50, headSha: "head", url: "https://github.com/example/observatory/actions/runs/91", status: "completed", conclusion: "failure" }, pending: null }],
};
function delivery() {
  return reduceDelivery("workflow_run", { installation: { id: 9 }, repository: { id: 12, owner: { id: 1001 }, visibility: "public" }, action: "completed" }, NOW)!;
}
function selection() {
  return { tokens: { get: vi.fn(async () => ({ ok: true, token: "ephemeral-ci-token", expiresAt: NOW + 7_200_000 })) },
    refreshInstallation: vi.fn(async () => ({ ok: true, changed: false, repositoryIds: [12], requestsUsed: 2 })), discardRefreshProgress: vi.fn() } as unknown as RepositorySelection;
}
async function fixture(name: string, run: (context: ConstructorParameters<typeof OverviewSync>[0], store: OverviewStore) => Promise<void>) {
  const stub = env.INSTANCE.getByName(`repository-ci-${name}`); await stub.health();
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new OverviewStore(state.storage); store.putRepository(FIXTURE_REPOSITORY);
    await run({ ownerId: 1001, storage: state.storage, store, selection: selection(), installations: () => INSTALLATIONS,
      visible: () => true, guard: async () => true, publish: async () => {} }, store);
  });
}

describe("durable repository CI scheduling", () => {
  it("checks repositories with no PRs without advancing PR/repository freshness", async () => {
    const reader = vi.spyOn(ciReader, "readRepositoryCi").mockResolvedValue({ kind: "complete", data: DATA, requestsUsed: 4 });
    await fixture("zero-pr", async (context, store) => {
      const counts = vi.spyOn(GithubPrReader.prototype, "countOpenPrs").mockResolvedValue({ repositories: [], status: "complete", issues: [], rateLimit: null, requestsUsed: 1, permissionCache: [], headCommitDates: [], continuation: null });
      const sync = new OverviewSync(context);
      await sync.visibility(NOW, false);
      await sync.alarm(NOW); // complete discovery queues CI even with no PRs
      await sync.alarm(NOW + 1);
      expect(reader).toHaveBeenCalledOnce();
      expect(counts).not.toHaveBeenCalled();
      expect(store.repositoryCi()[0]).toMatchObject({ ...DATA, check: { lastSuccessfulCheckAt: NOW } });
      expect(store.checkStatus("repository", "12").lastSuccessfulCheckAt).toBeNull();
      expect(store.pullRequests()).toEqual([]);
    });
  });

  it("coalesces duplicate events, persists independent results and retains cached failures on permission errors", async () => {
    const reader = vi.spyOn(ciReader, "readRepositoryCi").mockResolvedValue({ kind: "complete", data: DATA, requestsUsed: 4 });
    await fixture("coalesce", async (context, store) => {
      let sync = new OverviewSync(context);
      await sync.receive(delivery(), NOW);
      await sync.receive(delivery(), NOW + 1);
      sync = new OverviewSync(context);
      await sync.alarm(NOW + 2_001);
      expect(reader).toHaveBeenCalledOnce();
      const successful = store.repositoryCi()[0]!.check.lastSuccessfulCheckAt;
      expect(store.checkFreshness().repositories["12"]!.lastSuccessfulCheckAt).toBeNull();
      reader.mockResolvedValue({ kind: "failed", issue: "permission-required", requestsUsed: 2, defaultBranch: "main" });
      await sync.receive(delivery(), NOW + 5_000);
      await sync.alarm(NOW + 7_000);
      expect(store.repositoryCi()[0]).toMatchObject({ issue: "permission-required", streams: DATA.streams, check: { lastSuccessfulCheckAt: successful, latestAttempt: { result: "failed" } } });
      await sync.alarm(NOW + 100_000);
      expect(reader).toHaveBeenCalledTimes(2); // permission errors do not loop
    });
  });

  it("advances PR work after one CI operation despite a large older CI backlog", async () => {
    const reader = vi.spyOn(ciReader, "readRepositoryCi").mockResolvedValue({ kind: "complete", data: DATA, requestsUsed: 4 });
    await fixture("fairness", async (context, store) => {
      for (let id = 13; id < 33; id++) store.putRepository({ ...FIXTURE_REPOSITORY, id, nodeId: `R_${id}`, fullName: `example/repo-${id}` });
      const counts = vi.spyOn(GithubPrReader.prototype, "countOpenPrs").mockResolvedValue({ repositories: [], status: "complete", issues: [], rateLimit: null, requestsUsed: 1, permissionCache: [], headCommitDates: [], continuation: null });
      const sync = new OverviewSync(context);
      await sync.visibility(NOW, false); await sync.alarm(NOW);
      await sync.alarm(NOW + 1);
      expect(reader).toHaveBeenCalledOnce();
      await new OverviewSync(context).alarm(NOW + 2); // fairness survives restart
      expect(counts).toHaveBeenCalledOnce();
      expect(reader).toHaveBeenCalledOnce();
    });
  });

  it("rejects superseded responses and unmonitor/remonitor observations", async () => {
    await fixture("superseded", async (context, store) => {
      const sync = new OverviewSync(context);
      const reader = vi.spyOn(ciReader, "readRepositoryCi").mockImplementation(async () => {
        await sync.receive(delivery(), NOW + 3_000);
        return { kind: "complete", data: DATA, requestsUsed: 4 };
      });
      await sync.receive(delivery(), NOW);
      await sync.alarm(NOW + 2_000);
      expect(store.repositoryCi()[0]!.streams).toEqual([]);
      reader.mockImplementation(async () => {
        store.putRepository({ ...FIXTURE_REPOSITORY, monitored: false });
        store.putRepository(FIXTURE_REPOSITORY);
        return { kind: "complete", data: DATA, requestsUsed: 4 };
      });
      await sync.alarm(NOW + 5_000);
      expect(store.repositoryCi()[0]!.streams).toEqual([]);
    });
  });

  it("clears old-branch freshness even when replacement coverage is incomplete", async () => {
    const reader = vi.spyOn(ciReader, "readRepositoryCi").mockResolvedValue({ kind: "complete", data: DATA, requestsUsed: 4 });
    await fixture("branch", async (context, store) => {
      const sync = new OverviewSync(context);
      await sync.receive(delivery(), NOW); await sync.alarm(NOW + 2_000);
      reader.mockResolvedValue({ kind: "complete", data: { defaultBranch: "trunk", coverage: "incomplete", streams: [] }, requestsUsed: 4 });
      await sync.receive(delivery(), NOW + 4_000); await sync.alarm(NOW + 6_000);
      expect(store.repositoryCi()[0]).toMatchObject({ defaultBranch: "trunk", streams: [], issue: "history-limited", check: { lastSuccessfulCheckAt: null } });
    });
  });

  it("honors shared throttle waits after restart and a new webhook", async () => {
    const reader = vi.spyOn(ciReader, "readRepositoryCi").mockResolvedValue({ kind: "failed", issue: "rate-limited", requestsUsed: 2, retryAt: NOW + 80_000 });
    await fixture("throttle", async (context, store) => {
      let sync = new OverviewSync(context);
      await sync.receive(delivery(), NOW); await sync.alarm(NOW + 2_000);
      sync = new OverviewSync(context);
      await sync.receive(delivery(), NOW + 4_000);
      await sync.alarm(NOW + 6_000);
      expect(reader).toHaveBeenCalledOnce();
      reader.mockResolvedValue({ kind: "complete", data: DATA, requestsUsed: 4 });
      await sync.alarm(NOW + 80_000);
      expect(reader).toHaveBeenCalledTimes(2);
      expect(store.repositoryCi()[0]!.issue).toBeNull();
    });
  });

  it("resumes a token-free continuation after restart with the original check time", async () => {
    const continuation: ciReader.RepositoryCiContinuation = { version: 1, repositoryId: 12, ownerAccountId: 1001,
      fullName: FIXTURE_REPOSITORY.fullName, phase: "inventory", defaultBranch: "main", inventoryPage: 1, inventoryTotal: null,
      inventoryComplete: false, workflows: [], streamIndex: 0, streams: [], current: null };
    const reader = vi.spyOn(ciReader, "readRepositoryCi").mockResolvedValueOnce({ kind: "continuation", continuation, requestsUsed: 20 })
      .mockResolvedValue({ kind: "complete", data: DATA, requestsUsed: 4 });
    await fixture("continuation", async (context, store) => {
      let sync = new OverviewSync(context);
      await sync.receive(delivery(), NOW); await sync.alarm(NOW + 2_000);
      const stored = context.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", "overview-sync-work-v1").toArray()[0]!.value;
      expect(stored).not.toContain("ephemeral-ci-token");
      expect(store.repositoryCi()[0]!.check.latestAttempt?.result).toBe("running");
      sync = new OverviewSync(context); await sync.alarm(NOW + 2_001);
      expect(reader.mock.calls[1]![2]!.continuation).toEqual(continuation);
      expect(store.repositoryCi()[0]!.check.lastSuccessfulCheckAt).toBe(NOW + 2_000);
    });
  });

  it("withdraws CI if organization access is lost while the result is being read", async () => {
    await fixture("org-revoked", async (context, store) => {
      const repository = { ...FIXTURE_REPOSITORY, ownerAccountId: 2002, ownerLogin: "organization", fullName: "organization/observatory" };
      store.putRepository(repository);
      let permission = "write";
      const requests = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/user/1001")) return Response.json({ id: 1001, login: "owner" });
        if (url.endsWith("/collaborators/owner/permission")) return Response.json({ user: { id: 1001 }, permission });
        throw new Error(`Unexpected ${url}`);
      });
      vi.spyOn(ciReader, "readRepositoryCi").mockImplementation(async () => {
        permission = "none";
        return { kind: "complete", data: DATA, requestsUsed: 4 };
      });
      const sync = new OverviewSync(context);
      const event = reduceDelivery("workflow_run", { installation: { id: 9 }, repository: { id: 12, owner: { id: 2002 }, visibility: "private" } }, NOW)!;
      await sync.receive(event, NOW); await sync.alarm(NOW + 2_000);
      expect(requests).toHaveBeenCalledTimes(3);
      expect(store.repositoryCi()[0]).toMatchObject({ streams: [], issue: "permission-required", check: { lastSuccessfulCheckAt: null } });
    });
  });

  it("clears facts and scoped check evidence on membership and identity changes", async () => {
    await fixture("identity", async (_context, store) => {
      const write = () => {
        const repository = store.repositories()[0]!;
        const check = store.beginCheck("repository-ci", "12", NOW, "running");
        store.putRepositoryCi(repository, DATA, check);
        store.finishCheck("repository-ci", "12", check, "success");
      };
      write();
      store.putRepository({ ...FIXTURE_REPOSITORY, muted: true });
      expect(store.repositoryCi()[0]!.streams).toEqual(DATA.streams);
      store.putRepository({ ...FIXTURE_REPOSITORY, monitored: false });
      expect(store.repositoryCi()).toEqual([]);
      store.putRepository(FIXTURE_REPOSITORY);
      expect(store.repositoryCi()[0]!.check.lastSuccessfulCheckAt).toBeNull();
      write(); store.putRepository({ ...FIXTURE_REPOSITORY, ownerAccountId: 2002 });
      expect(store.repositoryCi()[0]!.streams).toEqual([]);
      write(); store.putRepository({ ...FIXTURE_REPOSITORY, ownerAccountId: 2002, installationId: 10 });
      expect(store.repositoryCi()[0]!.streams).toEqual([]);
      store.removeRepository(12); expect(store.repositoryCi()).toEqual([]);
    });
  });

  it("retains authorized organization evidence with unavailable wording on a permission lookup outage", async () => {
    await fixture("org-unavailable", async (context, store) => {
      const repository = { ...FIXTURE_REPOSITORY, ownerAccountId: 2002, ownerLogin: "organization", fullName: "organization/observatory" };
      store.putRepository(repository);
      const previous = store.beginCheck("repository-ci", "12", NOW - 10_000, "running");
      store.putRepositoryCi(repository, DATA, previous); store.finishCheck("repository-ci", "12", previous, "success");
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("/user/1001")
        ? Response.json({ id: 1001, login: "owner" }) : new Response(null, { status: 503 }));
      const reader = vi.spyOn(ciReader, "readRepositoryCi");
      const sync = new OverviewSync(context);
      const event = reduceDelivery("workflow_run", { installation: { id: 9 }, repository: { id: 12, owner: { id: 2002 }, visibility: "private" } }, NOW)!;
      await sync.receive(event, NOW); await sync.alarm(NOW + 2_000);
      expect(reader).not.toHaveBeenCalled();
      expect(store.repositoryCi()[0]).toMatchObject({ issue: "github-unavailable", streams: DATA.streams,
        check: { lastSuccessfulCheckAt: NOW - 10_000, latestAttempt: { result: "failed" } } });
    });
  });

  it("classifies temporary token failures as unavailable and bounds retries", async () => {
    await fixture("token", async (context, store) => {
      vi.spyOn(context.selection!.tokens, "get").mockResolvedValue({ ok: false, reason: "github-failed" });
      const sync = new OverviewSync(context);
      await sync.receive(delivery(), NOW); await sync.alarm(NOW + 2_000);
      expect(store.repositoryCi()[0]!.issue).toBe("github-unavailable");
      for (const offset of [7_000, 22_000, 52_000, 100_000]) await sync.alarm(NOW + offset);
      expect(context.selection!.tokens.get).toHaveBeenCalledTimes(4);
    });
  });

  it("removes canceled hidden CI jobs from alarm and monitoring evidence", async () => {
    await fixture("canceled-monitoring", async (context, store) => {
      context.visible = () => false;
      const sync = new OverviewSync(context);
      await sync.receive(delivery(), NOW);
      expect(sync.monitoringStatus(NOW).oldestPendingAt).not.toBeNull();
      store.putRepository({ ...FIXTURE_REPOSITORY, monitored: false });
      await sync.rearm(NOW + 1);
      expect(await context.storage.getAlarm()).toBeNull();
      expect(sync.monitoringStatus(NOW + 600_001).oldestPendingAt).toBeNull();
      expect(new OverviewSync(context).monitoringStatus(NOW + 600_001).oldestPendingAt).toBeNull();
    });
  });
});
