import { defineConfig } from "vitest/config";

// Fourth root Vitest config, alongside vitest.config.ts (Node), and the
// bin/integration passes below — vitest.config.ts (ADR-0067). This is the
// ONLY project that runs with a `jsdom` environment: React component tests
// need a DOM, and the main config's coverage.thresholds (perFile 90/83/80/89)
// were calibrated against the library's Node-only src, not against a fresh
// browser package — reusing that config's thresholds directly would either
// fail on day one or (worse) get silently loosened for everyone to
// accommodate one new package. A dedicated config keeps this package's floor
// independently tunable the same way vitest.bin.config.ts's floor is, for
// the same underlying reason (see that file's header comment on why a
// glob-keyed `coverage.thresholds` entry cannot give a subset of files a
// LOWER floor than the global default).
//
// Invoked as a second pass by `pnpm test` / `pnpm test:coverage` (see
// package.json), the same way vitest.bin.config.ts and
// vitest.integration.config.ts are.
export default defineConfig({
  test: {
    pool: "forks",
    // ADR-0080: cap the pool at half of this host's cores — see
    // vitest.config.ts for the full rationale.
    maxWorkers: "50%",
    environment: "jsdom",
    setupFiles: ["packages/m3l-console-web/vitest.setup.ts"],
    include: ["packages/m3l-console-web/tests/**/*.test.{ts,tsx}"],
    // tests/e2e/** is Playwright's domain (playwright.config.ts), not
    // Vitest's — its specs are named *.spec.ts precisely so this include
    // glob can't claim them, but the exclude is kept as a second line of
    // defense against a future .test.ts file landing under tests/e2e/ by
    // mistake.
    exclude: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/m3l-console-web/tests/e2e/**",
    ],
    coverage: {
      provider: "v8",
      include: ["packages/m3l-console-web/src/**/*.{ts,tsx}"],
      // main.tsx is the createRoot bootstrap — a thin, untestable entry
      // point, the same reason the main config excludes **/index.ts.
      exclude: ["**/*.d.ts", "packages/m3l-console-web/src/main.tsx"],
      reporter: ["text", "html", "json"],
      thresholds: {
        // Matches vitest.config.ts's floor (see that file's calibration
        // note) rather than starting the new package at a looser gate —
        // every shipped src/ file must individually clear this from day one.
        lines: 90,
        functions: 83,
        branches: 80,
        statements: 89,
        perFile: true,
      },
    },
  },
});
