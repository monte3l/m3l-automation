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

import type { M3LProcedureSummary } from "../../core/procedure/build-types.js";
import type {
  M3LProcedureCondition,
  M3LProcedureShape,
} from "../../core/procedure/types.js";
import type { ValidatedProcedureDefinition } from "./validate/index.js";

/**
 * Recursively `Object.freeze`s `value` and every own-property value it
 * (transitively) holds — arrays included, since `Array.prototype` own
 * properties are just numeric-index own properties. Guards against
 * re-freezing (an already-frozen node, e.g. a shared string, is left as-is)
 * so this never throws on a value that has no own properties to recurse
 * into.
 *
 * @remarks
 * Used only on {@link M3LProcedureSummary}, whose leaves are strings,
 * numbers, booleans, `undefined`, plain objects, and arrays — never a
 * function or a class instance with getters — so a plain recursive
 * `Object.freeze` walk is sufficient and safe here.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Builds the exact serialisable projection {@link computeProcedureDigest}
 * hashes: the procedure name and `revision`; each step's id, label, kind,
 * `continueOnFailure`, `jumpsTo` and `loop`, in declaration order; each
 * case's id, description, prose, priority and condition, in declaration
 * order; the fallback's description and prose; the declared parameter
 * names, deduplicated and sorted.
 *
 * @param definition - The already-validated declaration
 *   {@link validateProcedureDefinition} confirmed carries zero problems.
 * @returns The summary `M3LProcedure.describe()` returns verbatim.
 */
export function buildProcedureSummary(
  definition: ValidatedProcedureDefinition,
): M3LProcedureSummary {
  const summary: M3LProcedureSummary = {
    name: definition.name,
    revision: definition.revision,
    steps: definition.steps.map((step) => ({
      id: step.id,
      label: step.label,
      // `M3LProcedureStepKind` is a closed string union at the type level;
      // `validateProcedureDefinition`'s `checkStepKindDeclaration` enforces
      // the runtime floor — "is a non-empty string" — before this projection
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
  // `M3LProcedure.describe()` returns this exact object on every call — deep
  // freezing here (rather than at the call site) guarantees no caller can
  // mutate `steps[n]`/`cases[n]`/`fallback`/a nested `loop` and have that
  // mutation persist across subsequent `describe()` calls.
  return deepFreeze(summary);
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
