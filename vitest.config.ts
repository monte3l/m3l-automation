import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/tests/**/*.test.ts", "**/*.test.ts"],
    // `.claude/worktrees/**` holds nested checkouts of other branches; running
    // their tests from the main tree is wrong and pollutes the run.
    exclude: ["**/dist/**", "**/node_modules/**", "**/.claude/worktrees/**"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/index.ts", "**/*.d.ts"],
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
