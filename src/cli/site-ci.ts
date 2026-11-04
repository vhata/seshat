import { appendFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readBuildIdentity } from "../../scripts/build-identity.ts";
import { CliError } from "./settings.ts";
import { validateSiteConfig } from "./site-config.ts";
import { createSiteRuntime } from "./site-runtime.ts";
import { runSiteCli } from "./site.ts";
import type { SiteRuntime } from "./site-types.ts";

/** Only the current main push may update an already configured, pinned site. */
export async function prepareCiSite(runtime: SiteRuntime, env: NodeJS.ProcessEnv): Promise<void> {
  const commit = env.GITHUB_SHA;
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== "refs/heads/main" ||
      !commit || !/^[a-f0-9]{40}$/.test(commit) || readBuildIdentity(runtime.root).commit !== commit) {
    throw new CliError("Automatic deployment requires the exact main push checkout in GitHub Actions.");
  }
  if (!env.CLOUDFLARE_API_TOKEN?.trim()) throw new CliError("Configure the production CLOUDFLARE_API_TOKEN secret before enabling automatic deployment.");
  const config = validateSiteConfig({ format: 1, stage: "configured", accountId: env.SESHAT_ACCOUNT_ID,
    workerName: env.SESHAT_WORKER_NAME, origin: env.SESHAT_ORIGIN, namespaceId: env.SESHAT_NAMESPACE_ID });
  if (!config.namespaceId) throw new CliError("Automatic deployment requires a pinned SESHAT_NAMESPACE_ID.");
  const assertCurrentMain = async () => {
    const current = await runtime.command("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"]);
    if (current.trim() !== `${commit}\trefs/heads/main`) {
      throw new CliError("This run is no longer current main. Refusing to deploy superseded source; use the latest main CI run.");
    }
  };
  await assertCurrentMain();
  const wrangler = runtime.wrangler.bind(runtime);
  runtime.wrangler = async (args, options) => {
    // Recheck after the release build, immediately before the upload. An old
    // workflow rerun must not replace a newer release, even if queued last.
    if (args[0] === "deploy") await assertCurrentMain();
    return wrangler(args, options);
  };
  await runtime.writeConfig(config);
}

/** Persist a small allowlist in the run summary, including uncertain uploads. */
export async function summarizeCiDeployment(runtime: SiteRuntime, summaryPath?: string): Promise<void> {
  if (!summaryPath) return;
  const operation = await runtime.readPrivate("operation.json") as Record<string, unknown> | null;
  const states = ["uploading", "upload-outcome-unknown", "deployed-unverified", "verified"];
  const state = states.includes(String(operation?.state)) ? String(operation!.state) : "not-uploaded";
  const source = typeof operation?.source === "string" && /^[a-f0-9]{40}$/.test(operation.source) ? operation.source : "unknown";
  const version = typeof operation?.uploadedVersion === "string" && /^[a-f0-9-]{36}$/.test(operation.uploadedVersion) ? operation.uploadedVersion : "unknown";
  await appendFile(summaryPath, `### Seshat production deployment\n\nState: \`${state}\`\n\nSource: \`${source}\`\n\nUploaded version: \`${version}\`\n\nA failed or interrupted upload may already have changed production. Inspect the serving revision before retrying. No automatic rollback is performed.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const runtime = createSiteRuntime(root);
  try {
    await prepareCiSite(runtime, process.env);
    process.exitCode = await runSiteCli(["update", "--yes"], root, runtime);
  } catch (error) {
    process.stderr.write(`seshat: ${error instanceof CliError ? error.message : "Automatic deployment failed; inspect the deployment before retrying."}\n`);
    process.exitCode = 1;
  } finally {
    await summarizeCiDeployment(runtime, process.env.GITHUB_STEP_SUMMARY);
  }
}
