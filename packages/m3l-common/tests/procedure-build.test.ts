/**
 * Tests for the `core/procedure` submodule (RED phase — issue #474,
 * ADR-0046): everything `M3LProcedureBuilder.build()` rejects, plus the
 * cycle-detection graph walk.
 *
 * Contract source: docs/reference/core/procedure.md § Build-time validation,
 * § Cycle detection, § Builder/definition/engine, § Cases.
 *
 * The implementation is a typed scaffold: every runtime body in
 * `src/core/procedure/**` (including `M3LProcedureBuilder.step`/`.case`/
 * `.build`) unconditionally throws `M3LProcedureInvalidDefinitionError`
 * (code `ERR_PROCEDURE_INVALID_DEFINITION`) with a "not implemented yet"
 * message and a context shape that does NOT yet carry `problems`. Every
 * behavioral assertion below is therefore expected to fail today — either
 * because the call throws where the contract says it should build cleanly,
 * or because the caught error's `context.problems` is not yet an array.
 * That is the correct RED failure mode: the module's real per-problem
 * validation, cycle walk, and pattern-safety scan do not exist yet.
 *
 * No error class is exported from `core/procedure` — every failure is
 * asserted via `instanceof M3LError` plus the machine-readable `code`,
 * never a whitebox subclass import, mirroring `core/pipeline`'s own rule
 * (see `pipeline.test.ts`'s "construction-time validation" block, the model
 * for this file's aggregate-reporting tests).
 *
 * Sibling spokes are concurrently writing `procedure.test.ts`,
 * `procedure-conditions.test.ts` and `procedure-guards.test.ts` — this file
 * owns exactly the build()-time validation surface and the cycle walk.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3L_ERROR_CODES, M3LError } from "../src/core/errors/index.js";
import { canonicalJsonHash } from "../src/core/json/index.js";
import {
  createProcedureBuilder,
  M3L_PROCEDURE_CONDITION_MAX_DEPTH,
  M3L_PROCEDURE_MAX_PATTERN_LENGTH,
  M3LProcedure,
} from "../src/core/procedure/index.js";
import type {
  M3LProcedureBuildOptions,
  M3LProcedureCase,
  M3LProcedureCondition,
  M3LProcedureFallback,
  M3LProcedureProblemCode,
  M3LProcedureReference,
  M3LProcedureStep,
  M3LProcedureValidationProblem,
  M3LProcedureBuilder,
} from "../src/core/procedure/index.js";

// ---------------------------------------------------------------------------
// Shared behavioral fixture
// ---------------------------------------------------------------------------

/**
 * The behavioral fixture shape used throughout blocks 1–6. `stepId`/`caseId`
 * are deliberately widened to plain `string` rather than a literal union —
 * every scenario below exercises build()'s RUNTIME validation guard, which
 * plays the same role for `core/procedure` that construction-time option
 * validation plays for `M3LOperationPipeline`: protecting a dynamic/JS-style
 * caller the type system cannot see (a duplicate step/case id, a dangling
 * jump, a tied priority are all COMPILE errors under a properly narrowed
 * shape — see the "type-level" block at the end of this file, which uses a
 * separately and correctly narrowed `TypedShape`). Widening to `string` here
 * is also what lets the cycle-detection scale fixture assemble a thousand
 * steps without a thousand-member literal union.
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
 * deliberately assemble runtime-invalid shapes (duplicate ids, cycles, tied
 * priorities, dangerous keys, a missing fallback) that a properly-typed
 * caller cannot express — `build()`'s job is to guard exactly that
 * dynamic-construction path, the same rationale `core/pipeline`'s own
 * construction-time validation carries ("this runtime check exists to guard
 * JavaScript callers and dynamic construction").
 */
interface UntypedProcedureBuilder {
  step(step: unknown): UntypedProcedureBuilder;
  case(entry: unknown): UntypedProcedureBuilder;
  build(fallback: unknown, options?: unknown): M3LProcedure<TestShape>;
}

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

/** Builds `count` linear steps `s0..s(count-1)`, each forwarding to the next. */
function linearSteps(count: number): AnyTestStep[] {
  const steps: AnyTestStep[] = [];
  for (let index = 0; index < count; index += 1) {
    steps.push(makeStep({ id: `s${index}` }));
  }
  return steps;
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
      // structural shape `internal/pipeline/validate.ts`'s `renderMessage`
      // established: every problem's own message appears, each preceded by
      // its 1-based ordinal.
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
    test("an unacknowledged back edge is a problem (full coverage in the dedicated 'cycle detection' block below)", () => {
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
        buildProcedure([makeStep({ id: "a" })], [], undefined),
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
  });

  describe("per-problem code: ERR_PROCEDURE_INVALID_PATTERN", () => {
    test("a quantified group in a matches pattern is a problem (full coverage in 'pattern safety' below)", () => {
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

    // Unlike `stepId`, `TestShape.values`/`parameters` are fixed-shape
    // objects, so an unknown key genuinely requires the untyped path.
    test("[untyped path] a condition referencing an undeclared value key is a problem", () => {
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        subject: {
          source: "value",
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
  });

  describe("per-problem code: ERR_PROCEDURE_INVALID_DECLARATION", () => {
    test("an empty step id is a problem (full sub-case coverage in 'invalid declarations' below)", () => {
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
  });

  // -------------------------------------------------------------------------
  // 3. Invalid declarations
  // -------------------------------------------------------------------------
  describe("invalid declarations", () => {
    test("an empty step id", () => {
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

    test("[untyped path] a non-string step id", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: 123 as unknown as string })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_INVALID_DECLARATION",
      );
    });

    test("an empty step label", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a", label: "" })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_INVALID_DECLARATION",
      );
    });

    test("[untyped path] a non-string step label", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a", label: 42 as unknown as string })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_INVALID_DECLARATION",
      );
    });

    test("an empty procedure name", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
          FALLBACK,
          undefined,
          "",
        ),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_INVALID_DECLARATION",
      );
    });

    test("[untyped path] a non-string procedure name", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
          FALLBACK,
          undefined,
          123 as unknown as string,
        ),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_INVALID_DECLARATION",
      );
    });

    test.each(["__proto__", "constructor", "prototype"] as const)(
      "[untyped path] a dangerous value-reference key (%s)",
      (dangerousKey) => {
        const condition: M3LProcedureCondition<TestShape> = {
          kind: "exists",
          subject: {
            source: "value",
            key: dangerousKey,
          } as unknown as M3LProcedureReference<TestShape>,
        };
        const { problems } = captureProblems(() =>
          buildProcedure(
            [makeStep({ id: "a" })],
            [caseWithCondition(condition)],
          ),
        );
        expect(problemCodes(problems)).toContain(
          "ERR_PROCEDURE_INVALID_DECLARATION",
        );
      },
    );

    test.each(["__proto__", "constructor", "prototype"] as const)(
      "[untyped path] a dangerous parameter-reference key (%s)",
      (dangerousKey) => {
        const condition: M3LProcedureCondition<TestShape> = {
          kind: "exists",
          subject: {
            source: "parameter",
            key: dangerousKey,
          } as unknown as M3LProcedureReference<TestShape>,
        };
        const { problems } = captureProblems(() =>
          buildProcedure(
            [makeStep({ id: "a" })],
            [caseWithCondition(condition)],
          ),
        );
        expect(problemCodes(problems)).toContain(
          "ERR_PROCEDURE_INVALID_DECLARATION",
        );
      },
    );

    // `M3LProcedureBuildOptions`/the builder's public API surface no runtime
    // list of "declared parameter names" separate from the parameters
    // referenced in conditions (the shape's `parameters` type is
    // compile-time only). "A duplicate parameter name" therefore has no
    // unambiguous runtime construction distinct from "the same parameter
    // key referenced more than once" (which is normal, not an error) —
    // flagged in the RED report as a sub-case this file could not
    // confidently turn into a test without guessing the mechanism.

    test.each([NaN, Infinity, -Infinity])(
      "a case priority of %s (non-finite)",
      (priority) => {
        const { problems } = captureProblems(() =>
          buildProcedure(
            [makeStep({ id: "a" })],
            [caseWithCondition(ALWAYS_TRUE_CONDITION, "case-a", priority)],
          ),
        );
        expect(problemCodes(problems)).toContain(
          "ERR_PROCEDURE_INVALID_DECLARATION",
        );
      },
    );

    test("[untyped path] a non-number case priority", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [
            caseWithCondition(
              ALWAYS_TRUE_CONDITION,
              "case-a",
              "100" as unknown as number,
            ),
          ],
        ),
      );
      expect(problemCodes(problems)).toContain(
        "ERR_PROCEDURE_INVALID_DECLARATION",
      );
    });

    test.each([0, -1, 1.5, Infinity, NaN])(
      "a loop.maxRevisits of %s (not a finite integer > 0)",
      (maxRevisits) => {
        const { problems } = captureProblems(() =>
          buildProcedure(
            [
              makeStep({ id: "a" }),
              makeStep({
                id: "b",
                jumpsTo: ["a"],
                loop: { reason: "deliberate retry", maxRevisits },
              }),
            ],
            [caseWithCondition(ALWAYS_TRUE_CONDITION)],
          ),
        );
        expect(problemCodes(problems)).toContain(
          "ERR_PROCEDURE_INVALID_DECLARATION",
        );
      },
    );

    test.each([NaN, Infinity, -Infinity])(
      "a condition literal of %s (non-finite number)",
      (literal) => {
        const condition: M3LProcedureCondition<TestShape> = {
          kind: "compare",
          left: { source: "literal", literal },
          operator: "==",
          right: { source: "value", key: "count" },
        };
        const { problems } = captureProblems(() =>
          buildProcedure(
            [makeStep({ id: "a" })],
            [caseWithCondition(condition)],
          ),
        );
        expect(problemCodes(problems)).toContain(
          "ERR_PROCEDURE_INVALID_DECLARATION",
        );
      },
    );

    // The load-bearing case: `build()` calls `canonicalJsonHash`, which
    // rejects a non-finite number anywhere in the tree with
    // `ERR_INVALID_ARGUMENT`. `ERR_PROCEDURE_INVALID_DECLARATION` exists so
    // that code never leaks out of `build()` — assert the outer code
    // explicitly, both ways.
    test("a NaN priority surfaces as ERR_PROCEDURE_INVALID_DEFINITION, never a leaked ERR_INVALID_ARGUMENT", () => {
      const { error } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION, "case-a", NaN)],
        ),
      );
      expect(error.code).toBe("ERR_PROCEDURE_INVALID_DEFINITION");
      expect(error.code).not.toBe("ERR_INVALID_ARGUMENT");
    });

    test("an Infinity condition literal surfaces as ERR_PROCEDURE_INVALID_DEFINITION, never a leaked ERR_INVALID_ARGUMENT", () => {
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        subject: { source: "literal", literal: Infinity },
      };
      const { error } = captureProblems(() =>
        buildProcedure([makeStep({ id: "a" })], [caseWithCondition(condition)]),
      );
      expect(error.code).toBe("ERR_PROCEDURE_INVALID_DEFINITION");
      expect(error.code).not.toBe("ERR_INVALID_ARGUMENT");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cycle detection
  // -------------------------------------------------------------------------
  describe("cycle detection", () => {
    test("a self-loop without `loop` is a cycle", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "x", jumpsTo: ["x"] })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      const problem = problems.find(
        (candidate) => candidate.code === "ERR_PROCEDURE_CYCLE_DETECTED",
      );
      expect(problem).toBeDefined();
      expect(problem?.path).toEqual(["x", "x"]);
    });

    test("[near miss] a self-loop annotated with `loop` builds clean", () => {
      expect(() =>
        buildProcedure(
          [
            makeStep({
              id: "x",
              jumpsTo: ["x"],
              loop: { reason: "deliberate retry", maxRevisits: 3 },
            }),
          ],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });

    test("a two-node back edge without `loop` is a cycle, path repeats the first node last", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" }), makeStep({ id: "b", jumpsTo: ["a"] })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      const problem = problems.find(
        (candidate) => candidate.code === "ERR_PROCEDURE_CYCLE_DETECTED",
      );
      expect(problem).toBeDefined();
      expect(problem?.path?.[0]).toBe(problem?.path?.at(-1));
    });

    test("a three-node cycle without `loop` is a cycle", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [
            makeStep({ id: "a" }),
            makeStep({ id: "b" }),
            makeStep({ id: "c", jumpsTo: ["a"] }),
          ],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      const problem = problems.find(
        (candidate) => candidate.code === "ERR_PROCEDURE_CYCLE_DETECTED",
      );
      expect(problem).toBeDefined();
      expect(problem?.path).toContain("a");
      expect(problem?.path).toContain("b");
      expect(problem?.path).toContain("c");
      expect(problem?.path?.[0]).toBe(problem?.path?.at(-1));
    });

    test("[near miss] a diamond (two forward paths converging) is not a cycle", () => {
      expect(() =>
        buildProcedure(
          [
            makeStep({ id: "a", jumpsTo: ["c"] }),
            makeStep({ id: "b", jumpsTo: ["d"] }),
            makeStep({ id: "c" }),
            makeStep({ id: "d" }),
          ],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });

    test("[near miss] a forward-only jumpsTo is not a cycle", () => {
      expect(() =>
        buildProcedure(
          [
            makeStep({ id: "a", jumpsTo: ["c"] }),
            makeStep({ id: "b" }),
            makeStep({ id: "c" }),
          ],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });

    test("[near miss] a purely linear graph (no jumps at all) is clean", () => {
      expect(() =>
        buildProcedure(linearSteps(5), [
          caseWithCondition(ALWAYS_TRUE_CONDITION),
        ]),
      ).not.toThrow();
    });

    // Two distinct edges into the same back-edge target ("b") from the same
    // declaring step ("c") — a minimal, literal construction of "the same
    // cycle discovered via two distinct routes" the doc names, since every
    // step here is reachable from exactly one connected chain (the implicit
    // sequential edges make the whole graph one component, so two genuinely
    // separate DFS "roots" into an identical node set are not otherwise
    // constructible). Dedup must still yield exactly one problem.
    test("the same cycle reached via two distinct edges is reported once, not twice", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" }), makeStep({ id: "b", jumpsTo: ["a", "a"] })],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      const cycleProblems = problems.filter(
        (problem) => problem.code === "ERR_PROCEDURE_CYCLE_DETECTED",
      );
      expect(cycleProblems).toHaveLength(1);
    });

    test("[near miss] a `loop`-annotated back edge is excluded from cycle detection and builds clean", () => {
      expect(() =>
        buildProcedure(
          [
            makeStep({ id: "a" }),
            makeStep({
              id: "b",
              jumpsTo: ["a"],
              loop: { reason: "deliberate re-gather", maxRevisits: 2 },
            }),
          ],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });

    test("[near miss] a `loop` annotation on a forward jump is still clean", () => {
      expect(() =>
        buildProcedure(
          [
            makeStep({
              id: "a",
              jumpsTo: ["b"],
              loop: { reason: "not actually a back edge", maxRevisits: 1 },
            }),
            makeStep({ id: "b" }),
          ],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });

    test("any jumpsTo naming the declaring step itself or an earlier step is a cycle without `loop` — even one step back", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [
            makeStep({ id: "a" }),
            makeStep({ id: "b" }),
            makeStep({ id: "c", jumpsTo: ["b"] }),
          ],
          [caseWithCondition(ALWAYS_TRUE_CONDITION)],
        ),
      );
      expect(problemCodes(problems)).toContain("ERR_PROCEDURE_CYCLE_DETECTED");
    });

    test("a ~1000-step, ~1000-jump graph completes the iterative walk without a stack overflow", () => {
      const steps = linearSteps(1000);
      // Add a forward jumpsTo from every step but the last two, skipping
      // ahead by one extra hop each time — forward-only, so this remains
      // acyclic however the walk explores it.
      for (let index = 0; index < steps.length - 2; index += 1) {
        const step = steps[index];
        if (step === undefined) continue;
        steps[index] = { ...step, jumpsTo: [`s${index + 2}`] };
      }

      let thrown: unknown;
      try {
        buildProcedure(steps, [caseWithCondition(ALWAYS_TRUE_CONDITION)]);
      } catch (error) {
        thrown = error;
      }
      // Whatever the outcome, it must not be an uncaught native stack
      // overflow — the walk is documented as iterative with an explicit
      // stack precisely so a large hand-generated graph cannot overflow it.
      expect(thrown).not.toBeInstanceOf(RangeError);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Pattern safety
  // -------------------------------------------------------------------------
  describe("pattern safety", () => {
    function matchesCondition(
      pattern: string,
    ): M3LProcedureCondition<TestShape> {
      return {
        kind: "matches",
        subject: { source: "value", key: "label" },
        pattern,
      };
    }

    test("a pattern longer than M3L_PROCEDURE_MAX_PATTERN_LENGTH is a problem", () => {
      const pattern = "a".repeat(M3L_PROCEDURE_MAX_PATTERN_LENGTH + 1);
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(matchesCondition(pattern))],
        ),
      );
      expect(problemCodes(problems)).toContain("ERR_PROCEDURE_INVALID_PATTERN");
    });

    test("a pattern source `new RegExp` rejects is a problem", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(matchesCondition("(unclosed"))],
        ),
      );
      expect(problemCodes(problems)).toContain("ERR_PROCEDURE_INVALID_PATTERN");
    });

    test.each(["(a+)+", "(a|b)*", "(foo)?", "(\\d{2}){3}"])(
      "a quantified group (%s) is a problem",
      (pattern) => {
        const { problems } = captureProblems(() =>
          buildProcedure(
            [makeStep({ id: "a" })],
            [caseWithCondition(matchesCondition(pattern))],
          ),
        );
        expect(problemCodes(problems)).toContain(
          "ERR_PROCEDURE_INVALID_PATTERN",
        );
      },
    );

    test("[near miss] an escaped `\\)` followed by a quantifier is not a group closer and is accepted", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(matchesCondition("a\\)+"))],
        ),
      ).not.toThrow();
    });

    test.each(["[)]+", "[^)]*"])(
      "[near miss] a `)` inside a character class (%s) is not a group closer and is accepted",
      (pattern) => {
        expect(() =>
          buildProcedure(
            [makeStep({ id: "a" })],
            [caseWithCondition(matchesCondition(pattern))],
          ),
        ).not.toThrow();
      },
    );

    // The honest trade-off the doc records: the blanket rule is deliberately
    // stricter than "no nested quantifier" and also rejects a pattern that
    // is individually safe. Locking this in rather than letting it be
    // silently narrowed later.
    test("[documented trade-off] `(?:abc)+` is rejected even though it is safe", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(matchesCondition("(?:abc)+"))],
        ),
      );
      expect(problemCodes(problems)).toContain("ERR_PROCEDURE_INVALID_PATTERN");
    });
  });

  // -------------------------------------------------------------------------
  // 6. build() succeeds
  // -------------------------------------------------------------------------
  describe("build() succeeds", () => {
    function wellFormedProcedure(): M3LProcedure<TestShape> {
      return buildProcedure(
        [makeStep({ id: "gather" })],
        [caseWithCondition(ALWAYS_TRUE_CONDITION, "always", 1)],
        FALLBACK,
        { revision: "r1" },
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
  });

  // -------------------------------------------------------------------------
  // 7. Type-level
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
    // invoked: `.step()`/`.case()`/`.build()` unconditionally throw at
    // runtime in this scaffold, so calling them for real would fail the
    // test for the wrong reason. `tsc` still type-checks an uncalled
    // function body in full, which is all a `@ts-expect-error` needs.

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
