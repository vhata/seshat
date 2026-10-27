/** Prepare private, frozen, synthetic-only artifacts. Never deploys or calls APIs. */
import { build } from "esbuild";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export function targetIdentity(account, name, subdomain) {
  if (!/^[a-f0-9]{32}$/.test(account ?? "")) throw new Error("--account requires an explicit Cloudflare account ID");
  if (!/^seshat-recovery-proof-[a-z0-9-]{4,30}$/.test(name ?? "")) throw new Error("--name must be a dedicated seshat-recovery-proof-<suffix> temporary Worker");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain ?? "")) throw new Error("--subdomain requires the explicitly verified account workers.dev subdomain");
  return { account, name, subdomain, origin: `https://${name}.${subdomain}.workers.dev` };
}
export async function bundleFixture(target, mode, source) {
  const result = await build({
    entryPoints: [path.join(root, "scripts/recovery/fixture.ts")], bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2024", external: ["cloudflare:*"],
    define: { RECOVERY_BUILD: JSON.stringify({ ...target, mode, source }) },
  });
  return result.outputFiles[0].text;
}
export async function prepare(target) {
  targetIdentity(target.account, target.name, target.subdomain);
  process.umask(0o077);
  const evidenceRoot = path.join(root, ".context", "hosted-recovery");
  await mkdir(evidenceRoot, { recursive: true });
  const directory = await mkdtemp(path.join(evidenceRoot, "run-"));
  const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const manifest = { ...target, source, syntheticOnly: true, deployed: false, sha256: {} };
  for (const mode of ["current", "broken", "migration", "cleanup"]) {
    const cleanup = mode === "cleanup";
    const script = cleanup
      ? 'export default { fetch() { return new Response("Recovery fixture retired", { status: 410, headers: { "cache-control": "no-store" } }); } };\n'
      : await bundleFixture(target, mode, source);
    const config = JSON.stringify({
      name: target.name, account_id: target.account, main: `./${mode}.mjs`, compatibility_date: "2026-10-12",
      workers_dev: true, preview_urls: false,
      ...(cleanup ? {} : { version_metadata: { binding: "CF_VERSION_METADATA" } }),
      observability: { enabled: false },
      ...(cleanup ? {} : {
        vars: { OWNER_ID: "1001", RECOVERY_ACCOUNT: target.account, RECOVERY_NAME: target.name, RECOVERY_MAINTENANCE: "enabled", RECOVERY_NATIVE_PITR: "hosted-only" },
        durable_objects: { bindings: [{ name: "RECOVERY", class_name: "RecoveryFixture" }] },
      }),
      migrations: [
        { tag: "recovery-fixture-v1", new_sqlite_classes: ["RecoveryFixture"] },
        ...(cleanup ? [{ tag: "recovery-fixture-v2", deleted_classes: ["RecoveryFixture"] }] : []),
      ],
    }, null, 2) + "\n";
    for (const [name, content] of [[`${mode}.mjs`, script], [`wrangler.${mode}.json`, config]]) {
      await writeFile(path.join(directory, name), content, { mode: 0o400 });
      manifest.sha256[name] = createHash("sha256").update(content).digest("hex");
    }
  }
  const token = randomBytes(32).toString("hex");
  await writeFile(path.join(directory, "token"), token, { mode: 0o400 });
  await writeFile(path.join(directory, "secrets.json"), JSON.stringify({ RECOVERY_TOKEN: token }) + "\n", { mode: 0o400 });
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o400 });
  return directory;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--account" || args[2] !== "--name" || args[4] !== "--subdomain") throw new Error("usage: node scripts/prepare-hosted-recovery.mjs --account ACCOUNT --name seshat-recovery-proof-SUFFIX --subdomain VERIFIED_ACCOUNT_SUBDOMAIN");
  console.log(`Prepared only (nothing deployed): ${await prepare(targetIdentity(args[1], args[3], args[5]))}`);
}
