import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/tests/**/*.test.ts", "**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/index.ts", "**/*.d.ts"],
      reporter: ["text", "html"],
      // Pyramid + safety-net discipline (rules 02). Thresholds start modest
      // so a fresh scaffold passes; raise as the library gains real code.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
