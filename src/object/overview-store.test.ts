import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { fixturePr, FIXTURE_NOW, FIXTURE_REPOSITORY, SYNC_FIXTURES } from "../shared/overview/fixtures";
import { MIGRATIONS } from "./schema";
import { OverviewStore } from "./overview-store";

describe("overview storage", () => {
  it("migrates version two without changing sessions or installation rows", async () => {
    const stub = env.INSTANCE.getByName("overview-old-schema");
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE schema_version (version INTEGER NOT NULL) STRICT");
      sql.exec("INSERT INTO schema_version VALUES (2)");
      for (const migration of MIGRATIONS.slice(0, 2)) {
        for (const statement of migration.statements) sql.exec(statement);
      }
      sql.exec("INSERT INTO settings VALUES ('example', 'retained')");
      sql.exec("INSERT INTO sessions VALUES ('hash', 0, 9000)");
      sql.exec("INSERT INTO installations VALUES (9, 1001, 'User', 'accepted', 'all')");
    });
    await evictDurableObject(stub);
    await stub.health();
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT * FROM settings").toArray()).toEqual([{ key: "example", value: "retained" }]);
      expect(state.storage.sql.exec("SELECT * FROM sessions").toArray()).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT * FROM installations").toArray()).toHaveLength(1);
      const store = new OverviewStore(state.storage);
      expect(store.repositories()).toEqual([]);
      expect(store.pullRequests()).toEqual([]);
      expect(store.syncStatus()).toEqual(SYNC_FIXTURES.initial);
    });
  });

  it("retains Map permissions, unknown dates, metadata and sync state after eviction", async () => {
    const stub = env.INSTANCE.getByName("overview-roundtrip");
    await stub.health();
    await runInDurableObject(stub, (_instance, state) => {
      const store = new OverviewStore(state.storage);
      store.putRepository(FIXTURE_REPOSITORY);
      store.putPullRequest(fixturePr({ reviewerPermissions: new Map([[42, "write"]]), activity: { openedAt: NaN, lastCommitAt: NaN, lastCommentAt: null, lastStateChangeAt: null } }));
      store.putSyncStatus(SYNC_FIXTURES.failed);
    });
    await evictDurableObject(stub);
    const snapshot = await stub.overviewSnapshot(FIXTURE_NOW);
    expect(snapshot.repositories).toEqual([FIXTURE_REPOSITORY]);
    expect(snapshot.sync).toEqual(SYNC_FIXTURES.failed);
    const rows = snapshot.buckets.flatMap((bucket) => bucket.rows);
    expect(rows[0]).toMatchObject({ lastActivityAt: null, stale: false, pr: { title: "Keep the overview current", activity: { openedAt: null }, reviewerPermissions: [[42, "write"]] } });
    await runInDurableObject(stub, (_instance, state) => {
      const pr = new OverviewStore(state.storage).pullRequests()[0]!;
      expect(pr.reviewerPermissions.get(42)).toBe("write");
      expect(Number.isNaN(pr.activity.openedAt)).toBe(true);
    });
  });

  it("does not write unchanged repository, PR or sync data", async () => {
    const stub = env.INSTANCE.getByName("overview-unchanged");
    await stub.health();
    await runInDurableObject(stub, (_instance, state) => {
      const store = new OverviewStore(state.storage);
      store.putRepository(FIXTURE_REPOSITORY);
      store.putPullRequest(fixturePr());
      store.putSyncStatus(SYNC_FIXTURES.live);
      const exec = vi.spyOn(state.storage.sql, "exec");
      expect(store.putRepository(FIXTURE_REPOSITORY)).toBe(false);
      expect(store.putPullRequest(fixturePr())).toBe(false);
      expect(store.putSyncStatus(SYNC_FIXTURES.live)).toBe(false);
      expect(exec.mock.calls.every(([statement]) => statement.startsWith("SELECT"))).toBe(true);
    });
  });

  it("removes PRs atomically on monitoring changes and ignores future writes to them", async () => {
    const stub = env.INSTANCE.getByName("overview-monitoring");
    await stub.health();
    await runInDurableObject(stub, (_instance, state) => {
      const store = new OverviewStore(state.storage);
      store.putRepository(FIXTURE_REPOSITORY);
      store.putPullRequest(fixturePr());
      store.putRepository({ ...FIXTURE_REPOSITORY, monitored: false, monitorOverride: false });
      expect(store.pullRequests()).toEqual([]);
      expect(store.putPullRequest(fixturePr())).toBe(false);
    });
  });

  it("reconciles complete lists, leaves other repositories intact and rejects mismatched batches", async () => {
    const stub = env.INSTANCE.getByName("overview-reconcile");
    await stub.health();
    await runInDurableObject(stub, (_instance, state) => {
      const store = new OverviewStore(state.storage);
      store.putRepository(FIXTURE_REPOSITORY);
      store.putRepository({ ...FIXTURE_REPOSITORY, id: 13, installationId: 10 });
      store.putPullRequest(fixturePr());
      store.putPullRequest(fixturePr({ nodeId: "PR_other", repositoryId: 13 }));
      expect(() => store.reconcileCompleteRepository(12, [fixturePr({ repositoryId: 13 })])).toThrow("repository mismatch");
      expect(store.pullRequests()).toHaveLength(2);
      store.reconcileCompleteRepository(12, []);
      expect(store.pullRequests().map((pr) => pr.nodeId)).toEqual(["PR_other"]);
      store.replaceInstallationRepositories(9, []);
      expect(store.repositories().map((repo) => repo.id)).toEqual([13]);
      expect(store.pullRequests()).toHaveLength(1);
      store.removeRepository(13);
      expect(store.pullRequests()).toEqual([]);
    });
  });
});
