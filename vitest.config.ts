import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    // ADR-0080: cap the pool at half of this host's cores instead of
    // Vitest's own default (`availableParallelism() - 1`, i.e. nearly every
    // core). A percentage (Vitest 4 top-level `maxWorkers`, replacing the
    // removed `poolOptions.forks.maxForks`) scales with whatever host runs
    // it. This run is one of several heavy processes lefthook's `pre-push`
    // runs CONCURRENTLY (`parallel: true`) — a 19-package `turbo run
    // typecheck` and a 19-package `turbo run build` fire at the same time —
    // so leaving half the cores unclaimed here gives turbo's own (also
    // capped, see turbo.json) concurrency room instead of both processes
    // racing for every core at once.
    maxWorkers: "50%",
    include: ["**/tests/**/*.test.ts", "**/*.test.ts"],
    // `.claude/worktrees/**` holds nested checkouts of other branches; running
    // their tests from the main tree is wrong and pollutes the run.
    // `bin/tests/**` is excluded here because it is vitest.bin.config.ts's
    // domain — without this exclude, the broad `**/*.test.ts` include above
    // matches those files too, so `pnpm test:coverage` (which runs both
    // configs back to back) executed all of bin/tests/** twice per run with
    // no coverage benefit (the two configs' coverage `include` scopes were
    // always disjoint; only the test *execution* overlapped).
    // `**/tests/integration/**` is vitest.integration.config.ts's domain:
    // those tests bind a real loopback socket, so they are not unit tests and
    // must not run in this project (a unit test must not make network calls —
    // the same rule `eslint.config.js`'s bare-`fetch()` ban enforces).
    // `packages/m3l-console-web/**` is vitest.web.config.ts's domain (ADR-0067):
    // its component tests need a jsdom environment this Node-environment
    // project does not provide, and a plain-`.ts` test under its `src/`
    // (e.g. a fetch-wrapper test with no JSX) would otherwise still match
    // this project's `**/*.test.ts` include and run twice with no benefit —
    // the same reasoning `bin/tests/**` is excluded above.
    exclude: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.claude/worktrees/**",
      "bin/tests/**",
      "**/tests/integration/**",
      "packages/m3l-console-web/**",
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      // packages/m3l-console-web/** is vitest.web.config.ts's coverage domain
      // (see the test.exclude comment above) — its `.tsx` files already miss
      // this `.ts`-only include glob, but a plain-`.ts` module under its
      // src/ (e.g. api/client.ts) would not, so it is excluded explicitly.
      exclude: ["**/index.ts", "**/*.d.ts", "packages/m3l-console-web/**"],
      // `json` emits coverage-final.json: the v8 text table hides files that
      // are 100% on every metric, so the JSON is the authoritative per-file
      // record when investigating a suspected gap.
      reporter: ["text", "html", "json"],
      // Pyramid + safety-net discipline (rules 02). The library is well past
      // "fresh scaffold" (ADR-0021: ~97.2% aggregate statement coverage), so
      // the 80/80/80/80 starting gate was stale. Raised to the true per-file
      // floor measured from coverage-final.json on 2026-08-10 (perFile means
      // every file must individually clear each threshold, not just the
      // aggregate): statements 89.47% (M3LJSONListExporter.ts), functions
      // 83.33% (M3LPollingPolicies.ts), branches 80.00% (aws/lambda/client.ts),
      // lines 90.48% (exit-codes.ts). Each threshold below is set just under
      // its measured floor so today's suite still passes.
      thresholds: {
        lines: 90,
        functions: 83,
        branches: 80,
        statements: 89,
        // coverage.all defaults to false in v8, so only files that appear in
        // the report (i.e. files with at least one test) are gated — not-yet-
        // implemented modules simply don't show up and won't trip this gate.
        perFile: true,
      },
    },
  },
});
