/**
 * Tests for the `core/procedure` submodule — slice 3b (ADR-0046, issue #474):
 * opt-in tracing (`options.trace`/`options.logger`, `M3LProcedureTraceSink`,
 * `M3LProcedureTraceOptions`) and the `procedure:step`/`procedure:outcome`
 * breadcrumb events. NONE of `M3LProcedureTraceSink`/`M3LProcedureTraceOptions`
 * exist on `main` yet, and `M3LProcedureRunOptions` does not yet carry
 * `trace`/`logger` fields — every test in this file is written against the
 * documented, eventual contract and is expected to fail RED until this slice
 * lands. That RED failure is the point, not a defect in the test.
 *
 * Contract source: docs/reference/core/procedure.md § Tracing, § Option
 * validation, § Outcome.
 *
 * Scope owned by this file: `options.trace`/`options.logger` and the two
 * trace events only. `options.progress` (the no-progress guard) is slice
 * 3c's and is not exercised here. This file is self-contained — it does not
 * import the shared fixture rig from `procedure.test.ts` / `procedure-run-
 * faults.test.ts` / `procedure-run-guards.test.ts` (ADR-0072 per-file sizing).
 *
 * No error class is exported from `core/procedure` — every failure is
 * asserted via `instanceof M3LError` plus the machine-readable `code`, never
 * a whitebox subclass import.
 */

import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { createProcedureBuilder } from "../src/core/procedure/index.js";
import type {
  M3LProcedureCase,
  M3LProcedureContext,
  M3LProcedureFallback,
  M3LProcedureOutcome,
  M3LProcedureRunOptions,
  M3LProcedureShape,
  M3LProcedureStepKind,
  M3LProcedureStepResult,
  M3LProcedureTraceEntry,
  M3LProcedureTraceOptions,
  M3LProcedureTraceSink,
  M3LProcedureValue,
} from "../src/core/procedure/index.js";
import { M3LError, M3L_ERROR_CODES } from "../src/core/errors/index.js";
import { M3LBreadcrumbTrail } from "../src/core/diagnostics/index.js";
import type { M3LBreadcrumbScalar } from "../src/core/diagnostics/index.js";
import { M3LLogger } from "../src/core/logging/index.js";

// ---------------------------------------------------------------------------
// Shared shape + fixtures
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

/** Never satisfied — drives the `unrecognized` arm on demand. */
const NEVER_MATCH_CASE: M3LProcedureCase<TS, "caseA"> = {
  id: "caseA",
  description: "never matches",
  prose: "never matches",
  priority: 1,
  condition: { kind: "exists", subject: { source: "value", key: "absentKey" } },
  action: () => ({ verdict: "matched" }),
};

const DEFAULT_FALLBACK: M3LProcedureFallback<TS> = {
  description: "no case matched",
  prose: "no case matched",
  action: () => ({ verdict: "fallback" }),
};

/** One call recorded by a {@link RecordingSink}. */
interface RecordedCall {
  readonly source: string;
  readonly event: string;
  readonly payload: unknown;
}

/** An in-memory `M3LProcedureTraceSink`; pushes every call verbatim. */
class RecordingSink implements M3LProcedureTraceSink {
  readonly calls: RecordedCall[] = [];
  record(source: string, event: string, payload?: unknown): void {
    this.calls.push({ source, event, payload });
  }
}

function stepCallsOf(sink: RecordingSink): RecordedCall[] {
  return sink.calls.filter((call) => call.event === "procedure:step");
}

function outcomeCallsOf(sink: RecordingSink): RecordedCall[] {
  return sink.calls.filter((call) => call.event === "procedure:outcome");
}

function payloadOf(call: RecordedCall | undefined): Record<string, unknown> {
  expect(call).toBeDefined();
  return call?.payload as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe("core/procedure — tracing", () => {
  // -------------------------------------------------------------------------
  // 1. Absent trace → zero tracing work
  // -------------------------------------------------------------------------
  describe("absent trace option", () => {
    test("outcome.trace is [] when options.trace is omitted (baseline, shipped in 3a)", async () => {
      const procedure = createProcedureBuilder<TS>("no-trace")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({ deps: {}, parameters: {} });
      expect(outcome.trace).toEqual([]);
    });

    test("trace/logger passed as explicit undefined behave identically to omission", async () => {
      const procedure = createProcedureBuilder<TS>("explicit-undefined-trace")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      // Simulates an untyped caller explicitly writing `trace: undefined,
      // logger: undefined` — a typed caller cannot construct this literal
      // directly (`exactOptionalPropertyTypes` forbids an explicit
      // `undefined` on an optional field), so the whole-object cast mirrors
      // the "untyped caller" pattern this module's sibling
      // `procedure-run-*.test.ts` files use for the same reason.
      const options = {
        deps: {},
        parameters: {},
        trace: undefined,
        logger: undefined,
      } as unknown as M3LProcedureRunOptions<TS>;
      const outcome = await procedure.run(options);
      expect(outcome.trace).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 2. procedure:step — one entry per step that actually executes
  // -------------------------------------------------------------------------
  describe("procedure:step — clean success", () => {
    test("records exactly the engine keys merged with describeTrace's safe keys; engine keys win over forged same-named ones; sink and outcome.trace agree", async () => {
      const sink = new RecordingSink();
      const contextsSeenByDescribe: unknown[] = [];
      const contextsSeenByExecute: unknown[] = [];

      const procedure = createProcedureBuilder<TS>("clean-step")
        .step({
          id: "s1",
          label: "Step one",
          kind: "gather",
          describeTrace: (context: M3LProcedureContext<TS>) => {
            contextsSeenByDescribe.push(context);
            // `attempt`/`failed`/`flow` here forge the engine's own field
            // names — asserted overwritten below, never left standing.
            return {
              window: "PT1H",
              attempt: 999,
              failed: true,
              flow: "stop",
            };
          },
          execute: (context: M3LProcedureContext<TS>) => {
            contextsSeenByExecute.push(context);
            return { flow: "continue" as const };
          },
        })
        .step({
          id: "s2",
          label: "s2",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);

      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink },
      });

      expect(outcome.status).toBe("matched");

      // describeTrace ran with the exact same context execute received.
      expect(contextsSeenByDescribe).toHaveLength(1);
      expect(contextsSeenByExecute).toHaveLength(1);
      expect(contextsSeenByDescribe[0]).toBe(contextsSeenByExecute[0]);

      const stepCalls = stepCallsOf(sink);
      expect(stepCalls).toHaveLength(2);
      expect(stepCalls[0]?.source).toBe("M3LProcedure");

      const firstPayload = payloadOf(stepCalls[0]);
      expect(firstPayload["stepId"]).toBe("s1");
      expect(firstPayload["label"]).toBe("Step one");
      expect(firstPayload["kind"]).toBe("gather");
      expect(firstPayload["window"]).toBe("PT1H");
      // The engine's own values win over the forged same-named keys.
      expect(firstPayload["attempt"]).toBe(1);
      expect(firstPayload["failed"]).toBe(false);
      expect(firstPayload["flow"]).toBe("continue");
      expect(typeof firstPayload["durationMs"]).toBe("number");

      // outcome.trace retains the SAME entries, in execution order.
      expect(outcome.trace).toHaveLength(2);
      const entry = outcome.trace[0] as M3LProcedureTraceEntry;
      expect(entry.stepId).toBe("s1");
      expect(entry.attempt).toBe(1);
      expect(entry.failed).toBe(false);
      expect(entry.flow).toBe("continue");
      expect(entry.payload["window"]).toBe("PT1H");
    });

    test("a custom trace.source overrides the default 'M3LProcedure' label", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("custom-source")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink, source: "custom-source-label" },
      });
      expect(stepCallsOf(sink)[0]?.source).toBe("custom-source-label");
    });
  });

  // -------------------------------------------------------------------------
  // 3. The four "not a clean success" classifications
  // -------------------------------------------------------------------------
  describe("procedure:step — not-a-clean-success classifications", () => {
    test("(a) an unabsorbed thrown execute records failed:true, flow:undefined before the run ends as 'failed'", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("unabsorbed-throw")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => {
            throw new Error("boom");
          },
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink },
      });
      expect(outcome.status).toBe("failed");
      const stepCalls = stepCallsOf(sink);
      expect(stepCalls).toHaveLength(1);
      const payload = payloadOf(stepCalls[0]);
      expect(payload["stepId"]).toBe("s1");
      expect(payload["failed"]).toBe(true);
      expect(payload["flow"]).toBeUndefined();
    });

    test("(b) an absorbed continueOnFailure throw with no loop records failed:true, flow:undefined, even though the step's own record.status is 'recovered'", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("absorbed-no-loop")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          continueOnFailure: true,
          execute: () => {
            throw new Error("transient");
          },
        })
        .step({
          id: "s2",
          label: "s2",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink },
      });
      expect(outcome.status).toBe("matched");
      if (outcome.status === "matched") {
        const record = outcome.telemetry.steps.find((step) => step.id === "s1");
        expect(record?.status).toBe("recovered");
      }
      const s1Calls = stepCallsOf(sink).filter(
        (call) => payloadOf(call)["stepId"] === "s1",
      );
      expect(s1Calls).toHaveLength(1);
      const payload = payloadOf(s1Calls[0]);
      expect(payload["failed"]).toBe(true);
      expect(payload["flow"]).toBeUndefined();
    });

    test("(c) an absorbed continueOnFailure throw on a step declaring loop records a SEPARATE trace entry per attempt, each failed:true, flow:undefined", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("absorbed-with-loop")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          loop: { reason: "retry until exhausted", maxRevisits: 2 },
          continueOnFailure: true,
          execute: () => {
            throw new Error("always fails");
          },
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        maxIterations: 1000,
        trace: { sink },
      });
      // maxRevisits: 2 permits 3 executions (M + 1); all 3 throw, so the
      // run exhausts the revisit ceiling and resolves "failed".
      expect(outcome.status).toBe("failed");
      const stepCalls = stepCallsOf(sink);
      expect(stepCalls).toHaveLength(3);
      stepCalls.forEach((call, index) => {
        const payload = payloadOf(call);
        expect(payload["attempt"]).toBe(index + 1);
        expect(payload["failed"]).toBe(true);
        expect(payload["flow"]).toBeUndefined();
      });
    });

    test("(d) a malformed step result (missing/invalid flow) traces identically to a throw: failed:true, flow:undefined", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("malformed-result")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () =>
            ({ flow: null }) as unknown as M3LProcedureStepResult<TS, never>,
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink },
      });
      expect(outcome.status).toBe("failed");
      const stepCalls = stepCallsOf(sink);
      expect(stepCalls).toHaveLength(1);
      const payload = payloadOf(stepCalls[0]);
      expect(payload["failed"]).toBe(true);
      expect(payload["flow"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Abort boundary interaction with tracing
  // -------------------------------------------------------------------------
  describe("abort boundary interaction", () => {
    test("an already-aborted signal records zero trace entries — the boundary is checked before any step begins", async () => {
      const sink = new RecordingSink();
      const controller = new AbortController();
      controller.abort();
      const procedure = createProcedureBuilder<TS>("preaborted-trace")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        signal: controller.signal,
        trace: { sink },
      });
      expect(outcome.status).toBe("aborted");
      expect(stepCallsOf(sink)).toHaveLength(0);
    });

    test("an abort firing while a step's execute is running still traces that attempt as failed:true, flow:undefined, then the run resolves 'aborted'", async () => {
      const sink = new RecordingSink();
      const controller = new AbortController();
      const procedure = createProcedureBuilder<TS>("abort-mid-execute")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => {
            // Fires the abort itself, then throws a plain, unrelated error —
            // the step never checks the signal at all.
            controller.abort();
            throw new Error("unrelated");
          },
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        signal: controller.signal,
        trace: { sink },
      });
      expect(outcome.status).toBe("aborted");
      const stepCalls = stepCallsOf(sink);
      expect(stepCalls).toHaveLength(1);
      const payload = payloadOf(stepCalls[0]);
      expect(payload["stepId"]).toBe("s1");
      expect(payload["failed"]).toBe(true);
      expect(payload["flow"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 5. procedure:outcome event
  // -------------------------------------------------------------------------
  describe("procedure:outcome event", () => {
    test("matched arm records status, primaryCaseId (string), alsoMatchedCount, iterations, resolveChecks, earlyResolved, digest", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("outcome-matched")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink },
      });
      expect(outcome.status).toBe("matched");
      const outcomeCalls = outcomeCallsOf(sink);
      expect(outcomeCalls).toHaveLength(1);
      const payload = payloadOf(outcomeCalls[0]);
      expect(payload["status"]).toBe("matched");
      expect(payload["primaryCaseId"]).toBe("caseA");
      expect(payload["alsoMatchedCount"]).toBe(0);
      expect(payload["digest"]).toBe(outcome.digest);
      expect(typeof payload["iterations"]).toBe("number");
      expect(typeof payload["resolveChecks"]).toBe("number");
      expect(typeof payload["earlyResolved"]).toBe("boolean");
    });

    test("unrecognized arm records primaryCaseId: null — never omitted", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("outcome-unrecognized")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(NEVER_MATCH_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink },
      });
      expect(outcome.status).toBe("unrecognized");
      const outcomeCalls = outcomeCallsOf(sink);
      expect(outcomeCalls).toHaveLength(1);
      const payload = payloadOf(outcomeCalls[0]);
      expect(Object.hasOwn(payload, "primaryCaseId")).toBe(true);
      expect(payload["primaryCaseId"]).toBeNull();
      expect(payload["status"]).toBe("unrecognized");
    });

    test("failed arm records primaryCaseId: null — never omitted", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("outcome-failed")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => {
            throw new Error("boom");
          },
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink },
      });
      expect(outcome.status).toBe("failed");
      const outcomeCalls = outcomeCallsOf(sink);
      expect(outcomeCalls).toHaveLength(1);
      const payload = payloadOf(outcomeCalls[0]);
      expect(payload["primaryCaseId"]).toBeNull();
      expect(payload["status"]).toBe("failed");
    });

    test("aborted arm records primaryCaseId: null — never omitted", async () => {
      const sink = new RecordingSink();
      const controller = new AbortController();
      controller.abort();
      const procedure = createProcedureBuilder<TS>("outcome-aborted")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        signal: controller.signal,
        trace: { sink },
      });
      expect(outcome.status).toBe("aborted");
      const outcomeCalls = outcomeCallsOf(sink);
      expect(outcomeCalls).toHaveLength(1);
      const payload = payloadOf(outcomeCalls[0]);
      expect(payload["primaryCaseId"]).toBeNull();
      expect(payload["status"]).toBe("aborted");
    });

    test("no procedure:outcome event is recorded when a case action throws — run() rejects and the sink is unaffected", async () => {
      const sink = new RecordingSink();
      const boom = new Error("case action boom");
      const throwingCase: M3LProcedureCase<TS, "caseA"> = {
        ...ALWAYS_TRUE_CASE,
        action: () => {
          throw boom;
        },
      };
      const procedure = createProcedureBuilder<TS>("outcome-case-throws")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(throwingCase)
        .build(DEFAULT_FALLBACK);
      await expect(
        procedure.run({ deps: {}, parameters: {}, trace: { sink } }),
      ).rejects.toBe(boom);
      expect(outcomeCallsOf(sink)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Allowlist / sanitization rules for describeTrace's return
  // -------------------------------------------------------------------------
  describe("describeTrace payload allowlisting", () => {
    test("a dangerous key (__proto__, constructor, prototype) is dropped; sibling safe keys survive", async () => {
      const sink = new RecordingSink();
      // JSON.parse creates a genuine OWN "__proto__" data property — the
      // object-literal-syntax special case (which would instead set the
      // prototype) does not apply here.
      const dangerousReturn = JSON.parse(
        '{"__proto__": "x", "constructor": "y", "prototype": "z", "safe": "ok"}',
      ) as Record<string, M3LBreadcrumbScalar>;
      const procedure = createProcedureBuilder<TS>("dangerous-keys")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          describeTrace: () => dangerousReturn,
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      await procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      const payload = payloadOf(stepCallsOf(sink)[0]);
      expect(payload["safe"]).toBe("ok");
      expect(Object.hasOwn(payload, "__proto__")).toBe(false);
      expect(Object.hasOwn(payload, "constructor")).toBe(false);
      expect(Object.hasOwn(payload, "prototype")).toBe(false);
    });

    test("a non-scalar value under an otherwise-safe key is dropped individually; sibling safe keys still survive", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("non-scalar-key")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          describeTrace: () =>
            ({
              safeString: "ok",
              badObject: { nested: true },
              badArray: [1, 2, 3],
              badFunction: () => 1,
            }) as unknown as Record<string, M3LBreadcrumbScalar>,
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      await procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      const payload = payloadOf(stepCallsOf(sink)[0]);
      expect(payload["safeString"]).toBe("ok");
      expect(Object.hasOwn(payload, "badObject")).toBe(false);
      expect(Object.hasOwn(payload, "badArray")).toBe(false);
      expect(Object.hasOwn(payload, "badFunction")).toBe(false);
    });

    test("a null value under a safe key is preserved, not dropped", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("null-preserved")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          describeTrace: () => ({ bucket: null }),
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      await procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      const payload = payloadOf(stepCallsOf(sink)[0]);
      expect(Object.hasOwn(payload, "bucket")).toBe(true);
      expect(payload["bucket"]).toBeNull();
    });

    test.each([
      [
        "a string",
        () => "not an object" as unknown as Record<string, M3LBreadcrumbScalar>,
      ],
      [
        "an array",
        () => [1, 2, 3] as unknown as Record<string, M3LBreadcrumbScalar>,
      ],
      [
        "implicit undefined (falls off the end)",
        () => undefined as unknown as Record<string, M3LBreadcrumbScalar>,
      ],
    ])(
      "describeTrace returning %s degrades to an empty extras record, never a throw",
      async (
        _name: string,
        describeTrace: () => Record<string, M3LBreadcrumbScalar>,
      ) => {
        const sink = new RecordingSink();
        const procedure = createProcedureBuilder<TS>("non-object-describe")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            describeTrace,
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        const outcome = await procedure.run({
          deps: {},
          parameters: {},
          trace: { sink },
        });
        expect(outcome.status).toBe("matched");
        const payload = payloadOf(stepCallsOf(sink)[0]);
        const engineKeys = new Set([
          "stepId",
          "label",
          "kind",
          "attempt",
          "durationMs",
          "flow",
          "failed",
        ]);
        const extraKeys = Object.keys(payload).filter(
          (key) => !engineKeys.has(key),
        );
        expect(extraKeys).toHaveLength(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 7b. Flow projection for a clean step
  // -------------------------------------------------------------------------
  describe("flow projection for a clean step", () => {
    test("a step returning 'continue' projects to flow: 'continue'", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("flow-continue")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .step({
          id: "s2",
          label: "s2",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      await procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      expect(payloadOf(stepCallsOf(sink)[0])["flow"]).toBe("continue");
    });

    test("a step returning 'stop' projects to flow: 'stop'", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("flow-stop")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      await procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      expect(payloadOf(stepCallsOf(sink)[0])["flow"]).toBe("stop");
    });

    test("a step returning 'resolve' projects to flow: 'resolve'", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("flow-resolve")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "resolve" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      await procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      expect(payloadOf(stepCallsOf(sink)[0])["flow"]).toBe("resolve");
    });

    test("a step returning { goTo } projects to `goTo:<targetId>`", async () => {
      const sink = new RecordingSink();
      const procedure = createProcedureBuilder<TS>("flow-goto")
        .step({
          id: "s1",
          label: "s1",
          kind: "control",
          jumpsTo: ["s2"] as const,
          execute: () => ({ flow: { goTo: "s2" } }),
        })
        .step({
          id: "s2",
          label: "s2",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      await procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      expect(payloadOf(stepCallsOf(sink)[0])["flow"]).toBe("goTo:s2");
    });
  });

  // -------------------------------------------------------------------------
  // 7. Never-load-bearing guarantees
  // -------------------------------------------------------------------------
  describe("tracing is never load-bearing", () => {
    test("describeTrace throwing does not affect the step's execution or the run's outcome; logger.warning is called once, without leaking the thrown error's message", async () => {
      const logger = new M3LLogger([]);
      const warningSpy = vi.spyOn(logger, "warning");
      const marker = "SECRET-MARKER-DO-NOT-LEAK";
      const procedure = createProcedureBuilder<TS>("describe-throws")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          describeTrace: () => {
            throw new Error(marker);
          },
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink: new RecordingSink() },
        logger,
      });
      expect(outcome.status).toBe("matched");
      expect(warningSpy).toHaveBeenCalledTimes(1);
      const [message] = warningSpy.mock.calls[0] ?? [];
      expect(typeof message).toBe("string");
      expect(message as string).not.toContain(marker);
    });

    test("sink.record throwing does not affect the run's outcome; logger.warning is called", async () => {
      const logger = new M3LLogger([]);
      const warningSpy = vi.spyOn(logger, "warning");
      const throwingSink: M3LProcedureTraceSink = {
        record: () => {
          throw new Error("sink boom");
        },
      };
      const procedure = createProcedureBuilder<TS>("sink-throws")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink: throwingSink },
        logger,
      });
      expect(outcome.status).toBe("matched");
      expect(warningSpy).toHaveBeenCalled();
    });

    test("no logger supplied when a tracing failure occurs — no throw, silently dropped", async () => {
      const throwingSink: M3LProcedureTraceSink = {
        record: () => {
          throw new Error("sink boom");
        },
      };
      const procedure = createProcedureBuilder<TS>("sink-throws-no-logger")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink: throwingSink },
      });
      expect(outcome.status).toBe("matched");
    });

    test("a hostile logger.warning call that itself throws still does not affect the run's outcome", async () => {
      const logger = new M3LLogger([]);
      vi.spyOn(logger, "warning").mockImplementation(() => {
        throw new Error("logger boom");
      });
      const throwingSink: M3LProcedureTraceSink = {
        record: () => {
          throw new Error("sink boom");
        },
      };
      const procedure = createProcedureBuilder<TS>("hostile-logger")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink: throwingSink },
        logger,
      });
      expect(outcome.status).toBe("matched");
    });

    test("when the tracing failure's error is an M3LError whose code IS a member of M3L_ERROR_CODES, the warning message includes that code", async () => {
      const logger = new M3LLogger([]);
      const warningSpy = vi.spyOn(logger, "warning");
      const knownCode = M3L_ERROR_CODES[0];
      expect(knownCode).toBeDefined();
      const throwingSink: M3LProcedureTraceSink = {
        record: () => {
          throw new M3LError("boom", { code: knownCode });
        },
      };
      const procedure = createProcedureBuilder<TS>("known-code")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink: throwingSink },
        logger,
      });
      expect(warningSpy).toHaveBeenCalledTimes(1);
      const [message] = warningSpy.mock.calls[0] ?? [];
      expect(message as string).toContain(knownCode);
    });

    test.each<[string, () => never]>([
      [
        "a plain Error",
        () => {
          throw new Error("plain error");
        },
      ],
      [
        "a string",
        () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to verify the unclassified fallback covers a non-M3LError channel
          throw "a string thrown value";
        },
      ],
      [
        "an M3LError with an invented/unrecognized code",
        () => {
          throw new M3LError("boom", { code: "ERR_TOTALLY_MADE_UP_NOT_REAL" });
        },
      ],
    ])(
      "when the tracing failure's error is %s, the warning falls back to an unclassified label rather than echoing the invented code",
      async (_name, doThrow) => {
        const logger = new M3LLogger([]);
        const warningSpy = vi.spyOn(logger, "warning");
        const throwingSink: M3LProcedureTraceSink = {
          record: doThrow,
        };
        const procedure = createProcedureBuilder<TS>("unclassified")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        await procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: throwingSink },
          logger,
        });
        expect(warningSpy).toHaveBeenCalledTimes(1);
        const [message] = warningSpy.mock.calls[0] ?? [];
        expect(message as string).not.toContain("ERR_TOTALLY_MADE_UP_NOT_REAL");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 8. core/diagnostics breadcrumb integration
  // -------------------------------------------------------------------------
  describe("core/diagnostics breadcrumb integration", () => {
    test("a null-valued describeTrace key survives into trail.entries()'s procedure:step breadcrumb via the registered summarizer, not the generic scalar-only fallback", async () => {
      const trail = new M3LBreadcrumbTrail();
      const procedure = createProcedureBuilder<TS>("breadcrumb-null-step")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          describeTrace: () => ({ bucket: null }),
          execute: () => ({ flow: "stop" }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
      await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink: trail },
      });
      const stepEntry = trail
        .entries()
        .find((entry) => entry.event === "procedure:step");
      expect(stepEntry).toBeDefined();
      expect(Object.hasOwn(stepEntry?.payload ?? {}, "bucket")).toBe(true);
      expect(stepEntry?.payload["bucket"]).toBeNull();
    });

    test("the procedure:outcome breadcrumb's primaryCaseId: null arm survives into trail.entries() too", async () => {
      const trail = new M3LBreadcrumbTrail();
      const procedure = createProcedureBuilder<TS>("breadcrumb-null-outcome")
        .step({
          id: "s1",
          label: "s1",
          kind: "gather",
          execute: () => ({ flow: "stop" }),
        })
        .case(NEVER_MATCH_CASE)
        .build(DEFAULT_FALLBACK);
      const outcome = await procedure.run({
        deps: {},
        parameters: {},
        trace: { sink: trail },
      });
      expect(outcome.status).toBe("unrecognized");
      const outcomeEntry = trail
        .entries()
        .find((entry) => entry.event === "procedure:outcome");
      expect(outcomeEntry).toBeDefined();
      expect(outcomeEntry?.payload["primaryCaseId"]).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Type-level: the shape IS the contract
  // -------------------------------------------------------------------------
  describe("type-level", () => {
    test("M3LProcedureTraceEntry has exactly the documented fields (shipped in 3a; verified here, not assumed)", () => {
      expectTypeOf<M3LProcedureTraceEntry>().toEqualTypeOf<{
        readonly stepId: string;
        readonly label: string;
        readonly kind: M3LProcedureStepKind;
        readonly attempt: number;
        readonly durationMs: number;
        readonly failed: boolean;
        readonly flow:
          "continue" | "stop" | "resolve" | `goTo:${string}` | undefined;
        readonly payload: Readonly<Record<string, M3LBreadcrumbScalar>>;
      }>();
    });

    test("M3LProcedureRunOptions gains optional trace and logger fields", () => {
      expectTypeOf<M3LProcedureRunOptions<TS>>().toMatchTypeOf<{
        readonly trace?: M3LProcedureTraceOptions;
        readonly logger?: M3LLogger;
      }>();
    });

    test("M3LProcedureOutcome's status arms remain a discriminated union unaffected by tracing", () => {
      expectTypeOf<M3LProcedureOutcome<TS>["status"]>().toEqualTypeOf<
        "matched" | "unrecognized" | "failed" | "aborted"
      >();
    });
  });
});
