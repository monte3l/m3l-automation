import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import {
  AUTHORABLE_VERDICTS,
  HANDLING_MODES,
  MAX_PATTERN_LENGTH,
  RESERVED_PRIORITY_CEILING,
} from "./preset.js";
import type {
  TriageArm,
  TriageCase,
  TriageEnvelope,
  TriageHandling,
  TriageKeyRule,
  TriageLookupTier,
  TriageOnMissing,
  TriagePreset,
  TriageStateMap,
  TriageVerdict,
} from "./preset.js";

/** The error code every preset trust-boundary rejection carries. */
export const PRESET_CODE = "ERR_DLQ_TRIAGE_PRESET";

/** The file extension a preset is recognised by inside the runbook directory. */
export const PRESET_EXTENSION = ".json";

/** Every value {@link TriageOnMissing} may take. */
const ON_MISSING_MODES = [
  "entity-not-found",
  "escalate",
  "hold",
] as const satisfies readonly TriageOnMissing[];

/** Reads a required numeric field, rejecting a missing or non-numeric value. */
function requiredNumber(
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
function requireSafeCapturePattern(pattern: string, field: string): void {
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
function optionalPattern(
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
function requireSingleCaptureGroup(pattern: string, field: string): void {
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
function toStringArray(
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
function optionalStringArray(
  reader: Core.M3LInputFileReader,
  record: Readonly<Record<string, unknown>>,
  field: string,
): readonly string[] {
  const values = reader.optionalArrayField(record, field);
  return values === undefined ? [] : toStringArray(values, field);
}

/** Narrows a preset's `handling` field to one of {@link HANDLING_MODES}. */
function parseHandling(value: string, field: string): TriageHandling {
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
function parseOnMissing(value: string, field: string): TriageOnMissing {
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
function parseVerdict(value: string, field: string): TriageVerdict {
  const match = AUTHORABLE_VERDICTS.find((verdict) => verdict === value);
  if (match === undefined) {
    throw new Core.M3LError(
      `'${field}' must be one of: ${AUTHORABLE_VERDICTS.join(", ")}`,
      { code: PRESET_CODE },
    );
  }
  return match;
}

/** Parses the envelope rule describing how to reach the message payload. */
function parseEnvelope(
  reader: Core.M3LInputFileReader,
  root: Readonly<Record<string, unknown>>,
  source: string,
): TriageEnvelope {
  const record = reader.requireRecord(
    reader.optionalRecordField(root, "envelope"),
    "envelope",
    source,
  );
  return {
    bodyIsJson: reader.optionalBooleanField(record, "bodyIsJson") ?? false,
    payloadPath: reader.optionalStringField(record, "payloadPath"),
  };
}

/** Parses an arm's key-extraction rule, validating a declared capture pattern. */
function parseKeyRule(
  reader: Core.M3LInputFileReader,
  root: Readonly<Record<string, unknown>>,
  field: string,
): TriageKeyRule {
  const record = reader.requireRecord(
    reader.optionalRecordField(root, "key"),
    "key",
    field,
  );
  const capture = optionalPattern(
    reader,
    record,
    "capture",
    `${field}.key.capture`,
  );
  if (capture !== undefined) {
    requireSingleCaptureGroup(capture, `${field}.key.capture`);
    requireSafeCapturePattern(capture, `${field}.key.capture`);
  }
  return {
    path: reader.requiredStringField(record, "path", `${field}.key`),
    stripPrefix: reader.optionalStringField(record, "stripPrefix"),
    addSuffix: reader.optionalStringField(record, "addSuffix"),
    capture,
  };
}

/** Parses one lookup tier, requiring non-empty `label`/`table`/`keyField`. */
function parseLookupTier(
  reader: Core.M3LInputFileReader,
  value: unknown,
  field: string,
): TriageLookupTier {
  const record = reader.asRecord(value, field);
  return {
    label: reader.requiredStringField(record, "label", field),
    table: reader.requiredStringField(record, "table", field),
    keyField: reader.requiredStringField(record, "keyField", field),
  };
}

/** Parses an arm's ordered lookup-tier fallback chain — at least one tier. */
function parseLookup(
  reader: Core.M3LInputFileReader,
  root: Readonly<Record<string, unknown>>,
  field: string,
): readonly TriageLookupTier[] {
  const values = reader.requiredArrayField(root, "lookup", field);
  return values.map((value, index) =>
    parseLookupTier(reader, value, `${field}.lookup[${String(index)}]`),
  );
}

/** Parses the state-field map an arm projects into `derive-state`. */
function parseStateMap(
  reader: Core.M3LInputFileReader,
  root: Readonly<Record<string, unknown>>,
  field: string,
): TriageStateMap {
  const record = reader.requireRecord(
    reader.optionalRecordField(root, "state"),
    "state",
    field,
  );
  return {
    fromState: reader.requiredStringField(
      record,
      "fromState",
      `${field}.state`,
    ),
    nextState: reader.requiredStringField(
      record,
      "nextState",
      `${field}.state`,
    ),
    progression: reader.optionalStringField(record, "progression"),
  };
}

/**
 * Rejects an empty-string predicate value, so it can never collide with the
 * "unresolved" sentinel `derive-state` normalises a missing/non-string
 * `fromState`/`nextState` to (`""`), or with the fixed, non-empty
 * `EVENT_TYPE_UNROUTABLE` sentinel `route-event` uses instead of `""` for
 * exactly this reason. An empty-string `fromState`, `nextState`, or
 * `eventType` would otherwise match every entity whose corresponding path
 * resolves nothing — e.g. a mistyped path — silently turning a narrow row
 * into a catch-all. Every other declared string in this schema already
 * rejects `""` via `M3LInputFileReader.requiredStringField`; this restores
 * that same discipline for the one family of fields (`TriageCase`'s optional
 * predicates) that reads through `optionalStringField` instead, which admits
 * `""`.
 */
function rejectEmptyPredicate(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === "") {
    throw new Core.M3LError(
      `'${field}' must not be an empty string — an empty predicate is not permitted; declare a concrete value`,
      { code: PRESET_CODE },
    );
  }
  return value;
}

/**
 * Rejects a case row that declares none of its five predicates — such a row
 * would match every message and shadow the arm's fallback.
 */
function requireAtLeastOnePredicate(
  triageCase: TriageCase,
  field: string,
): void {
  const hasPredicate =
    triageCase.fromState !== undefined ||
    triageCase.nextState !== undefined ||
    triageCase.eventType !== undefined ||
    triageCase.signature !== undefined ||
    triageCase.requiredProgression !== undefined;
  if (!hasPredicate) {
    throw new Core.M3LError(
      `'${field}' declares no predicate (fromState, nextState, eventType, signature, requiredProgression are all absent) and would match every message, shadowing the fallback`,
      { code: PRESET_CODE },
    );
  }
}
/** Reads and validates a case row's `priority` field: an integer above the reserved ceiling. */
function parseCasePriority(
  reader: Core.M3LInputFileReader,
  record: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const priority = requiredNumber(reader, record, "priority", field);
  if (!Number.isInteger(priority) || priority <= RESERVED_PRIORITY_CEILING) {
    throw new Core.M3LError(
      `'${field}.priority' must be an integer above ${String(RESERVED_PRIORITY_CEILING)} — priorities 1-${String(RESERVED_PRIORITY_CEILING)} are reserved for the codified terminal cases`,
      { code: PRESET_CODE },
    );
  }
  return priority;
}

/** The three optional string predicates a case row may declare directly (as opposed to `signature`/`requiredProgression`). */
interface CasePredicateFields {
  readonly fromState: string | undefined;
  readonly nextState: string | undefined;
  readonly eventType: string | undefined;
}

/**
 * Reads a case row's `fromState`/`nextState`/`eventType` predicates,
 * rejecting an empty string for each — see {@link rejectEmptyPredicate}.
 */
function parseCasePredicateFields(
  reader: Core.M3LInputFileReader,
  record: Readonly<Record<string, unknown>>,
  field: string,
): CasePredicateFields {
  return {
    fromState: rejectEmptyPredicate(
      reader.optionalStringField(record, "fromState"),
      `${field}.fromState`,
    ),
    nextState: rejectEmptyPredicate(
      reader.optionalStringField(record, "nextState"),
      `${field}.nextState`,
    ),
    eventType: rejectEmptyPredicate(
      reader.optionalStringField(record, "eventType"),
      `${field}.eventType`,
    ),
  };
}

/** Parses one arm's known-case row. */
function parseCase(
  reader: Core.M3LInputFileReader,
  value: unknown,
  armField: string,
  index: number,
): TriageCase {
  const field = `${armField}.cases[${String(index)}]`;
  const record = reader.asRecord(value, field);
  const priority = parseCasePriority(reader, record, field);
  const predicates = parseCasePredicateFields(reader, record, field);
  const requiredProgressionValues = reader.optionalArrayField(
    record,
    "requiredProgression",
  );
  const triageCase: TriageCase = {
    id: reader.requiredStringField(record, "id", field),
    description: reader.requiredStringField(record, "description", field),
    prose: reader.requiredStringField(record, "prose", field),
    priority,
    ...predicates,
    signature: optionalPattern(
      reader,
      record,
      "signature",
      `${field}.signature`,
    ),
    requiredProgression:
      requiredProgressionValues === undefined
        ? undefined
        : toStringArray(
            requiredProgressionValues,
            `${field}.requiredProgression`,
          ),
    verdict: parseVerdict(
      reader.requiredStringField(record, "verdict", field),
      `${field}.verdict`,
    ),
    ticket: reader.optionalStringField(record, "ticket"),
    resolution: reader.optionalStringField(record, "resolution"),
    escalateTo: reader.optionalStringField(record, "escalateTo"),
    followUps: optionalStringArray(reader, record, "followUps"),
  };
  requireAtLeastOnePredicate(triageCase, field);
  return triageCase;
}

/** Parses one event-type arm, including its own known-cases table. */
function parseArm(
  reader: Core.M3LInputFileReader,
  value: unknown,
  index: number,
): TriageArm {
  const field = `arms[${String(index)}]`;
  const record = reader.asRecord(value, field);
  return {
    match: reader.optionalStringField(record, "match"),
    label: reader.requiredStringField(record, "label", field),
    key: parseKeyRule(reader, record, field),
    lookup: parseLookup(reader, record, field),
    onMissing: parseOnMissing(
      reader.requiredStringField(record, "onMissing", field),
      `${field}.onMissing`,
    ),
    state: parseStateMap(reader, record, field),
    cases: (reader.optionalArrayField(record, "cases") ?? []).map(
      (caseValue, caseIndex) => parseCase(reader, caseValue, field, caseIndex),
    ),
  };
}

/**
 * Rejects more than one default arm (a `match === undefined` arm), any
 * duplicate `match` value across arms, and any duplicate `label` — including
 * the default arm's. Every preset-row case's isolation from every other
 * arm's cases depends on `armLabel` equality (`cases.ts`'s `armGuard`), which
 * is a plain string comparison — so two arms sharing a `label` (a
 * copy-paste when adding a second arm) would let one arm's rows match
 * messages routed to the other, regardless of how distinct their `match`
 * values are.
 */
function requireUniqueArms(arms: readonly TriageArm[]): void {
  const defaultArmIndexes = arms
    .map((arm, index) => (arm.match === undefined ? index : undefined))
    .filter((index): index is number => index !== undefined);
  if (defaultArmIndexes.length > 1) {
    throw new Core.M3LError(
      `'arms' declares ${String(defaultArmIndexes.length)} default arms (no 'match') at indexes ${defaultArmIndexes.join(", ")} — at most one default arm is allowed`,
      { code: PRESET_CODE },
    );
  }
  const seenAt = new Map<string, number>();
  arms.forEach((arm, index) => {
    if (arm.match === undefined) return;
    const firstIndex = seenAt.get(arm.match);
    if (firstIndex !== undefined) {
      throw new Core.M3LError(
        `'arms[${String(index)}].match' ('${arm.match}') duplicates 'arms[${String(firstIndex)}].match' — arm match values must be unique`,
        { code: PRESET_CODE },
      );
    }
    seenAt.set(arm.match, index);
  });
  const seenLabelAt = new Map<string, number>();
  arms.forEach((arm, index) => {
    const firstIndex = seenLabelAt.get(arm.label);
    if (firstIndex !== undefined) {
      throw new Core.M3LError(
        `'arms[${String(index)}].label' ('${arm.label}') duplicates 'arms[${String(firstIndex)}].label' — arm labels must be unique, since case-row isolation between arms depends on it`,
        { code: PRESET_CODE },
      );
    }
    seenLabelAt.set(arm.label, index);
  });
}

/**
 * Rejects a duplicate case `id` or `priority` anywhere across the whole
 * preset — both are scoped to the preset, not to the arm, because one
 * procedure is compiled per preset.
 */
function requireUniqueCases(arms: readonly TriageArm[]): void {
  const seenIds = new Map<string, string>();
  const seenPriorities = new Map<number, string>();
  arms.forEach((arm, armIndex) => {
    arm.cases.forEach((triageCase, caseIndex) => {
      const location = `arms[${String(armIndex)}].cases[${String(caseIndex)}]`;
      const idLocation = seenIds.get(triageCase.id);
      if (idLocation !== undefined) {
        throw new Core.M3LError(
          `'${location}.id' ('${triageCase.id}') duplicates the case id declared at '${idLocation}' — case ids must be unique across the whole preset`,
          { code: PRESET_CODE },
        );
      }
      seenIds.set(triageCase.id, location);
      const priorityId = seenPriorities.get(triageCase.priority);
      if (priorityId !== undefined) {
        throw new Core.M3LError(
          `'${location}' case '${triageCase.id}' claims priority ${String(triageCase.priority)}, already claimed by case '${priorityId}' — case priorities must be unique across the whole preset`,
          { code: PRESET_CODE },
        );
      }
      seenPriorities.set(triageCase.priority, triageCase.id);
    });
  });
}

/**
 * Validates an already-JSON-parsed preset record and narrows it to a
 * {@link TriagePreset}. This is the script's trust boundary: every field a
 * step later reads is checked here, so a malformed preset fails at load with
 * a message naming the offending field rather than mid-run with a
 * `TypeError`.
 *
 * `todos` is deliberately not rejected here even when non-empty — a
 * partially converted preset is `validate`'s failure to report, not the
 * loader's, so `explain` and `convert` can still work on it.
 *
 * @param reader - The `M3LInputFileReader` supplying the field accessors.
 * @param record - The parsed preset object.
 * @param source - The preset's origin, used in thrown messages.
 * @returns The validated preset.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_PRESET` for any
 *   missing, mistyped, out-of-range, or reserved field.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { parseTriagePreset } from "./load-runbook.js";
 *
 * const reader = new Core.M3LInputFileReader({
 *   paths: new Core.M3LPaths(),
 *   code: "ERR_DLQ_TRIAGE_PRESET",
 * });
 * const preset = parseTriagePreset(reader, { queue: "orders-dlq" }, "orders-dlq.json");
 * ```
 */
export function parseTriagePreset(
  reader: Core.M3LInputFileReader,
  record: Readonly<Record<string, unknown>>,
  source: string,
): TriagePreset {
  const preset: TriagePreset = {
    queue: reader.requiredStringField(record, "queue", source),
    title: reader.requiredStringField(record, "title", source),
    handling: parseHandling(
      reader.requiredStringField(record, "handling", source),
      "handling",
    ),
    prohibitions: optionalStringArray(reader, record, "prohibitions"),
    fifo: reader.optionalBooleanField(record, "fifo") ?? false,
    orderBy: reader.optionalStringField(record, "orderBy"),
    sourceQueue: reader.optionalStringField(record, "sourceQueue"),
    envelope: parseEnvelope(reader, record, source),
    routeOn: reader.requiredStringField(record, "routeOn", source),
    arms: reader
      .requiredArrayField(record, "arms", source)
      .map((value, index) => parseArm(reader, value, index)),
    escalateTo: reader.requiredStringField(record, "escalateTo", source),
    followUps: optionalStringArray(reader, record, "followUps"),
    todos: optionalStringArray(reader, record, "todos"),
  };
  requireUniqueArms(preset.arms);
  requireUniqueCases(preset.arms);
  return preset;
}

/**
 * Reads and validates one preset from `<runbookDir>/<queue>.json` beneath the
 * input directory.
 *
 * @param reader - The `M3LInputFileReader` bound to `M3L_INPUT_DIR`.
 * @param relativePath - The preset's path relative to the input directory.
 * @returns The validated preset.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_PRESET` when the file
 *   is unreadable, is not JSON, or fails validation.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { loadRunbook } from "./load-runbook.js";
 *
 * const reader = new Core.M3LInputFileReader({
 *   paths: new Core.M3LPaths(),
 *   code: "ERR_DLQ_TRIAGE_PRESET",
 * });
 * const preset = await loadRunbook(reader, "runbooks/orders-dlq.json");
 * ```
 */
export async function loadRunbook(
  reader: Core.M3LInputFileReader,
  relativePath: string,
): Promise<TriagePreset> {
  const record = await reader.readJSONRecord(relativePath);
  return parseTriagePreset(reader, record, relativePath);
}

/**
 * Lists every preset file in `runbookDir`, as paths relative to the input
 * directory, sorted so `validate` reports in a stable order.
 *
 * @param paths - The run's `M3LPaths`, anchoring `M3L_INPUT_DIR`.
 * @param runbookDir - The preset directory, relative to the input directory.
 * @returns The relative paths of every `.json` file directly inside it.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_PRESET` when the
 *   directory cannot be read.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { listRunbooks } from "./load-runbook.js";
 *
 * const names = await listRunbooks(new Core.M3LPaths(), "runbooks");
 * ```
 */
export async function listRunbooks(
  paths: Core.M3LPaths,
  runbookDir: string,
): Promise<readonly string[]> {
  const resolved = paths.resolveInput(runbookDir);
  let entries: readonly string[];
  try {
    entries = await fsp.readdir(resolved);
  } catch (cause) {
    throw new Core.M3LError(
      `failed reading runbook directory '${runbookDir}'`,
      { code: PRESET_CODE, cause },
    );
  }
  return entries
    .filter((entry) => entry.endsWith(PRESET_EXTENSION))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.posix.join(runbookDir, entry));
}
