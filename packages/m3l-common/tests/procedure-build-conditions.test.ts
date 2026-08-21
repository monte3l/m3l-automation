/**
 * Sibling test file for `internal/procedure/validate/conditions.ts`
 * (ADR-0046, ADR-0072 slice 2a) — closes the remaining branch-coverage gaps
 * left after `procedure-build.test.ts` filled its own file-budget ceiling.
 * Follows this repo's `<module>-<facet>.test.ts` sibling convention
 * (`bin/check-scaffold-seam.mjs`'s `hasSeamTestFile`), mirroring
 * `procedure-conditions.test.ts`/`procedure-conditions-boundary.test.ts` from
 * slice 1.
 *
 * Contract source: docs/reference/core/procedure.md § Build-time validation,
 * § Values and references. Scope is deliberately narrow — the arms this file
 * targets (traced via `coverage-final.json`, not guessed):
 *
 *  1. `isQuantifierChar`'s `"*"`/`"?"`/`"{"` arms (`"+"` is covered elsewhere).
 *  2. `isPatternSafe`'s oversized-pattern guard.
 *  3. `describeUnknownDiscriminant`'s `undefined`/`null` arms.
 *  4. `projectPath`'s "is an array"/non-empty branch.
 *  5. `step`/`value`/`parameter` references' non-string-field fallback, and
 *     the "known" (resolved) arms for `step`/`parameter`.
 *  6. `compare`'s non-string-`operator` fallback.
 *  7. `and`/`or`'s non-array-`operands` fallback.
 *  8. The `"contains"` condition kind.
 *  9. `projectCondition`'s top-level non-object-condition guard.
 *
 * NOT attempted: `hasQuantifiedGroup`'s `if (char === undefined) continue;`
 * line — a previous pass determined this is unreachable defensive code under
 * `noUncheckedIndexedAccess` (a JS string never yields `undefined` at an
 * in-bounds loop index); left as an accepted, documented gap.
 *
 * No error class is exported from `core/procedure` — every failure is
 * asserted via `instanceof M3LError` plus the machine-readable `code`.
 */

import { describe, expect, test } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import {
  createProcedureBuilder,
  M3L_PROCEDURE_MAX_PATTERN_LENGTH,
} from "../src/core/procedure/index.js";
import type {
  M3LProcedure,
  M3LProcedureCondition,
  M3LProcedureFallback,
  M3LProcedureStep,
  M3LProcedureValidationProblem,
} from "../src/core/procedure/index.js";

// ---------------------------------------------------------------------------
// Self-contained fixture — deliberately not imported from
// `procedure-build.test.ts` (cross-file import between test-file siblings is
// not appropriate here; see `tests.md`'s per-slice-isolation rule).
// ---------------------------------------------------------------------------

interface TestShape {
  readonly deps: Record<string, never>;
  readonly values: { readonly count: number; readonly label: string };
  readonly parameters: { readonly threshold: number };
  readonly conclusion: { readonly verdict: string };
  readonly stepId: string;
  readonly caseId: string;
}

type AnyTestStep = M3LProcedureStep<TestShape, string, string>;

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

const FALLBACK: M3LProcedureFallback<TestShape> = {
  description: "no case matched",
  prose: "Unrecognized pattern. Investigate.",
  action: () => ({ verdict: "unrecognized" }),
};

interface UntypedProcedureBuilder {
  parameters(names: readonly string[]): UntypedProcedureBuilder;
  step(step: unknown): UntypedProcedureBuilder;
  case(entry: unknown): UntypedProcedureBuilder;
  build(fallback: unknown, options?: unknown): M3LProcedure<TestShape>;
}

/** Same untyped-builder shape as `procedure-build.test.ts`'s `buildProcedure`, reimplemented here so this file has no cross-file dependency. */
function buildProcedure(
  steps: readonly unknown[],
  cases: readonly unknown[],
  fallback: unknown = FALLBACK,
  declaredParameters: readonly string[] = [],
  name = "test-procedure",
): M3LProcedure<TestShape> {
  let builder = createProcedureBuilder<TestShape>(
    name,
  ) as unknown as UntypedProcedureBuilder;
  if (declaredParameters.length > 0) {
    builder = builder.parameters(declaredParameters);
  }
  for (const step of steps) builder = builder.step(step);
  for (const entry of cases) builder = builder.case(entry);
  return builder.build(fallback);
}

function caseWithCondition(
  condition: unknown,
  id = "case-under-test",
  priority = 1,
): unknown {
  return {
    id,
    description: id,
    prose: id,
    priority,
    condition,
    action: () => ({ verdict: id }),
  };
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

/** Builds an oversized `(a)` group followed by `count` copies of `filler`, past `M3L_PROCEDURE_MAX_PATTERN_LENGTH`. */
function overlongPattern(): string {
  return "a".repeat(M3L_PROCEDURE_MAX_PATTERN_LENGTH + 1);
}

// ---------------------------------------------------------------------------

describe("internal/procedure/validate/conditions — sibling coverage battery", () => {
  describe("isQuantifierChar — *, ?, { arms", () => {
    test.each(["*", "?", "{2}"] as const)(
      "a group closed by %s is ERR_PROCEDURE_INVALID_PATTERN, same as +",
      (quantifier) => {
        const condition: M3LProcedureCondition<TestShape> = {
          kind: "matches",
          subject: { source: "value", key: "label" },
          pattern: `(a)${quantifier}`,
        };
        const { problems } = captureProblems(() =>
          buildProcedure(
            [makeStep({ id: "a" })],
            [caseWithCondition(condition)],
          ),
        );
        expect(problemCodes(problems)).toContain(
          "ERR_PROCEDURE_INVALID_PATTERN",
        );
      },
    );
  });

  describe("isPatternSafe — oversized-pattern guard", () => {
    test("a pattern one character over M3L_PROCEDURE_MAX_PATTERN_LENGTH is ERR_PROCEDURE_INVALID_PATTERN", () => {
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "matches",
        subject: { source: "value", key: "label" },
        pattern: overlongPattern(),
      };
      const { problems } = captureProblems(() =>
        buildProcedure([makeStep({ id: "a" })], [caseWithCondition(condition)]),
      );
      expect(problemCodes(problems)).toContain("ERR_PROCEDURE_INVALID_PATTERN");
    });
  });

  describe("describeUnknownDiscriminant — undefined/null arms", () => {
    test("an undefined condition kind is described as 'undefined', via the kind-dispatch path", () => {
      const condition = {
        kind: undefined,
      } as unknown as M3LProcedureCondition<TestShape>;
      const { problems } = captureProblems(() =>
        buildProcedure([makeStep({ id: "a" })], [caseWithCondition(condition)]),
      );
      const problem = problems.find(
        (candidate) => candidate.code === "ERR_PROCEDURE_INVALID_DECLARATION",
      );
      expect(problem?.message).toContain("undefined");
    });

    test("a null reference source is described as 'null', via the source-dispatch path", () => {
      const condition = {
        kind: "exists",
        subject: { source: null },
      } as unknown as M3LProcedureCondition<TestShape>;
      const { problems } = captureProblems(() =>
        buildProcedure([makeStep({ id: "a" })], [caseWithCondition(condition)]),
      );
      const problem = problems.find(
        (candidate) => candidate.code === "ERR_PROCEDURE_INVALID_DECLARATION",
      );
      expect(problem?.message).toContain("null");
    });
  });

  describe("projectPath — array branch and non-empty ternary", () => {
    test("a step reference to a declared step carrying a non-empty string path is projected verbatim, with no unknown-reference problem", () => {
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        subject: { source: "step", step: "known-step", path: ["a", "b"] },
      };
      const procedure = buildProcedure(
        [makeStep({ id: "known-step" }), makeStep({ id: "other" })],
        [caseWithCondition(condition)],
      );
      expect(procedure.describe().cases[0]?.condition).toEqual({
        kind: "exists",
        subject: { source: "step", step: "known-step", path: ["a", "b"] },
      });
    });

    test("a parameter reference declared via .parameters() carrying a non-empty path resolves, with no unknown-reference problem", () => {
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        subject: {
          source: "parameter",
          key: "threshold",
          path: ["nested"],
        },
      };
      const procedure = buildProcedure(
        [makeStep({ id: "a" })],
        [caseWithCondition(condition)],
        FALLBACK,
        ["threshold"],
      );
      expect(procedure.describe().cases[0]?.condition).toEqual({
        kind: "exists",
        subject: { source: "parameter", key: "threshold", path: ["nested"] },
      });
    });
  });

  describe("step/value/parameter references — non-string-field fallback", () => {
    test("a step reference whose 'step' field is not a string projects step:'' without an unknown-reference problem or a throw", () => {
      const condition = {
        kind: "exists",
        subject: { source: "step", step: 42 },
      } as unknown as M3LProcedureCondition<TestShape>;
      let procedure: M3LProcedure<TestShape> | undefined;
      expect(() => {
        procedure = buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(condition)],
        );
      }).not.toThrow();
      expect(procedure?.describe().cases[0]?.condition).toEqual({
        kind: "exists",
        subject: { source: "step", step: "" },
      });
    });

    test("a value reference whose 'key' field is not a string projects key:'' without a throw", () => {
      const condition = {
        kind: "exists",
        subject: { source: "value", key: 42 },
      } as unknown as M3LProcedureCondition<TestShape>;
      let procedure: M3LProcedure<TestShape> | undefined;
      expect(() => {
        procedure = buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(condition)],
        );
      }).not.toThrow();
      expect(procedure?.describe().cases[0]?.condition).toEqual({
        kind: "exists",
        subject: { source: "value", key: "" },
      });
    });

    test("a parameter reference whose 'key' field is not a string projects key:'' without an unknown-reference problem or a throw", () => {
      const condition = {
        kind: "exists",
        subject: { source: "parameter", key: 42 },
      } as unknown as M3LProcedureCondition<TestShape>;
      let procedure: M3LProcedure<TestShape> | undefined;
      expect(() => {
        procedure = buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(condition)],
        );
      }).not.toThrow();
      expect(procedure?.describe().cases[0]?.condition).toEqual({
        kind: "exists",
        subject: { source: "parameter", key: "" },
      });
    });
  });

  describe("compare — non-string-operator fallback", () => {
    test("a compare condition whose operator is a number projects operator:'' without a native throw", () => {
      const condition = {
        kind: "compare",
        left: { source: "literal", literal: 1 },
        operator: 7,
        right: { source: "literal", literal: 2 },
      } as unknown as M3LProcedureCondition<TestShape>;
      let procedure: M3LProcedure<TestShape> | undefined;
      expect(() => {
        procedure = buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(condition)],
        );
      }).not.toThrow();
      expect(procedure?.describe().cases[0]?.condition).toMatchObject({
        kind: "compare",
        operator: "",
      });
    });
  });

  describe("and/or — non-array-operands fallback", () => {
    test.each([
      ["and", undefined],
      ["or", { not: "an array" }],
    ] as const)(
      "a %s junction whose operands is not an array degrades to operands: [] rather than throwing",
      (kind, badOperands) => {
        const condition = {
          kind,
          operands: badOperands,
        } as unknown as M3LProcedureCondition<TestShape>;
        let procedure: M3LProcedure<TestShape> | undefined;
        expect(() => {
          procedure = buildProcedure(
            [makeStep({ id: "a" })],
            [caseWithCondition(condition)],
          );
        }).not.toThrow();
        expect(procedure?.describe().cases[0]?.condition).toEqual({
          kind,
          operands: [],
        });
      },
    );
  });

  describe("'contains' condition kind", () => {
    test("build() succeeds with a contains condition, and describe() projects subject/item", () => {
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "contains",
        subject: { source: "value", key: "label" },
        item: { source: "literal", literal: "x" },
      };
      const procedure = buildProcedure(
        [makeStep({ id: "a" })],
        [caseWithCondition(condition)],
      );
      expect(procedure.describe().cases[0]?.condition).toEqual({
        kind: "contains",
        subject: { source: "value", key: "label" },
        item: { source: "literal", literal: "x" },
      });
    });
  });

  describe("projectCondition — top-level non-object condition guard", () => {
    test.each([
      ["a bare string", "not-an-object"],
      ["null", null],
    ] as const)(
      "a case whose condition field is %s (not an object at all) projects to an undefined condition without a throw",
      (_label, rawCondition) => {
        let procedure: M3LProcedure<TestShape> | undefined;
        expect(() => {
          procedure = buildProcedure(
            [makeStep({ id: "a" })],
            [caseWithCondition(rawCondition)],
          );
        }).not.toThrow();
        expect(procedure?.describe().cases[0]?.condition).toBeUndefined();
      },
    );
  });

  // ---------------------------------------------------------------------------
  // `internal/procedure/validate/normalize.ts` regression coverage — sited here
  // (rather than `procedure-build.test.ts`, its natural home) because that
  // sibling file sits at 59,528/60,000 bytes, near the ADR-0072 file-budget
  // ceiling, while this file has ample headroom. Confirms the fix landed for
  // PR #582's `claude-pr-review` Must-fix: `normalizeContinueOnFailure`
  // previously cast any non-null/undefined `continueOnFailure` straight to
  // `boolean` with no runtime type check.
  // ---------------------------------------------------------------------------
  describe("continueOnFailure declaration — non-boolean vs. default-absent", () => {
    test("a step declared with continueOnFailure: 'false' (a non-boolean string) is ERR_PROCEDURE_INVALID_DECLARATION naming the step", () => {
      // Not expressible via the typed fluent chain (`continueOnFailure` is
      // `boolean | undefined` at the type level) — cast through `unknown` to
      // reach the untyped/dynamically-assembled runtime path this guards.
      const step = {
        ...makeStep({ id: "flaky-step" }),
        continueOnFailure: "false",
      } as unknown;
      const { problems } = captureProblems(() =>
        buildProcedure([step], [caseWithCondition(undefined)]),
      );
      const problem = problems.find(
        (candidate) => candidate.code === "ERR_PROCEDURE_INVALID_DECLARATION",
      );
      expect(problem?.message).toContain("continueOnFailure");
      expect(problem?.stepId).toBe("flaky-step");
    });

    test("a step with continueOnFailure absent builds successfully, defaulting to false", () => {
      const procedure = buildProcedure(
        [makeStep({ id: "a" })],
        [caseWithCondition(undefined)],
      );
      expect(procedure.describe().steps[0]?.continueOnFailure).toBe(false);
    });

    test("a step with continueOnFailure explicitly undefined builds successfully, defaulting to false", () => {
      const step = {
        ...makeStep({ id: "b" }),
        continueOnFailure: undefined,
      } as unknown;
      const procedure = buildProcedure([step], [caseWithCondition(undefined)]);
      expect(procedure.describe().steps[0]?.continueOnFailure).toBe(false);
    });

    test("a step declared with continueOnFailure: true (an actual boolean) builds successfully, preserving the value", () => {
      const procedure = buildProcedure(
        [makeStep({ id: "c", continueOnFailure: true })],
        [caseWithCondition(undefined)],
      );
      expect(procedure.describe().steps[0]?.continueOnFailure).toBe(true);
    });
  });
});
