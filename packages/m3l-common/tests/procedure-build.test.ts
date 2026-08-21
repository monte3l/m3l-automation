/**
 * Tests for the `core/procedure` submodule — slice 2a (ADR-0046, issue #474):
 * the builder + build-time validation surface, and a reduced `M3LProcedure`
 * (constructor + `digest` + `describe()` only — `run()` lands in slice 3, and
 * no test in this file calls it).
 *
 * Contract source: docs/reference/core/procedure.md § Build-time validation,
 * § Builder/definition/engine, § Cases and the mandatory fallback,
 * § Definition digest.
 *
 * Scope: `createProcedureBuilder`/`M3LProcedureBuilder`/`build()`'s aggregate
 * reporting, one block per per-problem code, `build()` success, the digest
 * invariant, and type-level guarantees. Slice 2b (a later PR) owns the
 * exhaustive `invalid declarations` / `cycle detection` / `pattern safety`
 * batteries in a separate file — porting them here would blow the test-file
 * budget ceiling and rebind coverage across slices, exactly the trap that
 * sank the original PR #523 attempt (see `.claude/rules/tests.md`).
 *
 * No error class is exported from `core/procedure` — every failure is
 * asserted via `instanceof M3LError` plus the machine-readable `code`, never
 * a whitebox subclass import.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3L_ERROR_CODES, M3LError } from "../src/core/errors/index.js";
import { canonicalJsonHash } from "../src/core/json/index.js";
import {
  createProcedureBuilder,
  M3L_PROCEDURE_CONDITION_MAX_DEPTH,
  M3LProcedure,
} from "../src/core/procedure/index.js";
import type {
  M3LProcedureBuildOptions,
  M3LProcedureBuilder,
  M3LProcedureCase,
  M3LProcedureCondition,
  M3LProcedureFallback,
  M3LProcedureProblemCode,
  M3LProcedureReference,
  M3LProcedureStep,
  M3LProcedureValidationProblem,
} from "../src/core/procedure/index.js";

// ---------------------------------------------------------------------------
// Shared behavioral fixture
// ---------------------------------------------------------------------------

/**
 * The behavioral fixture shape used throughout this file. `stepId`/`caseId`
 * are deliberately widened to plain `string` rather than a literal union —
 * every scenario below exercises build()'s RUNTIME validation guard, which
 * protects a dynamic/JS-style caller the type system cannot see (a duplicate
 * step/case id, a dangling jump, a tied priority are all COMPILE errors under
 * a properly narrowed shape — see the "type-level" block at the end of this
 * file, which uses a separately and correctly narrowed `TypedShape`).
 */
interface TestShape {
  readonly deps: Record<string, never>;
  readonly values: {
    readonly count: number;
    readonly label: string;
    readonly flag: boolean;
  };
  readonly parameters: { readonly threshold: number };
  readonly conclusion: { readonly verdict: string };
  readonly stepId: string;
  readonly caseId: string;
}

type AnyTestStep = M3LProcedureStep<TestShape, string, string>;
type AnyTestCase = M3LProcedureCase<TestShape, string>;

function makeStep(
  overrides: Partial<AnyTestStep> & { readonly id: string },
): AnyTestStep {
  return {
    label: overrides.id,
    kind: "gather",
    execute: () => ({ flow: "continue" }),
    ...overrides,
  };
}

function makeCase(
  overrides: Partial<AnyTestCase> & {
    readonly id: string;
    readonly priority: number;
    readonly condition: M3LProcedureCondition<TestShape>;
  },
): AnyTestCase {
  return {
    description: overrides.id,
    prose: overrides.id,
    action: () => ({ verdict: overrides.id }),
    ...overrides,
  };
}

/** Always resolves `true`: a literal `0` always "exists". Content-neutral. */
const ALWAYS_TRUE_CONDITION: M3LProcedureCondition<TestShape> = {
  kind: "exists",
  subject: { source: "literal", literal: 0 },
};

function caseWithCondition(
  condition: M3LProcedureCondition<TestShape>,
  id = "case-under-test",
  priority = 1,
): AnyTestCase {
  return makeCase({ id, priority, condition });
}

const FALLBACK: M3LProcedureFallback<TestShape> = {
  description: "no case matched",
  prose: "Unrecognized pattern. Investigate.",
  action: () => ({ verdict: "unrecognized" }),
};

/**
 * An untyped view of the fluent builder chain. Behavioral fixtures below
 * deliberately assemble runtime-invalid shapes (duplicate ids, tied
 * priorities, dangling jumps, a missing fallback, non-function handlers) that
 * a properly-typed caller cannot express — `build()`'s job is to guard
 * exactly that dynamic-construction path.
 */
interface UntypedProcedureBuilder {
  step(step: unknown): UntypedProcedureBuilder;
  case(entry: unknown): UntypedProcedureBuilder;
  build(fallback: unknown, options?: unknown): M3LProcedure<TestShape>;
}

// NOTE — default-parameter trap: `fallback: unknown = FALLBACK` below means
// an OMITTED third argument and an explicitly-passed `undefined` third
// argument are indistinguishable at the call site — JavaScript triggers a
// parameter default in both cases identically. That is exactly what every
// other-problem-code test wants (it doesn't care about the fallback, so
// omitting it should still build a valid one), but it makes this helper
// unusable for simulating a caller who genuinely omits the fallback — use
// `buildProcedureWithFallbackAsGiven` below for that case instead.
function buildProcedure(
  steps: readonly unknown[],
  cases: readonly unknown[],
  fallback: unknown = FALLBACK,
  options?: M3LProcedureBuildOptions,
  name = "test-procedure",
): M3LProcedure<TestShape> {
  let builder = createProcedureBuilder<TestShape>(
    name,
  ) as unknown as UntypedProcedureBuilder;
  for (const step of steps) builder = builder.step(step);
  for (const entry of cases) builder = builder.case(entry);
  return builder.build(fallback, options);
}

/**
 * Identical untyped-builder chain to `buildProcedure`, but with no default
 * for `fallback` — required so a test can pass a literal `undefined` and have
 * `build()` actually receive it, simulating a JS caller that omits the
 * fallback argument entirely. Reach for this instead of `buildProcedure`
 * whenever the fallback argument's absence is the thing under test.
 */
function buildProcedureWithFallbackAsGiven(
  steps: readonly unknown[],
  cases: readonly unknown[],
  fallback: unknown,
  options?: M3LProcedureBuildOptions,
  name = "test-procedure",
): M3LProcedure<TestShape> {
  let builder = createProcedureBuilder<TestShape>(
    name,
  ) as unknown as UntypedProcedureBuilder;
  for (const step of steps) builder = builder.step(step);
  for (const entry of cases) builder = builder.case(entry);
  return builder.build(fallback, options);
}

/** Nests `depth` "not" wrappers around a leaf condition. */
function nestedNot(
  depth: number,
  leaf: M3LProcedureCondition<TestShape> = ALWAYS_TRUE_CONDITION,
): M3LProcedureCondition<TestShape> {
  let condition = leaf;
  for (let i = 0; i < depth; i += 1) {
    condition = { kind: "not", operand: condition };
  }
  return condition;
}

function captureProblems(build: () => unknown): {
  readonly error: M3LError;
  readonly problems: readonly M3LProcedureValidationProblem[];
} {
  let thrown: unknown;
  try {
    build();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(M3LError);
  const error = thrown as M3LError;
  expect(error.code).toBe("ERR_PROCEDURE_INVALID_DEFINITION");
  const rawProblems = (error.context as { problems?: unknown }).problems;
  expect(Array.isArray(rawProblems)).toBe(true);
  return {
    error,
    problems: (Array.isArray(rawProblems)
      ? rawProblems
      : []) as readonly M3LProcedureValidationProblem[],
  };
}

function problemCodes(
  problems: readonly M3LProcedureValidationProblem[],
): readonly string[] {
  return problems.map((problem) => problem.code);
}

// ---------------------------------------------------------------------------

describe("core/procedure — build-time validation", () => {
  // -------------------------------------------------------------------------
  // 1. Aggregate reporting
  // -------------------------------------------------------------------------
  describe("aggregate reporting", () => {
    /**
     * One step list carrying four independent fault classes at once:
     *  - "dup" declared twice -> ERR_PROCEDURE_DUPLICATE_STEP_ID
     *  - "ghost" jumps to a step that does not exist -> ERR_PROCEDURE_INVALID_JUMP_TARGET
     *  - "loop-b" jumps back to "loop-a" with no `loop` annotation -> ERR_PROCEDURE_CYCLE_DETECTED
     * and two cases sharing a priority -> ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY.
     */
    function fourFaultSteps(): AnyTestStep[] {
      return [
        makeStep({ id: "dup" }),
        makeStep({ id: "dup" }),
        makeStep({ id: "ghost", jumpsTo: ["does-not-exist"] }),
        makeStep({ id: "loop-a" }),
        makeStep({ id: "loop-b", jumpsTo: ["loop-a"] }),
      ];
    }
    function fourFaultCases(): AnyTestCase[] {
      return [
        caseWithCondition(ALWAYS_TRUE_CONDITION, "case-one", 10),
        caseWithCondition(ALWAYS_TRUE_CONDITION, "case-two", 10),
      ];
    }

    test("one throw carries every problem across four simultaneous fault classes, each under its own code", () => {
      const { error, problems } = captureProblems(() =>
        buildProcedure(fourFaultSteps(), fourFaultCases()),
      );
      expect(error.origin).toBe("caller");
      expect(error.retryable).toBe(false);
      expect(problems.length).toBeGreaterThanOrEqual(4);
      const codes = new Set(problemCodes(problems));
      expect(codes.has("ERR_PROCEDURE_DUPLICATE_STEP_ID")).toBe(true);
      expect(codes.has("ERR_PROCEDURE_INVALID_JUMP_TARGET")).toBe(true);
      expect(codes.has("ERR_PROCEDURE_CYCLE_DETECTED")).toBe(true);
      expect(codes.has("ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY")).toBe(true);
    });

    test("the problem list is deterministic across two independent builds of the same bad definition", () => {
      const first = captureProblems(() =>
        buildProcedure(fourFaultSteps(), fourFaultCases()),
      );
      const second = captureProblems(() =>
        buildProcedure(fourFaultSteps(), fourFaultCases()),
      );
      expect(second.problems).toEqual(first.problems);
    });

    test("a single problem renders inline: the thrown error's own message equals that one problem's message", () => {
      const { error, problems } = captureProblems(() =>
        buildProcedure([], [caseWithCondition(ALWAYS_TRUE_CONDITION)]),
      );
      expect(problems).toHaveLength(1);
      expect(error.message).toBe(problems[0]?.message);
    });

    test("several problems render as a numbered list, one line per problem in declaration order", () => {
      const { error, problems } = captureProblems(() =>
        buildProcedure(fourFaultSteps(), fourFaultCases()),
      );
      expect(problems.length).toBeGreaterThan(1);
      // Not asserting an exact prefix string (undocumented); asserting the
      // structural shape: every problem's own message appears, each preceded
      // by its 1-based ordinal.
      problems.forEach((problem, index) => {
        expect(error.message).toContain(problem.message);
        expect(error.message).toMatch(new RegExp(`${index + 1}\\.`));
      });
    });

    test("an empty step list does not suppress the other checks — EMPTY_STEPS and a duplicate case id are both reported", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [],
          [
            caseWithCondition(ALWAYS_TRUE_CONDITION, "dup-case", 1),
            caseWithCondition(ALWAYS_TRUE_CONDITION, "dup-case", 2),
          ],
        ),
      );
      const codes = problemCodes(problems);
      expect(codes).toContain("ERR_PROCEDURE_EMPTY_STEPS");
      expect(codes).toContain("ERR_PROCEDURE_DUPLICATE_CASE_ID");
    });

    test("every problem code is a member of M3L_ERROR_CODES", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(fourFaultSteps(), fourFaultCases()),
      );
      expect(problems.length).toBeGreaterThan(0);
      for (const problem of problems) {
        expect(M3L_ERROR_CODES).toContain(problem.code);
      }
    });

    test.each([
      "ERR_PROCEDURE_EMPTY_STEPS",
      "ERR_PROCEDURE_DUPLICATE_STEP_ID",
      "ERR_PROCEDURE_INVALID_JUMP_TARGET",
      "ERR_PROCEDURE_CYCLE_DETECTED",
      "ERR_PROCEDURE_DUPLICATE_CASE_ID",
      "ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY",
      "ERR_PROCEDURE_MISSING_FALLBACK",
      "ERR_PROCEDURE_INVALID_PATTERN",
      "ERR_PROCEDURE_CONDITION_TOO_DEEP",
      "ERR_PROCEDURE_UNKNOWN_REFERENCE",
      "ERR_PROCEDURE_INVALID_DECLARATION",
    ] as const)(
      "the per-problem code %s is registered in M3L_ERROR_CODES",
      (code) => {
        expect(M3L_ERROR_CODES).toContain(code);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 2. One block per per-problem code
  // -------------------------------------------------------------------------
  describe("per-problem code: ERR_PROCEDURE_EMPTY_STEPS", () => {
    test("no declared step is a problem", () => {
      const { problems } = captureProblems(() =>
        buildProcedure([], [caseWithCondition(ALWAYS_TRUE_CONDITION)]),
      );
      expect(problemCodes(problems)).toContain("ERR_PROCEDURE_EMPTY_STEPS");
    });

    test("[near miss] a non-empty step list does not fire EMPTY_STEPS", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "only-step" })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });
  });

  describe("per-problem code: ERR_PROCEDURE_DUPLICATE_STEP_ID", () => {
    test("two steps sharing an id is a problem", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "dup" }), makeStep({ id: "dup" })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_DUPLICATE_STEP_ID",
      );
    });

    test("an id repeated three times is reported exactly once, not once per repeat", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [
            makeStep({ id: "dup" }),
            makeStep({ id: "dup" }),
            makeStep({ id: "dup" }),
            makeStep({ id: "other" }),
          ],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      const duplicateProblems = problems.filter(
        (problem) => problem.code === "ERR_PROCEDURE_DUPLICATE_STEP_ID",
      );
      expect(duplicateProblems).toHaveLength(1);
    });

    test("[near miss] all-distinct ids do not fire DUPLICATE_STEP_ID", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "a" }), makeStep({ id: "b" })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });
  });

  describe("per-problem code: ERR_PROCEDURE_INVALID_JUMP_TARGET", () => {
    test("a jumpsTo entry naming no declared step is a problem", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a", jumpsTo: ["does-not-exist"] })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_INVALID_JUMP_TARGET",
      );
    });

    test("[near miss] a jumpsTo entry naming a real, later step does not fire INVALID_JUMP_TARGET", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "a", jumpsTo: ["b"] }), makeStep({ id: "b" })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });
  });

  describe("per-problem code: ERR_PROCEDURE_CYCLE_DETECTED", () => {
    test("an unacknowledged back edge is a problem (full coverage lands with slice 2b's dedicated 'cycle detection' battery)", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" }), makeStep({ id: "b", jumpsTo: ["a"] })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      expect(problemCodes(problems)).toContain("ERR_PROCEDURE_CYCLE_DETECTED");
    });
  });

  describe("per-problem code: ERR_PROCEDURE_DUPLICATE_CASE_ID", () => {
    test("two cases sharing an id is a problem", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [
            caseWithCondition(ALWAYS_TRUE_CONDITION, "dup", 1),
            caseWithCondition(ALWAYS_TRUE_CONDITION, "dup", 2),
          ],
        ),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_DUPLICATE_CASE_ID",
      );
    });

    test("[near miss] all-distinct case ids do not fire DUPLICATE_CASE_ID", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [
            caseWithCondition(ALWAYS_TRUE_CONDITION, "one", 1),
            caseWithCondition(ALWAYS_TRUE_CONDITION, "two", 2),
          ],
        ),
      ).not.toThrow();
    });
  });

  describe("per-problem code: ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY", () => {
    test("two cases sharing a priority is a problem naming both case ids", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [
            caseWithCondition(ALWAYS_TRUE_CONDITION, "case-alpha", 5),
            caseWithCondition(ALWAYS_TRUE_CONDITION, "case-beta", 5),
          ],
        ),
      );
      const problem = problems.find(
        (candidate) =>
          candidate.code === "ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY",
      );
      expect(problem).toBeDefined();
      expect(problem?.message).toContain("case-alpha");
      expect(problem?.message).toContain("case-beta");
      // Regression: `caseIds` carries every colliding id (`caseId` alone can
      // only hold one) — additive on top of the existing message assertion.
      expect(problem?.caseIds).toEqual(["case-alpha", "case-beta"]);
    });

    test("[near miss] distinct priorities do not fire DUPLICATE_CASE_PRIORITY", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [
            caseWithCondition(ALWAYS_TRUE_CONDITION, "one", 1),
            caseWithCondition(ALWAYS_TRUE_CONDITION, "two", 2),
          ],
        ),
      ).not.toThrow();
    });
  });

  describe("per-problem code: ERR_PROCEDURE_MISSING_FALLBACK", () => {
    // The typed path makes an absent fallback a compile error: `build()`'s
    // first parameter is a required positional `M3LProcedureFallback<TShape>`
    // (see the "type-level" block below). This reaches the runtime-only
    // guard through the untyped builder view, simulating a JS caller that
    // omits the argument entirely.
    test("[untyped path] an absent fallback is a problem", () => {
      const { problems } = captureProblems(() =>
        buildProcedureWithFallbackAsGiven(
          [makeStep({ id: "a" })],
          [],
          undefined,
        ),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_MISSING_FALLBACK",
      );
    });

    test("[untyped path] a malformed fallback (missing action) is a problem", () => {
      const { problems } = captureProblems(() =>
        buildProcedure([makeStep({ id: "a" })], [], {
          description: "d",
          prose: "p",
        }),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_MISSING_FALLBACK",
      );
    });

    // A fallback whose `action` is present but not a function is still a
    // malformed fallback (MISSING_FALLBACK), never INVALID_DECLARATION — that
    // new code is scoped to step `execute` / case `action` only (see the
    // "non-function handlers" block below), and this is the one case that
    // proves it doesn't leak onto the fallback.
    test("[untyped path] a fallback with a non-function action reports MISSING_FALLBACK, not INVALID_DECLARATION", () => {
      const { problems } = captureProblems(() =>
        buildProcedure([makeStep({ id: "a" })], [], {
          description: "d",
          prose: "p",
          action: "not-a-function",
        }),
      );
      expect(problemCodes(problems)).toEqual([
        "ERR_PROCEDURE_MISSING_FALLBACK",
      ]);
    });
  });

  describe("per-problem code: ERR_PROCEDURE_INVALID_PATTERN", () => {
    test("a quantified group in a matches pattern is a problem (full coverage lands with slice 2b's dedicated 'pattern safety' battery)", () => {
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "matches",
        subject: { source: "value", key: "label" },
        pattern: "(a+)+",
      };
      const { problems } = captureProblems(() =>
        buildProcedure([makeStep({ id: "a" })], [caseWithCondition(condition)]),
      );
      expect(problemCodes(problems)).toContain("ERR_PROCEDURE_INVALID_PATTERN");
    });
  });

  describe("per-problem code: ERR_PROCEDURE_CONDITION_TOO_DEEP", () => {
    test("a condition nesting past the max depth is a problem", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [
            caseWithCondition(
              nestedNot(M3L_PROCEDURE_CONDITION_MAX_DEPTH + 10),
            ),
          ],
        ),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_CONDITION_TOO_DEEP",
      );
    });

    test("[near miss] a condition nesting exactly at the max depth does not fire CONDITION_TOO_DEEP", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(nestedNot(M3L_PROCEDURE_CONDITION_MAX_DEPTH))],
        ),
      ).not.toThrow();
    });
  });

  describe("per-problem code: ERR_PROCEDURE_UNKNOWN_REFERENCE", () => {
    // `TestShape.stepId` is widened to plain `string` (see the fixture note
    // above), so a step reference naming a step this procedure never
    // declared is directly constructible without a cast — a properly
    // narrowed shape would make this a compile error instead.
    test("a condition referencing a step this procedure never declared is a problem", () => {
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        subject: { source: "step", step: "no-such-step" },
      };
      const { problems } = captureProblems(() =>
        buildProcedure([makeStep({ id: "a" })], [caseWithCondition(condition)]),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_UNKNOWN_REFERENCE",
      );
    });

    // Unlike `stepId`, `TestShape.parameters` is a fixed-shape object, so an
    // unknown key genuinely requires the untyped path.
    test("[untyped path] a condition referencing an undeclared parameter key is a problem", () => {
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        subject: {
          source: "parameter",
          key: "bogus",
        } as unknown as M3LProcedureReference<TestShape>,
      };
      const { problems } = captureProblems(() =>
        buildProcedure([makeStep({ id: "a" })], [caseWithCondition(condition)]),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_UNKNOWN_REFERENCE",
      );
    });

    // Narrowing (docs/reference/core/procedure.md § Build-time validation): a
    // step's `values` patch is produced inside its `execute` body at run
    // time, so `build()` has no declared set of value keys to check a
    // condition against — unlike `parameters`, a builder declaration would
    // not help, because the question is "which keys will any step actually
    // produce", a property of function bodies, not "which keys were
    // declared". This is deliberately a positive assertion that build()
    // succeeds, not a deleted test: it locks the narrowing in so a later
    // pass cannot quietly re-add an unimplementable check. The run-time
    // counterpart — an unresolvable `value` reference reports
    // `present: false` and the condition evaluates `false` — is covered in
    // `procedure-conditions.test.ts`.
    test("a `value` reference is deliberately not build-validated", () => {
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        subject: {
          source: "value",
          key: "bogus",
        } as unknown as M3LProcedureReference<TestShape>,
      };
      expect(() =>
        buildProcedure([makeStep({ id: "a" })], [caseWithCondition(condition)]),
      ).not.toThrow();
    });
  });

  describe("per-problem code: ERR_PROCEDURE_INVALID_DECLARATION", () => {
    test("an empty step id is a problem (full sub-case coverage lands with slice 2b's dedicated 'invalid declarations' battery)", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "" })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_INVALID_DECLARATION",
      );
    });

    // -----------------------------------------------------------------------
    // Non-function handlers — new for slice 2a, not ported from the abandoned
    // branch. A typed `.step({...})`/`.case({...})` call makes a non-function
    // `execute`/`action` a compile error, so this is reachable only via the
    // untyped path (the raw object literal, never cast through `AnyTestStep`/
    // `AnyTestCase`, since `steps`/`cases` are `readonly unknown[]`).
    // -----------------------------------------------------------------------
    const NON_FUNCTION_VALUES: ReadonlyArray<readonly [string, unknown]> = [
      ["undefined", undefined],
      ["null", null],
      ["a string", "not-a-function"],
      ["a number", 42],
      ["a plain object", { foo: "bar" }],
    ];

    test.each(NON_FUNCTION_VALUES)(
      "[untyped path] a step execute that is %s is a problem naming the stepId",
      (_label, badExecute) => {
        const { problems } = captureProblems(() =>
          buildProcedure(
            [
              {
                id: "bad-step",
                label: "bad-step",
                kind: "gather",
                execute: badExecute,
              },
            ],
            [caseWithCondition(ALWAYS_TRUE_CONDITION)],
          ),
        );
        const problem = problems.find(
          (candidate) => candidate.code === "ERR_PROCEDURE_INVALID_DECLARATION",
        );
        expect(problem).toBeDefined();
        expect(problem?.stepId).toBe("bad-step");
      },
    );

    test.each(NON_FUNCTION_VALUES)(
      "[untyped path] a case action that is %s is a problem naming the caseId",
      (_label, badAction) => {
        const { problems } = captureProblems(() =>
          buildProcedure(
            [makeStep({ id: "a" })],
            [
              {
                id: "bad-case",
                description: "d",
                prose: "p",
                priority: 1,
                condition: ALWAYS_TRUE_CONDITION,
                action: badAction,
              },
            ],
          ),
        );
        const problem = problems.find(
          (candidate) => candidate.code === "ERR_PROCEDURE_INVALID_DECLARATION",
        );
        expect(problem).toBeDefined();
        expect(problem?.caseId).toBe("bad-case");
      },
    );

    // -----------------------------------------------------------------------
    // Regression: a condition `literal` that is a `bigint` used to leak
    // `ERR_INVALID_ARGUMENT` out of `canonicalJsonHash` (reached a second,
    // independent read of the caller's condition tree) rather than being
    // caught here, at build time, under this code. `M3LProcedureScalar`
    // excludes `bigint` at the type level, so this is only reachable via the
    // untyped path.
    // -----------------------------------------------------------------------
    test("[untyped path] a condition literal that is a bigint is a problem naming the caseId, not a leaked ERR_INVALID_ARGUMENT", () => {
      const condition = {
        kind: "exists",
        subject: { source: "literal", literal: 10n },
      } as unknown as M3LProcedureCondition<TestShape>;
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(condition, "bigint-case", 1)],
        ),
      );
      const problem = problems.find(
        (candidate) => candidate.code === "ERR_PROCEDURE_INVALID_DECLARATION",
      );
      expect(problem).toBeDefined();
      expect(problem?.caseId).toBe("bigint-case");
    });

    // -----------------------------------------------------------------------
    // Regression: `options.revision` used to forward a non-string,
    // non-undefined value (a `bigint`, a `NaN`) straight into
    // `buildProcedureSummary`/`canonicalJsonHash` uncaught, rather than being
    // rejected here as a declaration problem.
    // -----------------------------------------------------------------------
    test.each([
      ["a bigint", 10n],
      ["NaN", Number.NaN],
    ])(
      "[untyped path] build()'s options.revision that is %s is a problem, not a thrown/uncoded error",
      (_label, badRevision) => {
        const { problems } = captureProblems(() =>
          buildProcedure(
            [makeStep({ id: "a" })],
            [caseWithCondition(ALWAYS_TRUE_CONDITION)],
            FALLBACK,
            { revision: badRevision } as unknown as M3LProcedureBuildOptions,
          ),
        );
        expect(problemCodes(problems)).toContain(
          "ERR_PROCEDURE_INVALID_DECLARATION",
        );
      },
    );
  });

  // -------------------------------------------------------------------------
  // Boundary catch-all — a declared field that throws while being read
  // -------------------------------------------------------------------------
  describe("build()'s defense-in-depth backstop for a throwing declared field", () => {
    // Regression: a hostile getter on a declared field (id/label/kind/
    // execute/action/etc.) used to escape `build()` as a bare, uncoded thrown
    // value — never reaching the caller as an `M3LError` at all. `build()`'s
    // own `try`/`catch` around `validateProcedureDefinition` is the
    // documented backstop for exactly this: it normalizes ANY unexpected
    // throw during validation into `ERR_PROCEDURE_INVALID_DEFINITION`,
    // chaining the original value as `cause`. Only reachable via the untyped
    // path — a typed `.step({...})` literal cannot carry a throwing getter
    // and still satisfy `M3LProcedureStep`.
    test("[untyped path] a step whose id is a throwing getter surfaces as ERR_PROCEDURE_INVALID_DEFINITION with the original value chained as cause", () => {
      const hostileStep = {
        get id() {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error thrown by a hostile getter, proving build()'s boundary catch-all normalizes an arbitrary thrown value rather than leaking it
          throw "boom";
        },
        label: "x",
        kind: "action",
        execute: () => ({ flow: "continue" }),
      };
      const { error, problems } = captureProblems(() =>
        buildProcedure(
          [hostileStep],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      // The backstop has no structured findings to report — the failure was
      // in reading the fields at all, not in what was read.
      expect(problems).toEqual([]);
      expect(error.cause).toBe("boom");
    });
  });

  // -------------------------------------------------------------------------
  // 3. build() succeeds
  // -------------------------------------------------------------------------
  describe("build() succeeds", () => {
    function wellFormedProcedure(
      options?: M3LProcedureBuildOptions,
      executeImpl: AnyTestStep["execute"] = () => ({ flow: "continue" }),
    ): M3LProcedure<TestShape> {
      return buildProcedure(
        [makeStep({ id: "gather", execute: executeImpl })],
        [caseWithCondition(ALWAYS_TRUE_CONDITION, "always", 1)],
        FALLBACK,
        options ?? { revision: "r1" },
        "well-formed",
      );
    }

    test("a well-formed definition builds without throwing and returns an M3LProcedure with a non-empty digest", () => {
      let procedure: M3LProcedure<TestShape> | undefined;
      expect(() => {
        procedure = wellFormedProcedure();
      }).not.toThrow();
      expect(procedure).toBeInstanceOf(M3LProcedure);
      expect(typeof procedure?.digest).toBe("string");
      expect(procedure?.digest.length).toBeGreaterThan(0);
    });

    test("describe() returns a summary every field of which is a scalar/array/condition value — canonicalJsonHash accepts it whole", () => {
      const procedure = wellFormedProcedure();
      const summary = procedure.describe();
      expect(() => canonicalJsonHash(summary)).not.toThrow();
      expect(summary.name).toBe("well-formed");
      expect(summary.revision).toBe("r1");
      expect(Array.isArray(summary.steps)).toBe(true);
      expect(Array.isArray(summary.cases)).toBe(true);
      expect(Array.isArray(summary.parameters)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Digest invariant — new for slice 2a, not ported from the abandoned
    // branch. `describe()` returns exactly the serialisable projection
    // `digest` hashes (docs/reference/core/procedure.md § Definition digest).
    // -----------------------------------------------------------------------
    describe("digest invariant", () => {
      test("canonicalJsonHash(procedure.describe()) equals procedure.digest", () => {
        const procedure = wellFormedProcedure();
        expect(canonicalJsonHash(procedure.describe())).toBe(procedure.digest);
      });

      test("digest is stable across two independently-built structurally-identical definitions", () => {
        const first = wellFormedProcedure({ revision: "r1" });
        const second = wellFormedProcedure({ revision: "r1" });
        expect(second.digest).toBe(first.digest);
      });

      test("digest is unchanged when only an execute body's closure changes, the declared shape being identical", () => {
        const first = wellFormedProcedure({ revision: "r1" }, () => ({
          flow: "continue",
        }));
        const second = wellFormedProcedure({ revision: "r1" }, () => ({
          flow: "stop",
        }));
        expect(second.digest).toBe(first.digest);
      });

      test("digest changes when revision changes", () => {
        const first = wellFormedProcedure({ revision: "r1" });
        const second = wellFormedProcedure({ revision: "r2" });
        expect(second.digest).not.toBe(first.digest);
      });
    });

    // -----------------------------------------------------------------------
    // Regression: `describe()`'s returned summary must be immutable — a
    // caller that mutates a returned array/nested object must not corrupt
    // what a later `describe()` call returns. `internal/procedure/digest.ts`'s
    // `buildProcedureSummary` deep-freezes the summary once, and
    // `M3LProcedure.describe()` returns that exact object reference on every
    // call (never a fresh clone) — this block asserts what is actually true,
    // not merely "structurally identical across calls".
    // -----------------------------------------------------------------------
    describe("describe() summary immutability", () => {
      test("the summary and its nested arrays/objects are deeply frozen", () => {
        const summary = wellFormedProcedure().describe();
        expect(Object.isFrozen(summary)).toBe(true);
        expect(Object.isFrozen(summary.steps)).toBe(true);
        expect(Object.isFrozen(summary.cases)).toBe(true);
        expect(Object.isFrozen(summary.parameters)).toBe(true);
        expect(Object.isFrozen(summary.fallback)).toBe(true);
        const firstStep = summary.steps[0];
        expect(firstStep).toBeDefined();
        expect(Object.isFrozen(firstStep)).toBe(true);
        expect(Object.isFrozen(firstStep?.jumpsTo)).toBe(true);
      });

      test("mutating a top-level field throws (this module is strict-mode ESM) and a later describe() call is unaffected", () => {
        const procedure = wellFormedProcedure();
        const summary = procedure.describe();
        expect(() => {
          (summary as { name: string }).name = "mutated";
        }).toThrow(TypeError);
        expect(procedure.describe().name).toBe("well-formed");
      });

      test("mutating a nested array (steps[0].jumpsTo) throws and a later describe() call is unaffected", () => {
        const procedure = wellFormedProcedure();
        const summary = procedure.describe();
        const firstStep = summary.steps[0];
        expect(firstStep).toBeDefined();
        expect(() => {
          (firstStep?.jumpsTo as string[]).push("nope");
        }).toThrow(TypeError);
        expect(procedure.describe().steps[0]?.jumpsTo).toEqual([]);
      });

      test("two describe() calls return the exact same object reference", () => {
        const procedure = wellFormedProcedure();
        expect(procedure.describe()).toBe(procedure.describe());
      });
    });
  });

  // -------------------------------------------------------------------------
  // 4. Type-level
  // -------------------------------------------------------------------------
  describe("type-level", () => {
    /**
     * A properly narrowed shape (a real literal step/case-id union), unlike
     * `TestShape` above — this is what makes the compile-time protections
     * below reachable at all.
     */
    interface TypedShape {
      readonly deps: Record<string, never>;
      readonly values: Record<string, never>;
      readonly parameters: Record<string, never>;
      readonly conclusion: void;
      readonly stepId: "step-a" | "step-b";
      readonly caseId: "case-a" | "case-b";
    }

    // Generic over the specific literal id (`const TId`), NOT
    // `TypedShape["stepId"]` itself — a helper typed to the whole union
    // would make every call site's `id` widen back to the union, defeating
    // the builder's per-call literal narrowing (`Exclude<TPendingSteps,
    // TId>`) and making the SECOND `.step()` call fail to typecheck for the
    // wrong reason (the first call would already have excluded the whole
    // union from pending).
    function step<const TId extends TypedShape["stepId"]>(
      id: TId,
      jumpsTo?: readonly TypedShape["stepId"][],
    ): M3LProcedureStep<TypedShape, TId, TypedShape["stepId"]> {
      return {
        id,
        label: id,
        kind: "gather",
        ...(jumpsTo !== undefined ? { jumpsTo } : {}),
        execute: () => ({ flow: "continue" }),
      };
    }

    function typedCase<const TId extends TypedShape["caseId"]>(
      id: TId,
      priority: number,
    ): M3LProcedureCase<TypedShape, TId> {
      return {
        id,
        description: id,
        prose: id,
        priority,
        condition: {
          kind: "exists",
          subject: { source: "literal", literal: 0 },
        },
        action: () => undefined,
      };
    }

    const typedFallback: M3LProcedureFallback<TypedShape> = {
      description: "fallback",
      prose: "fallback",
      action: () => undefined,
    };

    // The following type-only checks live inside functions that are never
    // invoked: `.step()`/`.case()`/`.build()` are not implemented yet in this
    // RED phase, so calling them for real would fail the test for the wrong
    // reason. `tsc` still type-checks an uncalled function body in full,
    // which is all a `@ts-expect-error` needs.

    test("[type-level] a duplicate step id does not compile", () => {
      function typeOnly(): void {
        const builder = createProcedureBuilder<TypedShape>("typed").step(
          step("step-a"),
        );
        // @ts-expect-error — "step-a" was already declared; the returned
        // builder's pending-steps union excludes it now.
        builder.step(step("step-a"));
      }
      expect(typeof typeOnly).toBe("function");
    });

    test("[type-level] a duplicate case id does not compile", () => {
      function typeOnly(): void {
        const builder = createProcedureBuilder<TypedShape>("typed")
          .step(step("step-a"))
          .step(step("step-b"))
          .case(typedCase("case-a", 1));
        // @ts-expect-error — "case-a" was already declared; the returned
        // builder's pending-cases union excludes it now.
        builder.case(typedCase("case-a", 2));
      }
      expect(typeof typeOnly).toBe("function");
    });

    test("[type-level] build() without a fallback does not compile", () => {
      function typeOnly(): void {
        const builder = createProcedureBuilder<TypedShape>("typed")
          .step(step("step-a"))
          .step(step("step-b"))
          .case(typedCase("case-a", 1))
          .case(typedCase("case-b", 2));
        // @ts-expect-error — fallback is a required positional argument.
        builder.build();
      }
      expect(typeof typeOnly).toBe("function");
    });

    test("[type-level] a jumpsTo entry outside TShape['stepId'] does not compile", () => {
      function typeOnly(): void {
        createProcedureBuilder<TypedShape>("typed").step({
          id: "step-a",
          label: "A",
          kind: "gather",
          // @ts-expect-error — "not-a-step" is not in TypedShape["stepId"].
          jumpsTo: ["not-a-step"],
          execute: () => ({ flow: "continue" }),
        });
      }
      expect(typeof typeOnly).toBe("function");
    });

    test("[type-level] M3LProcedureProblemCode is exactly the eleven per-problem literals", () => {
      expectTypeOf<M3LProcedureProblemCode>().toEqualTypeOf<
        | "ERR_PROCEDURE_EMPTY_STEPS"
        | "ERR_PROCEDURE_DUPLICATE_STEP_ID"
        | "ERR_PROCEDURE_INVALID_JUMP_TARGET"
        | "ERR_PROCEDURE_CYCLE_DETECTED"
        | "ERR_PROCEDURE_DUPLICATE_CASE_ID"
        | "ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY"
        | "ERR_PROCEDURE_MISSING_FALLBACK"
        | "ERR_PROCEDURE_INVALID_PATTERN"
        | "ERR_PROCEDURE_CONDITION_TOO_DEEP"
        | "ERR_PROCEDURE_UNKNOWN_REFERENCE"
        | "ERR_PROCEDURE_INVALID_DECLARATION"
      >();
    });

    test("[type-level] the builder type shape is what createProcedureBuilder returns", () => {
      expectTypeOf(createProcedureBuilder<TypedShape>).returns.toExtend<
        M3LProcedureBuilder<
          TypedShape,
          TypedShape["stepId"],
          TypedShape["caseId"]
        >
      >();
      // Silence unused-binding lint for fixtures only exercised inside
      // uncalled `typeOnly` closures above.
      void typedFallback;
    });
  });
});
