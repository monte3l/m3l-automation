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
