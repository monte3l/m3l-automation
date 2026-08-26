/**
 * `core/script/capture-run-failures` — the lifecycle-hook failure capture
 * (U7 PR1).
 *
 * ADR-0072 slice split: this file owns `captureRunFailures` and
 * `M3LCapturedRunFailures` and nothing else. `script.test.ts` is already
 * ~7,000 lines and covers `M3LScript`'s own pipeline; this seam is a pure
 * function over a hooks bag and is tested in isolation.
 *
 * Provenance: ported from the byte-identical private `captureFailures()` the
 * three pilot scripts (`json-etl`, `sqs-etl`, `dynamodb-crud`) each carried in
 * `src/command.ts`, deleted in the same change that adds this function.
 *
 * Why the capture goes through `onError` rather than a `try`/`catch` around
 * `mainFn`: `mainFn` is stage 7 of the nine-stage pipeline, and stages 1-6, 8
 * and 9 throw outside it — `config-load` (a missing or invalid parameter, by
 * far the most common real failure) most of all.
 * `M3LScript.runWithErrorHandling` invokes `onError` for EVERY stage's error
 * before re-throwing, so this capture observes exactly the value `runScript`
 * classifies and can never shadow it.
 *
 * Why it lives in `core/script` and not `core/cli-contract`: it names
 * `M3LScriptLifecycleHooks`, which the ADR-0009 layering zone forbids any
 * other `core/**` module from naming, even via `import type`.
 *
 * The load-bearing subtlety asserted below: `failures` is the SAME array
 * reference the composed `onError` mutates, not a snapshot. A caller reads it
 * AFTER the run finishes, so a copy taken at call time would always be empty.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { captureRunFailures } from "../src/core/script/index.js";
import type {
  M3LCapturedRunFailures,
  M3LScriptHookContext,
  M3LScriptLifecycleHooks,
} from "../src/core/script/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A stand-in hook context. `M3LScriptHookContext` is only ever passed THROUGH
 * this function — never read by it — so the double only has to be
 * reference-comparable, which is exactly what the pass-through assertions
 * check.
 */
const hookContext = {
  config: { get: () => undefined },
  dryRun: false,
} as unknown as M3LScriptHookContext;

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

describe("captureRunFailures — capture", () => {
  test("records an error when the input hooks declare no onError of their own", () => {
    const capture = captureRunFailures({});
    const error = new Error("boom");

    void capture.hooks.onError?.(hookContext, error);

    expect(capture.failures).toEqual([error]);
  });

  test("records an error when called with no arguments at all", () => {
    const capture = captureRunFailures();
    const error = new Error("boom");

    void capture.hooks.onError?.(hookContext, error);

    expect(capture.failures).toEqual([error]);
  });

  test("starts with an empty failures array", () => {
    expect(captureRunFailures().failures).toEqual([]);
  });

  test("accumulates multiple errors in invocation order", () => {
    const capture = captureRunFailures({});
    const first = new Error("first");
    const second = new Error("second");
    const third = new Error("third");

    void capture.hooks.onError?.(hookContext, first);
    void capture.hooks.onError?.(hookContext, second);
    void capture.hooks.onError?.(hookContext, third);

    expect(capture.failures).toEqual([first, second, third]);
  });

  // A thrown `undefined` is representable, and the array (rather than a
  // `let captured: unknown`) is what keeps it distinguishable from "nothing
  // was captured" — the same reason `deriveCommandOutcome` keys off
  // `failures.length`.
  test("records a thrown undefined as a real captured failure", () => {
    const capture = captureRunFailures({});

    void capture.hooks.onError?.(hookContext, undefined);

    expect(capture.failures).toHaveLength(1);
    expect(capture.failures[0]).toBeUndefined();
  });

  test("records a thrown non-Error value verbatim", () => {
    const capture = captureRunFailures({});

    void capture.hooks.onError?.(hookContext, "a thrown string");

    expect(capture.failures).toEqual(["a thrown string"]);
  });

  // The load-bearing reference identity: the returned array is the live buffer
  // the closure pushes into, so a caller holding it before the run observes
  // every push made during the run. A defensive copy would leave this empty.
  test("failures is the live array the closure mutates, not a snapshot", () => {
    const capture = captureRunFailures({});
    const observed = capture.failures;
    const error = new Error("pushed after the caller took the reference");

    void capture.hooks.onError?.(hookContext, error);

    expect(observed).toEqual([error]);
    expect(observed).toBe(capture.failures);
  });
});

// ---------------------------------------------------------------------------
// Composition with the caller's own onError
// ---------------------------------------------------------------------------

describe("captureRunFailures — composition with the caller's own onError", () => {
  test("still invokes the caller's onError, with the same (ctx, error) arguments", () => {
    const seen: { ctx: M3LScriptHookContext; error: unknown }[] = [];
    const ownHooks: M3LScriptLifecycleHooks = {
      onError: (ctx, error) => {
        seen.push({ ctx, error });
      },
    };
    const capture = captureRunFailures(ownHooks);
    const error = new Error("boom");

    void capture.hooks.onError?.(hookContext, error);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.ctx).toBe(hookContext);
    expect(seen[0]?.error).toBe(error);
    // Composition, not replacement: the capture happened as well.
    expect(capture.failures).toEqual([error]);
  });

  test("captures BEFORE calling through, so the caller's hook sees the recorded failure", () => {
    const lengthAtCallTime: number[] = [];
    const capture = captureRunFailures({
      onError: () => {
        lengthAtCallTime.push(capture.failures.length);
      },
    });

    void capture.hooks.onError?.(hookContext, new Error("boom"));

    expect(lengthAtCallTime).toEqual([1]);
  });

  test("returns the caller's own onError result (an awaited async hook is not swallowed)", async () => {
    let resolved = false;
    const capture = captureRunFailures({
      onError: async () => {
        await Promise.resolve();
        resolved = true;
      },
    });

    // The composed hook must hand back the caller's promise, or `M3LScript`
    // would move on before an async error handler finished.
    await capture.hooks.onError?.(hookContext, new Error("boom"));

    expect(resolved).toBe(true);
  });

  test("composes a fresh, independent capture on every call", () => {
    const first = captureRunFailures({});
    const second = captureRunFailures({});

    void first.hooks.onError?.(hookContext, new Error("only first"));

    expect(first.failures).toHaveLength(1);
    expect(second.failures).toHaveLength(0);
    expect(second.failures).not.toBe(first.failures);
  });
});

// ---------------------------------------------------------------------------
// The other seven hooks pass through untouched
// ---------------------------------------------------------------------------

/** Every hook name except `onError` — the set that must survive untouched. */
const PASS_THROUGH_HOOKS = [
  "onBeforeInit",
  "onAfterInit",
  "onBeforeConfigLoad",
  "onAfterConfigLoad",
  "onBeforeRun",
  "onAfterRun",
  "onCleanup",
] as const;

type PassThroughHook = (typeof PASS_THROUGH_HOOKS)[number];

describe("captureRunFailures — pass-through", () => {
  /** A hooks bag whose every non-`onError` member is a distinct function. */
  function allHooks(): M3LScriptLifecycleHooks {
    return {
      onBeforeInit: () => undefined,
      onAfterInit: () => undefined,
      onBeforeConfigLoad: () => undefined,
      onAfterConfigLoad: () => undefined,
      onBeforeRun: () => undefined,
      onAfterRun: () => undefined,
      onCleanup: () => undefined,
    };
  }

  test.each(PASS_THROUGH_HOOKS)(
    "%s is reference-equal to the input hook",
    (name: PassThroughHook) => {
      const input = allHooks();
      const capture = captureRunFailures(input);

      expect(capture.hooks[name]).toBe(input[name]);
    },
  );

  // An invariant named over a set has to enumerate the set, not sample it:
  // this row fails if `M3LScriptLifecycleHooks` grows a ninth hook the table
  // above never learned about.
  test("the pass-through table names every hook except onError", () => {
    const declared = Object.keys(allHooks()).sort();
    expect(declared).toEqual([...PASS_THROUGH_HOOKS].sort());
    expectTypeOf<PassThroughHook>().toEqualTypeOf<
      Exclude<keyof M3LScriptLifecycleHooks, "onError">
    >();
  });

  test("onError is the ONLY member replaced", () => {
    const input: M3LScriptLifecycleHooks = {
      ...allHooks(),
      onError: () => undefined,
    };
    const capture = captureRunFailures(input);

    expect(capture.hooks.onError).not.toBe(input.onError);
    expect(Object.keys(capture.hooks).sort()).toEqual(
      Object.keys(input).sort(),
    );
  });

  test("does not mutate the caller's own hooks bag", () => {
    const input: M3LScriptLifecycleHooks = { onBeforeRun: () => undefined };
    const ownOnError = input.onError;

    const capture = captureRunFailures(input);
    void capture.hooks.onError?.(hookContext, new Error("boom"));

    expect(input.onError).toBe(ownOnError);
    expect(input.onError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("M3LCapturedRunFailures — type-level contract", () => {
  test("the returned bag is a hooks bag plus a readonly failures list", () => {
    expectTypeOf<
      M3LCapturedRunFailures["hooks"]
    >().toEqualTypeOf<M3LScriptLifecycleHooks>();
    expectTypeOf<M3LCapturedRunFailures["failures"]>().toEqualTypeOf<
      readonly unknown[]
    >();
  });

  test("the hooks argument is optional and the return type is pinned", () => {
    expectTypeOf(
      captureRunFailures,
    ).returns.toEqualTypeOf<M3LCapturedRunFailures>();
    expectTypeOf(captureRunFailures)
      .parameter(0)
      .toEqualTypeOf<M3LScriptLifecycleHooks | undefined>();
  });

  test("the returned hooks bag is directly assignable to M3LScriptOptions.hooks", () => {
    const capture = captureRunFailures({});
    const hooks: M3LScriptLifecycleHooks = capture.hooks;
    expect(typeof hooks.onError).toBe("function");
  });
});
