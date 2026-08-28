import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end config for the operations-console frontend (ADR-0067). Chromium
 * only — the console targets one operator on one machine (ADR-0071), not a
 * cross-browser public surface, so the multi-browser matrix Playwright's own
 * template defaults to would only add CI minutes with no coverage this
 * package actually needs.
 *
 * `webServer` builds the production bundle once and serves it via
 * `vite preview` rather than the dev server, so this suite exercises the
 * same static artifact `vite build` produces (and X12 will eventually
 * containerize), not a dev-only code path.
 *
 * The X9 row's CI-cost decision (path-scoped + `e2e`-label-gated, recorded
 * as a dated Update on ADR-0067) lives in `.github/workflows/ci.yml`'s `e2e`
 * job, not here — this file only defines what runs, not when.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Calls `vite` directly (not the `build`/`preview` package.json scripts)
  // deliberately: `pnpm preview -- --port 4173 --host 127.0.0.1` silently
  // drops both forwarded flags (a pnpm arg-forwarding quirk, verified
  // empirically — vite then falls back to its own default port/host,
  // which happened to still work locally but left the CI runner's preview
  // server listening somewhere Playwright's readiness check never found,
  // timing out after 60s with no error). Bypassing the script layer and
  // pinning --host explicitly removes the ambiguity entirely.
  webServer: {
    command:
      "pnpm exec vite build && pnpm exec vite preview --port 4173 --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
