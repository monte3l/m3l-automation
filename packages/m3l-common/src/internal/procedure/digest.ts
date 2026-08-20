/**
 * `internal/procedure/digest` — projects a validated procedure declaration
 * into the serialisable `M3LProcedureSummary` `M3LProcedure.describe()`
 * returns, and hashes it with `canonicalJsonHash` for `M3LProcedure.digest`.
 *
 * Two things are deliberately outside the projection: handler *bodies*
 * (functions are not canonical-JSON serialisable — `M3LProcedureBuildOptions.revision`
 * is the author's lever for "the declared shape is unchanged but the
 * behaviour is not") and parameter *values* (`digest` identifies the
 * procedure; a run's `parametersDigest` identifies its inputs).
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { canonicalJsonHash } from "../../core/json/index.js";

import type {
  M3LProcedureCondition,
  M3LProcedureShape,
  M3LProcedureSummary,
} from "../../core/procedure/types.js";
import type { ValidatedProcedureDefinition } from "./validate.js";

/**
 * Builds the exact serialisable projection {@link computeProcedureDigest}
 * hashes: the procedure name and `revision`; each step's id, label, kind,
 * `continueOnFailure`, `jumpsTo` and `loop`, in declaration order; each
 * case's id, description, prose, priority and condition, in declaration
 * order; the fallback's description and prose; the declared parameter
 * names, deduplicated and sorted.
 *
 * @param definition - The already-validated declaration
 *   {@link collectProcedureProblems} confirmed carries zero problems.
 * @returns The summary `M3LProcedure.describe()` returns verbatim.
 */
export function buildProcedureSummary(
  definition: ValidatedProcedureDefinition,
): M3LProcedureSummary {
  return {
    name: definition.name,
    revision: definition.revision,
    steps: definition.steps.map((step) => ({
      id: step.id,
      label: step.label,
      // `M3LProcedureStepKind` is a closed string union at the type level;
      // `collectProcedureProblems`'s `checkStepKindDeclaration` enforces the
      // runtime floor — "is a non-empty string" — before this projection
      // ever runs, so an untyped caller's malformed `kind` is already an
      // `ERR_PROCEDURE_INVALID_DECLARATION` problem and never reaches here.
      // The cast below only recovers the type-level literal union from a
      // value already known to be a validated string.
      kind: step.kind as M3LProcedureSummary["steps"][number]["kind"],
      continueOnFailure: step.continueOnFailure,
      jumpsTo: step.jumpsTo,
      loop: step.loop,
    })),
    cases: definition.cases.map((entry) => ({
      id: entry.id,
      description: entry.description,
      prose: entry.prose,
      priority: entry.priority,
      condition: entry.condition as M3LProcedureCondition<M3LProcedureShape>,
    })),
    fallback: definition.fallback,
    parameters: [...new Set(definition.parameters)].sort(),
  };
}

/**
 * Hashes a {@link M3LProcedureSummary} with `canonicalJsonHash` — the same
 * hash `M3LProcedure.digest` carries and `M3LProcedure.describe()` returns
 * the exact input of.
 *
 * @param summary - The projection {@link buildProcedureSummary} produced.
 * @returns The lowercase hex-encoded SHA-256 digest.
 */
export function computeProcedureDigest(summary: M3LProcedureSummary): string {
  return canonicalJsonHash(summary);
}
