import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config for the operations-console frontend (ADR-0067).
 *
 * The dev proxy forwards `/health` and `/ready` to `m3l-console-server`'s
 * default loopback bind (port 8787 — `DEFAULT_PORT` in
 * `packages/m3l-console-server/src/config/env.ts`), so `pnpm console:web`
 * can hit the real backend without the browser needing CORS handling or a
 * hardcoded absolute origin baked into the client. Production serves the
 * built static bundle from behind the console server instead (X12), where
 * this proxy plays no part.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/health": "http://127.0.0.1:8787",
      "/ready": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
  },
});
