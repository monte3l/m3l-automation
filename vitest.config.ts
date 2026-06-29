import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/tests/**/*.test.ts", "**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/index.ts", "**/*.d.ts"],
      // `json` emits coverage-final.json: the v8 text table hides files that
      // are 100% on every metric, so the JSON is the authoritative per-file
      // record when investigating a suspected gap.
      reporter: ["text", "html", "json"],
      // Pyramid + safety-net discipline (rules 02). Thresholds start modest
      // so a fresh scaffold passes; raise as the library gains real code.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        // coverage.all defaults to false in v8, so only files that appear in
        // the report (i.e. files with at least one test) are gated — not-yet-
        // implemented modules simply don't show up and won't trip this gate.
        perFile: true,
      },
    },
  },
});
