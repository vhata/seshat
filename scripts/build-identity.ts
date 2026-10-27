import { execFileSync } from "node:child_process";
import type { BuildIdentity } from "../src/shared/health.ts";

/** Git hooks may export selectors for a different index or working tree. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
}

/** No checkout means unknown identity, never a caller-supplied revision. */
export function readBuildIdentity(root: string): BuildIdentity {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {
    env: gitEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    const commit = git("rev-parse", "--verify", "HEAD");
    if (!/^[a-f0-9]{40}$/.test(commit)) return { commit: null, dirty: null };
    const dirty = git("status", "--porcelain", "--untracked-files=all").length > 0;
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

export function requireReleaseIdentity(identity: BuildIdentity): void {
  if (identity.commit === null || identity.dirty !== false) {
    throw new Error("Release builds require a clean Git checkout with a committed HEAD.");
  }
}
