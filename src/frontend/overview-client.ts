import {
  KEEP_ALIVE_REQUEST,
  KEEP_ALIVE_RESPONSE,
  SOCKET_PATH,
  parseServerMessage,
  INITIAL_SYNC,
  type ClientMessage,
  type OverviewSnapshot,
  type OverviewBucketDto,
  type OverviewRowDto,
  type SyncStatus,
} from "../shared/overview/protocol";
import { isOverdue, MINUTE } from "./freshness";

export interface ChangeNote {
  at: number;
  text: string;
}
export interface OverviewState {
  snapshot: OverviewSnapshot | null;
  connected: boolean;
  now: number;
  visibleSince: number;
  lastMessageAt: number | null;
  changes: ReadonlyMap<string, ChangeNote>;
}
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}
export interface ClientEnvironment {
  clock(): number;
  visible(): boolean;
  socket(): SocketLike;
  session(signal: AbortSignal): Promise<"signed-in" | "signed-out">;
  interval(callback: () => void, delay: number): () => void;
  later(callback: () => void, delay: number): () => void;
  onVisibility(callback: () => void): () => void;
}
function rows(buckets: readonly OverviewBucketDto[]) {
  return new Map(
    buckets.flatMap(({ bucket, rows }) =>
      rows.map((row) => [row.pr.nodeId, { row, bucket }] as const),
    ),
  );
}
/** Elapsed time changes the stale flag without changing the source facts. */
function sourceFacts({ pr, facts, lastActivityAt }: OverviewRowDto) {
  return { pr, facts, lastActivityAt };
}
function changesBetween(
  old: readonly OverviewBucketDto[],
  next: readonly OverviewBucketDto[],
  now: number,
  previous: ReadonlyMap<string, ChangeNote>,
) {
  const before = rows(old);
  const after = rows(next);
  const changes = new Map(previous);
  for (const [id, item] of after) {
    const prior = before.get(id);
    if (!prior) changes.set(id, { at: now, text: "Added to overview" });
    else if (
      JSON.stringify(sourceFacts(prior.row)) !==
        JSON.stringify(sourceFacts(item.row)) ||
      prior.bucket.id !== item.bucket.id
    ) {
      const detail =
        prior.row.facts.ci !== item.row.facts.ci
          ? `CI ${item.row.facts.ci}`
          : "Updated on GitHub";
      changes.set(id, {
        at: now,
        text:
          detail +
          (prior.bucket.id !== item.bucket.id
            ? ` · moved from ${prior.bucket.title}`
            : ""),
      });
    }
  }
  for (const id of changes.keys()) if (!after.has(id)) changes.delete(id);
  return changes;
}
/**
 * A new attempt does not prove recovery. Keep a failure this page has seen,
 * including through reconnect snapshots, until a successful sweep covers it.
 * The producer must also persist this unresolved failure for fresh pages,
 * which cannot reconstruct the instance's earlier messages.
 */
function retainUnresolvedFailure(
  previous: SyncStatus | undefined,
  next: SyncStatus,
): SyncStatus {
  const failed = previous?.latestAttempt;
  if (failed?.result !== "failed" || next.latestAttempt?.result === "failed")
    return next;
  if (
    next.lastSuccessfulSweepAt !== null &&
    next.lastSuccessfulSweepAt >= failed.startedAt
  )
    return next;
  return { ...next, latestAttempt: failed };
}

/** Owns timing and socket lifecycle; never derives buckets, facts or ordering. */
export function startOverviewClient(
  env: ClientEnvironment,
  emit: (state: OverviewState) => void,
  onSessionEnded: () => void,
) {
  let stopped = false;
  let connection: SocketLike | null = null;
  let cancelReconnect = () => {};
  let reconnectAttempt = 0;
  let sessionCheck: AbortController | null = null;
  let receivedAt = env.clock();
  let offset = 0;
  let lastTick = env.clock();
  let lastVisibilityReport = -Infinity;
  let overdueSent = false;
  let state: OverviewState = {
    snapshot: null,
    connected: false,
    now: lastTick,
    visibleSince: lastTick,
    lastMessageAt: null,
    changes: new Map(),
  };
  const publish = () => emit({ ...state });
  const send = (type: ClientMessage["type"]) => {
    if (state.connected)
      connection?.send(
        JSON.stringify({
          type,
          visible: env.visible(),
        } satisfies ClientMessage),
      );
  };
  const reportVisibility = () => {
    lastVisibilityReport = env.clock();
    send("visibility");
  };
  const becameVisible = () => {
    if (stopped) return;
    if (env.visible()) {
      state.visibleSince = env.clock() + offset;
      overdueSent = false;
    }
    reportVisibility();
    publish();
  };
  const connect = () => {
    if (stopped) return;
    // A manual retry can replace a connection that has not opened yet.
    const previous = connection;
    connection = null;
    previous?.close();
    const socket = env.socket();
    connection = socket;
    socket.onopen = () => {
      if (stopped || connection !== socket) return;
      state.connected = true;
      receivedAt = env.clock();
      reconnectAttempt = 0;
      reportVisibility();
      publish();
    };
    socket.onmessage = ({ data }) => {
      if (stopped || connection !== socket) return;
      receivedAt = env.clock();
      if (data === KEEP_ALIVE_RESPONSE) return;
      const message = parseServerMessage(data);
      if (!message) return;
      const serverTime =
        message.type === "snapshot"
          ? message.snapshot.serverTime
          : message.serverTime;
      const oldOffset = offset;
      offset = serverTime - env.clock();
      state.visibleSince += offset - oldOffset;
      state.now = serverTime;
      state.lastMessageAt = serverTime;
      const next =
        message.type === "snapshot"
          ? message.snapshot
          : state.snapshot === null
            ? null
            : {
                ...state.snapshot,
                serverTime,
                ...(message.type === "sync"
                  ? { sync: message.sync }
                  : { buckets: message.buckets }),
              };
      if (next) {
        if (state.snapshot)
          state.changes = changesBetween(
            state.snapshot.buckets,
            next.buckets,
            serverTime,
            state.changes,
          );
        if (
          state.snapshot?.sync.lastSuccessfulSweepAt !==
          next.sync.lastSuccessfulSweepAt
        )
          overdueSent = false;
        state.snapshot = {
          ...next,
          sync: retainUnresolvedFailure(state.snapshot?.sync, next.sync),
        };
      }
      publish();
    };
    socket.onclose = ({ code, reason }) => {
      if (stopped || connection !== socket) return;
      connection = null;
      state.connected = false;
      publish();
      if (code === 1008 && reason === "session ended") {
        endSession();
        return;
      }
      // Browsers hide a rejected upgrade's HTTP status behind close code
      // 1006, so confirm authorization before treating it as an outage.
      const controller = new AbortController();
      sessionCheck = controller;
      void env.session(controller.signal)
        .catch(() => "unavailable" as const)
        .then((session) => {
          if (stopped || sessionCheck !== controller) return;
          sessionCheck = null;
          if (session === "signed-out") endSession();
          else
            cancelReconnect = env.later(
              connect,
              Math.min(30_000, 1000 * 2 ** reconnectAttempt++),
            );
        });
    };
    socket.onerror = () => {
      if (!stopped && connection === socket) socket.close();
    };
  };
  const cancelInterval = env.interval(() => {
    if (stopped) return;
    const localNow = env.clock();
    if (localNow - lastTick > MINUTE) becameVisible();
    lastTick = localNow;
    state.now = localNow + offset;
    state.changes = new Map(
      [...state.changes].filter(([, note]) => state.now - note.at < 2 * MINUTE),
    );
    if (env.visible() && localNow - lastVisibilityReport >= 10 * MINUTE)
      reportVisibility();
    if (state.connected) {
      if (localNow - receivedAt > 45_000) connection?.close();
      else connection?.send(KEEP_ALIVE_REQUEST);
    }
    if (
      env.visible() &&
      state.now - state.visibleSince >= MINUTE &&
      isOverdue(state.snapshot?.sync ?? INITIAL_SYNC, state.now) &&
      !overdueSent
    ) {
      send("overdue");
      overdueSent = true;
    }
    publish();
  }, 15_000);
  const cancelVisibility = env.onVisibility(becameVisible);
  function stop() {
    if (stopped) return;
    stopped = true;
    cancelInterval();
    cancelVisibility();
    cancelReconnect();
    sessionCheck?.abort();
    sessionCheck = null;
    connection?.close();
    connection = null;
  }
  function endSession() {
    stop();
    state = {
      ...state,
      connected: false,
      snapshot: null,
      lastMessageAt: null,
      changes: new Map(),
    };
    publish();
    onSessionEnded();
  }
  connect();
  publish();
  return {
    retry() {
      if (stopped || sessionCheck) return;
      if (state.connected) send("retry-now");
      else {
        cancelReconnect();
        connect();
      }
    },
    stop,
  };
}
export function browserEnvironment(): ClientEnvironment {
  return {
    clock: () => Date.now(),
    visible: () => document.visibilityState === "visible",
    socket: () => {
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${SOCKET_PATH}`,
      );
      const adapter: SocketLike = {
        send: (data) => ws.send(data),
        close: () => ws.close(),
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
      };
      ws.onopen = () => adapter.onopen?.();
      ws.onclose = (event) =>
        adapter.onclose?.({ code: event.code, reason: event.reason });
      ws.onerror = () => adapter.onerror?.();
      ws.onmessage = (event) => adapter.onmessage?.({ data: event.data });
      return adapter;
    },
    session: async (signal) => {
      const response = await fetch("/api/session", {
        // A stalled authorization request must not strand outage recovery.
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (response.status === 401) return "signed-out";
      if (response.ok) return "signed-in";
      throw new Error("Could not check the session");
    },
    interval: (fn, delay) => {
      const id = window.setInterval(fn, delay);
      return () => clearInterval(id);
    },
    later: (fn, delay) => {
      const id = window.setTimeout(fn, delay);
      return () => clearTimeout(id);
    },
    onVisibility: (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  };
}
