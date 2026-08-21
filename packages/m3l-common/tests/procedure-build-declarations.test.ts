/**
 * Sibling test file for `core/procedure` (ADR-0046, ADR-0072 slice 2b,
 * issue #474/#576) — the dedicated, exhaustive battery of every distinct
 * `ERR_PROCEDURE_INVALID_DECLARATION` sub-case. `procedure-build.test.ts`
 * (slice 2a) tests this code exactly once for aggregate-reporting purposes
 * and explicitly defers full sub-case coverage here.
 *
 * Contract source: docs/reference/core/procedure.md § Build-time validation
 * — the per-problem-code table's `ERR_PROCEDURE_INVALID_DECLARATION` row
 * lists: an empty/non-string `id`/`label`/parameter name; a dangerous
 * parameter or `values` key; a duplicate parameter name; a non-finite/
 * non-number case `priority`; a `loop.maxRevisits` that is not a finite
 * integer > 0; a condition `literal` that is a non-finite number; a step
 * `execute`/case `action` that is not a function. Cross-referencing the
 * shipped source (`internal/procedure/validate/{normalize,index,
 * conditions}.ts`) against that row yields 17 distinct sub-cases, grouped
 * below by their owning module.
 *
 * Self-contained fixture, matching the sibling files' style but with no
 * cross-file import (`tests.md`'s per-slice-isolation rule).
 *
 * No error class is exported from `core/procedure` — every failure is
 * asserted via `instanceof M3LError` plus the machine-readable `code`.
 */

import { describe, expect, test } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import { createProcedureBuilder } from "../src/core/procedure/index.js";
import type {
  M3LProcedureBuildOptions,
  M3LProcedureCondition,
  M3LProcedureFallback,
  M3LProcedureReference,
  M3LProcedureStep,
  M3LProcedureValidationProblem,
} from "../src/core/procedure/index.js";

// ---------------------------------------------------------------------------
// Self-contained fixture
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

/** One valid reference per recognized `source`, used by the "recognized source" near-miss battery. */
function referenceForSource(
  source: "step" | "value" | "parameter" | "literal",
): M3LProcedureReference<TestShape> {
  switch (source) {
    case "step":
      return { source, step: "s" };
    case "value":
      return { source, key: "count" };
    case "parameter":
      return { source, key: "threshold" };
    case "literal":
      return { source, literal: 1 };
  }
}

function makeCase(
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

const ALWAYS_TRUE_CONDITION: M3LProcedureCondition<TestShape> = {
  kind: "exists",
  subject: { source: "literal", literal: 0 },
};

const FALLBACK: M3LProcedureFallback<TestShape> = {
  description: "no case matched",
  prose: "Unrecognized pattern. Investigate.",
  action: () => ({ verdict: "unrecognized" }),
};

interface UntypedProcedureBuilder {
  parameters(names: readonly string[]): UntypedProcedureBuilder;
  step(step: unknown): UntypedProcedureBuilder;
  case(entry: unknown): UntypedProcedureBuilder;
  build(fallback: unknown, options?: unknown): unknown;
}

/**
 * Same untyped-builder shape as the sibling files' `buildProcedure`, plus an
 * untyped `name` — several sub-cases here (the procedure name declaration)
 * are only reachable when the builder's own constructor argument, typed
 * `string` at compile time, carries a non-string value.
 */
function buildProcedure(
  steps: readonly unknown[],
  cases: readonly unknown[],
  options: {
    readonly name?: unknown;
    readonly fallback?: unknown;
    readonly buildOptions?: M3LProcedureBuildOptions;
    readonly declaredParameters?: readonly unknown[];
  } = {},
): unknown {
  const name = "name" in options ? options.name : "test-procedure";
  let builder = createProcedureBuilder<TestShape>(
    name as string,
  ) as unknown as UntypedProcedureBuilder;
  if (options.declaredParameters !== undefined) {
    builder = builder.parameters(
      options.declaredParameters as readonly string[],
    );
  }
  for (const step of steps) builder = builder.step(step);
  for (const entry of cases) builder = builder.case(entry);
  return builder.build(
    "fallback" in options ? options.fallback : FALLBACK,
    options.buildOptions,
  );
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

function declarationProblems(
  problems: readonly M3LProcedureValidationProblem[],
): readonly M3LProcedureValidationProblem[] {
  return problems.filter(
    (problem) => problem.code === "ERR_PROCEDURE_INVALID_DECLARATION",
  );
}

// ---------------------------------------------------------------------------

describe("core/procedure — ERR_PROCEDURE_INVALID_DECLARATION exhaustive sub-cases", () => {
  // ---------------------------------------------------------------------
  // internal/procedure/validate/normalize.ts (10 sub-cases)
  // ---------------------------------------------------------------------
  describe("1. step id — empty or non-string", () => {
    test.each([
      ["empty string", ""],
      ["a number", 42],
    ])("a step id that is %s is a problem", (_label, badId) => {
      const step = { ...makeStep({ id: "placeholder" }), id: badId };
      const { problems } = captureProblems(() =>
        buildProcedure([step], [makeCase(ALWAYS_TRUE_CONDITION)]),
      );
      expect(declarationProblems(problems).length).toBeGreaterThan(0);
    });

    test("[near miss] a non-empty string step id does not fire this problem", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "valid-id" })],
          [makeCase(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });
  });

  describe("2. step label — empty or non-string", () => {
    test.each([
      ["empty string", ""],
      ["a number", 7],
    ])(
      "a step label that is %s is a problem naming the stepId",
      (_label, badLabel) => {
        const step = { ...makeStep({ id: "s" }), label: badLabel };
        const { problems } = captureProblems(() =>
          buildProcedure([step], [makeCase(ALWAYS_TRUE_CONDITION)]),
        );
        const problem = declarationProblems(problems).find((candidate) =>
          candidate.message.includes("label"),
        );
        expect(problem?.stepId).toBe("s");
      },
    );

    test("[near miss] a non-empty string label does not fire this problem", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "s", label: "A label" })],
          [makeCase(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });
  });

  describe("3. step kind — empty or non-string", () => {
    test.each([
      ["empty string", ""],
      ["a boolean", true],
    ])(
      "a step kind that is %s is a problem naming the stepId",
      (_label, badKind) => {
        const step = { ...makeStep({ id: "s" }), kind: badKind };
        const { problems } = captureProblems(() =>
          buildProcedure([step], [makeCase(ALWAYS_TRUE_CONDITION)]),
        );
        const problem = declarationProblems(problems).find((candidate) =>
          candidate.message.includes("kind"),
        );
        expect(problem?.stepId).toBe("s");
      },
    );

    test("[near miss] a non-empty string kind does not fire this problem", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "s", kind: "gather" })],
          [makeCase(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });
  });

  describe("4. step loop.maxRevisits — not a finite integer greater than 0", () => {
    test.each([
      ["zero", 0],
      ["negative", -3],
      ["a non-integer", 2.5],
      ["non-finite", Number.POSITIVE_INFINITY],
      ["non-numeric", "two"],
    ])(
      "a loop.maxRevisits that is %s is a problem naming the stepId",
      (_label, badMaxRevisits) => {
        const step = {
          ...makeStep({ id: "s" }),
          loop: { maxRevisits: badMaxRevisits, reason: "retry" },
        };
        const { problems } = captureProblems(() =>
          buildProcedure([step], [makeCase(ALWAYS_TRUE_CONDITION)]),
        );
        const problem = declarationProblems(problems).find((candidate) =>
          candidate.message.includes("loop.maxRevisits"),
        );
        expect(problem?.stepId).toBe("s");
      },
    );

    test("[near miss] maxRevisits: 1 (the smallest valid boundary) does not fire this problem", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "s", loop: { maxRevisits: 1, reason: "retry" } })],
          [makeCase(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });
  });

  describe("5. step continueOnFailure — present but non-boolean", () => {
    test.each([
      ["the string 'false'", "false"],
      ["the number 0", 0],
      ["a plain object", {}],
    ])(
      "a continueOnFailure that is %s is a problem naming the stepId",
      (_label, badValue) => {
        const step = {
          ...makeStep({ id: "flaky" }),
          continueOnFailure: badValue,
        };
        const { problems } = captureProblems(() =>
          buildProcedure([step], [makeCase(ALWAYS_TRUE_CONDITION)]),
        );
        const problem = declarationProblems(problems).find((candidate) =>
          candidate.message.includes("continueOnFailure"),
        );
        expect(problem?.stepId).toBe("flaky");
      },
    );

    test.each([
      ["absent", undefined],
      ["null", null],
      ["explicit true", true],
      ["explicit false", false],
    ])(
      "[near miss] continueOnFailure %s does not fire this problem",
      (_label, okValue) => {
        const step =
          okValue === undefined
            ? makeStep({ id: "s" })
            : { ...makeStep({ id: "s" }), continueOnFailure: okValue };
        expect(() =>
          buildProcedure([step], [makeCase(ALWAYS_TRUE_CONDITION)]),
        ).not.toThrow();
      },
    );
  });

  describe("6. step execute — not a function", () => {
    test.each([
      ["undefined", undefined],
      ["a string", "not-a-function"],
    ])(
      "a step execute that is %s is a problem naming the stepId",
      (_label, badExecute) => {
        const step = { ...makeStep({ id: "s" }), execute: badExecute };
        const { problems } = captureProblems(() =>
          buildProcedure([step], [makeCase(ALWAYS_TRUE_CONDITION)]),
        );
        const problem = declarationProblems(problems).find((candidate) =>
          candidate.message.includes("execute"),
        );
        expect(problem?.stepId).toBe("s");
      },
    );

    test("[near miss] a function execute does not fire this problem", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "s", execute: () => ({ flow: "continue" }) })],
          [makeCase(ALWAYS_TRUE_CONDITION)],
        ),
      ).not.toThrow();
    });
  });

  describe("7. case id — empty or non-string", () => {
    test.each([
      ["empty string", ""],
      ["a number", 9],
    ])("a case id that is %s is a problem", (_label, badId) => {
      const badCase = {
        ...(makeCase(ALWAYS_TRUE_CONDITION, "placeholder") as object),
        id: badId,
      };
      const { problems } = captureProblems(() =>
        buildProcedure([makeStep({ id: "s" })], [badCase]),
      );
      expect(declarationProblems(problems).length).toBeGreaterThan(0);
    });

    test("[near miss] a non-empty string case id does not fire this problem", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "s" })],
          [makeCase(ALWAYS_TRUE_CONDITION, "valid-case")],
        ),
      ).not.toThrow();
    });
  });

  describe("8. case priority — not a finite number", () => {
    test.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["a string", "high"],
    ])(
      "a case priority that is %s is a problem naming the caseId",
      (_label, badPriority) => {
        const badCase = {
          ...(makeCase(ALWAYS_TRUE_CONDITION, "bad-priority") as object),
          priority: badPriority,
        };
        const { problems } = captureProblems(() =>
          buildProcedure([makeStep({ id: "s" })], [badCase]),
        );
        const problem = declarationProblems(problems).find((candidate) =>
          candidate.message.includes("priority"),
        );
        expect(problem?.caseId).toBe("bad-priority");
      },
    );

    test.each([
      ["zero", 0],
      ["negative", -5],
    ])(
      "[near miss] a finite priority that is %s does not fire this problem",
      (_label, okPriority) => {
        expect(() =>
          buildProcedure(
            [makeStep({ id: "s" })],
            [makeCase(ALWAYS_TRUE_CONDITION, "case", okPriority)],
          ),
        ).not.toThrow();
      },
    );
  });

  describe("9. case action — not a function", () => {
    test.each([
      ["undefined", undefined],
      ["a number", 1],
    ])(
      "a case action that is %s is a problem naming the caseId",
      (_label, badAction) => {
        const badCase = {
          ...(makeCase(ALWAYS_TRUE_CONDITION, "bad-action") as object),
          action: badAction,
        };
        const { problems } = captureProblems(() =>
          buildProcedure([makeStep({ id: "s" })], [badCase]),
        );
        const problem = declarationProblems(problems).find((candidate) =>
          candidate.message.includes("action"),
        );
        expect(problem?.caseId).toBe("bad-action");
      },
    );

    test("[near miss] a function action does not fire this problem", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "s" })],
          [makeCase(ALWAYS_TRUE_CONDITION, "case")],
        ),
      ).not.toThrow();
    });
  });

  describe("10. build() options.revision — not a string, not undefined", () => {
    test.each([
      ["a bigint", 10n],
      ["NaN", Number.NaN],
      ["a plain object", { rev: 1 }],
    ])(
      "[untyped path] a revision that is %s is a problem, not a leaked/uncoded error",
      (_label, badRevision) => {
        const { problems } = captureProblems(() =>
          buildProcedure(
            [makeStep({ id: "s" })],
            [makeCase(ALWAYS_TRUE_CONDITION)],
            {
              buildOptions: {
                revision: badRevision,
              } as unknown as M3LProcedureBuildOptions,
            },
          ),
        );
        expect(declarationProblems(problems).length).toBeGreaterThan(0);
      },
    );

    test.each([
      ["a valid string", "r1"],
      ["omitted (undefined)", undefined],
    ])(
      "[near miss] a revision that is %s does not fire this problem",
      (_label, okRevision) => {
        expect(() =>
          buildProcedure(
            [makeStep({ id: "s" })],
            [makeCase(ALWAYS_TRUE_CONDITION)],
            {
              buildOptions: {
                revision: okRevision,
              } as M3LProcedureBuildOptions,
            },
          ),
        ).not.toThrow();
      },
    );
  });

  // ---------------------------------------------------------------------
  // internal/procedure/validate/index.ts (4 sub-cases)
  // ---------------------------------------------------------------------
  describe("11. procedure name — empty or non-string", () => {
    test.each([
      ["empty string", ""],
      ["a number", 42],
      ["undefined", undefined],
    ])(
      "[untyped path] a procedure name that is %s is a problem",
      (_label, badName) => {
        const { problems } = captureProblems(() =>
          buildProcedure(
            [makeStep({ id: "s" })],
            [makeCase(ALWAYS_TRUE_CONDITION)],
            { name: badName },
          ),
        );
        const problem = declarationProblems(problems).find((candidate) =>
          candidate.message.includes("procedure name"),
        );
        expect(problem).toBeDefined();
      },
    );

    test("[near miss] a non-empty string name does not fire this problem", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "s" })],
          [makeCase(ALWAYS_TRUE_CONDITION)],
          { name: "a-real-name" },
        ),
      ).not.toThrow();
    });
  });

  describe("12. .parameters() — a declared name that is not a non-empty string", () => {
    test.each([
      ["empty string", ""],
      ["a number", 5],
    ])(
      "[untyped path] a declared parameter name that is %s is a problem",
      (_label, badName) => {
        const { problems } = captureProblems(() =>
          buildProcedure(
            [makeStep({ id: "s" })],
            [makeCase(ALWAYS_TRUE_CONDITION)],
            { declaredParameters: [badName] },
          ),
        );
        const problem = declarationProblems(problems).find((candidate) =>
          candidate.message.includes("parameter name"),
        );
        expect(problem).toBeDefined();
      },
    );

    test("[near miss] a non-empty string parameter name does not fire this problem", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "s" })],
          [makeCase(ALWAYS_TRUE_CONDITION)],
          { declaredParameters: ["threshold"] },
        ),
      ).not.toThrow();
    });
  });

  describe("13. .parameters() — a dangerous key (__proto__/constructor/prototype)", () => {
    test.each(["__proto__", "constructor", "prototype"])(
      "a declared parameter name '%s' is a problem",
      (dangerousName) => {
        const { problems } = captureProblems(() =>
          buildProcedure(
            [makeStep({ id: "s" })],
            [makeCase(ALWAYS_TRUE_CONDITION)],
            { declaredParameters: [dangerousName] },
          ),
        );
        const problem = declarationProblems(problems).find((candidate) =>
          candidate.message.includes("not a safe parameter name"),
        );
        expect(problem).toBeDefined();
      },
    );

    test("[near miss] an ordinary, non-dangerous parameter name does not fire this problem", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "s" })],
          [makeCase(ALWAYS_TRUE_CONDITION)],
          { declaredParameters: ["threshold"] },
        ),
      ).not.toThrow();
    });
  });

  describe("14. .parameters() — a name declared more than once", () => {
    test("a parameter name repeated three times is reported exactly once, not once per repeat", () => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "s" })],
          [makeCase(ALWAYS_TRUE_CONDITION)],
          { declaredParameters: ["threshold", "threshold", "threshold"] },
        ),
      );
      const duplicateProblems = declarationProblems(problems).filter(
        (candidate) => candidate.message.includes("declared more than once"),
      );
      expect(duplicateProblems).toHaveLength(1);
    });

    test("[near miss] all-distinct declared parameter names do not fire this problem", () => {
      expect(() =>
        buildProcedure(
          [makeStep({ id: "s" })],
          [makeCase(ALWAYS_TRUE_CONDITION)],
          { declaredParameters: ["threshold", "other"] },
        ),
      ).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------
  // internal/procedure/validate/conditions.ts (3 sub-cases)
  // ---------------------------------------------------------------------
  describe("15. condition reference — an unrecognized 'source'", () => {
    test("a reference source outside step/value/parameter/literal is a problem naming it", () => {
      const condition = {
        kind: "exists",
        subject: { source: "typo-source" },
      } as unknown as M3LProcedureCondition<TestShape>;
      const { problems } = captureProblems(() =>
        buildProcedure([makeStep({ id: "s" })], [makeCase(condition)]),
      );
      const problem = declarationProblems(problems).find((candidate) =>
        candidate.message.includes("typo-source"),
      );
      expect(problem).toBeDefined();
    });

    test.each(["step", "value", "parameter", "literal"] as const)(
      "[near miss] the recognized source '%s' does not fire this problem",
      (source) => {
        const subject: M3LProcedureReference<TestShape> =
          referenceForSource(source);
        const condition: M3LProcedureCondition<TestShape> = {
          kind: "exists",
          subject,
        };
        expect(() =>
          buildProcedure([makeStep({ id: "s" })], [makeCase(condition)], {
            declaredParameters: ["threshold"],
          }),
        ).not.toThrow();
      },
    );
  });

  describe("16. condition's 'parameter' reference — a dangerous key", () => {
    test.each(["__proto__", "constructor", "prototype"])(
      "a parameter reference key '%s' is a problem, distinct from the .parameters()-declaration call site",
      (dangerousKey) => {
        const condition = {
          kind: "exists",
          subject: { source: "parameter", key: dangerousKey },
        } as unknown as M3LProcedureCondition<TestShape>;
        const { problems } = captureProblems(() =>
          buildProcedure([makeStep({ id: "s" })], [makeCase(condition)]),
        );
        const problem = declarationProblems(problems).find((candidate) =>
          candidate.message.includes("dangerous parameter key"),
        );
        expect(problem).toBeDefined();
      },
    );

    test("[near miss] a safe, declared parameter reference key does not fire this problem", () => {
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        subject: { source: "parameter", key: "threshold" },
      };
      expect(() =>
        buildProcedure([makeStep({ id: "s" })], [makeCase(condition)], {
          declaredParameters: ["threshold"],
        }),
      ).not.toThrow();
    });
  });

  describe("17. condition node — an unrecognized 'kind'", () => {
    test("a condition kind outside compare/matches/contains/exists/and/or/not is a problem naming it", () => {
      const condition = {
        kind: "typo-kind",
      } as unknown as M3LProcedureCondition<TestShape>;
      const { problems } = captureProblems(() =>
        buildProcedure([makeStep({ id: "s" })], [makeCase(condition)]),
      );
      const problem = declarationProblems(problems).find((candidate) =>
        candidate.message.includes("typo-kind"),
      );
      expect(problem).toBeDefined();
    });

    test.each([
      "compare",
      "matches",
      "contains",
      "exists",
      "and",
      "or",
      "not",
    ] as const)(
      "[near miss] the recognized kind '%s' does not fire this problem",
      (kind) => {
        const literalRef = { source: "literal", literal: 1 } as const;
        const condition: unknown =
          kind === "compare"
            ? { kind, left: literalRef, operator: "==", right: literalRef }
            : kind === "matches"
              ? { kind, subject: literalRef, pattern: "a" }
              : kind === "contains"
                ? { kind, subject: literalRef, item: literalRef }
                : kind === "exists"
                  ? { kind, subject: literalRef }
                  : kind === "and" || kind === "or"
                    ? { kind, operands: [ALWAYS_TRUE_CONDITION] }
                    : { kind, operand: ALWAYS_TRUE_CONDITION };
        expect(() =>
          buildProcedure([makeStep({ id: "s" })], [makeCase(condition)]),
        ).not.toThrow();
      },
    );
  });
});
