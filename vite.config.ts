import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `vite dev` runs the Worker and Durable Object in the local Workers runtime
// beside the frontend; `vite build` writes both to dist/.
export default defineConfig({
  plugins: [react(), cloudflare()],
});
