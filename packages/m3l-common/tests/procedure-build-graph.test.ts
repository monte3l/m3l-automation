/**
 * Dedicated, exhaustive battery for `core/procedure` build-time cycle
 * detection (`internal/procedure/graph.ts`'s `findProcedureCycles`) and
 * `matches`-condition pattern safety (`internal/procedure/validate/
 * conditions.ts`'s `isPatternSafe`), per ADR-0046, ADR-0072 slice 2b
 * (issue #474, tracker B2).
 *
 * `procedure-build.test.ts` already carries one basic case of each for its
 * own aggregate-reporting purposes and explicitly defers full coverage here
 * — its own test titles say so. This file owns the exhaustive scenarios;
 * follows the same self-contained-fixture convention as its siblings
 * (`procedure-build-conditions.test.ts`): no cross-file import, per
 * `tests.md`'s per-slice-isolation rule.
 *
 * Contract source: docs/reference/core/procedure.md § Cycle detection,
 * § Build-time validation.
 *
 * No error class is exported from `core/procedure` — every failure is
 * asserted via `instanceof M3LError` plus the machine-readable `code`.
 */

import { describe, expect, test } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import {
  createProcedureBuilder,
  M3L_PROCEDURE_MAX_PATTERN_LENGTH,
  M3LProcedure,
} from "../src/core/procedure/index.js";
import type {
  M3LProcedureCondition,
  M3LProcedureFallback,
  M3LProcedureStep,
  M3LProcedureValidationProblem,
} from "../src/core/procedure/index.js";

// ---------------------------------------------------------------------------
// Self-contained fixture
// ---------------------------------------------------------------------------

interface TestShape {
  readonly deps: Record<string, never>;
  readonly values: { readonly label: string };
  readonly parameters: Record<string, never>;
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

const ALWAYS_TRUE_CONDITION: M3LProcedureCondition<TestShape> = {
  kind: "exists",
  subject: { source: "literal", literal: 0 },
};

function caseWithCondition(
  condition: M3LProcedureCondition<TestShape>,
  id = "case-under-test",
): unknown {
  return {
    id,
    description: id,
    prose: id,
    priority: 1,
    condition,
    action: () => ({ verdict: id }),
  };
}

const FALLBACK: M3LProcedureFallback<TestShape> = {
  description: "no case matched",
  prose: "Unrecognized pattern. Investigate.",
  action: () => ({ verdict: "unrecognized" }),
};

interface UntypedProcedureBuilder {
  step(step: unknown): UntypedProcedureBuilder;
  case(entry: unknown): UntypedProcedureBuilder;
  build(fallback: unknown, options?: unknown): M3LProcedure<TestShape>;
}

function buildProcedure(
  steps: readonly unknown[],
  cases: readonly unknown[] = [caseWithCondition(ALWAYS_TRUE_CONDITION)],
  name = "test-procedure",
): M3LProcedure<TestShape> {
  let builder = createProcedureBuilder<TestShape>(
    name,
  ) as unknown as UntypedProcedureBuilder;
  for (const step of steps) builder = builder.step(step);
  for (const entry of cases) builder = builder.case(entry);
  return builder.build(FALLBACK);
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

function cycleProblems(
  problems: readonly M3LProcedureValidationProblem[],
): readonly M3LProcedureValidationProblem[] {
  return problems.filter(
    (problem) => problem.code === "ERR_PROCEDURE_CYCLE_DETECTED",
  );
}

// ---------------------------------------------------------------------------

describe("core/procedure — cycle detection (slice 2b exhaustive battery)", () => {
  test("a 2-node cycle (a -> b -> a via jumpsTo, unannotated) is detected with the full path", () => {
    const { problems } = captureProblems(() =>
      buildProcedure([
        makeStep({ id: "a" }),
        makeStep({ id: "b", jumpsTo: ["a"] }),
      ]),
    );
    const cycles = cycleProblems(problems);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.path).toEqual(["a", "b", "a"]);
  });

  test("a self-loop (a step's own jumpsTo names itself, unannotated) is a cycle", () => {
    const { problems } = captureProblems(() =>
      buildProcedure([makeStep({ id: "a", jumpsTo: ["a"] })]),
    );
    const cycles = cycleProblems(problems);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.path).toEqual(["a", "a"]);
  });

  test("[near miss] the same self-loop WITH a loop annotation is not a cycle", () => {
    expect(() =>
      buildProcedure([
        makeStep({
          id: "a",
          jumpsTo: ["a"],
          loop: { maxRevisits: 3, reason: "deliberate re-gather" },
        }),
      ]),
    ).not.toThrow();
  });

  test("two independent, disjoint cycles in one definition both get reported, each under its own code", () => {
    const { problems } = captureProblems(() =>
      buildProcedure([
        makeStep({ id: "a" }),
        makeStep({ id: "b", jumpsTo: ["a"] }),
        makeStep({ id: "c" }),
        makeStep({ id: "d", jumpsTo: ["c"] }),
      ]),
    );
    const cycles = cycleProblems(problems);
    expect(cycles).toHaveLength(2);
    const paths = cycles.map((problem) => problem.path);
    expect(paths).toContainEqual(["a", "b", "a"]);
    expect(paths).toContainEqual(["c", "d", "c"]);
  });

  test("the same cycle discoverable via two duplicate jumpsTo back-edge entries is reported exactly once", () => {
    const { problems } = captureProblems(() =>
      buildProcedure([
        makeStep({ id: "a" }),
        makeStep({ id: "b", jumpsTo: ["a", "a"] }),
      ]),
    );
    const cycles = cycleProblems(problems);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.path).toEqual(["a", "b", "a"]);
  });

  test("[near miss] a diamond shape (two steps independently jumping forward to a shared later step) is not a cycle", () => {
    expect(() =>
      buildProcedure([
        makeStep({ id: "start", jumpsTo: ["left", "right"] }),
        makeStep({ id: "left", jumpsTo: ["end"] }),
        makeStep({ id: "right" }),
        makeStep({ id: "end" }),
      ]),
    ).not.toThrow();
  });

  test("building the identical cyclic definition twice independently reports the cycles in the same order both times", () => {
    function cyclicSteps(): AnyTestStep[] {
      return [
        makeStep({ id: "a" }),
        makeStep({ id: "b", jumpsTo: ["a"] }),
        makeStep({ id: "c" }),
        makeStep({ id: "d", jumpsTo: ["c"] }),
      ];
    }
    const first = captureProblems(() => buildProcedure(cyclicSteps()));
    const second = captureProblems(() => buildProcedure(cyclicSteps()));
    expect(
      cycleProblems(second.problems).map((problem) => problem.path),
    ).toEqual(cycleProblems(first.problems).map((problem) => problem.path));
  });

  test("a long chain of 20 steps with one back-edge near the end still resolves correctly (iterative DFS, no stack overflow)", () => {
    const stepCount = 20;
    const ids = Array.from(
      { length: stepCount },
      (_unused, index) => `step-${index}`,
    );
    const steps = ids.map((id, index) =>
      index === stepCount - 1
        ? makeStep({ id, jumpsTo: [ids[0] as string] })
        : makeStep({ id }),
    );
    const { problems } = captureProblems(() => buildProcedure(steps));
    const cycles = cycleProblems(problems);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.path).toHaveLength(stepCount + 1);
    expect(cycles[0]?.path?.[0]).toBe("step-0");
    expect(cycles[0]?.path?.at(-1)).toBe("step-0");
  });

  test("[near miss] the implicit sequential edge alone (no jumpsTo at all) never creates a false-positive cycle across a large step list", () => {
    const stepCount = 25;
    const steps = Array.from({ length: stepCount }, (_unused, index) =>
      makeStep({ id: `linear-${index}` }),
    );
    expect(() => buildProcedure(steps)).not.toThrow();
  });
});

describe("core/procedure — matches pattern safety (slice 2b exhaustive battery)", () => {
  function matchesCondition(pattern: string): M3LProcedureCondition<TestShape> {
    return {
      kind: "matches",
      subject: { source: "value", key: "label" },
      pattern,
    };
  }

  test("[near miss] a pattern exactly at M3L_PROCEDURE_MAX_PATTERN_LENGTH is safe", () => {
    const pattern = "a".repeat(M3L_PROCEDURE_MAX_PATTERN_LENGTH);
    expect(pattern).toHaveLength(M3L_PROCEDURE_MAX_PATTERN_LENGTH);
    expect(() =>
      buildProcedure(
        [makeStep({ id: "a" })],
        [caseWithCondition(matchesCondition(pattern))],
      ),
    ).not.toThrow();
  });

  test.each(["+", "*", "?", "{2}"])(
    "a group closed by ')' followed by quantifier '%s' is ERR_PROCEDURE_INVALID_PATTERN",
    (quantifier) => {
      const { problems } = captureProblems(() =>
        buildProcedure(
          [makeStep({ id: "a" })],
          [caseWithCondition(matchesCondition(`(a)${quantifier}`))],
        ),
      );
      expect(problems.map((problem) => problem.code)).toContain(
        "ERR_PROCEDURE_INVALID_PATTERN",
      );
    },
  );

  test("[near miss] an escaped \\) followed by a quantifier is not a quantified group", () => {
    expect(() =>
      buildProcedure(
        [makeStep({ id: "a" })],
        [caseWithCondition(matchesCondition("a\\)+"))],
      ),
    ).not.toThrow();
  });

  test("[near miss] a ) inside a [...] character class followed by a quantifier is not a quantified group", () => {
    expect(() =>
      buildProcedure(
        [makeStep({ id: "a" })],
        [caseWithCondition(matchesCondition("[)]+"))],
      ),
    ).not.toThrow();
  });

  test("a nested group's quantified close is still caught: (a(b)+)", () => {
    const { problems } = captureProblems(() =>
      buildProcedure(
        [makeStep({ id: "a" })],
        [caseWithCondition(matchesCondition("(a(b)+)"))],
      ),
    );
    expect(problems.map((problem) => problem.code)).toContain(
      "ERR_PROCEDURE_INVALID_PATTERN",
    );
  });

  test("an unterminated character class ('[abc') passes the quantified-group heuristic but fails to compile, still ERR_PROCEDURE_INVALID_PATTERN", () => {
    // Verified independently that `new RegExp("[abc")` throws (Node's own
    // regex compiler rejects it); asserting only build()'s behavior here to
    // avoid a static `no-invalid-regexp` eslint finding on a deliberately
    // malformed literal.
    const { problems } = captureProblems(() =>
      buildProcedure(
        [makeStep({ id: "a" })],
        [caseWithCondition(matchesCondition("[abc"))],
      ),
    );
    expect(problems.map((problem) => problem.code)).toContain(
      "ERR_PROCEDURE_INVALID_PATTERN",
    );
  });

  test("a well-formed, safe pattern builds successfully end-to-end and describe() reflects it unchanged", () => {
    const pattern = "^[a-z]+@[a-z]+\\.[a-z]{2,}$";
    const procedure = buildProcedure(
      [makeStep({ id: "a" })],
      [caseWithCondition(matchesCondition(pattern))],
    );
    expect(procedure).toBeInstanceOf(M3LProcedure);
    expect(procedure.describe().cases[0]?.condition).toMatchObject({
      kind: "matches",
      pattern,
    });
  });
});
