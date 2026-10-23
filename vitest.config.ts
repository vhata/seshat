import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway App key for the Workers tests, generated per run in the PKCS#1
// form GitHub issues, so no private key is ever committed. Tests verify the
// JWTs they see against the public half.
const testKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "cli",
          include: ["src/cli/**/*.test.ts"],
          environment: "node",
          setupFiles: ["./src/test/fetch-guard.ts"],
        },
      },
      {
        test: {
          name: "frontend",
          include: ["src/frontend/**/*.test.ts", "src/frontend/**/*.test.tsx"],
          environment: "node",
          setupFiles: ["./src/test/fetch-guard.ts"],
        },
      },
      {
        // Pure logic shared by the Worker, the object and the frontend; runs
        // in Node with no Workers runtime.
        test: {
          name: "shared",
          include: ["src/shared/**/*.test.ts"],
          environment: "node",
          setupFiles: ["./src/test/fetch-guard.ts"],
        },
      },
      {
        // Worker and Durable Object code, run inside the Workers runtime with
        // the bindings from wrangler.jsonc, plus a configured test instance.
        // No test reaches the network: the fetch guard refuses any request
        // that a test's own stub does not answer.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                OWNER_ID: "1001",
                SETUP_SECRET: "test-setup-secret",
                GITHUB_APP_SLUG: "seshat-test",
                GITHUB_CLIENT_ID: "Iv23test",
                GITHUB_CLIENT_SECRET: "test-client-secret",
                GITHUB_PRIVATE_KEY: testKey.privateKey,
                GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
                TEST_APP_PUBLIC_KEY: testKey.publicKey,
              },
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["src/worker/**/*.test.ts", "src/object/**/*.test.ts"],
          setupFiles: ["./src/test/fetch-guard.ts"],
        },
      },
    ],
  },
});
