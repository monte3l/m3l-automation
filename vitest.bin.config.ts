import { defineConfig } from "vitest/config";

// Separate coverage run for bin/ tooling, invoked as a second pass by
// `pnpm test:coverage` (see package.json) alongside the main vitest.config.ts
// run. This is a distinct process, not a `test.projects` entry in the main
// config — Vitest's coverage thresholds are a single aggregation over one
// run's coverage map (confirmed against vitest's own source,
// node_modules/vitest/dist/chunks/coverage.*.js `resolveThresholds`): a
// glob-keyed threshold entry ADDS an extra, typically stricter check on top
// of the global one, it never gives a subset of files a LOWER floor than the
// global default. `packages/*/src/**/*.ts`'s 80% perFile floor and bin/'s
// realistic floor cannot coexist in one coverage.thresholds block for that
// reason, so bin/ gets its own config/run instead of a glob override in
// vitest.config.ts.
//
// perFile is deliberately OFF here (aggregate across all bin/**/*.mjs files
// combined), unlike the main config's perFile: true. Every check-*.mjs's real
// logic sits behind an `if (process.argv[1] === fileURLToPath(import.meta.url))`
// main guard that only executes via a direct `node bin/check-*.mjs`
// invocation — verified that way, by every pre-push/CI check:* step, not by
// vitest — so bin/tests/*.test.ts exercises each script's exported PURE
// functions only. Measured directly: ~20 of ~48 bin/**/*.mjs files sit at a
// literal 0% per-file (a glob-included .mjs file appears in the v8 report at
// 0% even with zero tests touching it — unlike packages/*/src, which Vite
// only instruments for files reachable from an executed test's import graph).
// A perFile floor would therefore fail immediately on files whose main guard
// is untestable-by-design, not because anything regressed. An AGGREGATE floor
// avoids that trap while still catching a real regression (e.g. deleting
// bin/lib/licenses.mjs's tests measurably drops the combined percentage).
export default defineConfig({
  test: {
    include: ["bin/tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["bin/**/*.mjs"],
      reporter: ["text", "json"],
      thresholds: {
        // Calibrated below the measured baseline (statements 41.5%, branches
        // 41.3%, functions 54.3%, lines 41.4% at authoring time) for margin
        // against normal fluctuation — raise these as bin/'s test coverage
        // genuinely grows; do not raise them to make a single PR's numbers
        // look better without new tests behind it.
        lines: 35,
        functions: 45,
        branches: 35,
        statements: 35,
        perFile: false,
      },
    },
  },
});
