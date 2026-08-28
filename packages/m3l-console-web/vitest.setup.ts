import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// vitest.web.config.ts deliberately does not set `test.globals: true` (the
// workspace's other Vitest projects don't either — every test file imports
// `describe`/`it`/`expect` explicitly), so React Testing Library's own
// auto-cleanup — which gates on `typeof afterEach === "function"` as a
// global — never registers. Without this, DOM nodes from one test's
// `render()` call accumulate into the next test in the same file, breaking
// any assertion that expects a single match (e.g. `getByTestId`).
afterEach(() => {
  cleanup();
});
