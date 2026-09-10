import { describe, expect, test } from "vitest";
import { parseJobsArg, selectReadyLaneIndex } from "../../bin/verify-all.mjs";

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

  // ---------------------------------------------------------------------
  // Tightened validation: bare Number(raw) would also accept exponent
  // ("1e3" -> 1000) and hex ("0x8" -> 8) forms, neither of which matches the
  // flag's documented plain-integer N shape — a bot Nit on PR #1167.
  // ---------------------------------------------------------------------

  test("--jobs=1e3 falls back to defaultJobs, not 1000", () => {
    expect(parseJobsArg(["--jobs=1e3"], 2)).toBe(2);
  });

  test("--jobs=0x8 falls back to defaultJobs, not 8", () => {
    expect(parseJobsArg(["--jobs=0x8"], 2)).toBe(2);
  });

  test("plain --jobs=4 still returns 4 (regression check: tightening the regex didn't break the normal case)", () => {
    expect(parseJobsArg(["--jobs=4"], 2)).toBe(4);
  });
});

describe("selectReadyLaneIndex", () => {
  test("returns index 0 when the first lane's dependsOn is already fully satisfied", () => {
    const queue = [
      { jobName: "a", dependsOn: ["build"] },
      { jobName: "b", dependsOn: [] },
    ];
    const completed = new Set(["build"]);

    expect(selectReadyLaneIndex(queue, completed)).toBe(0);
  });

  test("skips an earlier lane whose dependency isn't satisfied yet and returns a later lane's index", () => {
    const queue = [
      { jobName: "a", dependsOn: ["build"] },
      { jobName: "b", dependsOn: [] },
    ];
    const completed = new Set<string>(); // "build" has not completed

    expect(selectReadyLaneIndex(queue, completed)).toBe(1);
  });

  test("returns -1 when no lane's dependencies are satisfied yet", () => {
    const queue = [
      { jobName: "a", dependsOn: ["build"] },
      { jobName: "b", dependsOn: ["build"] },
    ];
    const completed = new Set<string>();

    expect(selectReadyLaneIndex(queue, completed)).toBe(-1);
  });

  test("a lane with dependsOn: [] is always immediately ready regardless of completedJobNames", () => {
    const queue = [{ jobName: "a", dependsOn: [] }];

    expect(selectReadyLaneIndex(queue, new Set())).toBe(0);
    expect(selectReadyLaneIndex(queue, new Set(["unrelated"]))).toBe(0);
  });

  test("an empty queue returns -1", () => {
    expect(selectReadyLaneIndex([], new Set())).toBe(-1);
  });
});
