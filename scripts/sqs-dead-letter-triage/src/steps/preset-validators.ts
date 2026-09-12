/**
 * @packageDocumentation
 * Generic field-reading and pattern-validation primitives for the DLQ triage
 * preset schema — a required/optional field reader, a regular-expression
 * safety/shape checker, and a handful of literal-union narrowers. None of
 * these know anything about the preset's nested shape (arms, cases, lookup
 * tiers, envelopes); they read one field, or validate one pattern, in
 * isolation. `load-runbook.ts`'s `parseEnvelope` and everything after it, by
 * contrast, know the preset's structure and compose these primitives to
 * build it. That is the real seam this module marks — not an arbitrary split
 * to satisfy the file-budget ceiling, though it does that too.
 */
import { Core } from "@m3l-automation/m3l-common";

import {
  AUTHORABLE_VERDICTS,
  HANDLING_MODES,
  MAX_PATTERN_LENGTH,
} from "./preset.js";
import type {
  TriageHandling,
  TriageOnMissing,
  TriageVerdict,
} from "./preset.js";

/**
 * The error code every preset trust-boundary rejection carries. Defined here
 * (rather than in `load-runbook.ts`, which re-exports it) because every
 * validator in this module throws with it, and `load-runbook.ts` importing
 * these validators would otherwise form an import cycle with the reverse
 * direction.
 */
export const PRESET_CODE = "ERR_DLQ_TRIAGE_PRESET";

/** Every value {@link TriageOnMissing} may take. */
const ON_MISSING_MODES = [
  "entity-not-found",
  "escalate",
  "hold",
] as const satisfies readonly TriageOnMissing[];

/** Reads a required numeric field, rejecting a missing or non-numeric value. */
export function requiredNumber(
  reader: Core.M3LInputFileReader,
  record: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): number {
  const value = reader.optionalNumberField(record, field);
  if (value === undefined) {
    throw new Core.M3LError(`'${label}.${field}' is required`, {
      code: PRESET_CODE,
    });
  }
  return value;
}

/**
 * The declared shape of a throwaway, single-step, single-case procedure used
 * only to run one pattern through the procedure engine's own `matches`
 * condition validation (`internal/procedure/validate/condition-literals.ts`'s
 * `isPatternSafe`). Never run — `build()` is the whole point, since it is
 * what performs the safety check.
 */
interface PatternProbeShape extends Core.M3LProcedureShape {
  deps: Record<string, never>;
  values: Record<string, never>;
  parameters: Record<string, never>;
  conclusion: void;
  stepId: "probe";
  caseId: "probe";
}

/**
 * Rejects a `capture` pattern the procedure engine's own safety check would
 * reject, by actually running it through that check rather than duplicating
 * it.
 *
 * `isPatternSafe` lives in `packages/m3l-common/src/internal/` and is not
 * exported — copying or reimplementing it here would drift the moment the
 * engine's own check changes. A `case.signature` pattern already gets this
 * check for free: it becomes a `matches` condition compiled into the
 * procedure's case table, which `build()` validates at `validate`/`explain`
 * time. A `capture` pattern never enters the condition tree — `extract-key`
 * runs it directly against the extracted key — so nothing else routes it
 * through the engine's check. Building a one-step, one-case throwaway
 * procedure whose sole case matches this pattern against a literal subject
 * reuses the real check with zero duplication: a `build()` rejection here
 * means the pattern is unsafe (or otherwise invalid), reported as a preset
 * problem naming `field` rather than as a hang inside `extract-key`.
 *
 * Do not "simplify" this into a local ReDoS heuristic — that is exactly the
 * duplication this function exists to avoid.
 */
export function requireSafeCapturePattern(
  pattern: string,
  field: string,
): void {
  try {
    Core.createProcedureBuilder<PatternProbeShape>("dlq-triage-pattern-probe")
      .step({
        id: "probe",
        label: "pattern-safety probe",
        kind: "control",
        execute: (): Core.M3LProcedureStepResult<PatternProbeShape> => ({
          flow: "continue",
        }),
      })
      .case({
        id: "probe",
        description: "pattern-safety probe",
        prose: "pattern-safety probe",
        priority: 1,
        condition: {
          kind: "matches",
          subject: { source: "literal", literal: "" },
          pattern,
        },
        action: (): void => undefined,
      })
      .build({
        description: "pattern-safety probe fallback",
        prose: "pattern-safety probe fallback",
        action: (): void => undefined,
      });
  } catch (cause) {
    throw new Core.M3LError(
      `'${field}' is rejected by the procedure engine's pattern-safety check (unsafe or otherwise invalid regular expression)`,
      { code: PRESET_CODE, cause },
    );
  }
}

/** Rejects `value` unless it is a compilable, length-bounded regular expression. */
function requirePattern(value: string, field: string): string {
  if (value.length > MAX_PATTERN_LENGTH) {
    throw new Core.M3LError(
      `'${field}' exceeds the ${String(MAX_PATTERN_LENGTH)}-character pattern limit`,
      { code: PRESET_CODE },
    );
  }
  try {
    // Compiled and discarded: the point is the SyntaxError, not the RegExp.
    new RegExp(value, "u");
  } catch (cause) {
    throw new Core.M3LError(`'${field}' is not a valid regular expression`, {
      code: PRESET_CODE,
      cause,
    });
  }
  return value;
}

/** Reads an optional pattern field, validating it when present. */
export function optionalPattern(
  reader: Core.M3LInputFileReader,
  record: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string | undefined {
  const value = reader.optionalStringField(record, field);
  return value === undefined ? undefined : requirePattern(value, label);
}

/**
 * Rejects a capture pattern that does not declare exactly one capture group.
 *
 * Counting `(` occurrences is wrong — non-capturing `(?:` and a character
 * class `(` both break it. Instead, executing the compiled pattern against
 * the empty string (with a trailing `|` alternative, which always matches
 * empty) yields a match array whose length minus one is the true capture
 * group count, independent of the pattern's internal syntax.
 */
export function requireSingleCaptureGroup(
  pattern: string,
  field: string,
): void {
  const match = new RegExp(`${pattern}|`, "u").exec("");
  const groupCount = match === null ? 0 : match.length - 1;
  if (groupCount !== 1) {
    throw new Core.M3LError(
      `'${field}' must declare exactly one capture group (found ${String(groupCount)})`,
      { code: PRESET_CODE },
    );
  }
}

/** Narrows an unknown array to `string[]`, rejecting any non-string element. */
export function toStringArray(
  values: readonly unknown[],
  field: string,
): readonly string[] {
  return values.map((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Core.M3LError(
        `'${field}[${String(index)}]' must be a non-empty string`,
        { code: PRESET_CODE },
      );
    }
    return value;
  });
}

/** Reads an optional `string[]` field, defaulting to an empty list. */
export function optionalStringArray(
  reader: Core.M3LInputFileReader,
  record: Readonly<Record<string, unknown>>,
  field: string,
): readonly string[] {
  const values = reader.optionalArrayField(record, field);
  return values === undefined ? [] : toStringArray(values, field);
}

/** Narrows a preset's `handling` field to one of {@link HANDLING_MODES}. */
export function parseHandling(value: string, field: string): TriageHandling {
  const match = HANDLING_MODES.find((mode) => mode === value);
  if (match === undefined) {
    throw new Core.M3LError(
      `'${field}' must be one of: ${HANDLING_MODES.join(", ")}`,
      { code: PRESET_CODE },
    );
  }
  return match;
}

/** Narrows an arm's `onMissing` field to one of {@link ON_MISSING_MODES}. */
export function parseOnMissing(value: string, field: string): TriageOnMissing {
  const match = ON_MISSING_MODES.find((mode) => mode === value);
  if (match === undefined) {
    throw new Core.M3LError(
      `'${field}' must be one of: ${ON_MISSING_MODES.join(", ")}`,
      { code: PRESET_CODE },
    );
  }
  return match;
}

/** Narrows a case row's `verdict` to one of {@link AUTHORABLE_VERDICTS}. */
export function parseVerdict(value: string, field: string): TriageVerdict {
  const match = AUTHORABLE_VERDICTS.find((verdict) => verdict === value);
  if (match === undefined) {
    throw new Core.M3LError(
      `'${field}' must be one of: ${AUTHORABLE_VERDICTS.join(", ")}`,
      { code: PRESET_CODE },
    );
  }
  return match;
}
