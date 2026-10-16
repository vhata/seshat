import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Pure logic shared by the Worker, the object and the frontend; runs
        // in Node with no Workers runtime.
        test: {
          name: "shared",
          include: ["src/shared/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        // Worker and Durable Object code, run inside the Workers runtime with
        // the bindings from wrangler.jsonc.
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: {
          name: "workers",
          include: ["src/worker/**/*.test.ts", "src/object/**/*.test.ts"],
        },
      },
    ],
  },
});
