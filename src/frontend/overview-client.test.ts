import { describe, expect, it } from "vitest";
import {
  fixtureSnapshot,
  fixturePr,
  FIXTURE_NOW,
  FIXTURE_OWNER_ID,
  FIXTURE_REPOSITORY,
  SYNC_FIXTURES,
} from "../shared/overview/fixtures";
import { buildSnapshot, type OverviewSnapshot } from "../shared/overview/protocol";
import {
  startOverviewClient,
  type ClientEnvironment,
  type OverviewState,
  type SocketLike,
} from "./overview-client";
import { freshness } from "./freshness";
function harness() {
  let now = FIXTURE_NOW + 9_000_000;
  let visible = true;
  let tick = () => {};
  let visibility = () => {};
  let reconnect = () => {};
  let cancelled = 0;
  let closed = 0;
  let state: OverviewState | undefined;
  const sockets: (SocketLike & { sent: string[] })[] = [];
  const env: ClientEnvironment = {
    clock: () => now,
    visible: () => visible,
    socket() {
      const s = {
        sent: [] as string[],
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        send(data: string) {
          this.sent.push(data);
        },
        close() {
          closed++;
        },
      };
      sockets.push(s);
      return s;
    },
    interval(fn) {
      tick = fn;
      return () => {
        cancelled++;
      };
    },
    later(fn) {
      reconnect = fn;
      return () => {
        cancelled++;
      };
    },
    onVisibility(fn) {
      visibility = fn;
      return () => {
        cancelled++;
      };
    },
  };
  const client = startOverviewClient(env, (value) => {
    state = value;
  });
  return {
    client,
    sockets,
    get state() {
      return state!;
    },
    get socket() {
      return sockets.at(-1)!;
    },
    advance(ms: number) {
      now += ms;
      tick();
    },
    visibility(value: boolean) {
      visible = value;
      visibility();
    },
    reconnect() {
      reconnect();
    },
    get cancelled() {
      return cancelled;
    },
    get closed() {
      return closed;
    },
  };
}
function snapshot(h: ReturnType<typeof harness>, value = fixtureSnapshot()) {
  h.socket.onmessage?.({
    data: JSON.stringify({ type: "snapshot", snapshot: value }),
  });
}
function messages(h: ReturnType<typeof harness>) {
  return h.socket.sent
    .filter((s) => s !== "ping")
    .map((s) => JSON.parse(s) as { type: string; visible: boolean });
}
describe("overview socket lifecycle", () => {
  it.each(["snapshot", "pr-changes"] as const)(
    "updates the seven-day stale flag without a GitHub notice or flash via %s",
    (type) => {
      const h = harness();
      h.socket.onopen?.();
      const pr = fixturePr();
      const threshold = pr.activity.lastCommitAt! + 7 * 86_400_000;
      const build = (now: number, input = pr) =>
        buildSnapshot(
          [FIXTURE_REPOSITORY],
          [input],
          SYNC_FIXTURES.live,
          FIXTURE_OWNER_ID,
          now,
        );
      const deliver = (next: OverviewSnapshot) => {
        if (type === "snapshot") snapshot(h, next);
        else
          h.socket.onmessage?.({
            data: JSON.stringify({
              type,
              buckets: next.buckets,
              removed: [],
              serverTime: next.serverTime,
            }),
          });
      };
      const row = () => h.state.snapshot!.buckets.flatMap((b) => b.rows)[0]!;
      snapshot(h, build(threshold - 1));
      expect(row().stale).toBe(false);
      deliver(build(threshold));
      expect(row().stale).toBe(true);
      expect(h.state.changes.size).toBe(0);

      // A source edit at the same threshold still receives a notice.
      const edited = { ...pr, title: "Changed on GitHub" };
      deliver(build(threshold + 1, edited));
      expect(h.state.changes.get(pr.nodeId)).toEqual({
        at: threshold + 1,
        text: "Updated on GitHub",
      });

      // A clock correction must neither replace nor extend that notice.
      deliver(build(threshold - 1, edited));
      expect(row().stale).toBe(false);
      expect(h.state.changes.get(pr.nodeId)).toEqual({
        at: threshold + 1,
        text: "Updated on GitHub",
      });
      h.client.stop();
    },
  );
  it("keeps CI and bucket movement notices when a PR also becomes stale", () => {
    const h = harness();
    h.socket.onopen?.();
    const pr = fixturePr();
    const threshold = pr.activity.lastCommitAt! + 7 * 86_400_000;
    const build = (now: number, input = pr) =>
      buildSnapshot(
        [FIXTURE_REPOSITORY],
        [input],
        SYNC_FIXTURES.live,
        FIXTURE_OWNER_ID,
        now,
      );
    snapshot(h, build(threshold - 1));
    snapshot(h, build(threshold, {
      ...pr,
      ci: [{ kind: "check_run", status: "completed", conclusion: "failure" }],
    }));
    expect(h.state.snapshot!.buckets.find((b) => b.rows.length)?.bucket.id).toBe(
      "broken",
    );
    expect(h.state.snapshot!.buckets.flatMap((b) => b.rows)[0]!.stale).toBe(true);
    expect(h.state.changes.get(pr.nodeId)).toEqual({
      at: threshold,
      text: "CI failing · moved from Ready to land",
    });
    h.client.stop();
  });
  it("keeps failure details through new attempts and reconnect snapshots until success", () => {
    const h = harness();
    h.socket.onopen?.();
    snapshot(h);
    const failed = {
      ...SYNC_FIXTURES.live,
      latestAttempt: {
        result: "failed" as const,
        startedAt: FIXTURE_NOW,
        reason: "installation-suspended" as const,
        unreadableRepositoryIds: [12],
      },
    };
    h.socket.onmessage?.({
      data: JSON.stringify({
        type: "sync",
        sync: failed,
        serverTime: FIXTURE_NOW + 1000,
      }),
    });
    const running = {
      ...SYNC_FIXTURES.live,
      latestAttempt: {
        result: "running" as const,
        startedAt: FIXTURE_NOW + 2000,
      },
    };
    h.socket.onmessage?.({
      data: JSON.stringify({
        type: "sync",
        sync: running,
        serverTime: FIXTURE_NOW + 2000,
      }),
    });
    expect(h.state.snapshot?.sync.latestAttempt).toEqual(failed.latestAttempt);
    expect(freshness({ ...h.state, sync: h.state.snapshot!.sync })).toBe(
      "Sync failed",
    );
    h.socket.onclose?.();
    h.reconnect();
    h.socket.onopen?.();
    snapshot(h, {
      ...fixtureSnapshot(running),
      serverTime: FIXTURE_NOW + 3000,
    });
    expect(h.state.snapshot?.sync.latestAttempt).toEqual(failed.latestAttempt);
    expect(freshness({ ...h.state, sync: h.state.snapshot!.sync })).toBe(
      "Sync failed",
    );
    const success = {
      ...SYNC_FIXTURES.live,
      lastSuccessfulSweepAt: FIXTURE_NOW + 2000,
      latestAttempt: {
        result: "success" as const,
        startedAt: FIXTURE_NOW + 2000,
      },
    };
    h.socket.onmessage?.({
      data: JSON.stringify({
        type: "sync",
        sync: success,
        serverTime: FIXTURE_NOW + 4000,
      }),
    });
    expect(h.state.snapshot?.sync).toEqual(success);
    expect(freshness({ ...h.state, sync: h.state.snapshot!.sync })).toBe(
      "Live",
    );
  });
  it("gives a retained old failure the visibility catch-up grace and never treats a re-read as recovery", () => {
    const h = harness();
    h.socket.onopen?.();
    snapshot(h, fixtureSnapshot(SYNC_FIXTURES.failed));
    h.visibility(false);
    h.advance(15_000);
    h.visibility(true);
    const running = {
      ...SYNC_FIXTURES.failed,
      latestAttempt: {
        result: "running" as const,
        startedAt: FIXTURE_NOW + 15000,
      },
    };
    snapshot(h, {
      ...fixtureSnapshot(running),
      serverTime: FIXTURE_NOW + 15000,
    });
    expect(h.state.snapshot?.sync.latestAttempt).toEqual(
      SYNC_FIXTURES.failed.latestAttempt,
    );
    expect(freshness({ ...h.state, sync: h.state.snapshot!.sync })).toBe(
      "Checking",
    );
    const next = fixtureSnapshot();
    h.socket.onmessage?.({
      data: JSON.stringify({
        type: "pr-changes",
        buckets: next.buckets,
        removed: [],
        serverTime: FIXTURE_NOW + 15000,
      }),
    });
    expect(h.state.snapshot?.sync.latestAttempt).toEqual(
      SYNC_FIXTURES.failed.latestAttempt,
    );
    for (let i = 0; i < 4; i++) h.advance(15_000);
    expect(freshness({ ...h.state, sync: h.state.snapshot!.sync })).toBe(
      "Sync failed",
    );
  });
  it("times out a silent socket but accepts keepalive replies", () => {
    const h = harness();
    h.socket.onopen?.();
    snapshot(h);
    h.advance(30_000);
    h.socket.onmessage?.({ data: "pong" });
    h.advance(30_000);
    expect(h.closed).toBe(0);
    h.advance(30_000);
    expect(h.closed).toBe(1);
  });
  it("wakes an overdue instance even when its failed sync takes display precedence", () => {
    const h = harness();
    h.socket.onopen?.();
    snapshot(h, fixtureSnapshot(SYNC_FIXTURES.failed));
    for (let i = 0; i < 5; i++) h.advance(15_000);
    expect(messages(h).filter((m) => m.type === "overdue")).toHaveLength(1);
    expect(freshness({ ...h.state, sync: h.state.snapshot!.sync })).toBe(
      "Sync failed",
    );
  });
  it("corrects browser clock and reports visibility on connect/change/ten minutes/sleep", () => {
    const h = harness();
    h.socket.onopen?.();
    snapshot(h);
    expect(h.state.now).toBe(FIXTURE_NOW);
    expect(freshness({ ...h.state, sync: h.state.snapshot!.sync })).toBe(
      "Live",
    );
    expect(messages(h)).toEqual([{ type: "visibility", visible: true }]);
    h.visibility(false);
    expect(messages(h).at(-1)).toEqual({ type: "visibility", visible: false });
    h.advance(600_001);
    expect(messages(h).at(-1)?.visible).toBe(false);
    h.visibility(true);
    expect(h.state.visibleSince).toBe(h.state.now);
    const before = messages(h).length;
    h.advance(65_000);
    expect(messages(h).length).toBe(before + 1); // wake report
    expect(h.state.visibleSince).toBe(h.state.now);
    for (let n = 0; n < 40; n++) h.advance(15_000);
    expect(
      messages(h).filter((m) => m.type === "visibility").length,
    ).toBeGreaterThanOrEqual(5);
    h.client.stop();
    expect(h.cancelled).toBe(2);
  });
  it("sends one overdue message, forwards retry, reconnects and refreshes snapshot", () => {
    const h = harness();
    h.socket.onopen?.();
    snapshot(h, fixtureSnapshot(SYNC_FIXTURES.overdue));
    for (let i = 0; i < 8; i++) h.advance(15_000);
    expect(messages(h).filter((m) => m.type === "overdue")).toHaveLength(1);
    h.client.retry();
    expect(messages(h).at(-1)?.type).toBe("retry-now");
    h.socket.onclose?.();
    expect(h.state.connected).toBe(false);
    h.reconnect();
    expect(h.sockets).toHaveLength(2);
    h.socket.onopen?.();
    expect(messages(h).at(-1)?.type).toBe("visibility");
    snapshot(h);
    expect(h.state.connected).toBe(true);
    h.client.stop();
    const n = h.sockets.length;
    h.reconnect();
    expect(h.sockets).toHaveLength(n);
  });
  it("replaces authoritative buckets, removes rows, tracks changes for two minutes", () => {
    const h = harness();
    h.socket.onopen?.();
    snapshot(h);
    const next = fixtureSnapshot();
    const buckets = next.buckets.map((b) => ({
      ...b,
      rows: b.rows.map((r) => ({
        ...r,
        pr: { ...r.pr, title: "A different title" },
      })),
    }));
    h.socket.onmessage?.({
      data: JSON.stringify({
        type: "pr-changes",
        buckets,
        removed: [],
        serverTime: FIXTURE_NOW + 1000,
      }),
    });
    expect(h.state.snapshot?.buckets).toEqual(buckets);
    expect(h.state.changes.get("PR_example")?.text).toBe("Updated on GitHub");
    for (let i = 0; i < 9; i++) h.advance(15_000);
    expect(h.state.changes.size).toBe(0);
    h.socket.onmessage?.({ data: "malformed" });
    expect(h.state.snapshot?.buckets).toEqual(buckets);
    h.socket.onmessage?.({
      data: JSON.stringify({
        type: "pr-changes",
        buckets: buckets.map((b) => ({ ...b, rows: [] })),
        removed: ["PR_example"],
        serverTime: FIXTURE_NOW + 140_000,
      }),
    });
    expect(h.state.snapshot?.buckets.every((b) => b.rows.length === 0)).toBe(
      true,
    );
  });
});
