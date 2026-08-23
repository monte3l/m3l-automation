import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import {
  AUTHORABLE_VERDICTS,
  RESERVED_PRIORITY_CEILING,
  SAFE_QUERY_VALUE,
} from "./preset.js";
import type {
  AnalysisVerdict,
  RunbookAuthorizerStage,
  RunbookCase,
  RunbookCorrelation,
  RunbookPreset,
  RunbookQueryStage,
  RunbookSignature,
  RunbookTraceLevel,
  RunbookUnsupported,
  RunbookWindow,
} from "./preset.js";

/** The error code every preset trust-boundary rejection carries. */
export const PRESET_CODE = "ERR_LOGS_ANALYSIS_PRESET";

/** The file extension a preset is recognised by inside the runbook directory. */
export const PRESET_EXTENSION = ".json";

const DEFAULT_LEAD_MINUTES = 5;
const DEFAULT_LAG_MINUTES = 15;
/** Mirrors `Core.M3L_PROCEDURE_MAX_PATTERN_LENGTH`, checked here so an oversized
 *  pattern is reported as a preset problem rather than a build-time one. */
const MAX_PATTERN_LENGTH = 512;

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

/**
 * Rejects a severity rung that is not safe to substitute into a query.
 *
 * A rung is interpolated verbatim into the entry query wherever
 * `severityPlaceholder` appears, so it reaches the same substitution boundary
 * the extracted correlation key does and is held to the same
 * {@link SAFE_QUERY_VALUE} allow-list. Checked here, at the trust boundary,
 * so the message names the preset field.
 */
function requireSafeLadder(rungs: readonly string[]): readonly string[] {
  for (const [index, rung] of rungs.entries()) {
    if (!SAFE_QUERY_VALUE.test(rung)) {
      throw new Core.M3LError(
        `'severityLadder[${String(index)}]' is substituted into the entry query and must contain only word characters, '.', ':', '/', '@', '#', '=', '+' or '-'`,
        { code: PRESET_CODE },
      );
    }
  }
  return rungs;
}

/** Parses the `logGroups`/`query`/`limit` triple every query stage shares. */
function parseQueryStage(
  reader: Core.M3LInputFileReader,
  record: Readonly<Record<string, unknown>>,
  field: string,
): RunbookQueryStage {
  return {
    logGroups: toStringArray(
      reader.requiredArrayField(record, "logGroups", field),
      `${field}.logGroups`,
    ),
    query: reader.requiredStringField(record, "query", field),
    limit: reader.optionalNumberField(record, "limit"),
  };
}

/** Parses the optional authorizer hop. */
function parseAuthorizer(
  reader: Core.M3LInputFileReader,
  root: Readonly<Record<string, unknown>>,
): RunbookAuthorizerStage | undefined {
  const record = reader.optionalRecordField(root, "authorizer");
  if (record === undefined) return undefined;
  return {
    ...parseQueryStage(reader, record, "authorizer"),
    latencyField: reader.requiredStringField(
      record,
      "latencyField",
      "authorizer",
    ),
    latencyThresholdMs: requiredNumber(
      reader,
      record,
      "latencyThresholdMs",
      "authorizer",
    ),
  };
}

/** Parses the optional trace chain, innermost hop last. */
function parseTrace(
  reader: Core.M3LInputFileReader,
  root: Readonly<Record<string, unknown>>,
): readonly RunbookTraceLevel[] {
  const levels = reader.optionalArrayField(root, "trace");
  if (levels === undefined) return [];
  return levels.map((level, index) => {
    const field = `trace[${String(index)}]`;
    const record = reader.asRecord(level, field);
    return {
      ...parseQueryStage(reader, record, field),
      label: reader.requiredStringField(record, "label", field),
      rekeyPattern: optionalPattern(
        reader,
        record,
        "rekeyPattern",
        `${field}.rekeyPattern`,
      ),
    };
  });
}

/** Parses the correlation-key extraction rule. */
function parseCorrelation(
  reader: Core.M3LInputFileReader,
  root: Readonly<Record<string, unknown>>,
): RunbookCorrelation | undefined {
  const record = reader.optionalRecordField(root, "correlation");
  if (record === undefined) return undefined;
  return {
    field: reader.requiredStringField(record, "field", "correlation"),
    pattern: requirePattern(
      reader.requiredStringField(record, "pattern", "correlation"),
      "correlation.pattern",
    ),
    label: reader.requiredStringField(record, "label", "correlation"),
  };
}

/** Parses the error-signature derivation rule. */
function parseSignature(
  reader: Core.M3LInputFileReader,
  root: Readonly<Record<string, unknown>>,
): RunbookSignature | undefined {
  const record = reader.optionalRecordField(root, "signature");
  if (record === undefined) return undefined;
  return {
    field: reader.requiredStringField(record, "field", "signature"),
    pattern: optionalPattern(reader, record, "pattern", "signature.pattern"),
    levelField: reader.optionalStringField(record, "levelField"),
    serviceField: reader.optionalStringField(record, "serviceField"),
  };
}

/** Parses the window offsets, defaulting to the fleet-standard ±5/15 minutes. */
function parseWindow(
  reader: Core.M3LInputFileReader,
  root: Readonly<Record<string, unknown>>,
): RunbookWindow {
  const record = reader.optionalRecordField(root, "window");
  if (record === undefined) {
    return {
      leadMinutes: DEFAULT_LEAD_MINUTES,
      lagMinutes: DEFAULT_LAG_MINUTES,
    };
  }
  return {
    leadMinutes:
      reader.optionalNumberField(record, "leadMinutes") ?? DEFAULT_LEAD_MINUTES,
    lagMinutes:
      reader.optionalNumberField(record, "lagMinutes") ?? DEFAULT_LAG_MINUTES,
  };
}

/** Parses the out-of-scope declaration, when the preset carries one. */
function parseUnsupported(
  reader: Core.M3LInputFileReader,
  root: Readonly<Record<string, unknown>>,
): RunbookUnsupported | undefined {
  const record = reader.optionalRecordField(root, "unsupported");
  if (record === undefined) return undefined;
  return {
    reason: reader.requiredStringField(record, "reason", "unsupported"),
    manualSteps: optionalStringArray(reader, record, "manualSteps"),
  };
}

/** Narrows a preset row's `verdict` to one of {@link AUTHORABLE_VERDICTS}. */
function parseVerdict(value: string, field: string): AnalysisVerdict {
  const match = AUTHORABLE_VERDICTS.find((verdict) => verdict === value);
  if (match === undefined) {
    throw new Core.M3LError(
      `'${field}' must be one of: ${AUTHORABLE_VERDICTS.join(", ")}`,
      { code: PRESET_CODE },
    );
  }
  return match;
}

/** Parses one known-case row. */
function parseCase(
  reader: Core.M3LInputFileReader,
  value: unknown,
  index: number,
): RunbookCase {
  const field = `cases[${String(index)}]`;
  const record = reader.asRecord(value, field);
  const priority = requiredNumber(reader, record, "priority", field);
  if (!Number.isInteger(priority) || priority <= RESERVED_PRIORITY_CEILING) {
    throw new Core.M3LError(
      `'${field}.priority' must be an integer above ${String(RESERVED_PRIORITY_CEILING)} — lower priorities are reserved for the codified terminal cases`,
      { code: PRESET_CODE },
    );
  }
  return {
    id: reader.requiredStringField(record, "id", field),
    description: reader.requiredStringField(record, "description", field),
    prose: reader.requiredStringField(record, "prose", field),
    priority,
    pattern: requirePattern(
      reader.requiredStringField(record, "pattern", field),
      `${field}.pattern`,
    ),
    level: reader.optionalStringField(record, "level"),
    service: reader.optionalStringField(record, "service"),
    verdict: parseVerdict(
      reader.requiredStringField(record, "verdict", field),
      `${field}.verdict`,
    ),
    ticket: reader.optionalStringField(record, "ticket"),
    resolution: reader.optionalStringField(record, "resolution"),
    escalateTo: reader.optionalStringField(record, "escalateTo"),
    followUps: optionalStringArray(reader, record, "followUps"),
  };
}

/**
 * Rejects a supported preset that is missing a stage the step graph cannot
 * run without. An unsupported preset legitimately carries none of them: its
 * procedure short-circuits before any query runs.
 */
function requireAnalysableStages(preset: RunbookPreset): void {
  if (preset.unsupported !== undefined) return;
  const missing = [
    preset.entry === undefined ? "entry" : undefined,
    preset.correlation === undefined ? "correlation" : undefined,
    preset.signature === undefined ? "signature" : undefined,
  ].filter((field): field is string => field !== undefined);
  if (missing.length > 0) {
    throw new Core.M3LError(
      `a supported preset requires ${missing.join(", ")} — declare 'unsupported' instead when the alarm's evidence is not in a log group`,
      { code: PRESET_CODE },
    );
  }
}

/**
 * Validates an already-JSON-parsed preset record and narrows it to a
 * {@link RunbookPreset}. This is the script's trust boundary: every field a
 * step later reads is checked here, so a malformed preset fails at load with
 * a message naming the offending field rather than mid-incident with a
 * `TypeError`.
 *
 * @param reader - The `M3LInputFileReader` supplying the field accessors.
 * @param record - The parsed preset object.
 * @param source - The preset's origin, used in thrown messages.
 * @returns The validated preset.
 * @throws {@link Core.M3LError} coded `ERR_LOGS_ANALYSIS_PRESET` for any
 *   missing, mistyped, or out-of-range field.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { parseRunbookPreset } from "./load-runbook.js";
 *
 * const reader = new Core.M3LInputFileReader({
 *   paths: new Core.M3LPaths(),
 *   code: "ERR_LOGS_ANALYSIS_PRESET",
 * });
 * const preset = parseRunbookPreset(reader, { alarm: "a" }, "a.json");
 * ```
 */
export function parseRunbookPreset(
  reader: Core.M3LInputFileReader,
  record: Readonly<Record<string, unknown>>,
  source: string,
): RunbookPreset {
  const entryRecord = reader.optionalRecordField(record, "entry");
  const preset: RunbookPreset = {
    alarm: reader.requiredStringField(record, "alarm", source),
    title: reader.requiredStringField(record, "title", source),
    unsupported: parseUnsupported(reader, record),
    entry:
      entryRecord === undefined
        ? undefined
        : parseQueryStage(reader, entryRecord, "entry"),
    severityLadder: requireSafeLadder(
      optionalStringArray(reader, record, "severityLadder"),
    ),
    severityPlaceholder: reader.optionalStringField(
      record,
      "severityPlaceholder",
    ),
    window: parseWindow(reader, record),
    authorizer: parseAuthorizer(reader, record),
    correlation: parseCorrelation(reader, record),
    trace: parseTrace(reader, record),
    signature: parseSignature(reader, record),
    cases: (reader.optionalArrayField(record, "cases") ?? []).map(
      (value, index) => parseCase(reader, value, index),
    ),
    escalateTo: reader.requiredStringField(record, "escalateTo", source),
    followUps: optionalStringArray(reader, record, "followUps"),
    todos: optionalStringArray(reader, record, "todos"),
  };
  requireAnalysableStages(preset);
  return preset;
}

/**
 * Reads and validates one preset from `<runbookDir>/<name>` beneath the
 * input directory.
 *
 * @param reader - The `M3LInputFileReader` bound to `M3L_INPUT_DIR`.
 * @param relativePath - The preset's path relative to the input directory.
 * @returns The validated preset.
 * @throws {@link Core.M3LError} coded `ERR_LOGS_ANALYSIS_PRESET` when the
 *   file is unreadable, is not JSON, or fails validation.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { loadRunbook } from "./load-runbook.js";
 *
 * const reader = new Core.M3LInputFileReader({
 *   paths: new Core.M3LPaths(),
 *   code: "ERR_LOGS_ANALYSIS_PRESET",
 * });
 * const preset = await loadRunbook(reader, "runbooks/example-alarm.json");
 * ```
 */
export async function loadRunbook(
  reader: Core.M3LInputFileReader,
  relativePath: string,
): Promise<RunbookPreset> {
  const record = await reader.readJSONRecord(relativePath);
  return parseRunbookPreset(reader, record, relativePath);
}

/**
 * Lists every preset file in `runbookDir`, as paths relative to the input
 * directory, sorted so `validate` reports in a stable order.
 *
 * @param paths - The run's `M3LPaths`, anchoring `M3L_INPUT_DIR`.
 * @param runbookDir - The preset directory, relative to the input directory.
 * @returns The relative paths of every `.json` file directly inside it.
 * @throws {@link Core.M3LError} coded `ERR_LOGS_ANALYSIS_PRESET` when the
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
