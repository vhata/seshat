import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { readBuildIdentity, requireReleaseIdentity } from "./scripts/build-identity.ts";

// `vite dev` runs the Worker and Durable Object in the local Workers runtime
// beside the frontend; `vite build` writes both to dist/.
export default defineConfig(({ command }) => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  // Development has no immutable build; the tests likewise leave this unknown.
  const identity = command === "build" ? readBuildIdentity(root) : { commit: null, dirty: null };
  if (process.env.SESHAT_RELEASE_BUILD === "1") requireReleaseIdentity(identity);
  return {
    define: { __SESHAT_BUILD_IDENTITY__: JSON.stringify(identity) },
    plugins: [react(), cloudflare(), {
      name: "seshat-build-identity",
      apply: "build",
      applyToEnvironment: (environment) => environment.config.consumer === "server",
      generateBundle() {
        // Refuse a build whose source changed after the identity was captured.
        const current = readBuildIdentity(root);
        if (current.commit !== identity.commit || current.dirty !== identity.dirty) {
          throw new Error("Source identity changed during the build; build again.");
        }
        this.emitFile({ type: "asset", fileName: "revision.json", source: `${JSON.stringify(identity)}\n` });
      },
    }],
  };
});
