import {
  KEEP_ALIVE_REQUEST, KEEP_ALIVE_RESPONSE, SOCKET_PATH, parseServerMessage,
  type ClientMessage, type OverviewSnapshot, type OverviewBucketDto,
} from "../shared/overview/protocol";
import { freshness, MINUTE } from "./freshness";

export interface ChangeNote { at: number; text: string }
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
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}
export interface ClientEnvironment {
  clock(): number;
  visible(): boolean;
  socket(): SocketLike;
  interval(callback: () => void, delay: number): () => void;
  later(callback: () => void, delay: number): () => void;
  onVisibility(callback: () => void): () => void;
}
function rows(buckets: readonly OverviewBucketDto[]) {
  return new Map(buckets.flatMap(({ bucket, rows }) => rows.map((row) => [row.pr.nodeId, { row, bucket }] as const)));
}
function changesBetween(old: readonly OverviewBucketDto[], next: readonly OverviewBucketDto[], now: number, previous: ReadonlyMap<string, ChangeNote>) {
  const before = rows(old);
  const after = rows(next);
  const changes = new Map(previous);
  for (const [id, item] of after) {
    const prior = before.get(id);
    if (!prior) changes.set(id, { at: now, text: "Added to overview" });
    else if (JSON.stringify(prior.row) !== JSON.stringify(item.row) || prior.bucket.id !== item.bucket.id) {
      const detail = prior.row.facts.ci !== item.row.facts.ci ? `CI ${item.row.facts.ci}` : "Updated on GitHub";
      changes.set(id, { at: now, text: detail + (prior.bucket.id !== item.bucket.id ? ` · moved from ${prior.bucket.title}` : "") });
    }
  }
  for (const id of changes.keys()) if (!after.has(id)) changes.delete(id);
  return changes;
}
/** Owns timing and socket lifecycle; never derives buckets, facts or ordering. */
export function startOverviewClient(env: ClientEnvironment, emit: (state: OverviewState) => void) {
  let stopped = false;
  let connection: SocketLike | null = null;
  let cancelReconnect = () => {};
  let reconnectAttempt = 0;
  let offset = 0;
  let lastTick = env.clock();
  let lastVisibilityReport = -Infinity;
  let overdueSent = false;
  let state: OverviewState = { snapshot: null, connected: false, now: lastTick,
    visibleSince: lastTick, lastMessageAt: null, changes: new Map() };
  const publish = () => emit({ ...state });
  const send = (type: ClientMessage["type"]) => {
    if (state.connected) connection?.send(JSON.stringify({ type, visible: env.visible() } satisfies ClientMessage));
  };
  const reportVisibility = () => {
    lastVisibilityReport = env.clock();
    send("visibility");
  };
  const becameVisible = () => {
    if (env.visible()) {
      state.visibleSince = env.clock() + offset;
      overdueSent = false;
    }
    reportVisibility();
    publish();
  };
  const connect = () => {
    if (stopped) return;
    const socket = env.socket();
    connection = socket;
    socket.onopen = () => {
      if (stopped || connection !== socket) return;
      state.connected = true;
      reconnectAttempt = 0;
      reportVisibility();
      publish();
    };
    socket.onmessage = ({ data }) => {
      if (stopped || connection !== socket) return;
      if (data === KEEP_ALIVE_RESPONSE) return;
      const message = parseServerMessage(data);
      if (!message) return;
      const serverTime = message.type === "snapshot" ? message.snapshot.serverTime : message.serverTime;
      const oldOffset = offset;
      offset = serverTime - env.clock();
      state.visibleSince += offset - oldOffset;
      state.now = serverTime;
      state.lastMessageAt = serverTime;
      const next = message.type === "snapshot" ? message.snapshot : state.snapshot === null ? null : {
        ...state.snapshot, serverTime,
        ...(message.type === "sync" ? { sync: message.sync } : { buckets: message.buckets }),
      };
      if (next) {
        if (state.snapshot) state.changes = changesBetween(state.snapshot.buckets, next.buckets, serverTime, state.changes);
        if (state.snapshot?.sync.lastSuccessfulSweepAt !== next.sync.lastSuccessfulSweepAt) overdueSent = false;
        state.snapshot = next;
      }
      publish();
    };
    socket.onclose = () => {
      if (stopped || connection !== socket) return;
      state.connected = false;
      publish();
      cancelReconnect = env.later(connect, Math.min(30_000, 1000 * 2 ** reconnectAttempt++));
    };
    socket.onerror = () => socket.close();
  };
  const cancelInterval = env.interval(() => {
    const localNow = env.clock();
    if (localNow - lastTick > MINUTE) becameVisible();
    lastTick = localNow;
    state.now = localNow + offset;
    state.changes = new Map([...state.changes].filter(([, note]) => state.now - note.at < 2 * MINUTE));
    if (env.visible() && localNow - lastVisibilityReport >= 10 * MINUTE) reportVisibility();
    if (state.connected) connection?.send(KEEP_ALIVE_REQUEST);
    if (state.snapshot && env.visible() && freshness({ ...state, sync: state.snapshot.sync }) === "Overdue" && !overdueSent) {
      send("overdue");
      overdueSent = true;
    }
    publish();
  }, 15_000);
  const cancelVisibility = env.onVisibility(becameVisible);
  connect();
  publish();
  return {
    retry() { if (state.connected) send("retry-now"); else { cancelReconnect(); connect(); } },
    stop() {
      stopped = true;
      cancelInterval(); cancelVisibility(); cancelReconnect();
      connection?.close();
    },
  };
}
export function browserEnvironment(): ClientEnvironment {
  return {
    clock: () => Date.now(), visible: () => document.visibilityState === "visible",
    socket: () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${SOCKET_PATH}`);
      const adapter: SocketLike = {
        send: (data) => ws.send(data), close: () => ws.close(),
        onopen: null, onclose: null, onerror: null, onmessage: null,
      };
      ws.onopen = () => adapter.onopen?.();
      ws.onclose = () => adapter.onclose?.();
      ws.onerror = () => adapter.onerror?.();
      ws.onmessage = (event) => adapter.onmessage?.({ data: event.data });
      return adapter;
    },
    interval: (fn, delay) => { const id = window.setInterval(fn, delay); return () => clearInterval(id); },
    later: (fn, delay) => { const id = window.setTimeout(fn, delay); return () => clearTimeout(id); },
    onVisibility: (fn) => { document.addEventListener("visibilitychange", fn); return () => document.removeEventListener("visibilitychange", fn); },
  };
}
