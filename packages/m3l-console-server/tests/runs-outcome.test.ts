/**
 * Tests for src/runs/outcome.ts — `mapSpawnOutcome` (m3l-console-server X4
 * run-governor contract). Maps a spawned script's exit info onto
 * `Core.M3LRunOutcome`, with `killRequested` taking priority over both
 * `exitCode` and `dryRun`.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import type { Core } from "@m3l-automation/m3l-common";

import { mapSpawnOutcome } from "../src/runs/outcome.js";
import type { M3LSpawnExitInfo } from "../src/runs/outcome.js";

describe("mapSpawnOutcome", () => {
  test.each<[M3LSpawnExitInfo, Core.M3LRunOutcome]>([
    [{ exitCode: 0, killRequested: false, dryRun: false }, "success"],
    [{ exitCode: 1, killRequested: false, dryRun: false }, "failure"],
    [{ exitCode: 0, killRequested: false, dryRun: true }, "dry-run"],
    [{ exitCode: 1, killRequested: false, dryRun: true }, "failure"],
    [{ exitCode: 0, killRequested: true, dryRun: false }, "interrupted"],
    [{ exitCode: 1, killRequested: true, dryRun: false }, "interrupted"],
    [{ exitCode: 0, killRequested: true, dryRun: true }, "interrupted"],
    [{ exitCode: 130, killRequested: true, dryRun: false }, "interrupted"],
  ])("maps %o to %s", (exit, expected) => {
    expect(mapSpawnOutcome(exit)).toBe(expected);
  });

  test("killRequested wins over a zero exit code and dryRun both being true", () => {
    const outcome = mapSpawnOutcome({
      exitCode: 0,
      killRequested: true,
      dryRun: true,
    });
    expect(outcome).toBe("interrupted");
  });
});

describe("mapSpawnOutcome — return type", () => {
  test("returns Core.M3LRunOutcome", () => {
    const outcome = mapSpawnOutcome({
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    expectTypeOf(outcome).toEqualTypeOf<Core.M3LRunOutcome>();
  });
});

// Regression coverage for PR #721's review finding: `mapCommandOutcome`
// (src/runs/executor.ts) can only express a hosted command's own
// "interrupted"/"partial" self-report through exitCode/killRequested, and
// `mapSpawnOutcome`'s exit-code-only fallback then degrades a self-reported
// "interrupted" or "partial" (with killRequested: false) to "failure". The
// fix under test: `M3LSpawnExitInfo` gains an optional `outcome` field that
// `mapSpawnOutcome` prefers over its exit-code/killRequested derivation.
describe("mapSpawnOutcome — explicit outcome field takes priority", () => {
  // Each row's `exit` fields are deliberately chosen so the exit-code/
  // killRequested fallback would derive a DIFFERENT outcome than the
  // explicit `outcome` field states — proving the explicit value wins
  // rather than merely coinciding with what the fallback would have said.
  test.each<[Core.M3LRunOutcome, M3LSpawnExitInfo]>([
    [
      "success",
      { exitCode: 1, killRequested: true, dryRun: true, outcome: "success" },
    ],
    [
      "failure",
      { exitCode: 0, killRequested: false, dryRun: false, outcome: "failure" },
    ],
    [
      "dry-run",
      { exitCode: 0, killRequested: false, dryRun: false, outcome: "dry-run" },
    ],
    [
      "interrupted",
      {
        exitCode: 130,
        killRequested: false,
        dryRun: false,
        outcome: "interrupted",
      },
    ],
    [
      "partial",
      { exitCode: 2, killRequested: false, dryRun: false, outcome: "partial" },
    ],
  ])(
    "explicit outcome %s wins even though exitCode/killRequested/dryRun would derive something else",
    (expected, exit) => {
      expect(mapSpawnOutcome(exit)).toBe(expected);
    },
  );
});

describe("M3LSpawnExitInfo — outcome is optional", () => {
  test("an exit info omitting outcome still satisfies M3LSpawnExitInfo", () => {
    const exit: M3LSpawnExitInfo = {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    };
    expectTypeOf(exit).toExtend<M3LSpawnExitInfo>();
    expect(mapSpawnOutcome(exit)).toBe("success");
  });
});
