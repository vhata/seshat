/** Explicit operator client. Makes hosted calls only when invoked by the owner. */
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function loadArtifacts(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  for (const [name, expected] of Object.entries(manifest.sha256)) {
    if (!/^(current|broken|migration|cleanup)\.mjs$|^wrangler\.(current|broken|migration|cleanup)\.json$/.test(name)) throw new Error("Unexpected artifact name");
    const content = await readFile(path.join(directory, name));
    if (createHash("sha256").update(content).digest("hex") !== expected) throw new Error(`Frozen artifact changed: ${name}`);
  }
  const { RECOVERY_TOKEN: token } = JSON.parse(await readFile(path.join(directory, "secrets.json"), "utf8"));
  if (!/^[a-f0-9]{64}$/.test(token ?? "")) throw new Error("Invalid private fixture token");
  return { manifest, token };
}
export function endpointFor(manifest, value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/"
      || url.origin !== manifest.origin) throw new Error("Supply the exact verified temporary Worker workers.dev origin");
  return url.origin;
}
export function bookmarkEvidence(saved, manifest, key) {
  if (saved.target?.account !== manifest.account || saved.target?.name !== manifest.name) throw new Error("Bookmark evidence targets another fixture");
  if (!/^[a-f0-9]{64}$/.test(saved.observedIdentity?.objectId ?? "")) throw new Error("Bookmark evidence lacks namespace/object identity");
  if (saved.status !== 200 || saved.operation !== (key === "bookmark" ? "bookmark" : "prepare-restore")) throw new Error("Evidence is not a successful native bookmark response");
  if (typeof saved.response?.[key] !== "string") throw new Error("Evidence lacks required bookmark");
  return { identity: saved.observedIdentity, value: saved.response[key] };
}
async function main(args) {
  if (args.length < 6 || args[0] !== "--directory" || args[2] !== "--url" || args[4] !== "--op") throw new Error("usage: node scripts/hosted-recovery-control.mjs --directory DIR --url https://NAME.SUBDOMAIN.workers.dev --op OP [--bookmark-file FILE | --undo-file FILE]");
  process.umask(0o077);
  const directory = path.resolve(args[1]);
  const { manifest, token } = await loadArtifacts(directory);
  const origin = endpointFor(manifest, args[3]);
  const op = args[5];
  const allowed = ["status", "seed", "inspect", "damage", "health", "invalidate-sessions", "bookmark", "prepare-restore", "restart"];
  if (!allowed.includes(op)) throw new Error("Unknown control operation");
  let savedIdentity;
  const input = { target: { account: manifest.account, name: manifest.name } };
  if (op === "prepare-restore" || op === "restart") {
    const acceptedFlags = op === "prepare-restore" ? ["--bookmark-file", "--undo-file"] : ["--undo-file"];
    if (args.length !== 8 || !acceptedFlags.includes(args[6])) throw new Error(`${op} requires ${acceptedFlags.join(" or ")} with a previously saved response`);
    const saved = JSON.parse(await readFile(args[7], "utf8"));
    const key = args[6] === "--bookmark-file" ? "bookmark" : "undoBookmark";
    const validated = bookmarkEvidence(saved, manifest, key);
    savedIdentity = validated.identity;
    input[op === "prepare-restore" ? "bookmark" : "undoBookmark"] = validated.value;
    if (op === "restart") input.prepareReceipt = {
      target: saved.target, observedIdentity: { objectId: saved.observedIdentity.objectId },
      operation: saved.operation, status: saved.status,
      response: { undoBookmark: validated.value },
    };
  } else if (args.length !== 6) throw new Error("Unexpected arguments");
  async function request(operation, body) {
    const response = await fetch(`${origin}/recovery/${operation}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, response: await response.json() };
  }
  const identity = await request("status", { target: input.target });
  if (identity.status !== 200 || identity.response.account !== manifest.account || identity.response.name !== manifest.name || identity.response.source !== manifest.source
      || !["current", "broken", "migration"].includes(identity.response.mode) || identity.response.maintenance !== true) throw new Error("Hosted fixture identity did not match frozen artifacts");
  if (typeof identity.response.objectId !== "string" || !/^[a-f0-9]{64}$/.test(identity.response.objectId)) throw new Error("Missing fixture object identity");
  if (savedIdentity && savedIdentity.objectId !== identity.response.objectId) throw new Error("Bookmark evidence belongs to a different namespace/object; stop");
  let result;
  try { result = op === "status" ? identity : await request(op, input); }
  catch {
    // abort() normally severs the restart connection; preparation failures
    // can be ambiguous too. Never turn transport failure into success.
    throw new Error(`${op} connection failed; outcome unknown. Stop and inspect status. Lost prepare response: do not retry blindly.`);
  }
  const evidence = { target: input.target, observedIdentity: identity.response, operation: op, ...result };
  const filename = path.join(directory, `${Date.now()}-${op}-${randomBytes(3).toString("hex")}.json`);
  // In particular, preserve undoBookmark before reporting prepare success.
  await writeFile(filename, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(`Saved private ${op} response (HTTP ${result.status}): ${filename}`);
  if (result.status >= 400) throw new Error(`Control refused operation: ${result.response.error ?? result.status}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
