import { describe, expect, test } from "vitest";
import { parseJobsArg } from "../../bin/verify-all.mjs";

// bin/verify-all.mjs's effectful top-level work (resolveBaseRef, the ci.yml
// read, the classification loop, runLanesConcurrently, etc.) lives inside an
// `async function main()`, invoked only under a
// `process.argv[1] === fileURLToPath(import.meta.url)` guard (the same
// pattern as bin/bench-gates.mjs) — importing `parseJobsArg` alone never
// triggers a real `pnpm verify` run.

describe("parseJobsArg", () => {
  test("--jobs=4 returns 4", () => {
    expect(parseJobsArg(["--jobs=4"], 2)).toBe(4);
  });

  test("--jobs followed by a separate '4' arg returns 4", () => {
    expect(parseJobsArg(["--jobs", "4"], 2)).toBe(4);
  });

  test("no --jobs flag at all falls back to defaultJobs", () => {
    expect(parseJobsArg([], 2)).toBe(2);
    expect(parseJobsArg(["--continue", "--full"], 2)).toBe(2);
  });

  test.each([["--jobs=0"], ["--jobs=-1"], ["--jobs=abc"], ["--jobs=3.5"]])(
    "%s falls back to defaultJobs (non-positive, non-numeric, or non-integer is rejected, not clamped)",
    (flag) => {
      expect(parseJobsArg([flag], 2)).toBe(2);
    },
  );

  test("--jobs as the very last argv element with nothing after it falls back to defaultJobs", () => {
    expect(parseJobsArg(["--continue", "--jobs"], 2)).toBe(2);
  });

  test("other unrelated flags alongside --jobs=N don't interfere with parsing", () => {
    expect(parseJobsArg(["--continue", "--jobs=4", "--full"], 2)).toBe(4);
  });
});
