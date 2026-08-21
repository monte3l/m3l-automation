/**
 * Tests for the `core/procedure` submodule — slice 3a (ADR-0046, issue #474):
 * `M3LProcedure.run()`'s undeclared-jump guard, `continueOnFailure`/recovery,
 * and cancellation. `run()` does not exist on `main` yet, so every test in
 * this file is written against the documented, eventual contract and is
 * expected to fail RED until this slice lands — that failure is the point,
 * not a defect in the test.
 *
 * Sibling file `procedure-run-guards.test.ts` owns the same slice's option
 * validation, capture-by-value, and iteration-ceiling blocks — the split is
 * purely a file-size partition (ADR-0072); both files share the same
 * contract source and scope notes.
 *
 * Contract source: docs/reference/core/procedure.md § Flow directives,
 * § Phase 1 — steps (steps 5–6), § Outcome.
 *
 * Scope owned by this file: the three blocks named above only. `progress`
 * (the no-progress guard), `trace`/`logger` and tracing are NOT part of this
 * slice's `M3LProcedureRunOptions` — every fixture below omits them. Later
 * slices (3b/3c) own the no-progress guard, tracing, and adversarial trace
 * payloads in their own files.
 *
 * No error class is exported from `core/procedure` — every failure is
 * asserted via `instanceof M3LError` plus the machine-readable `code`, never
 * a whitebox subclass import.
 */

import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { createProcedureBuilder } from "../src/core/procedure/index.js";
import type {
  M3LProcedureCase,
  M3LProcedureFallback,
  M3LProcedureOutcome,
  M3LProcedureShape,
  M3LProcedureStepRecord,
  M3LProcedureStepResult,
  M3LProcedureValue,
} from "../src/core/procedure/index.js";
import {
  M3LError,
  M3LOperationAbortedError,
} from "../src/core/errors/index.js";
import { M3L_RECOVERY_LIMIT } from "../src/core/diagnostics/index.js";
import type {
  M3LRunRecoveryEntry,
  M3LRunReportInput,
} from "../src/core/diagnostics/index.js";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** A general-purpose loose shape reused by every block in this file. */
interface TS extends M3LProcedureShape {
  readonly deps: Record<string, never>;
  readonly values: Readonly<Record<string, M3LProcedureValue>>;
  readonly parameters: Readonly<Record<string, M3LProcedureValue>>;
  readonly conclusion: { readonly verdict: string };
  readonly stepId: "s1" | "s2" | "s3";
  readonly caseId: "caseA" | "caseB";
}

const ALWAYS_TRUE_CASE: M3LProcedureCase<TS, "caseA"> = {
  id: "caseA",
  description: "always matches",
  prose: "always matches",
  priority: 1,
  condition: { kind: "exists", subject: { source: "literal", literal: "x" } },
  action: () => ({ verdict: "matched" }),
};

const DEFAULT_FALLBACK: M3LProcedureFallback<TS> = {
  description: "no case matched",
  prose: "no case matched",
  action: () => ({ verdict: "fallback" }),
};

/** Runs `fn`, capturing either its resolved outcome or whatever it throws/rejects. */
async function runCapturing<T>(
  fn: () => Promise<T> | T,
): Promise<{ outcome?: T; thrown?: unknown }> {
  try {
    const outcome = await fn();
    return { outcome };
  } catch (thrown) {
    return { thrown };
  }
}

function asM3LError(value: unknown): M3LError {
  expect(value).toBeInstanceOf(M3LError);
  return value as M3LError;
}

// ---------------------------------------------------------------------------

describe("core/procedure — run faults", () => {
  // -------------------------------------------------------------------------
  // 4. undeclared jump guard
  // -------------------------------------------------------------------------
  describe("undeclared jump guard", () => {
    // Unreachable from typed TypeScript by design: `jumpsTo` is the sole
    // inference site for a step's `{ goTo }` target union (`NoInfer` blocks
    // inference from `execute`'s return in `M3LProcedureStep`), so a typed
    // caller gets a compile error for either shape below. Both tests reach
    // the guard the same way the file's other untyped-path tests do — a cast
    // on the returned step result — simulating an untyped (plain-JS) caller.

    test("a goTo target that names no declared step at all yields a failed outcome under ERR_PROCEDURE_UNDECLARED_JUMP, and the run does not silently continue to the next step", async () => {
      const nextStepSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("undeclared-jump-unknown")
          .step({
            id: "s1",
            label: "s1",
            kind: "control",
            jumpsTo: ["s2"] as const,
            execute: () =>
              ({
                flow: { goTo: "ghost" },
              }) as unknown as M3LProcedureStepResult<TS, "s2">,
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: () => {
              nextStepSpy();
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_UNDECLARED_JUMP");
      }
      // The actual regression this guards against: the old engine folded
      // an unresolved goTo into `index: target ?? index + 1` and silently
      // ran the next declared step anyway. A code-only assertion would
      // pass against that broken engine too, since it never checks
      // whether s2 ran.
      expect(nextStepSpy).not.toHaveBeenCalled();
    });

    test("a goTo target naming a declared step absent from the declaring step's own jumpsTo yields a failed outcome under ERR_PROCEDURE_UNDECLARED_JUMP, and the run does not silently continue to the next step", async () => {
      const nextStepSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>(
          "undeclared-jump-declared-elsewhere",
        )
          .step({
            id: "s1",
            label: "s1",
            kind: "control",
            // s1 only ever declares "s2" as a jump target...
            jumpsTo: ["s2"] as const,
            execute: () =>
              // ...but returns "s3" — a step the procedure declares below,
              // just not in s1's own jumpsTo allowlist. This is the
              // subtler shape: a lookup that only checked "is this id a
              // declared step" (ignoring jumpsTo) would wrongly accept it.
              ({
                flow: { goTo: "s3" },
              }) as unknown as M3LProcedureStepResult<TS, "s2">,
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: () => {
              nextStepSpy();
              return { flow: "stop" };
            },
          })
          .step({
            id: "s3",
            label: "s3",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_UNDECLARED_JUMP");
      }
      expect(nextStepSpy).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------------
    // New regressions: docs/reference/core/procedure.md § Flow directives
    // says ANY malformed flow shape — a null flow, a non-string goTo, an
    // unrecognized flow string — unifies onto the same
    // ERR_PROCEDURE_UNDECLARED_JUMP path, never a bare TypeError and never
    // a silent "continue".
    // ------------------------------------------------------------------

    test("a step returning { flow: null } yields a failed outcome under ERR_PROCEDURE_UNDECLARED_JUMP", async () => {
      const nextStepSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("malformed-flow-null")
          .step({
            id: "s1",
            label: "s1",
            kind: "control",
            jumpsTo: ["s2"] as const,
            execute: () =>
              ({ flow: null }) as unknown as M3LProcedureStepResult<TS, "s2">,
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: () => {
              nextStepSpy();
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_UNDECLARED_JUMP");
      }
      expect(nextStepSpy).not.toHaveBeenCalled();
    });

    test("a step returning { flow: { goTo: Symbol('x') } } resolves ERR_PROCEDURE_UNDECLARED_JUMP rather than throwing a TypeError converting a Symbol to a string", async () => {
      const nextStepSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("malformed-flow-symbol")
          .step({
            id: "s1",
            label: "s1",
            kind: "control",
            jumpsTo: ["s2"] as const,
            execute: () =>
              ({
                flow: { goTo: Symbol("x") },
              }) as unknown as M3LProcedureStepResult<TS, "s2">,
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: () => {
              nextStepSpy();
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(thrown).not.toBeInstanceOf(TypeError);
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error).not.toBeInstanceOf(TypeError);
        expect(error.code).toBe("ERR_PROCEDURE_UNDECLARED_JUMP");
      }
      expect(nextStepSpy).not.toHaveBeenCalled();
    });

    test("a step returning { flow: 'halt' } (an unrecognized string) yields ERR_PROCEDURE_UNDECLARED_JUMP and does not silently advance as 'continue' would", async () => {
      const nextStepSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>(
          "malformed-flow-unrecognized-string",
        )
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () =>
              ({ flow: "halt" }) as unknown as M3LProcedureStepResult<TS>,
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: () => {
              nextStepSpy();
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_UNDECLARED_JUMP");
      }
      // Proves the run did not treat "halt" as if "continue" had been
      // returned — s2 must never execute.
      expect(nextStepSpy).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------------
    // New regressions: a step's returned result is caller data, so reading
    // ANY of its fields can throw (a hostile getter) — that must resolve
    // "failed"/ERR_PROCEDURE_UNDECLARED_JUMP, never reject run()'s promise.
    // A step's `output`/`note` are equally caller data and must be
    // *validated*, not just read: a BigInt output or a non-string note are
    // malformed the same way a malformed `flow` is.
    // ------------------------------------------------------------------

    test.each<[string, () => unknown]>([
      [
        "flow",
        () => ({
          get flow(): never {
            throw new Error("hostile flow getter");
          },
        }),
      ],
      [
        "output",
        () => ({
          flow: "continue",
          get output(): never {
            throw new Error("hostile output getter");
          },
        }),
      ],
      [
        "note",
        () => ({
          flow: "continue",
          get note(): never {
            throw new Error("hostile note getter");
          },
        }),
      ],
      [
        "values",
        () => ({
          flow: "continue",
          get values(): never {
            throw new Error("hostile values getter");
          },
        }),
      ],
    ])(
      "a step whose returned result has a hostile getter on %s resolves failed/ERR_PROCEDURE_UNDECLARED_JUMP, never rejects run()",
      async (label, buildResult) => {
        const nextStepSpy = vi.fn();
        const { outcome, thrown } = await runCapturing(() => {
          const procedure = createProcedureBuilder<TS>(
            `hostile-getter-${label}`,
          )
            .step({
              id: "s1",
              label: "s1",
              kind: "gather",
              execute: () => buildResult() as M3LProcedureStepResult<TS>,
            })
            .step({
              id: "s2",
              label: "s2",
              kind: "gather",
              execute: () => {
                nextStepSpy();
                return { flow: "stop" };
              },
            })
            .case(ALWAYS_TRUE_CASE)
            .build(DEFAULT_FALLBACK);
          return procedure.run({ deps: {}, parameters: {} });
        });

        expect(thrown).toBeUndefined();
        expect(outcome?.status).toBe("failed");
        if (outcome?.status === "failed") {
          const error = asM3LError(outcome.error);
          expect(error.code).toBe("ERR_PROCEDURE_UNDECLARED_JUMP");
        }
        expect(nextStepSpy).not.toHaveBeenCalled();
      },
    );

    test("a step returning { flow: 'continue', output: 10n } (a literal BigInt output) resolves failed/ERR_PROCEDURE_UNDECLARED_JUMP — output is validated, not just read", async () => {
      const nextStepSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("bigint-output")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () =>
              ({
                flow: "continue",
                output: 10n,
              }) as unknown as M3LProcedureStepResult<TS>,
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: () => {
              nextStepSpy();
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_UNDECLARED_JUMP");
      }
      expect(nextStepSpy).not.toHaveBeenCalled();
    });

    test("a step returning { flow: 'continue', note: {} } (a non-string note) resolves failed/ERR_PROCEDURE_UNDECLARED_JUMP — note is validated, not just read", async () => {
      const nextStepSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("non-string-note")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () =>
              ({
                flow: "continue",
                note: {},
              }) as unknown as M3LProcedureStepResult<TS>,
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: () => {
              nextStepSpy();
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_UNDECLARED_JUMP");
      }
      expect(nextStepSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 5. continueOnFailure and recovery
  // -------------------------------------------------------------------------
  describe("continueOnFailure and recovery", () => {
    test("without the flag, a step throw yields a failed outcome naming the step, carrying the thrown value verbatim (identity + cause chain)", async () => {
      const cause = new Error("root cause");
      const thrownByStep = new Error("step blew up", { cause });

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("no-recovery")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              throw thrownByStep;
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        expect(outcome.failedStep).toBe("s1");
        expect(outcome.error).toBe(thrownByStep);
        expect((outcome.error as Error).cause).toBe(cause);
      }
    });

    test("with continueOnFailure, the run continues and appends one M3LRunRecoveryEntry shaped {item, error, recordedAt}", async () => {
      const stepError = new Error("absorbed failure");
      const spy = vi.fn();

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("recovery-shape")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            continueOnFailure: true,
            execute: () => {
              throw stepError;
            },
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: (ctx) => {
              spy(ctx.recovered.length, ctx.recoveredTotal);
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(spy).toHaveBeenCalledWith(1, 1);
      if (outcome?.status === "matched") {
        const recovered = outcome.telemetry.recovered;
        expect(recovered).toHaveLength(1);
        const entry: M3LRunRecoveryEntry = recovered[0] as M3LRunRecoveryEntry;
        expect(entry.item).toBe("s1");
        expect(Array.isArray(entry.error)).toBe(true);
        expect(() => new Date(entry.recordedAt).toISOString()).not.toThrow();
        expect(new Date(entry.recordedAt).toISOString()).toBe(entry.recordedAt);
        // Not the pipeline recovery shape.
        expect(Object.hasOwn(entry, "index")).toBe(false);
        expect(Object.hasOwn(entry, "attempt")).toBe(false);
      }
    });

    test("recovered.length caps at M3L_RECOVERY_LIMIT with the oldest evicted; recoveredTotal counts uncapped", async () => {
      const attempts = M3L_RECOVERY_LIMIT + 10;
      const builder = createProcedureBuilder<TS>("recovery-cap").step({
        id: "s1",
        label: "s1",
        kind: "control",
        // This self-entry is NOT a precondition for the retry below: `loop`
        // and `jumpsTo` are independent optional fields, and the engine's
        // own continueOnFailure retry is never routed through the
        // `jumpsTo` allowlist check at all (see the dedicated regression
        // "a loop step with continueOnFailure retries without needing a
        // self-entry in jumpsTo" further down in this describe block,
        // which omits `jumpsTo` entirely and still retries). It is left
        // here only because this fixture happens to declare it, not
        // because removing it would break the retry.
        jumpsTo: ["s1"] as const,
        loop: { reason: "repeated absorbed failures", maxRevisits: attempts },
        continueOnFailure: true,
        execute: (ctx) => {
          if (ctx.iteration >= attempts) {
            return { flow: "stop" };
          }
          throw new Error(`failure #${ctx.iteration}`);
        },
      });
      const procedure = builder.case(ALWAYS_TRUE_CASE).build(DEFAULT_FALLBACK);

      const { outcome, thrown } = await runCapturing(() =>
        procedure.run({
          deps: {},
          parameters: {},
          maxIterations: attempts + 1,
        }),
      );

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      if (outcome?.status === "matched") {
        expect(outcome.telemetry.recovered.length).toBeLessThanOrEqual(
          M3L_RECOVERY_LIMIT,
        );
        expect(outcome.telemetry.recoveredTotal).toBeGreaterThan(
          M3L_RECOVERY_LIMIT,
        );
        // Oldest evicted: the first entry's item should not be "failure #0".
        const first = outcome.telemetry.recovered[0];
        expect(first?.item).not.toBe("s1@0");
      }
    });

    test("a loop step with continueOnFailure retries without needing a self-entry in jumpsTo", async () => {
      // Regression for PR #523: the engine used to synthesize a loop
      // step's absorbed-throw retry as a caller-shaped `{ goTo: step.id }`
      // flow directive, which `#interpretGoTo` then validated against the
      // declaring step's own `jumpsTo` allowlist. `loop` and `jumpsTo` are
      // independent optional fields — nothing requires a step to list
      // itself in `jumpsTo` just because it declares `loop` — so a step
      // with `loop` + `continueOnFailure: true` and no self-entry in
      // `jumpsTo` (indeed no `jumpsTo` at all, as here) never got its
      // throw absorbed: the engine's own directive was rejected as an
      // undeclared jump, and the run resolved `failed` under
      // `ERR_PROCEDURE_UNDECLARED_JUMP` — blaming the step for a directive
      // it never returned. Before the fix, this test failed with exactly
      // that: a `failed` outcome instead of `matched`.
      let calls = 0;
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("loop-retry-no-jumps-to")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            // Deliberately no `jumpsTo` at all.
            loop: { reason: "retry an absorbed failure", maxRevisits: 1 },
            continueOnFailure: true,
            execute: () => {
              calls += 1;
              if (calls === 1) {
                throw new Error("transient failure");
              }
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(calls).toBeGreaterThan(1);
      if (outcome?.status === "matched") {
        expect(outcome.telemetry.recovered).toHaveLength(1);
        expect(outcome.telemetry.recoveredTotal).toBe(1);
        const record = outcome.telemetry.steps.find(
          (step: M3LProcedureStepRecord) => step.id === "s1",
        );
        expect(record?.status).toBe("recovered");
      }
    });

    test("a recovered step's record has status 'recovered' and no output", async () => {
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("recovered-record")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            continueOnFailure: true,
            execute: () => {
              throw new Error("boom");
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      if (outcome?.status === "matched") {
        const record = outcome.telemetry.steps.find(
          (step: M3LProcedureStepRecord) => step.id === "s1",
        );
        expect(record?.status).toBe("recovered");
        expect(record?.output).toBeUndefined();
      }
    });

    // ------------------------------------------------------------------
    // New regression: a malformed flow directive is an engine-level
    // contract violation, never an ordinary step failure — it must NOT be
    // absorbed into "recovered" even when the step opts into
    // continueOnFailure. docs/reference/core/procedure.md § Phase 1 step 5
    // is explicit that this case is "never absorbed by continueOnFailure".
    // This is the test most likely to be wrong under a naive fix that folds
    // the malformed-result check into the same try/catch that absorbs a
    // genuine execute() throw — hence the explicit recoveredTotal === 0
    // assertion below, not just a "failed" status check.
    // ------------------------------------------------------------------
    test("[KNOWN CONTRACT] continueOnFailure does not absorb a malformed { flow: null } result — the outcome is still 'failed' under ERR_PROCEDURE_UNDECLARED_JUMP, not 'recovered'", async () => {
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>(
          "malformed-flow-not-absorbed",
        )
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            continueOnFailure: true,
            execute: () =>
              ({ flow: null }) as unknown as M3LProcedureStepResult<TS, never>,
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_UNDECLARED_JUMP");
      }
      // The malformed result must not be folded into the recovery ring
      // buffer at all — recoveredTotal is common to every outcome status.
      expect(outcome?.telemetry.recoveredTotal).toBe(0);
    });

    test("[type] telemetry.recovered is assignable to M3LRunReportInput['recovery']", () => {
      expectTypeOf<
        M3LProcedureOutcome<TS>["telemetry"]["recovered"]
      >().toExtend<M3LRunReportInput["recovery"]>();
    });
  });

  // -------------------------------------------------------------------------
  // 6. cancellation
  // -------------------------------------------------------------------------
  describe("cancellation", () => {
    test("an already-aborted signal yields status 'aborted' with zero steps executed", async () => {
      const spy = vi.fn();
      const controller = new AbortController();
      controller.abort();

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("preaborted")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              spy();
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          signal: controller.signal,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
      expect(spy).not.toHaveBeenCalled();
    });

    test("an abort between steps ends the run at the boundary", async () => {
      const controller = new AbortController();
      const spy = vi.fn();

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("abort-between")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              controller.abort();
              return { flow: "continue" };
            },
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: () => {
              spy();
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          signal: controller.signal,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
      expect(spy).not.toHaveBeenCalled();
    });

    test("the signal is threaded into context.signal with identity equal to options.signal", async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("signal-identity")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: (ctx) => {
              seen = ctx.signal;
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          signal: controller.signal,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(seen).toBe(controller.signal);
    });

    test("a step that throws an error with code === ERR_OPERATION_ABORTED yields 'aborted', not 'failed' — discriminated by code, not instanceof", async () => {
      class NotAnAbortedError extends M3LError {
        constructor() {
          super("plain abort-shaped error", { code: "ERR_OPERATION_ABORTED" });
        }
      }

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("code-discrimination")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              throw new NotAnAbortedError();
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
    });

    test("a raw AbortError DOMException maps to 'failed', not 'aborted'", async () => {
      const domException = new DOMException("aborted", "AbortError");

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("dom-exception")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              throw domException;
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
    });

    test("a step that throws ERR_OPERATION_ABORTED while options.signal is NOT aborted still yields 'aborted'", async () => {
      class SelfReportedAbort extends M3LError {
        constructor() {
          super("owned cancellation", { code: "ERR_OPERATION_ABORTED" });
        }
      }
      const controller = new AbortController(); // never aborted

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("unaborted-signal")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              throw new SelfReportedAbort();
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          signal: controller.signal,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
      expect(controller.signal.aborted).toBe(false);
    });

    test("an abort wins over continueOnFailure — the aborting step is not absorbed", async () => {
      class SelfReportedAbort extends M3LError {
        constructor() {
          super("owned cancellation", { code: "ERR_OPERATION_ABORTED" });
        }
      }

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("abort-vs-recovery")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            continueOnFailure: true,
            execute: () => {
              throw new SelfReportedAbort();
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
      if (outcome?.status === "matched") {
        expect(outcome.telemetry.recovered).toHaveLength(0);
      }
    });

    // ------------------------------------------------------------------
    // New regression: docs/reference/core/procedure.md § Phase 1 says "An
    // abort always wins... over a step's own thrown error." A step here
    // fires the AbortController itself, synchronously, immediately before
    // throwing an ordinary, non-abort-coded Error — the run must still
    // resolve "aborted", not "failed", because the signal is now aborted by
    // the time the throw is handled.
    // ------------------------------------------------------------------

    test("an abort fired synchronously inside a step's own execute wins over that step's own unrelated thrown error — the outcome is 'aborted', not 'failed'", async () => {
      const controller = new AbortController();

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>(
          "abort-wins-over-own-throw",
        )
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              // Fires the abort itself, then throws a plain, unrelated
              // error — the step never checks the signal at all.
              controller.abort();
              throw new Error("boom");
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          signal: controller.signal,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
    });

    // ------------------------------------------------------------------
    // New regression: the "aborted" arm must preserve an already-genuine
    // M3LOperationAbortedError instance rather than re-minting a fresh one
    // — re-minting would lose the caller's own message/context.
    // ------------------------------------------------------------------

    test("the aborted arm preserves an already-genuine M3LOperationAbortedError instance rather than re-minting one", async () => {
      const original = new M3LOperationAbortedError("custom message");
      const controller = new AbortController(); // never aborted — the step self-reports

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("preserve-abort-instance")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              throw original;
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          signal: controller.signal,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
      if (outcome?.status === "aborted") {
        expect(outcome.error).toBe(original);
        expect(outcome.error.message).toBe("custom message");
      }
    });

    test("abortedAt names the step boundary; it is undefined for an abort observed after phase 1", async () => {
      const controller = new AbortController();

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("abort-boundary")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              controller.abort();
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          signal: controller.signal,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
      if (outcome?.status === "aborted") {
        // Observed after phase 1 (about to enter phase 2), so undefined —
        // not the id of the step that already ran.
        expect(outcome.abortedAt).toBeUndefined();
      }
    });
  });
});
