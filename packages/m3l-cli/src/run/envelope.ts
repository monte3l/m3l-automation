/**
 * `run/envelope` — assembles and serializes the `m3l run <script> --json`
 * result envelope: an allowlisted-scalar summary of a completed run (ADR-0063
 * / #539). Pure: no I/O, no `process` access — every input is supplied by the
 * caller.
 *
 * ADR-0035 classifies the run report as a sensitive, crash-dump-class
 * artifact. This envelope never re-emits report content verbatim; it copies
 * only the closed set of scalars the report-lookup layer already allowlisted,
 * plus the report's path.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

/**
 * The closed set of terminal run outcomes this envelope can carry, kept
 * independently declared (rather than imported) so this module has no
 * compile-time dependency on `Core.M3LRunOutcome`'s exact declaration site —
 * only a structural one, asserted by the test suite's type-contract checks.
 *
 * @example
 * ```ts
 * import type { M3LCliRunOutcome } from "@m3l-automation/m3l-cli/run/envelope";
 *
 * function isTerminalFailure(outcome: M3LCliRunOutcome): boolean {
 *   return outcome === "failure";
 * }
 * ```
 */
export type M3LCliRunOutcome =
  "success" | "failure" | "dry-run" | "interrupted" | "partial";

/** The exhaustive set of recognized {@link M3LCliRunOutcome} literals, for a safe runtime narrow. */
const RECOGNIZED_OUTCOMES: ReadonlySet<M3LCliRunOutcome> = new Set([
  "success",
  "failure",
  "dry-run",
  "interrupted",
  "partial",
]);

/**
 * Narrows an unknown value to {@link M3LCliRunOutcome}, or `null` when it
 * isn't one of the five recognized literals.
 *
 * @param value - Any value, typically read from a hostile or malformed source.
 * @returns The narrowed outcome, or `null`.
 *
 * @example
 * ```ts
 * // Internal-only: illustrative shape, not part of the public API.
 * toRunOutcome("partial"); // "partial"
 * toRunOutcome("bogus"); // null
 * ```
 */
function toRunOutcome(value: unknown): M3LCliRunOutcome | null {
  return typeof value === "string" &&
    RECOGNIZED_OUTCOMES.has(value as M3LCliRunOutcome)
    ? (value as M3LCliRunOutcome)
    : null;
}

/**
 * The name of an exit code in the ADR-0035 registry
 * (`Core.M3L_EXIT_CODES`), e.g. `"SUCCESS"` or `"EXTERNAL"`.
 *
 * @example
 * ```ts
 * import type { M3LCliExitCodeName } from "@m3l-automation/m3l-cli/run/envelope";
 *
 * const name: M3LCliExitCodeName = "SUCCESS";
 * ```
 */
export type M3LCliExitCodeName = keyof typeof Core.M3L_EXIT_CODES;

/**
 * Reverse lookup from a numeric exit code to its registry name, built once
 * from `Core.M3L_EXIT_CODES` at module scope — never hand-duplicated.
 */
const EXIT_CODE_NAME_BY_CODE: ReadonlyMap<number, M3LCliExitCodeName> = new Map(
  (Object.entries(Core.M3L_EXIT_CODES) as [M3LCliExitCodeName, number][]).map(
    ([name, code]) => [code, name],
  ),
);

/**
 * The reasons {@link M3LCliRunReportLookup} can fail to resolve a matching
 * `run-report.json`.
 *
 * @example
 * ```ts
 * import type { M3LCliRunReportUnavailableReason } from "@m3l-automation/m3l-cli/run/envelope";
 *
 * function isDirectoryFault(reason: M3LCliRunReportUnavailableReason): boolean {
 *   return (
 *     reason === "output-directory-missing" ||
 *     reason === "output-directory-unreadable"
 *   );
 * }
 * ```
 */
export type M3LCliRunReportUnavailableReason =
  | "output-directory-missing"
  | "output-directory-unreadable"
  | "no-matching-report"
  | "report-unreadable"
  | "report-malformed";

/** The exhaustive set of recognized {@link M3LCliRunReportUnavailableReason} literals, for a safe runtime narrow. */
const RECOGNIZED_UNAVAILABLE_REASONS: ReadonlySet<M3LCliRunReportUnavailableReason> =
  new Set([
    "output-directory-missing",
    "output-directory-unreadable",
    "no-matching-report",
    "report-unreadable",
    "report-malformed",
  ]);

/**
 * Narrows an unknown value to {@link M3LCliRunReportUnavailableReason}, or
 * `null` when it isn't one of the five recognized literals.
 *
 * @param value - Any value, typically read from a hostile or malformed source.
 * @returns The narrowed reason, or `null`.
 *
 * @example
 * ```ts
 * // Internal-only: illustrative shape, not part of the public API.
 * toReportUnavailableReason("no-matching-report"); // "no-matching-report"
 * toReportUnavailableReason("bogus"); // null
 * ```
 */
function toReportUnavailableReason(
  value: unknown,
): M3LCliRunReportUnavailableReason | null {
  return typeof value === "string" &&
    RECOGNIZED_UNAVAILABLE_REASONS.has(
      value as M3LCliRunReportUnavailableReason,
    )
    ? (value as M3LCliRunReportUnavailableReason)
    : null;
}

/**
 * The allowlisted scalar summary projected from a located `run-report.json`.
 * Every field is independently nullable — the projection degrades a missing
 * or malformed report value to `null` rather than fabricating one.
 *
 * @example
 * ```ts
 * import type { M3LCliRunReportSummary } from "@m3l-automation/m3l-cli/run/envelope";
 *
 * const summary: M3LCliRunReportSummary = {
 *   outcome: "success",
 *   timelineCount: 12,
 *   timelineSourceCount: 3,
 *   recoveryTotal: null,
 * };
 * ```
 */
export interface M3LCliRunReportSummary {
  /** The report's terminal outcome, or `null` when absent/unrecognized. */
  readonly outcome: M3LCliRunOutcome | null;
  /** The number of timeline entries, or `null` when `timeline` isn't an array. */
  readonly timelineCount: number | null;
  /** The number of distinct timeline `source` values, or `null` when `timeline` isn't an array. */
  readonly timelineSourceCount: number | null;
  /** The absorbed-failure count for a `"partial"` outcome, or `null` otherwise. */
  readonly recoveryTotal: number | null;
}

/**
 * The result of scanning the output directory for a run's `run-report.json`.
 * A discriminated union: `summary` and `reportPath` are reachable only after
 * narrowing to `"found"`.
 *
 * @example
 * ```ts
 * import type { M3LCliRunReportLookup } from "@m3l-automation/m3l-cli/run/envelope";
 *
 * const lookup: M3LCliRunReportLookup = {
 *   status: "unavailable",
 *   reason: "no-matching-report",
 * };
 * ```
 */
export type M3LCliRunReportLookup =
  | {
      readonly status: "found";
      readonly reportPath: string;
      readonly summary: M3LCliRunReportSummary;
    }
  | {
      readonly status: "unavailable";
      readonly reason: M3LCliRunReportUnavailableReason;
    };

/**
 * The `m3l run <script> --json` result envelope: allowlisted scalars only,
 * emitted as a single line of JSON on stdout.
 *
 * @example
 * ```ts
 * import type { M3LCliRunEnvelope } from "@m3l-automation/m3l-cli/run/envelope";
 *
 * function isSuccess(envelope: M3LCliRunEnvelope): boolean {
 *   return envelope.outcome === "success";
 * }
 * ```
 */
export interface M3LCliRunEnvelope {
  /** The envelope's discriminant; always `"m3l.run.result"`. */
  readonly kind: "m3l.run.result";
  /** The envelope schema's version; always `1`. */
  readonly schemaVersion: 1;
  /** The script's name, verbatim from the invocation. */
  readonly script: string;
  /** The run's start time, ISO-8601 — always the parent-observed timestamp. */
  readonly startedAt: string;
  /** The run's end time, ISO-8601 — always the parent-observed timestamp. */
  readonly finishedAt: string;
  /** `finishedAt - startedAt` in whole milliseconds; not clamped to zero. */
  readonly durationMs: number;
  /** The child process's numeric exit code. */
  readonly exitCode: number;
  /** The ADR-0035 registry name for `exitCode`, or `null` when unregistered. */
  readonly exitCodeName: M3LCliExitCodeName | null;
  /** The located report's outcome, or `null` when unavailable or absent. */
  readonly outcome: M3LCliRunOutcome | null;
  /** The absolute path to the matched `run-report.json`, or `null`. */
  readonly reportPath: string | null;
  /** Why no report was located, or `null` when one was found. */
  readonly reportUnavailable: M3LCliRunReportUnavailableReason | null;
  /** The located report's timeline entry count, or `null`. */
  readonly timelineCount: number | null;
  /** The located report's distinct timeline source count, or `null`. */
  readonly timelineSourceCount: number | null;
  /** The located report's absorbed-failure count, or `null`. */
  readonly recoveryTotal: number | null;
}

/**
 * The parent-observed inputs {@link buildRunEnvelope} assembles into an
 * {@link M3LCliRunEnvelope}.
 *
 * @example
 * ```ts
 * import type { M3LCliRunEnvelopeInput } from "@m3l-automation/m3l-cli/run/envelope";
 *
 * const input: M3LCliRunEnvelopeInput = {
 *   scriptName: "export-users",
 *   startedAt: new Date(),
 *   finishedAt: new Date(),
 *   exitCode: 0,
 *   lookup: { status: "unavailable", reason: "no-matching-report" },
 * };
 * ```
 */
export interface M3LCliRunEnvelopeInput {
  /** The invoked script's name. */
  readonly scriptName: string;
  /** The parent-observed time the child process was spawned. */
  readonly startedAt: Date;
  /** The parent-observed time the child process exited. */
  readonly finishedAt: Date;
  /** The child process's numeric exit code. */
  readonly exitCode: number;
  /** The report-lookup result for this run. */
  readonly lookup: M3LCliRunReportLookup;
}

/**
 * Safely reads a string property from an unknown value, tolerating a value
 * that isn't a plain object or a hostile getter that throws.
 */
function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === "string" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Safely reads a number property from an unknown value, tolerating a value
 * that isn't a plain object or a hostile getter that throws.
 */
function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === "number" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Safely reads a value's property from an unknown value, tolerating a value
 * that isn't a plain object or a hostile getter that throws.
 */
function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Fields the envelope copies straight from a `"found"` lookup's `summary`, or `null` when unavailable. */
interface ReportDerivedFields {
  readonly reportPath: string | null;
  readonly outcome: M3LCliRunOutcome | null;
  readonly timelineCount: number | null;
  readonly timelineSourceCount: number | null;
  readonly recoveryTotal: number | null;
  readonly reportUnavailable: M3LCliRunReportUnavailableReason | null;
}

/**
 * Resolves the report-derived envelope fields from `lookup`, guarding every
 * read so a hostile or malformed lookup (extra/missing keys, wrong shapes)
 * degrades to `null` fields instead of throwing. Never reads timing fields
 * from `lookup` — those always come from the caller's own `startedAt`/
 * `finishedAt`.
 */
function resolveReportDerivedFields(
  lookup: M3LCliRunReportLookup,
): ReportDerivedFields {
  if (lookup.status !== "found") {
    const reason = readString(lookup, "reason");
    return {
      reportPath: null,
      outcome: null,
      timelineCount: null,
      timelineSourceCount: null,
      recoveryTotal: null,
      reportUnavailable: toReportUnavailableReason(reason),
    };
  }

  const reportPath = readString(lookup, "reportPath") ?? null;
  const summary = readProperty(lookup, "summary");

  return {
    reportPath,
    outcome: toRunOutcome(readString(summary, "outcome")),
    timelineCount: readNumber(summary, "timelineCount") ?? null,
    timelineSourceCount: readNumber(summary, "timelineSourceCount") ?? null,
    recoveryTotal: readNumber(summary, "recoveryTotal") ?? null,
    reportUnavailable: null,
  };
}

/**
 * Assembles an {@link M3LCliRunEnvelope} from parent-observed run inputs.
 * Pure: performs no I/O and never touches `process`.
 *
 * @param input - The run's parent-observed timing, exit code, and
 *   report-lookup result.
 * @returns The fully assembled envelope.
 *
 * @example
 * ```ts
 * import { buildRunEnvelope } from "@m3l-automation/m3l-cli/run/envelope";
 *
 * const envelope = buildRunEnvelope({
 *   scriptName: "export-users",
 *   startedAt: new Date("2026-08-20T10:00:00.000Z"),
 *   finishedAt: new Date("2026-08-20T10:00:05.500Z"),
 *   exitCode: 0,
 *   lookup: { status: "unavailable", reason: "no-matching-report" },
 * });
 * ```
 */
export function buildRunEnvelope(
  input: M3LCliRunEnvelopeInput,
): M3LCliRunEnvelope {
  const derived = resolveReportDerivedFields(input.lookup);

  return {
    kind: "m3l.run.result",
    schemaVersion: 1,
    script: input.scriptName,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    exitCode: input.exitCode,
    exitCodeName: EXIT_CODE_NAME_BY_CODE.get(input.exitCode) ?? null,
    outcome: derived.outcome,
    reportPath: derived.reportPath,
    reportUnavailable: derived.reportUnavailable,
    timelineCount: derived.timelineCount,
    timelineSourceCount: derived.timelineSourceCount,
    recoveryTotal: derived.recoveryTotal,
  };
}

/**
 * Serializes an {@link M3LCliRunEnvelope} as a single line of JSON, with no
 * embedded or trailing newline — the caller (`output.info`) supplies the
 * trailing newline.
 *
 * @param envelope - The envelope to serialize.
 * @returns The JSON text.
 *
 * @example
 * ```ts
 * import {
 *   buildRunEnvelope,
 *   formatRunEnvelope,
 * } from "@m3l-automation/m3l-cli/run/envelope";
 *
 * const envelope = buildRunEnvelope({
 *   scriptName: "export-users",
 *   startedAt: new Date(),
 *   finishedAt: new Date(),
 *   exitCode: 0,
 *   lookup: { status: "unavailable", reason: "no-matching-report" },
 * });
 * console.log(formatRunEnvelope(envelope));
 * ```
 */
export function formatRunEnvelope(envelope: M3LCliRunEnvelope): string {
  return JSON.stringify(envelope);
}
