import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config for the operations-console frontend (ADR-0067).
 *
 * The dev proxy forwards `/health`, `/ready`, and `/api` to
 * `m3l-console-server`'s default loopback bind (port 8787 — `DEFAULT_PORT`
 * in `packages/m3l-console-server/src/config/env.ts`), so `pnpm console:web`
 * can hit the real backend without the browser needing CORS handling or a
 * hardcoded absolute origin baked into the client. `/api` covers every
 * `/api/v1/*` route the discovery and run-registry views fetch (X10c) —
 * without it, those requests would 404 against the Vite dev server instead
 * of reaching the console server. In production (X12) the built static
 * bundle is served by its own nginx image, which proxies the same three
 * prefixes to the console server over a shared container network namespace
 * (docker/default.conf, compose.yaml) — this dev-only proxy plays no part
 * there.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/health": "http://127.0.0.1:8787",
      "/ready": "http://127.0.0.1:8787",
      "/api": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
  },
});
