/**
 * `internal/procedure/validate/shared` — the raw-input/validated-output
 * shapes and the two field-safe primitives (`field`, `problem`) every other
 * `validate/*` module builds on.
 *
 * Split out of a single `validate.ts` purely to stay under the per-file byte
 * ceiling (`check:file-budget`) — see `validate/index.ts`'s module doc for
 * the full validation contract and its "read exactly once" invariant.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import type { M3LProcedureValidationProblem } from "../../../core/procedure/build-types.js";

/**
 * Keys that never resolve as a reference segment or a declared name — a
 * `__proto__`, `constructor` or `prototype` value/parameter key is refused
 * unconditionally, mirroring `internal/procedure/resolve.ts`'s path-walk
 * rule (a later slice).
 */
export const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** The minimum repeat count that makes an id/priority "duplicated". */
export const DUPLICATE_THRESHOLD = 2;

/** Safe own-property reader over an `unknown` — an untyped caller's raw declaration may be anything. */
export function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

/** The `stepId`/`caseId`/`path`/`caseIds` context {@link problem} may attach. */
export type ProblemContext = Readonly<
  Partial<
    Pick<
      M3LProcedureValidationProblem,
      "stepId" | "caseId" | "path" | "caseIds"
    >
  >
>;

/**
 * Builds one {@link M3LProcedureValidationProblem} from a single named
 * `fields` object, so every call site literally contains a `code: "ERR_…"`
 * property — the drift guard in `tests/errors.test.ts` scans `src/**\/*.ts`
 * as text for that exact shape, and a positional `problem(code, message)`
 * call hides the code from it (registered-but-unemitted false positive). An
 * omitted `stepId`/`caseId`/`path` is never spread as an explicit
 * `undefined` on the returned object — `exactOptionalPropertyTypes` rejects
 * that on the target interface's optional fields — so a caller that doesn't
 * have one either leaves the key out entirely or spreads a conditional
 * `{ stepId: id } : {}` in.
 */
export function problem(
  fields: {
    readonly code: M3LProcedureValidationProblem["code"];
    readonly message: string;
  } & ProblemContext,
): M3LProcedureValidationProblem {
  return fields;
}

// ---------------------------------------------------------------------------
// Raw input this module validates
// ---------------------------------------------------------------------------

/** The raw, not-yet-validated pieces `M3LProcedureBuilder.build()` hands to this module. */
export interface RawProcedureInput {
  readonly name: unknown;
  readonly steps: readonly unknown[];
  readonly cases: readonly unknown[];
  readonly fallback: unknown;
  /** Declared via `M3LProcedureBuilder.parameters()`; empty when never called. */
  readonly declaredParameters: readonly string[];
  /**
   * Not yet type-checked at this boundary — an untyped/JS caller can pass
   * anything through `M3LProcedureBuildOptions.revision`. Validated to
   * `string | undefined` by `normalizeRevision` before it ever reaches
   * {@link ValidatedProcedureDefinition.revision} or the digest projection.
   */
  readonly revision: unknown;
}

/**
 * One summary-projection step, already validated — see `M3LProcedureSummary`.
 * Carries the raw (possibly-invalid, already function-checked) `execute`/
 * `describeTrace` references captured exactly once during normalization, so
 * `M3LProcedureBuilder` never re-reads the caller's raw step object for them
 * — the R3/R4 validate-then-re-read fix.
 */
interface ValidatedStepProjection {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly continueOnFailure: boolean;
  readonly jumpsTo: readonly string[];
  readonly loop:
    { readonly reason: string; readonly maxRevisits: number } | undefined;
  /** Confirmed `typeof … === "function"` by normalization. */
  readonly execute: unknown;
  /** Captured once; validated again at run time (a slice-3 concern). */
  readonly describeTrace: unknown;
}

/**
 * One summary-projection case, already validated — see `M3LProcedureSummary`.
 * Carries the raw (already function-checked) `action` reference captured
 * exactly once during normalization — see {@link ValidatedStepProjection}.
 */
interface ValidatedCaseProjection {
  readonly id: string;
  readonly description: string;
  readonly prose: string;
  readonly priority: number;
  readonly condition: unknown;
  /** Confirmed `typeof … === "function"` by normalization. */
  readonly action: unknown;
}

/** The validated pieces this module hands back once zero problems were found. */
export interface ValidatedProcedureDefinition {
  readonly name: string;
  readonly revision: string | undefined;
  readonly steps: readonly ValidatedStepProjection[];
  readonly cases: readonly ValidatedCaseProjection[];
  readonly fallback: { readonly description: string; readonly prose: string };
  readonly parameters: readonly string[];
}

/**
 * The result of {@link validateProcedureDefinition}: either every problem
 * found, or the validated definition alongside the fallback's `action` —
 * read exactly once, during normalization, and never re-read off the
 * caller's fallback object afterward.
 */
export type ProcedureValidationOutcome =
  | {
      readonly kind: "invalid";
      readonly problems: readonly M3LProcedureValidationProblem[];
    }
  | {
      readonly kind: "valid";
      readonly definition: ValidatedProcedureDefinition;
      readonly fallbackAction: unknown;
    };

// ---------------------------------------------------------------------------
// Normalized (pre-projection) internal shapes shared by normalize.ts,
// structure.ts and conditions.ts
// ---------------------------------------------------------------------------

/** One step's normalized `loop` fields. */
export interface NormalizedLoop {
  readonly hasLoop: boolean;
  readonly loop:
    { readonly reason: string; readonly maxRevisits: number } | undefined;
  /** `true` when `loop` is absent — there is then nothing to flag. */
  readonly isValidMaxRevisits: boolean;
}

/** One raw step, normalized: every field read exactly once and validated. */
export interface NormalizedStep {
  readonly index: number;
  readonly rawId: unknown;
  readonly id: string;
  readonly hasValidId: boolean;
  readonly label: string;
  readonly kind: string;
  readonly continueOnFailure: boolean;
  readonly jumpsTo: readonly string[];
  readonly hasLoop: boolean;
  readonly loop:
    { readonly reason: string; readonly maxRevisits: number } | undefined;
  /** Read once here; never re-read off the caller's step object afterward. */
  readonly execute: unknown;
  /** Read once here; never re-read off the caller's step object afterward. */
  readonly describeTrace: unknown;
  readonly declarationProblems: readonly M3LProcedureValidationProblem[];
}

/** One raw case, normalized: every field read exactly once and validated. */
export interface NormalizedCase {
  readonly index: number;
  readonly rawId: unknown;
  readonly id: string;
  readonly hasValidId: boolean;
  readonly description: string;
  readonly prose: string;
  readonly priority: number;
  readonly hasValidPriority: boolean;
  readonly condition: unknown;
  /** Read once here; never re-read off the caller's case object afterward. */
  readonly action: unknown;
  readonly declarationProblems: readonly M3LProcedureValidationProblem[];
}

/** The fallback, normalized: every field read exactly once and validated. */
export interface NormalizedFallback {
  /** Read exactly once here; never re-read off the caller's fallback object afterward. */
  readonly action: unknown;
  readonly description: string;
  readonly prose: string;
  readonly declarationProblems: readonly M3LProcedureValidationProblem[];
}

/** One entry a duplicate-id scan can group by `rawId`. */
export interface DuplicatableEntry {
  readonly rawId: unknown;
  readonly id: string;
  readonly hasValidId: boolean;
}
