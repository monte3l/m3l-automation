/**
 * `internal/procedure/validate/structure` — the structural checks over the
 * step/case lists that don't require walking a condition tree: empty steps,
 * duplicate step/case ids, dangling jump targets, cycle detection, and
 * duplicate case priorities.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { findProcedureCycles } from "../graph.js";

import { DUPLICATE_THRESHOLD, problem } from "./shared.js";
import type {
  DuplicatableEntry,
  NormalizedCase,
  NormalizedStep,
} from "./shared.js";
import type { M3LProcedureValidationProblem } from "../../../core/procedure/build-types.js";

// ---------------------------------------------------------------------------
// 1. Empty steps
// ---------------------------------------------------------------------------

export function checkEmptySteps(
  steps: readonly unknown[],
): readonly M3LProcedureValidationProblem[] {
  if (steps.length > 0) return [];
  return [
    problem({
      code: "ERR_PROCEDURE_EMPTY_STEPS",
      message: "M3LProcedure: build() requires at least one declared step",
    }),
  ];
}

// ---------------------------------------------------------------------------
// 2 / 5. Duplicate step / case ids
// ---------------------------------------------------------------------------

/**
 * Every `rawId` that repeats across `entries`, each reported once
 * regardless of repeat count. Entries with no valid id are excluded before
 * grouping — two id-less entries share the sentinel `undefined` `rawId`, and
 * reporting that as a "duplicate id" would misreport a declaration problem
 * the per-entry check already covers under its own id, on top of a spurious
 * "two or more share the id undefined" finding.
 */
function findDuplicateEntries(
  entries: readonly DuplicatableEntry[],
): readonly DuplicatableEntry[] {
  const validEntries = entries.filter((entry) => entry.hasValidId);

  const counts = new Map<unknown, number>();
  for (const entry of validEntries) {
    counts.set(entry.rawId, (counts.get(entry.rawId) ?? 0) + 1);
  }

  const duplicates: DuplicatableEntry[] = [];
  const reported = new Set<unknown>();
  for (const entry of validEntries) {
    if (reported.has(entry.rawId)) continue;
    if ((counts.get(entry.rawId) ?? 0) <= 1) continue;
    reported.add(entry.rawId);
    duplicates.push(entry);
  }
  return duplicates;
}

export function checkDuplicateStepIds(
  steps: readonly DuplicatableEntry[],
): readonly M3LProcedureValidationProblem[] {
  return findDuplicateEntries(steps).map((entry) =>
    problem({
      code: "ERR_PROCEDURE_DUPLICATE_STEP_ID",
      message: `M3LProcedure: two or more steps share the id '${entry.id}'`,
      stepId: entry.id,
    }),
  );
}

export function checkDuplicateCaseIds(
  cases: readonly DuplicatableEntry[],
): readonly M3LProcedureValidationProblem[] {
  return findDuplicateEntries(cases).map((entry) =>
    problem({
      code: "ERR_PROCEDURE_DUPLICATE_CASE_ID",
      message: `M3LProcedure: two or more cases share the id '${entry.id}'`,
      caseId: entry.id,
    }),
  );
}

// ---------------------------------------------------------------------------
// 3. Invalid jump target
// ---------------------------------------------------------------------------

export function checkInvalidJumpTargets(
  steps: readonly NormalizedStep[],
  knownStepIds: ReadonlySet<string>,
): readonly M3LProcedureValidationProblem[] {
  const problems: M3LProcedureValidationProblem[] = [];
  for (const step of steps) {
    for (const target of step.jumpsTo) {
      if (knownStepIds.has(target)) continue;
      problems.push(
        problem({
          code: "ERR_PROCEDURE_INVALID_JUMP_TARGET",
          message: `M3LProcedure: step '${step.id}' has a jumpsTo entry naming an undeclared step '${target}'`,
          ...(step.hasValidId ? { stepId: step.id } : {}),
        }),
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 4. Cycle detection
// ---------------------------------------------------------------------------

export function checkCycles(
  steps: readonly NormalizedStep[],
): readonly M3LProcedureValidationProblem[] {
  const graphSteps = steps.map((step) => ({
    id: step.id,
    jumpsTo: step.jumpsTo,
    hasLoop: step.hasLoop,
  }));
  const cycles = findProcedureCycles(graphSteps);
  return cycles.map((path) => ({
    code: "ERR_PROCEDURE_CYCLE_DETECTED" as const,
    message: `M3LProcedure: cycle detected in the step graph: ${path
      .map((id) => `'${id}'`)
      .join(
        " -> ",
      )} (annotate the jumping step with \`loop\` if this repetition is deliberate)`,
    path,
  }));
}

// ---------------------------------------------------------------------------
// 6. Duplicate case priority
// ---------------------------------------------------------------------------

export function checkDuplicateCasePriorities(
  cases: readonly NormalizedCase[],
): readonly M3LProcedureValidationProblem[] {
  const byPriority = new Map<number, string[]>();
  for (const entry of cases) {
    if (!entry.hasValidPriority) continue;
    const list = byPriority.get(entry.priority) ?? [];
    list.push(entry.id);
    byPriority.set(entry.priority, list);
  }

  const problems: M3LProcedureValidationProblem[] = [];
  for (const [priority, ids] of byPriority) {
    if (ids.length < DUPLICATE_THRESHOLD) continue;
    problems.push(
      problem({
        code: "ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY",
        message: `M3LProcedure: cases share priority ${priority}: ${ids
          .map((id) => `'${id}'`)
          .join(", ")}`,
        caseIds: [...ids],
      }),
    );
  }
  return problems;
}
