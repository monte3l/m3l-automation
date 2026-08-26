/**
 * `core/cli-contract/outcome` — the run-state to outcome derivation (U7 PR1).
 *
 * ADR-0072 slice split: this file owns `deriveCommandOutcome` and
 * `M3LCommandRunState` and nothing else.
 *
 * Provenance: every case here is ported from the three pilot scripts'
 * `tests/command.test.ts` "outcome derivation" blocks, which asserted against a
 * byte-identical private `toOutcome` in `json-etl`, `sqs-etl` and
 * `dynamodb-crud`. Those three copies are deleted in the same change that adds
 * this function, so this file is where that coverage now lives — nothing is
 * dropped, only relocated.
 *
 * The property under test is PARITY: for every state a finished run can be in,
 * `mapCommandOutcomeToExitCode(deriveCommandOutcome(...))` must equal the exit
 * code `runScript` already assigned to `process.exitCode` on the spawn path. A
 * disagreement means a scheduler sees two different results for the same run
 * depending on how it was invoked — the exact thing ADR-0054's parity clause
 * forbids. That is why the precedence order (failure/interrupted, then partial,
 * then dry-run, then success) mirrors `run-script.ts` literally rather than
 * being re-derived.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import {
  deriveCommandOutcome,
  mapCommandOutcomeToExitCode,
} from "../src/core/cli-contract/index.js";
import type {
  M3LCommandOutcome,
  M3LCommandRunState,
} from "../src/core/cli-contract/index.js";
import { M3L_EXIT_CODES } from "../src/core/diagnostics/index.js";
import type { M3LRunRecoveryEntry } from "../src/core/diagnostics/index.js";
import {
  M3LError,
  M3LOperationAbortedError,
} from "../src/core/errors/index.js";
// Type-only, and legal here: the ADR-0009 layering zone that forbids a
// `core/**` module from naming `core/script` does not cover `tests/**`, which
// is where the two sides of a structural contract can finally be pinned
// against each other.
import type { M3LScript } from "../src/core/script/index.js";

// ---------------------------------------------------------------------------
// Fixtures — the same two the pilots used
// ---------------------------------------------------------------------------

/** A run that absorbed nothing. */
const clean: M3LCommandRunState = { recovery: [], recoveryTotal: 0 };

/** One absorbed per-item failure — the minimum that makes a run `partial`. */
const absorbedEntry: M3LRunRecoveryEntry = {
  item: "record-1",
  error: [],
  recordedAt: "2026-01-01T00:00:00.000Z",
};

const absorbed: M3LCommandRunState = {
  recovery: [absorbedEntry],
  recoveryTotal: 1,
};

// ---------------------------------------------------------------------------
// The four terminal states
// ---------------------------------------------------------------------------

describe("deriveCommandOutcome — the clean arms", () => {
  test("reports a clean run as success", () => {
    expect(deriveCommandOutcome(clean, [], false)).toEqual({
      status: "success",
    });
  });

  test("reports a clean dry run as dry-run", () => {
    expect(deriveCommandOutcome(clean, [], true)).toEqual({
      status: "dry-run",
    });
  });
});

describe("deriveCommandOutcome — the partial arm", () => {
  test("reports an absorbed per-item failure as partial", () => {
    expect(deriveCommandOutcome(absorbed, [], false)).toEqual({
      status: "partial",
      recovered: 1,
    });
  });

  // `recoveryTotal`, not `recovery.length`: the buffer is a ring truncated at
  // `M3L_RECOVERY_LIMIT`, so `.length` under-reports a large batch. The
  // truncated state is simulated directly — the two numbers disagree here on
  // purpose, so an implementation reading `.length` fails.
  test("reports the honest recovered count when the ring buffer truncated", () => {
    expect(
      deriveCommandOutcome({ ...absorbed, recoveryTotal: 4096 }, [], false),
    ).toEqual({ status: "partial", recovered: 4096 });
  });

  // The PREDICATE stays `recovery.length > 0`, mirroring `run-script.ts`
  // literally: a state with a non-zero total but an empty buffer is not
  // reachable from `M3LScript` (the buffer is only truncated once full), and
  // mirroring the library rather than second-guessing it is what keeps the two
  // paths in step.
  test("an empty recovery buffer is not partial, whatever recoveryTotal says", () => {
    expect(
      deriveCommandOutcome({ recovery: [], recoveryTotal: 7 }, [], false),
    ).toEqual({ status: "success" });
  });

  test("a dry run that absorbed a failure reports partial, not dry-run", () => {
    expect(deriveCommandOutcome(absorbed, [], true)).toEqual({
      status: "partial",
      recovered: 1,
    });
  });
});

describe("deriveCommandOutcome — the failure arm", () => {
  test("reports a thrown error as failure, carrying the error", () => {
    const error = new M3LError("boom", { code: "ERR_CONFIG_MISSING" });
    expect(deriveCommandOutcome(clean, [error], false)).toEqual({
      status: "failure",
      error,
    });
  });

  test("carries the FIRST captured failure when several were captured", () => {
    const first = new M3LError("first", { code: "ERR_CONFIG_MISSING" });
    const second = new M3LError("second", { code: "ERR_AWS_CLIENT" });

    expect(deriveCommandOutcome(clean, [first, second], false)).toEqual({
      status: "failure",
      error: first,
    });
  });

  // A thrown `undefined` is representable, which is exactly why the capture is
  // an array rather than a `let captured: unknown` — the two would otherwise be
  // indistinguishable from "nothing was captured".
  test("treats a thrown undefined as a failure, not as no failure", () => {
    expect(deriveCommandOutcome(clean, [undefined], false)).toEqual({
      status: "failure",
      error: undefined,
    });
  });

  test("treats a thrown non-Error value as a failure, carrying it verbatim", () => {
    expect(deriveCommandOutcome(clean, ["a thrown string"], false)).toEqual({
      status: "failure",
      error: "a thrown string",
    });
  });
});

describe("deriveCommandOutcome — the interrupted arm", () => {
  // Classified by CODE, never by class (ADR-0049) — and it must NOT come out
  // as `failure`, because `mapErrorToExitCode` is typed never to return
  // INTERRUPTED (see the parity block below).
  test("reports a cooperative abort as interrupted, not failure", () => {
    expect(
      deriveCommandOutcome(
        clean,
        [new M3LOperationAbortedError("cancelled")],
        false,
      ),
    ).toEqual({ status: "interrupted" });
  });

  // The code is the classifier, so a structurally-equivalent abort raised
  // across a module boundary (a different library copy, an SDK's own error)
  // still classifies — that is the whole reason the check is not `instanceof
  // M3LOperationAbortedError`.
  test("classifies a foreign Error carrying the abort code as interrupted", () => {
    const foreign = Object.assign(new Error("cancelled"), {
      code: "ERR_OPERATION_ABORTED",
    });
    expect(deriveCommandOutcome(clean, [foreign], false)).toEqual({
      status: "interrupted",
    });
  });

  // The negative arms of the same classifier: neither a non-`Error` carrying
  // the code nor an `Error` carrying a different code is an abort.
  test("a plain object carrying the abort code is NOT an abort — it must be an Error", () => {
    const notAnError = { code: "ERR_OPERATION_ABORTED" };
    expect(deriveCommandOutcome(clean, [notAnError], false)).toEqual({
      status: "failure",
      error: notAnError,
    });
  });

  test("an Error carrying a different code is a plain failure", () => {
    const error = new M3LError("boom", { code: "ERR_CONFIG_MISSING" });
    expect(deriveCommandOutcome(clean, [error], false)).toMatchObject({
      status: "failure",
    });
  });

  test("an Error with no code at all is a plain failure", () => {
    const error = new Error("boom");
    expect(deriveCommandOutcome(clean, [error], false)).toEqual({
      status: "failure",
      error,
    });
  });
});

// ---------------------------------------------------------------------------
// Hostile input — the classifier must never become the failure
// ---------------------------------------------------------------------------

describe("deriveCommandOutcome — hostile failure values", () => {
  /**
   * The captured failure is arbitrary caller data: `onError` receives whatever
   * a step threw, and a thrown object can carry an accessor. The abort
   * classifier reads `error.code`, so a throwing `code` getter turns the
   * classifier itself into the failure — `deriveCommandOutcome` throws out of
   * a host's `execute`, which then reports nothing at all instead of the
   * failure it was handed. That is strictly worse than the failure it was
   * asked to classify, and it contradicts the contract this function mirrors:
   * `mapCommandOutcomeToExitCode` is total over its input and never throws.
   *
   * The safe fallback is the conservative one: a failure whose `code` cannot
   * be read is not demonstrably an abort, so it is a plain failure and is
   * carried verbatim. `toBe`, not `toEqual`, is used on the error so the
   * assertion itself never touches the hostile accessor.
   */
  test("a failure whose `code` getter throws is classified, not rethrown", () => {
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "code", {
      get(): never {
        throw new Error("boom");
      },
      // Non-enumerable so a reporter printing the value does not trip the
      // same accessor while rendering an unrelated failure message.
      enumerable: false,
      configurable: true,
    });

    const outcome = deriveCommandOutcome(clean, [hostile], false);
    const carried = outcome.status === "failure" ? outcome.error : undefined;

    expect(outcome.status).toBe("failure");
    expect(carried).toBe(hostile);
  });

  // The same hostile shape must not escape the exit-code mapping either: the
  // whole point of classifying rather than rethrowing is that a host still
  // gets an integer out the other end.
  test("the hostile failure still maps to a real exit code", () => {
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "code", {
      get(): never {
        throw new Error("boom");
      },
      enumerable: false,
      configurable: true,
    });

    expect(
      mapCommandOutcomeToExitCode(
        deriveCommandOutcome(clean, [hostile], false),
      ),
    ).not.toBe(M3L_EXIT_CODES.INTERRUPTED);
  });
});

// ---------------------------------------------------------------------------
// Precedence — both arms reachable in each test's own setup
// ---------------------------------------------------------------------------

describe("deriveCommandOutcome — precedence", () => {
  // Mirrors runScript: its `catch` skips the PARTIAL assignment entirely, and
  // a dry run that threw is still a failure. The state passed here HAS
  // absorbed recovery AND is a dry run, so both losing branches are genuinely
  // reachable — this is not a tautology.
  test("lets a failure win over both absorbed recovery and dry-run", () => {
    const error = new M3LError("boom", { code: "ERR_CONFIG_MISSING" });
    expect(deriveCommandOutcome(absorbed, [error], true)).toEqual({
      status: "failure",
      error,
    });
  });

  test("lets an abort win over both absorbed recovery and dry-run", () => {
    expect(
      deriveCommandOutcome(
        absorbed,
        [new M3LOperationAbortedError("cancelled")],
        true,
      ),
    ).toEqual({ status: "interrupted" });
  });

  // Recovery beats dry-run: the state is a dry run AND absorbed a failure, so
  // the dry-run branch is reachable and loses on purpose.
  test("lets absorbed recovery win over dry-run", () => {
    expect(deriveCommandOutcome(absorbed, [], true)).toMatchObject({
      status: "partial",
    });
  });
});

// ---------------------------------------------------------------------------
// Parity with runScript's own exit codes
// ---------------------------------------------------------------------------

describe("deriveCommandOutcome — outcome-to-exit-code parity", () => {
  test("a clean run and a clean dry run both map to SUCCESS", () => {
    expect(
      mapCommandOutcomeToExitCode(deriveCommandOutcome(clean, [], false)),
    ).toBe(M3L_EXIT_CODES.SUCCESS);
    expect(
      mapCommandOutcomeToExitCode(deriveCommandOutcome(clean, [], true)),
    ).toBe(M3L_EXIT_CODES.SUCCESS);
  });

  test("an absorbed-recovery run maps to PARTIAL", () => {
    expect(
      mapCommandOutcomeToExitCode(deriveCommandOutcome(absorbed, [], false)),
    ).toBe(M3L_EXIT_CODES.PARTIAL);
  });

  test("an abort maps to INTERRUPTED — a code the failure arm can never produce", () => {
    const abort = new M3LOperationAbortedError("cancelled");
    expect(
      mapCommandOutcomeToExitCode(deriveCommandOutcome(clean, [abort], false)),
    ).toBe(M3L_EXIT_CODES.INTERRUPTED);
    // Why the interrupted arm is load-bearing rather than decorative:
    // routing the same abort through the failure arm maps it to 1-4 while
    // runScript set 5.
    expect(
      mapCommandOutcomeToExitCode({ status: "failure", error: abort }),
    ).not.toBe(M3L_EXIT_CODES.INTERRUPTED);
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("M3LCommandRunState — type-level contract", () => {
  test("the run-state shape is the two-property slice a finished M3LScript exposes", () => {
    expectTypeOf<M3LCommandRunState["recovery"]>().toEqualTypeOf<
      readonly M3LRunRecoveryEntry[]
    >();
    expectTypeOf<M3LCommandRunState["recoveryTotal"]>().toEqualTypeOf<number>();
  });

  // The reason `M3LCommandRunState` is structural rather than a
  // `Pick<M3LScript, ...>` is an ADR-0009 layering zone, not a claim that the
  // two shapes may drift. This pin is the missing half of that argument: a
  // real `M3LScript` must remain assignable to the interface, or every hosted
  // `execute` in the fleet (`deriveCommandOutcome(script, ...)`) stops
  // compiling — or worse, keeps compiling against a renamed getter.
  test("a real M3LScript structurally satisfies the run-state slice", () => {
    expectTypeOf<M3LScript>().toExtend<M3LCommandRunState>();
  });

  test("the derivation's signature is pinned", () => {
    expectTypeOf(
      deriveCommandOutcome,
    ).returns.toEqualTypeOf<M3LCommandOutcome>();
    expectTypeOf(deriveCommandOutcome)
      .parameter(0)
      .toEqualTypeOf<M3LCommandRunState>();
    expectTypeOf(deriveCommandOutcome)
      .parameter(1)
      .toEqualTypeOf<readonly unknown[]>();
    expectTypeOf(deriveCommandOutcome).parameter(2).toEqualTypeOf<boolean>();
  });

  // `isAbortFailure` is deliberately NOT exported: it has zero call sites
  // outside `outcome.ts` once the derivation absorbs it, and ADR-0054's
  // decision driver is "promote only what has two or more demonstrated
  // consumers". This row is the drift guard on that decision.
  test("isAbortFailure is not part of the public surface", async () => {
    const barrel: Record<string, unknown> =
      await import("../src/core/cli-contract/index.js");
    expect(Object.keys(barrel)).not.toContain("isAbortFailure");
  });
});
