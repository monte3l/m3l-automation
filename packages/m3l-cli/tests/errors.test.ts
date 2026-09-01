/**
 * Tests for src/cli/errors.ts — the `M3LCliError` hierarchy and its exit-code
 * mapping (m3l-cli 8b contract).
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { exitCodeForError, M3LCliError } from "../src/cli/errors.js";
import type { M3LCliErrorCode } from "../src/cli/errors.js";

describe("M3LCliErrorCode", () => {
  test("is the exact twenty-three-member union the contract declares (U7 adds ERR_CLI_COMMAND_MODULE_INVALID/ERR_CLI_IN_PROCESS_FAILED; a U7 follow-up splits off ERR_CLI_COMMAND_MODULE_IMPORT_FAILED for a genuine import failure, distinct from ERR_CLI_COMMAND_MODULE_INVALID's 'no adopted seam' case; a further U7 follow-up adds ERR_CLI_IN_PROCESS_UNSUPPORTED; U10 stage A adds ERR_CLI_FLOW_INVALID/ERR_CLI_UNKNOWN_FLOW for the m3l flow command; U10 stage B adds ERR_CLI_UNKNOWN_FLOW_STEP for resume-from step validation and ERR_CLI_FLOW_RECORD_WRITE_FAILED/ERR_CLI_FLOW_RECORD_INVALID for flow record persistence; a further U10 follow-up splits off ERR_CLI_FLOW_READ_FAILED as the machine-side counterpart to ERR_CLI_FLOW_INVALID)", () => {
    expectTypeOf<M3LCliErrorCode>().toEqualTypeOf<
      | "ERR_CLI_UNKNOWN_COMMAND"
      | "ERR_CLI_UNKNOWN_SCRIPT"
      | "ERR_CLI_CONFIG_IMPORT"
      | "ERR_CLI_WORKSPACE_NOT_FOUND"
      | "ERR_CLI_SCRIPT_NOT_BUILT"
      | "ERR_CLI_SPAWN_FAILED"
      | "ERR_CLI_UNKNOWN_PARAMETER"
      | "ERR_CLI_INVALID_PARAMETER_VALUE"
      | "ERR_CLI_DOCTOR_FAILED"
      | "ERR_CLI_PRESET_INVALID"
      | "ERR_CLI_SCAFFOLD_INVALID"
      | "ERR_CLI_SCAFFOLD_EXISTS"
      | "ERR_CLI_SCAFFOLD_FAILED"
      | "ERR_CLI_COMMAND_MODULE_INVALID"
      | "ERR_CLI_IN_PROCESS_FAILED"
      | "ERR_CLI_COMMAND_MODULE_IMPORT_FAILED"
      | "ERR_CLI_IN_PROCESS_UNSUPPORTED"
      | "ERR_CLI_FLOW_INVALID"
      | "ERR_CLI_FLOW_READ_FAILED"
      | "ERR_CLI_UNKNOWN_FLOW"
      | "ERR_CLI_UNKNOWN_FLOW_STEP"
      | "ERR_CLI_FLOW_RECORD_WRITE_FAILED"
      | "ERR_CLI_FLOW_RECORD_INVALID"
    >();
  });
});

describe("M3LCliError", () => {
  test("extends Core.M3LError and exposes code/name/message", () => {
    const error = new M3LCliError(
      "ERR_CLI_UNKNOWN_COMMAND",
      "unknown command 'foo'",
    );

    expect(error).toBeInstanceOf(Core.M3LError);
    expect(error).toBeInstanceOf(M3LCliError);
    expect(error.name).toBe("M3LCliError");
    expect(error.code).toBe("ERR_CLI_UNKNOWN_COMMAND");
    expect(error.message).toBe("unknown command 'foo'");
  });

  test("defaults suggestions to an empty array when not supplied", () => {
    const error = new M3LCliError("ERR_CLI_UNKNOWN_SCRIPT", "unknown script");

    expect(error.suggestions).toEqual([]);
  });

  test("carries explicit suggestions through unchanged", () => {
    const error = new M3LCliError(
      "ERR_CLI_UNKNOWN_SCRIPT",
      "unknown script 'lst'",
      { suggestions: ["list"] },
    );

    expect(error.suggestions).toEqual(["list"]);
  });

  test("chains cause through to Core.M3LError's cause handling", () => {
    const cause = new Error("boom");
    const error = new M3LCliError(
      "ERR_CLI_CONFIG_IMPORT",
      "failed to import config",
      { cause },
    );

    expect(error.cause).toBe(cause);
  });

  test("cause defaults to undefined when not supplied", () => {
    const error = new M3LCliError(
      "ERR_CLI_WORKSPACE_NOT_FOUND",
      "workspace not found",
    );

    expect(error.cause).toBeUndefined();
  });

  test("suggestions is readonly string[] at the type level", () => {
    const error = new M3LCliError(
      "ERR_CLI_WORKSPACE_NOT_FOUND",
      "workspace not found",
    );

    expectTypeOf(error.suggestions).toEqualTypeOf<readonly string[]>();
    expectTypeOf(error.code).toEqualTypeOf<M3LCliErrorCode>();
  });
});

describe("exitCodeForError", () => {
  // `as const satisfies` gives us two things simultaneously:
  //   1. `satisfies` validates that every row has a real M3LCliErrorCode and a number.
  //   2. `as const` preserves the literal types so the exhaustiveness test below
  //      can derive the exact union of covered codes via
  //      `(typeof codeExitCases)[number][0]` and assert it equals M3LCliErrorCode.
  // If a new M3LCliErrorCode is added to errors.ts without a matching row here,
  // the `toEqualTypeOf<M3LCliErrorCode>()` assertion fails to compile.
  const codeExitCases = [
    ["ERR_CLI_UNKNOWN_COMMAND", 2],
    ["ERR_CLI_UNKNOWN_SCRIPT", 2],
    ["ERR_CLI_CONFIG_IMPORT", 1],
    ["ERR_CLI_WORKSPACE_NOT_FOUND", 1],
    ["ERR_CLI_SCRIPT_NOT_BUILT", 1],
    ["ERR_CLI_SPAWN_FAILED", 1],
    ["ERR_CLI_UNKNOWN_PARAMETER", 2],
    ["ERR_CLI_INVALID_PARAMETER_VALUE", 2],
    ["ERR_CLI_DOCTOR_FAILED", 1],
    ["ERR_CLI_PRESET_INVALID", 1],
    ["ERR_CLI_SCAFFOLD_INVALID", 2],
    ["ERR_CLI_SCAFFOLD_EXISTS", 2],
    ["ERR_CLI_SCAFFOLD_FAILED", 1],
    // U7 (ADR-0054 in-process host): both codes map to the general exit-code
    // class (1), not usage (2) — the caller's flags/args were syntactically
    // fine, the target script just doesn't support what was asked (no
    // adopted commandModule, or its execute genuinely failed) — the same
    // class as their spawn-path analogues ERR_CLI_SCRIPT_NOT_BUILT /
    // ERR_CLI_SPAWN_FAILED above.
    ["ERR_CLI_COMMAND_MODULE_INVALID", 1],
    ["ERR_CLI_IN_PROCESS_FAILED", 1],
    // U7 follow-up: splits the collapsed "import itself threw" case out of
    // ERR_CLI_COMMAND_MODULE_INVALID (which is now reserved for the
    // benign/expected "no adopted seam" case). Same exit-code class (1) as
    // the code it's split from — a genuine import failure is still a
    // general failure, not a usage error.
    ["ERR_CLI_COMMAND_MODULE_IMPORT_FAILED", 1],
    // U7 follow-up: an unsupported flag combination was requested alongside
    // --in-process (non-dry-run passthrough args, or --json combined with
    // --in-process) — raised by dispatchDynamicRun's assertInProcessSupported,
    // before any command module is ever loaded. A usage-shaped mismatch
    // between what was asked and what --in-process supports, so it maps to
    // the usage exit-code class (2), not the general class (1).
    ["ERR_CLI_IN_PROCESS_UNSUPPORTED", 2],
    // U10 stage A (m3l flow command): both codes are usage-class — a malformed
    // or unparseable flow definition and a misspelled flow name are the
    // invocation's fault, not the machine's, so both map to exit code 2.
    ["ERR_CLI_FLOW_INVALID", 2],
    // U10 follow-up: the machine-side counterpart to ERR_CLI_FLOW_INVALID —
    // the flows directory or file could not be read at all (e.g. EACCES),
    // which is a fault in the machine, not the invocation, so it joins the
    // general exit-code class (1) rather than usage (2).
    ["ERR_CLI_FLOW_READ_FAILED", 1],
    ["ERR_CLI_UNKNOWN_FLOW", 2],
    // U10 stage B (flow resume/persistence): ERR_CLI_UNKNOWN_FLOW_STEP is
    // usage-class (2) — a misspelled --resume-from step id is the invocation's
    // fault, exactly like an unknown flow or script name. The two record
    // codes are machine-side faults (1): the definition was fine and the run
    // happened; only persisting or re-reading its record failed.
    ["ERR_CLI_UNKNOWN_FLOW_STEP", 2],
    ["ERR_CLI_FLOW_RECORD_WRITE_FAILED", 1],
    ["ERR_CLI_FLOW_RECORD_INVALID", 1],
  ] as const satisfies readonly (readonly [M3LCliErrorCode, number])[];

  test("codeExitCases covers every M3LCliErrorCode (exhaustiveness)", () => {
    // This assertion fails to compile — not just at runtime — if any
    // M3LCliErrorCode member is absent from codeExitCases. The `as const`
    // above preserves literal types so the derived union is exact, and
    // `toEqualTypeOf` requires bidirectional assignability.
    expectTypeOf<
      (typeof codeExitCases)[number][0]
    >().toEqualTypeOf<M3LCliErrorCode>();
  });

  test.each(codeExitCases)(
    "returns %i for M3LCliError code %s",
    (code, expected) => {
      const error = new M3LCliError(code, "message");
      expect(exitCodeForError(error)).toBe(expected);
    },
  );

  test("returns 1 for a plain Error (not an M3LCliError)", () => {
    expect(exitCodeForError(new Error("plain"))).toBe(1);
  });

  test.each([
    ["a string", "string error"],
    ["undefined", undefined],
    ["a plain object", { message: "not an error" }],
  ] as const)("returns 1 for a non-M3LCliError value: %s", (_label, value) => {
    expect(exitCodeForError(value)).toBe(1);
  });
});
