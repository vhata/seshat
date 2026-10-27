#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Deliberately standalone: this operator tool never loads application secrets.
const MAX_JSON_BYTES = 65_536;
const FAILURE_REASONS = new Set([
  "github-unavailable", "rate-limited", "installation-suspended",
  "installation-removed", "cloudflare-quota",
]);
const USAGE_FIELDS = [
  "workersRequests", "objectRequests", "objectDuration", "rowsRead",
  "rowsWritten", "storage", "logs",
];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const timestamp = (value) => value === null || number(value);

async function privateFile(path, limit) {
  // O_NOFOLLOW prevents a replaced symbolic link from selecting another file.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > limit) throw new Error();
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

function options(args) {
  if (args.length < 3) throw new Error();
  const raw = args[0];
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username || url.password || url.search || url.hash ||
      (raw !== url.origin && raw !== `${url.origin}/`)) throw new Error();
  const files = {};
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    if (!["--cookie-file", "--usage-file"].includes(flag) ||
        files[flag] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error();
    files[flag] = args[i + 1];
  }
  if (!files["--cookie-file"]) throw new Error();
  return { origin: url.origin, insecure: url.protocol === "http:", files };
}

function validMonitoring(value) {
  if (!record(value) || value.version !== 1 || !number(value.serverTime) ||
      !timestamp(value.activeSince) || !timestamp(value.oldestPendingAt) ||
      !timestamp(value.lastEventFailureAt) || typeof value.githubRateLimited !== "boolean" ||
      value.cloudflareCapacity !== "unknown" || !record(value.sync)) return false;
  const sync = value.sync;
  if (!timestamp(sync.lastSuccessfulSweepAt) || !number(sync.intervalMs) || sync.intervalMs === 0 ||
      typeof sync.slowedByRateLimit !== "boolean") return false;
  const attempt = sync.latestAttempt;
  if (attempt === null) return true;
  return record(attempt) && number(attempt.startedAt) &&
    ["running", "success", "failed"].includes(attempt.result) &&
    (attempt.reason === undefined || FAILURE_REASONS.has(attempt.reason)) &&
    (attempt.result !== "failed" || FAILURE_REASONS.has(attempt.reason));
}

/** Evaluate only documented fields; response details never reach terminal output. */
export function evaluate(value) {
  const issues = [];
  const { sync, serverTime, activeSince } = value;
  const attempt = sync.latestAttempt;
  if (attempt?.result === "failed") issues.push("sync-failed");
  if (activeSince !== null) {
    if (serverTime - activeSince > 60_000 &&
        (sync.lastSuccessfulSweepAt === null ||
         serverTime - sync.lastSuccessfulSweepAt > Math.max(300_000, 2 * sync.intervalMs))) issues.push("sync-overdue");
    if (attempt?.result === "running" && serverTime - attempt.startedAt > 600_000) {
      issues.push("sync-stalled");
    }
  }
  if (value.oldestPendingAt !== null && serverTime - value.oldestPendingAt >= 600_000) {
    issues.push("background-work-overdue");
  }
  if (value.lastEventFailureAt !== null) issues.push("event-read-failed");
  if (value.githubRateLimited) issues.push("github-budget-low");
  return issues;
}

async function readJson(response) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error();
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES)) throw new Error();
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  try {
    const chunks = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_JSON_BYTES) throw new Error();
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function request(origin, path, cookie) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${origin}${path}`, {
      method: "GET", redirect: "manual", signal: controller.signal,
      headers: cookie ? { accept: "application/json", cookie } : { accept: "application/json" },
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return { status: response.status };
    }
    try {
      return { status: 200, data: await readJson(response) };
    } catch {
      return { status: 200, invalid: true };
    }
  } catch {
    return { status: 0 };
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

/** Returns a terminal-safe result. No caught exception text is exposed. */
export async function run(args) {
  let config;
  let cookie;
  let usage;
  try {
    config = options(args);
    const rawCookie = await privateFile(config.files["--cookie-file"], 4096);
    if (/[\x00-\x1f\x7f]/u.test(rawCookie)) throw new Error();
    cookie = rawCookie.trim();
    const name = config.insecure ? "(?:__Host-seshat-session|seshat-session)" : "__Host-seshat-session";
    if (!new RegExp(`^${name}=[A-Za-z0-9_-]{43}$`).test(cookie)) throw new Error();
    if (config.files["--usage-file"]) {
      usage = JSON.parse(await privateFile(config.files["--usage-file"], 16_384));
      if (!record(usage) || !number(usage.observedAt) ||
          USAGE_FIELDS.some((field) => !number(usage[field]))) throw new Error();
    }
  } catch {
    return { exitCode: 2, result: { ok: false, issues: ["config-invalid"] } };
  }
  const issues = [];
  const health = await request(config.origin, "/api/health");
  if (health.status !== 200 || !record(health.data) || health.data.ok !== true ||
      !Number.isInteger(health.data.schemaVersion) || health.data.schemaVersion < 0) {
    issues.push("health-unavailable");
  }
  const monitoring = await request(config.origin, "/api/monitoring", cookie);
  if (monitoring.status === 401) issues.push("monitoring-auth-required");
  else if (monitoring.status !== 200) issues.push("monitoring-unavailable");
  else if (monitoring.invalid || !validMonitoring(monitoring.data)) issues.push("monitoring-invalid");
  else issues.push(...evaluate(monitoring.data));
  const age = usage ? Date.now() - usage.observedAt : Infinity;
  if (age < 0 || age > 900_000) issues.push("cloudflare-capacity-unknown");
  else if (USAGE_FIELDS.some((field) => usage[field] >= 0.8)) issues.push("cloudflare-capacity-low");
  return { exitCode: issues.length ? 1 : 0, result: { ok: issues.length === 0, issues } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode, result } = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}
