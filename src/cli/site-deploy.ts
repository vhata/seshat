import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readBuildIdentity } from "../../scripts/build-identity.ts";
import { MIGRATIONS } from "../object/schema.ts";
import { CliError } from "./settings.ts";
import { validateSiteConfig } from "./site-config.ts";
import { ensureSiteDependencies, siteEnvironment, siteValidationEnvironment } from "./site-runtime.ts";
import type { SiteConfig, SiteInspection, SiteRuntime } from "./site-types.ts";

/** Reuse the existing serving-version inspector rather than infer identity locally. */
export async function inspectSite(runtime: SiteRuntime, config: SiteConfig): Promise<SiteInspection> {
  const inspectorUrl = pathToFileURL(join(runtime.root, "scripts/inspect-revision.mjs")).href;
  const { inspectRunningRevision } = await import(inspectorUrl) as {
    inspectRunningRevision(options: { origin: string; name: string }, dependencies: {
      runWrangler(args: string[]): Promise<unknown>; fetchHealth(url: string): Promise<unknown>;
    }): Promise<SiteInspection>;
  };
  try {
    return await inspectRunningRevision({ origin: config.origin, name: config.workerName }, {
      runWrangler: async args => JSON.parse(await runtime.wrangler(args, { accountId: config.accountId })) as unknown,
      fetchHealth: url => runtime.fetchJson(url),
    });
  } catch { throw new CliError("Cannot verify the saved origin against the active Worker deployment; run site doctor and check the target and authentication."); }
}

export async function verifyAnonymousSite(runtime: SiteRuntime, config: SiteConfig, configured = true): Promise<void> {
  const checks: [string, number][] = [["/", 200], ["/api/overview", 401], ["/api/session", 401], ["/api/overview/socket", 401]];
  if (configured) checks.push(["/setup", 404]);
  for (const [path, status] of checks) {
    const response = await runtime.request(`${config.origin}${path}`, { headers: { "cache-control": "no-cache" } });
    if (response.status !== status || (path !== "/" && response.headers.get("cache-control") !== "no-store")) {
      throw new CliError(`The deployed instance failed the anonymous ${path} verification check.`);
    }
    if (path === "/setup" && !(await response.text()).includes("Setup is finished")) {
      throw new CliError("The deployed instance did not confirm configured setup closure.");
    }
    await response.body?.cancel().catch(() => undefined);
  }
}

export async function verifySite(runtime: SiteRuntime, config: SiteConfig, configured = true): Promise<SiteInspection> {
  const inspection = await inspectSite(runtime, config);
  const expectedSchema = MIGRATIONS.at(-1)!.version;
  if (inspection.schemaVersion !== expectedSchema) throw new CliError("The deployed instance has not reached the expected database schema; verification is incomplete.");
  await verifyAnonymousSite(runtime, config, configured);
  // Bind the smoke result to a stable deployment, rather than a concurrent upload.
  const after = await inspectSite(runtime, config);
  if (JSON.stringify(after.deployment) !== JSON.stringify(inspection.deployment) || after.version.id !== inspection.version.id) {
    throw new CliError("The active deployment changed during verification; run site doctor again.");
  }
  return after;
}

function requireCleanSource(root: string): string {
  const identity = readBuildIdentity(root);
  if (identity.commit === null || identity.dirty !== false) throw new CliError("Site update requires a clean checkout with a committed HEAD. Commit or set aside local changes; the command never fetches or pulls.");
  return identity.commit;
}

export async function artifactFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new CliError("Build artifacts must not contain symlinks.");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        hash.update(JSON.stringify({ path: relative(root, path), size: bytes.length })).update("\0").update(bytes);
      }
      else throw new CliError("Build artifacts must be regular files and directories.");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

export async function prepareDeployArtifact(runtime: SiteRuntime, config: SiteConfig, commit: string): Promise<{ path: string; fingerprint: string }> {
  const dist = join(runtime.root, "dist");
  const redirectPath = join(runtime.root, ".wrangler/deploy/config.json");
  const redirect = JSON.parse(await readFile(redirectPath, "utf8")) as { configPath?: unknown };
  if (typeof redirect.configPath !== "string") throw new CliError("The build did not identify its generated Wrangler configuration.");
  const builtPath = resolve(dirname(redirectPath), redirect.configPath);
  if (!relative(dist, builtPath).startsWith("seshat/") || relative(dist, builtPath).includes("..")) throw new CliError("The generated Wrangler configuration is outside the expected build directory.");
  const builtInfo = await lstat(builtPath);
  if (!builtInfo.isFile() || builtInfo.isSymbolicLink()) throw new CliError("Generated Wrangler configuration must be a regular file.");
  const built = JSON.parse(await readFile(builtPath, "utf8")) as Record<string, unknown>;
  const identity = JSON.parse(await readFile(join(dirname(builtPath), "revision.json"), "utf8")) as { commit?: unknown; dirty?: unknown };
  if (identity.commit !== commit || identity.dirty !== false) throw new CliError("The release artifact does not identify the validated clean source.");
  const objects = built.durable_objects as { bindings?: unknown } | undefined;
  const bindings = objects?.bindings;
  if (!Array.isArray(bindings) || bindings.length !== 1 || JSON.stringify(Object.keys(bindings[0] as object).sort()) !== JSON.stringify(["class_name", "name"]) ||
      bindings[0]?.name !== "INSTANCE" || bindings[0]?.class_name !== "InstanceObject" ||
      JSON.stringify(built.migrations) !== JSON.stringify([{ tag: "v1", new_sqlite_classes: ["InstanceObject"] }]) ||
      (built.account_id !== undefined && built.account_id !== config.accountId) ||
      (built.env !== undefined && Object.keys(built.env as object).length > 0)) {
    throw new CliError("The build has unexpected account, environment, Durable Object bindings or migrations; inspect it before deploying.");
  }
  const output = join(dirname(builtPath), "site-wrangler.json");
  try {
    const old = await lstat(output);
    if (!old.isFile() || old.isSymbolicLink()) throw new CliError("The derived deploy configuration must be a regular file.");
    await unlink(output);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Keep the file beside Vite's generated configuration so every relative
  // module/asset path retains its generated meaning. Only the target changes.
  const temporary = `${output}.pending`;
  await writeFile(temporary, `${JSON.stringify({ ...built, name: config.workerName, account_id: config.accountId }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, output);
  return { path: output, fingerprint: await artifactFingerprint(dist) };
}

export async function deploySite(runtime: SiteRuntime, supplied: SiteConfig, options: { yes: boolean; bootstrap?: boolean }): Promise<SiteInspection> {
  const config = validateSiteConfig(supplied);
  siteEnvironment(config.accountId);
  if (!options.bootstrap && config.stage !== "configured") throw new CliError("Site setup is incomplete; run seshat site setup before updating.");
  const commit = requireCleanSource(runtime.root);
  await ensureSiteDependencies(runtime);
  const targetUrl = pathToFileURL(join(runtime.root, "src/cli/site-cloudflare.ts")).href;
  const { inspectWorkerTarget, assertWorkerAbsent } = await import(targetUrl) as {
    inspectWorkerTarget(runtime: SiteRuntime, config: SiteConfig): Promise<{ namespaceId: string; configured: boolean }>;
    assertWorkerAbsent(runtime: SiteRuntime, config: SiteConfig): Promise<void>;
  };
  let before: { namespaceId: string; configured: boolean } | null = null;
  if (options.bootstrap) await assertWorkerAbsent(runtime, config);
  else {
    before = await inspectWorkerTarget(runtime, config);
    if (!before.configured) throw new CliError("The remote site is not fully configured; finish setup before updating.");
  }
  const deploymentBefore = options.bootstrap ? null : JSON.parse(await runtime.wrangler(["deployments", "status", "--name", config.workerName, "--json"], { accountId: config.accountId })) as unknown;
  process.stdout.write("seshat: validating the current checkout and building a clean release.\n");
  await runtime.command("bash", ["scripts/check.sh"], { interactive: true, env: siteValidationEnvironment(config.accountId) });
  await runtime.command("npm", ["run", "--silent", "build:release"], { interactive: true, env: siteEnvironment(config.accountId) });
  if (requireCleanSource(runtime.root) !== commit) throw new CliError("Source changed during validation; run site update again.");
  const artifact = await prepareDeployArtifact(runtime, config, commit);
  await runtime.confirm(`Deploy ${commit} from ${runtime.root} to ${config.workerName} (${config.accountId}) at ${config.origin}?`, options.yes);
  const saved = await runtime.readConfig();
  if (saved === null || JSON.stringify(saved) !== JSON.stringify(config)) throw new CliError("Saved site settings changed during validation; run the operation again.");
  if (requireCleanSource(runtime.root) !== commit || await artifactFingerprint(join(runtime.root, "dist")) !== artifact.fingerprint) {
    throw new CliError("Source or build artifacts changed after validation; run the operation again.");
  }
  if (before !== null) {
    const current = await inspectWorkerTarget(runtime, config);
    const deploymentNow = JSON.parse(await runtime.wrangler(["deployments", "status", "--name", config.workerName, "--json"], { accountId: config.accountId })) as unknown;
    if (current.namespaceId !== before.namespaceId || !current.configured || JSON.stringify(deploymentNow) !== JSON.stringify(deploymentBefore)) {
      throw new CliError("Another deployment or binding change affected the site while this update was preparing; inspect site status before retrying.");
    }
  } else await assertWorkerAbsent(runtime, config);
  if (requireCleanSource(runtime.root) !== commit || await artifactFingerprint(join(runtime.root, "dist")) !== artifact.fingerprint) {
    throw new CliError("Source or build artifacts changed before upload; run the operation again.");
  }
  const operation = { format: 1, state: "uploading", source: commit, artifact: artifact.fingerprint,
    accountId: config.accountId, workerName: config.workerName, origin: config.origin, startedAt: new Date().toISOString() };
  await runtime.writePrivate("operation.json", operation);
  let uploadOutput: string;
  try {
    uploadOutput = await runtime.wrangler(["deploy", "--config", artifact.path, "--name", config.workerName, "--tag", commit], { accountId: config.accountId });
  } catch {
    await runtime.writePrivate("operation.json", { ...operation, state: "upload-outcome-unknown" });
    throw new CliError("Upload did not complete successfully. Its remote outcome is unknown; inspect site status before retrying.");
  }
  const uploadedVersion = /Current Version ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i.exec(uploadOutput)?.[1]?.toLowerCase() ?? null;
  await runtime.writePrivate("operation.json", { ...operation, state: "deployed-unverified", uploadedVersion });
  try {
    const inspection = await verifySite(runtime, config, !options.bootstrap);
    if (uploadedVersion === null || inspection.version.id !== uploadedVersion || inspection.build.commit !== commit || inspection.deployment.versions.length !== 1 || inspection.deployment.versions[0]?.percentage !== 100) {
      throw new CliError("The serving deployment does not run this release for all traffic.");
    }
    const target = await inspectWorkerTarget(runtime, config);
    if (before !== null && target.namespaceId !== before.namespaceId) throw new CliError("The namespace changed during deployment; verification is incomplete.");
    await runtime.writeConfig({ ...config, namespaceId: target.namespaceId, stage: options.bootstrap ? "bootstrap" : "configured" });
    await runtime.writePrivate("operation.json", { ...operation, state: "verified", uploadedVersion, completedAt: new Date().toISOString(), inspection });
    process.stdout.write(`seshat: deployed and verified ${commit} at ${config.origin}.\n`);
    return inspection;
  } catch {
    throw new CliError("Deployment succeeded, but verification is incomplete. The deployment is recorded as deployed-unverified; run site doctor before retrying or making further changes.");
  }
}
