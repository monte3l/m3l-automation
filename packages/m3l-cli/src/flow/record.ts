/**
 * `flow/record` — the per-run flow record: a canonical hash of the definition
 * that produced it, the nested per-step-execution list, and a LOUD
 * read-validate-write persistence layer.
 *
 * Deliberately the opposite of `history/store.ts`. That module is a capped,
 * append-only list of flat entries and must never throw, because run history
 * is a diagnostic convenience — a lost entry costs nothing. This one is a
 * resume ledger: losing or misreading a flow run record makes a resume either
 * impossible or WRONG (it would restart a flow from the wrong step, or reset
 * the loop guard it was supposed to carry forward). So every write failure
 * throws with its cause chained, and every read failure other than a genuinely
 * absent file throws too. Do not "harmonize" these two contracts.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { M3LCliError } from "../cli/errors.js";
import type { M3LCliRunOutcome } from "../run/envelope.js";
import type { M3LCliFlowRunResult } from "./run.js";
import type {
  M3LCliFlowBranch,
  M3LCliFlowDefinition,
  M3LCliFlowRunStatus,
  M3LCliFlowStepExecution,
  M3LCliFlowStepOutcome,
} from "./types.js";

/** The only `schemaVersion` this module writes, and the only one it reads back. */
const FLOW_RECORD_SCHEMA_VERSION = 1;

/** The record file's `kind` discriminant. */
const FLOW_RECORD_KIND = "m3l.flow.record";

/** Indent width for the persisted record — human-readable, since an operator debugs a failed resume by reading it. */
const FLOW_RECORD_JSON_INDENT = 2;

/**
 * One flow run, as persisted for a later resume.
 *
 * Timestamps are ISO-8601 strings rather than `Date`s: this shape IS the
 * on-disk JSON, so it must round-trip through `JSON.parse` unchanged.
 *
 * @example
 * ```ts
 * function isResumable(record: M3LCliFlowRunRecord): boolean {
 *   return record.resumeStepId !== null;
 * }
 * ```
 */
export interface M3LCliFlowRunRecord {
  /** The record's discriminant; always `"m3l.flow.record"`. */
  readonly kind: "m3l.flow.record";
  /** The record schema's version; always `1` in U10. */
  readonly schemaVersion: 1;
  /** The run's own id — unique per run, and the record's identity. */
  readonly runId: string;
  /** The flow that ran. */
  readonly flowName: string;
  /** {@link hashFlowDefinition} of the definition that produced this run. */
  readonly definitionHash: string;
  /** When the run started, ISO-8601. */
  readonly startedAt: string;
  /** When the run finished, ISO-8601. */
  readonly finishedAt: string;
  /** How the run ended. */
  readonly status: M3LCliFlowRunStatus;
  /** The run's resolved exit code. */
  readonly exitCode: number;
  /** Cumulative step executions across this run AND every earlier run of it. */
  readonly stepExecutionCount: number;
  /** The step the run ended at, or `null`. */
  readonly haltingStepId: string | null;
  /** Where a follow-up run should resume, or `null`. */
  readonly resumeStepId: string | null;
  /** THIS run's own executions, in order. */
  readonly stepExecutions: readonly M3LCliFlowStepExecution[];
}

/**
 * What {@link buildFlowRunRecord} needs: the run's id, the definition it ran,
 * and what the run produced.
 *
 * @example
 * ```ts
 * const input: M3LCliFlowRunRecordInput = { runId, definition, result };
 * ```
 */
export interface M3LCliFlowRunRecordInput {
  /** The run's own id. */
  readonly runId: string;
  /** The definition that ran — hashed, not stored. */
  readonly definition: M3LCliFlowDefinition;
  /** What `flow/run` reported. */
  readonly result: M3LCliFlowRunResult;
}

/**
 * Recursively rewrites `value` into a canonical form for hashing: every
 * object's keys are re-emitted in code-unit order, while every ARRAY keeps
 * its order untouched.
 *
 * That asymmetry is the whole point. YAML mapping order carries no meaning,
 * so a reformatted file must hash identically — otherwise a resume would be
 * refused after an innocuous re-indent. Array order does carry meaning:
 * `steps` order and count decide what the flow actually does, so reordering
 * two steps MUST change the digest.
 *
 * A key whose value is `undefined` needs no special handling —
 * `JSON.stringify` drops it, so an absent optional (e.g. `description`) can
 * never leak a placeholder into the digest.
 *
 * @param value - Any value from a flow definition, including an opaque
 *   parameter value.
 * @returns The canonicalized value, ready for `JSON.stringify`.
 */
function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForHash);
  }
  if (typeof value === "object" && value !== null) {
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort((left, right) =>
      left < right ? -1 : 1,
    )) {
      canonical[key] = canonicalizeForHash(
        (value as Record<string, unknown>)[key],
      );
    }
    return canonical;
  }
  return value;
}

/**
 * Hashes a flow definition to a stable sha256 hex digest.
 *
 * The digest is taken over {@link canonicalizeForHash}'s output, so it is
 * insensitive to key order at every nesting depth (flow level, step level,
 * `parameters`) and sensitive to everything semantic: the flow name, its
 * description, `maxStepExecutions`, every step field, and the ORDER and COUNT
 * of the steps.
 *
 * That is exactly the property a resume needs: it can refuse to resume a
 * definition that really changed, without false-positiving on a reformat.
 *
 * @param definition - The validated definition to hash.
 * @returns A 64-character lowercase hex digest.
 *
 * @example
 * ```ts
 * const hash = hashFlowDefinition(definition);
 * // "3f0a…" (64 hex chars)
 * ```
 */
export function hashFlowDefinition(definition: M3LCliFlowDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeForHash(definition)), "utf8")
    .digest("hex");
}

/**
 * Projects one rich in-memory {@link M3LCliFlowStepOutcome} down to the
 * JSON-safe {@link M3LCliFlowStepExecution} this record persists.
 *
 * Spelled out field by field rather than spread-and-delete for two reasons.
 * It builds a FRESH object, so the persisted record never aliases the loop's
 * own array or its elements — a caller mutating one cannot retroactively edit
 * the other. And it fixes the key INSERTION order, which `JSON.stringify`
 * follows, so the bytes on disk are stable regardless of how the loop happened
 * to assemble the outcome.
 *
 * The three dropped fields (`startedAt`, `finishedAt`, `reportUnavailable`)
 * are dropped on purpose: two are `Date`s that JSON cannot round-trip as
 * themselves, and the third belongs to the `--json` envelope's per-step
 * `lookup` reconstruction, not to the resume ledger.
 *
 * @param outcome - One executed step as the loop observed it.
 * @returns The seven persisted fields, in their declared order.
 */
function projectStepOutcome(
  outcome: M3LCliFlowStepOutcome,
): M3LCliFlowStepExecution {
  return {
    stepId: outcome.stepId,
    script: outcome.script,
    attempt: outcome.attempt,
    exitCode: outcome.exitCode,
    outcome: outcome.outcome,
    reportPath: outcome.reportPath,
    branch: outcome.branch,
  };
}

/**
 * Assembles the persistable record from a run result and its definition.
 *
 * Pure: no filesystem access, no clock read. The `runId` and the run's own
 * observed window come from the caller, so the same inputs always produce the
 * same record.
 *
 * `stepExecutionCount` is carried through VERBATIM even when it exceeds
 * `stepExecutions.length` — a resumed run records only its own executions
 * while the count stays cumulative, and that is precisely what stops a resume
 * from resetting the loop guard.
 *
 * Each execution is PROJECTED through {@link projectStepOutcome}, so no `Date`
 * and no `reportUnavailable` reason survives into the persisted bytes.
 *
 * @param input - The run id, the definition, and the run result.
 * @returns The assembled record.
 *
 * @example
 * ```ts
 * const record = buildFlowRunRecord({ runId, definition, result });
 * ```
 */
export function buildFlowRunRecord(
  input: M3LCliFlowRunRecordInput,
): M3LCliFlowRunRecord {
  const { result } = input;
  return {
    kind: FLOW_RECORD_KIND,
    schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
    runId: input.runId,
    flowName: result.flowName,
    definitionHash: hashFlowDefinition(input.definition),
    startedAt: result.startedAt.toISOString(),
    finishedAt: result.finishedAt.toISOString(),
    status: result.status,
    exitCode: result.exitCode,
    stepExecutionCount: result.stepExecutionCount,
    haltingStepId: result.haltingStepId,
    resumeStepId: result.resumeStepId,
    stepExecutions: result.stepExecutions.map(projectStepOutcome),
  };
}

/**
 * Persists `record` at `recordFilePath`, creating its parent directory.
 *
 * Throws rather than reporting a boolean, unlike
 * `history/store.ts`'s `recordHistoryEntry`: a lost run record makes a resume
 * impossible, so the failure has to reach the caller instead of being
 * absorbed into a return value nobody is obliged to read.
 *
 * @param recordFilePath - The record file's absolute path.
 * @param record - The record to persist.
 * @throws {@link M3LCliError} coded `ERR_CLI_FLOW_RECORD_WRITE_FAILED` when
 *   the directory cannot be created or the file cannot be written, with the
 *   underlying failure chained as `cause`.
 *
 * @example
 * ```ts
 * writeFlowRunRecord("/repo/data/cache/m3l-cli/flows/dlq-reconcile.json", record);
 * ```
 */
export function writeFlowRunRecord(
  recordFilePath: string,
  record: M3LCliFlowRunRecord,
): void {
  try {
    mkdirSync(dirname(recordFilePath), { recursive: true });
    writeFileSync(
      recordFilePath,
      JSON.stringify(record, undefined, FLOW_RECORD_JSON_INDENT),
      "utf8",
    );
  } catch (cause) {
    throw new M3LCliError(
      "ERR_CLI_FLOW_RECORD_WRITE_FAILED",
      `failed to write the flow run record '${recordFilePath}'`,
      { cause },
    );
  }
}

/** The exhaustive set of recognized {@link M3LCliFlowRunStatus} literals, for a safe runtime narrow. */
const RECOGNIZED_STATUSES: ReadonlySet<string> = new Set<M3LCliFlowRunStatus>([
  "completed",
  "stopped",
  "failed",
  "loop-guard-exceeded",
]);

/** The exhaustive set of recognized run-report outcome literals, for a safe runtime narrow. */
const RECOGNIZED_OUTCOMES: ReadonlySet<string> = new Set<M3LCliRunOutcome>([
  "success",
  "failure",
  "dry-run",
  "interrupted",
  "partial",
]);

/**
 * Narrows an unknown value to a plain record, or `null`.
 *
 * @param value - Any parsed JSON value.
 * @returns The value as a record, or `null` when it is not a non-array object.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Checks whether `value` is a well-formed {@link M3LCliFlowBranch}.
 *
 * @param value - Any parsed JSON value.
 * @returns Whether it is `"continue"`, `"stop"`, or `{ goto: string }`.
 */
function isValidBranch(value: unknown): value is M3LCliFlowBranch {
  if (value === "continue" || value === "stop") {
    return true;
  }
  const record = asRecord(value);
  return record !== null && typeof record["goto"] === "string";
}

/**
 * Checks whether `value` is a recognized run-report outcome or `null`.
 *
 * @param value - Any parsed JSON value.
 * @returns Whether it is `null` or one of the five recognized literals.
 */
function isValidNullableOutcome(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && RECOGNIZED_OUTCOMES.has(value))
  );
}

/**
 * Checks whether `value` is a string or `null` — the shape every nullable
 * string field in a record file takes.
 *
 * @param value - Any parsed JSON value.
 * @returns Whether it is `null` or a string.
 */
function isValidNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

/**
 * Checks whether `value` is a well-formed {@link M3LCliFlowStepExecution}.
 *
 * @param value - Any parsed JSON value.
 * @returns Whether every one of the seven fields is present and well-typed.
 */
function isValidStepExecution(
  value: unknown,
): value is M3LCliFlowStepExecution {
  const entry = asRecord(value);
  if (entry === null) {
    return false;
  }
  return (
    typeof entry["stepId"] === "string" &&
    typeof entry["script"] === "string" &&
    typeof entry["attempt"] === "number" &&
    typeof entry["exitCode"] === "number" &&
    isValidNullableOutcome(entry["outcome"]) &&
    isValidNullableString(entry["reportPath"]) &&
    isValidBranch(entry["branch"])
  );
}

/**
 * Checks the record's identity half: the two discriminants plus the five
 * string fields naming which run of which flow this was.
 *
 * @param record - The parsed record's own keys.
 * @returns Whether every identity field is present and well-typed.
 */
function hasValidRecordIdentity(record: Record<string, unknown>): boolean {
  return (
    record["kind"] === FLOW_RECORD_KIND &&
    record["schemaVersion"] === FLOW_RECORD_SCHEMA_VERSION &&
    typeof record["runId"] === "string" &&
    typeof record["flowName"] === "string" &&
    typeof record["definitionHash"] === "string" &&
    typeof record["startedAt"] === "string" &&
    typeof record["finishedAt"] === "string"
  );
}

/**
 * Checks the record's verdict half: how the run ended, and the two step ids a
 * resume is computed from.
 *
 * @param record - The parsed record's own keys.
 * @returns Whether every verdict field is present and well-typed.
 */
function hasValidRecordVerdict(record: Record<string, unknown>): boolean {
  const status = record["status"];
  return (
    typeof status === "string" &&
    RECOGNIZED_STATUSES.has(status) &&
    typeof record["exitCode"] === "number" &&
    typeof record["stepExecutionCount"] === "number" &&
    isValidNullableString(record["haltingStepId"]) &&
    isValidNullableString(record["resumeStepId"])
  );
}

/**
 * Checks whether `value` is a well-formed {@link M3LCliFlowRunRecord}.
 *
 * A single malformed nested step execution invalidates the WHOLE record. That
 * is not over-strictness: dropping one entry would desync
 * `stepExecutionCount` from `stepExecutions`, and a resume computed from that
 * pair would restart from the wrong step with the wrong budget. Unlike run
 * history, this file cannot be partially trusted.
 *
 * @param value - Any parsed JSON value.
 * @returns Whether it is a complete, recognized record.
 */
function isValidFlowRunRecord(value: unknown): value is M3LCliFlowRunRecord {
  const record = asRecord(value);
  if (record === null) {
    return false;
  }
  const stepExecutions = record["stepExecutions"];
  return (
    hasValidRecordIdentity(record) &&
    hasValidRecordVerdict(record) &&
    Array.isArray(stepExecutions) &&
    stepExecutions.every(isValidStepExecution)
  );
}

/**
 * Projects a validated record onto exactly the declared shape, so an
 * unrecognized extra key in the file cannot ride along into the typed value.
 *
 * @param record - An already-validated record.
 * @returns The projected record.
 */
function projectFlowRunRecord(
  record: M3LCliFlowRunRecord,
): M3LCliFlowRunRecord {
  return {
    kind: FLOW_RECORD_KIND,
    schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
    runId: record.runId,
    flowName: record.flowName,
    definitionHash: record.definitionHash,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    status: record.status,
    exitCode: record.exitCode,
    stepExecutionCount: record.stepExecutionCount,
    haltingStepId: record.haltingStepId,
    resumeStepId: record.resumeStepId,
    stepExecutions: record.stepExecutions.map((entry) => ({
      stepId: entry.stepId,
      script: entry.script,
      attempt: entry.attempt,
      exitCode: entry.exitCode,
      outcome: entry.outcome,
      reportPath: entry.reportPath,
      branch: entry.branch,
    })),
  };
}

/**
 * Reads the flow run record at `recordFilePath`.
 *
 * `undefined` means exactly one thing: the file does not exist (`ENOENT`) —
 * the honest state of a flow that has never run. EVERY other failure throws:
 * an unreadable file, malformed JSON, an array/scalar/`null` top level, a
 * missing field, one malformed nested step execution, or an unrecognized
 * `schemaVersion`.
 *
 * Contrast `history/store.ts`'s `readHistory`, which returns `[]` for all of
 * those. Silently reading "no record" out of a corrupt file would make a
 * resume restart a flow it should have refused to resume — so the distinction
 * between "never ran" and "cannot be trusted" is preserved here.
 *
 * @param recordFilePath - The record file's absolute path.
 * @returns The parsed record, or `undefined` when no record file exists.
 * @throws {@link M3LCliError} coded `ERR_CLI_FLOW_RECORD_INVALID` for every
 *   failure other than an absent file, with the underlying failure chained as
 *   `cause` when there was one.
 *
 * @example
 * ```ts
 * const record = readFlowRunRecord(
 *   "/repo/data/cache/m3l-cli/flows/dlq-reconcile.json",
 * );
 * // undefined on a first run; throws on a corrupt one
 * ```
 */
export function readFlowRunRecord(
  recordFilePath: string,
): M3LCliFlowRunRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(recordFilePath, "utf8");
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      (cause as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw new M3LCliError(
      "ERR_CLI_FLOW_RECORD_INVALID",
      `failed to read the flow run record '${recordFilePath}'`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new M3LCliError(
      "ERR_CLI_FLOW_RECORD_INVALID",
      `the flow run record '${recordFilePath}' is not valid JSON`,
      { cause },
    );
  }

  if (!isValidFlowRunRecord(parsed)) {
    throw new M3LCliError(
      "ERR_CLI_FLOW_RECORD_INVALID",
      `the flow run record '${recordFilePath}' is malformed or of an unrecognized schema version`,
    );
  }
  return projectFlowRunRecord(parsed);
}
