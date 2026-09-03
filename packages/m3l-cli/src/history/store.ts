/**
 * `history/store` — the best-effort, never-throwing run-history ring buffer
 * `commands/run.ts`/`commands/dynamic.ts` append to after a spawn resolves,
 * and `commands/history.ts` reads back for display. Entries never carry a
 * parameter's resolved *value* — only its declared name — so this store
 * cannot leak a secret through the read path. The read path
 * ({@link readHistory} → {@link projectHistoryEntry}) re-validates and
 * projects every persisted entry to the exact declared fields, so no extra
 * field reaches `history --json` output. The write path
 * ({@link recordHistoryEntry}) runs the same {@link isValidHistoryEntry}
 * check the read path uses, and refuses to write (returning `false`) when a
 * required field (`timestamp`, `script`, `parameterNames`, `exitCode`) is
 * missing or the wrong shape — a bad caller can no longer corrupt the
 * history file with a single malformed append. A well-formed entry is then
 * projected through {@link projectHistoryEntry}, so an extra field or an
 * invalid `outcome`/`retryAttempts` value is dropped rather than persisted.
 *
 * @packageDocumentation
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  M3LCliRunOutcome,
  M3LCliRunReportSummary,
} from "../run/envelope.js";
import { toRunOutcome } from "../run/envelope.js";

/** Indentation width for the pretty-printed history file. */
const HISTORY_JSON_INDENT = 2;

/**
 * The maximum number of entries {@link recordHistoryEntry} persists — a
 * sliding window over the most recent runs; the oldest entries are dropped
 * once the cap is exceeded.
 *
 * @example
 * ```ts
 * import { HISTORY_CAP } from "@m3l-automation/m3l-common";
 * // HISTORY_CAP === 100
 * ```
 */
export const HISTORY_CAP = 100;

/**
 * A single recorded run. Deliberately carries only parameter *names*, never
 * their resolved values. Both the read and write paths funnel every entry
 * through {@link projectHistoryEntry}, so no extra field — nor an invalid
 * `outcome`/`retryAttempts` value — can appear in the persisted file or in
 * `history --json` output, regardless of what the caller hands in.
 *
 * @example
 * ```ts
 * const entry: M3LCliHistoryEntry = {
 *   timestamp: new Date().toISOString(),
 *   script: "exporter",
 *   parameterNames: ["region", "verbose"],
 *   exitCode: 0,
 * };
 * ```
 */
export interface M3LCliHistoryEntry {
  /** The run's start time, ISO-8601 (`Date.prototype.toISOString()`). */
  readonly timestamp: string;
  /** The run script's name. */
  readonly script: string;
  /** The declared parameter names supplied to the run — never their values. */
  readonly parameterNames: readonly string[];
  /** The spawned child's resolved exit code. */
  readonly exitCode: number;
  /**
   * The run's terminal outcome, when a run report was located and contained a
   * recognized outcome literal. Absent when no report was found (the `wizard`
   * spawn path and the in-process path never produce one) or when the report
   * carried an unrecognized value — meaningfully different from any of the five
   * known outcomes.
   */
  readonly outcome?: M3LCliRunOutcome;
  /**
   * The number of retry attempts recorded by the run report. Absent when no
   * report was located, or when the report carried no numeric finite value for
   * this field — absent is meaningfully different from zero, which would imply
   * the run completed on its first try.
   */
  readonly retryAttempts?: number;
}

/**
 * Checks whether `value` is a non-array plain object.
 *
 * @param value - The candidate value to check.
 * @returns Whether `value` is a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The shape `isValidHistoryEntry` can actually vouch for: the four core
 * fields are checked; the two optional ones are whatever was in the file.
 * `projectHistoryEntry` is the boundary that narrows them to their final types.
 */
type ParsedHistoryEntry = Omit<
  M3LCliHistoryEntry,
  "outcome" | "retryAttempts"
> & {
  readonly outcome?: unknown;
  readonly retryAttempts?: unknown;
};

/**
 * Checks whether `value` has the minimal shape {@link M3LCliHistoryEntry}
 * requires, so a malformed or hand-edited entry in the history file is
 * dropped rather than trusted through to a raw crash in `commands/history.ts`.
 * Used on both the read path ({@link readHistory}, filtering a parsed file)
 * and the write path ({@link recordHistoryEntry}, refusing to persist a
 * structurally invalid caller-supplied entry) — a single check, so the two
 * paths can never disagree on what counts as well-formed.
 *
 * `exitCode` is checked with `Number.isFinite` (not merely
 * `typeof === "number"`) so `NaN`/`±Infinity` are rejected, mirroring
 * {@link narrowRetryAttempts}. This also tightens the read path, but safely:
 * `JSON.stringify` already collapses `NaN`/`Infinity` to `null`, and
 * `typeof null !== "number"` already failed this check, so no file that was
 * previously read successfully changes meaning.
 *
 * @param value - The candidate entry value to check.
 * @returns Whether `value` is a well-formed {@link ParsedHistoryEntry}.
 */
function isValidHistoryEntry(value: unknown): value is ParsedHistoryEntry {
  if (!isPlainObject(value)) {
    return false;
  }
  const { timestamp, script, parameterNames, exitCode } = value;
  return (
    typeof timestamp === "string" &&
    typeof script === "string" &&
    Array.isArray(parameterNames) &&
    parameterNames.every((name) => typeof name === "string") &&
    typeof exitCode === "number" &&
    Number.isFinite(exitCode)
  );
}

/**
 * Narrows a candidate `retryAttempts` value read exactly once from an
 * untrusted source to a finite number, or `null` when it isn't one.
 * `Number.isFinite` (not merely `typeof === "number"`) rejects `NaN` and
 * `±Infinity` — both of which `JSON.stringify` collapses to `null`, which
 * would otherwise read back as neither a valid count nor an absent field.
 * Shared by {@link projectHistoryEntry} (persisted-entry fields, typed
 * `unknown`) and {@link historyOutcomeFields} (a live run summary, typed
 * `number | null`) — both callers bind the source property to a local
 * `unknown` exactly once before calling this, so a hostile getter can't
 * diverge between the check and the value.
 *
 * @param value - The already-read candidate value.
 * @returns The finite number, or `null`.
 */
function narrowRetryAttempts(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Projects a {@link ParsedHistoryEntry} down to exactly the declared
 * {@link M3LCliHistoryEntry} fields, so a hand-added extra field cannot pass
 * through into `history --json` output. The predicate only checked the four
 * required fields, so `outcome` and `retryAttempts` arrive as `unknown` here
 * and are re-validated before being included. Used by both {@link readHistory}
 * (a persisted entry re-validated on read) and {@link recordHistoryEntry} (a
 * caller-supplied entry projected before it is ever written), so neither path
 * can let an extra field or an invalid optional value reach the file.
 *
 * @param entry - An entry already confirmed well-formed by
 *   {@link isValidHistoryEntry}, or a caller-supplied
 *   {@link M3LCliHistoryEntry} (assignable to {@link ParsedHistoryEntry}).
 * @returns A new object carrying only the declared fields.
 */
function projectHistoryEntry(entry: ParsedHistoryEntry): M3LCliHistoryEntry {
  // Object.hasOwn guards both reads so an *inherited* outcome/retryAttempts —
  // e.g. `Object.prototype.outcome` polluted by a script-author config module
  // this CLI `import()`s in-process — can never fabricate a field the object
  // never had its own copy of. `Object.hasOwn` itself never invokes a getter,
  // and each branch below still reads the source property exactly once: a
  // getter on a proxy or Proxy-like object could return a different value on
  // a second read, letting a value that passed the type/finite check diverge
  // from the value stored in the output. Never simplify this to a plain
  // `entry.outcome`/`entry.retryAttempts` access.
  const outcomeRaw: unknown = Object.hasOwn(entry, "outcome")
    ? entry.outcome
    : undefined;
  const outcome = toRunOutcome(outcomeRaw);
  const retryRaw: unknown = Object.hasOwn(entry, "retryAttempts")
    ? entry.retryAttempts
    : undefined;
  const retryAttempts = narrowRetryAttempts(retryRaw);
  const parameterNames: readonly string[] = entry.parameterNames;

  return {
    timestamp: entry.timestamp,
    script: entry.script,
    parameterNames: [...parameterNames],
    exitCode: entry.exitCode,
    ...(outcome !== null && { outcome }),
    ...(retryAttempts !== null && { retryAttempts }),
  };
}

/**
 * Derives the `outcome`/`retryAttempts` fields {@link M3LCliHistoryEntry}
 * accepts from a run's {@link M3LCliRunReportSummary}, so a caller building a
 * history entry can splice in `...historyOutcomeFields(summary)` rather than
 * hand-rolling the null-to-absent mapping. This exists because the two types
 * disagree on how "no value" is represented: `M3LCliRunReportSummary` uses
 * `| null` throughout (JSON-friendly, always-present keys), while
 * {@link M3LCliHistoryEntry} uses optional keys — and persisting a literal
 * `null` (rather than omitting the key) would round-trip through
 * `JSON.stringify` as `"outcome":null`, which {@link projectHistoryEntry}
 * would then have to specially unlearn on the next read. `outcome` is
 * re-narrowed via {@link toRunOutcome} rather than trusted from the summary's
 * declared type, since a forward-incompatible report reader could still hand
 * this an unrecognized literal.
 *
 * `summary`'s `outcome`/`retryAttempts` are read through an `Object.hasOwn`
 * guard first, so an *inherited* value — e.g. `Object.prototype.outcome`
 * polluted by a script-author config module this CLI `import()`s in-process —
 * can never fabricate a field `summary` never had its own copy of. This
 * function is also total over any non-object input: `null`, or anything else
 * that isn't a plain object, maps to `{}` rather than throwing, the same as
 * `undefined` already did.
 *
 * @param summary - The run's report summary, or `undefined` when no report
 *   was located. Any other non-object value (e.g. a hostile `null`) is
 *   treated the same as `undefined`.
 * @returns The subset of {@link M3LCliHistoryEntry} fields derived from
 *   `summary`; both keys are omitted (never set to `null`/`undefined`) when
 *   their source value is absent or invalid.
 *
 * @example
 * ```ts
 * import type { M3LCliHistoryEntry } from "@m3l-automation/m3l-cli/history/store";
 *
 * const entry: M3LCliHistoryEntry = {
 *   timestamp: new Date().toISOString(),
 *   script: "exporter",
 *   parameterNames: [],
 *   exitCode: 0,
 *   ...historyOutcomeFields(summary),
 * };
 * ```
 */
export function historyOutcomeFields(
  summary: M3LCliRunReportSummary | undefined,
): Pick<M3LCliHistoryEntry, "outcome" | "retryAttempts"> {
  if (!isPlainObject(summary)) {
    return {};
  }
  // Object.hasOwn guards both reads against prototype-chain forgery, and each
  // accessor is still read exactly once — see the rationale in
  // `projectHistoryEntry`, above. Never simplify to a plain
  // `summary.outcome`/`summary.retryAttempts` access.
  const outcomeRaw: unknown = Object.hasOwn(summary, "outcome")
    ? summary.outcome
    : undefined;
  const outcome = toRunOutcome(outcomeRaw);
  const retryRaw: unknown = Object.hasOwn(summary, "retryAttempts")
    ? summary.retryAttempts
    : undefined;
  const retryAttempts = narrowRetryAttempts(retryRaw);

  return {
    ...(outcome !== null && { outcome }),
    ...(retryAttempts !== null && { retryAttempts }),
  };
}

/**
 * Reads and parses the run-history file, tolerating every failure mode
 * (missing file, unreadable file, invalid JSON, non-array payload, or a
 * malformed individual entry) by falling back to an empty array — or
 * dropping just the malformed entries — since history is a diagnostic
 * convenience and must never block a command.
 *
 * @param historyFilePath - The absolute path to the history file.
 * @returns The parsed history, oldest first, with only its well-formed
 *   entries (see {@link isValidHistoryEntry}); `[]` on any failure.
 *
 * @example
 * ```ts
 * const history = readHistory("/repo/data/cache/m3l-cli/history.json");
 * // [] when the file is missing, unreadable, or holds only malformed entries
 * ```
 */
export function readHistory(
  historyFilePath: string,
): readonly M3LCliHistoryEntry[] {
  try {
    const raw = readFileSync(historyFilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isValidHistoryEntry).map(projectHistoryEntry);
  } catch {
    return [];
  }
}

/**
 * Appends `entry` to the run-history file, capping the persisted history at
 * {@link HISTORY_CAP} entries via a sliding window (the oldest entries are
 * dropped first). `entry` is first checked against {@link isValidHistoryEntry}
 * — the same required-field check {@link readHistory} runs on every persisted
 * entry — and the write is refused (returning `false`, writing nothing) when
 * a required field (`timestamp`, `script`, `parameterNames`, `exitCode`) is
 * missing or the wrong shape, so a single malformed append can never corrupt
 * an existing history file. A well-formed `entry` is then passed through
 * {@link projectHistoryEntry} before being appended, so a structurally wider
 * caller object (an extra field, an invalid `outcome`/`retryAttempts` value)
 * never reaches the persisted file, and `parameterNames` is written as a
 * fresh array rather than an alias of the caller's — a mutation of the
 * caller's array after this call returns cannot change what was persisted.
 * Never throws — any failure (permission, disk-full, an unexpectedly
 * unreadable existing file, a malformed `entry`, etc.) is reported via the
 * boolean return, since history recording must never affect a command's
 * resolved exit code.
 *
 * Concurrency: this is a plain read-modify-write over a single file, not an
 * atomic append — two invocations racing against the same `historyFilePath`
 * (e.g. two `m3l run` processes started back to back) can each read the same
 * "existing" snapshot and each write their own version, so the loser's entry
 * is silently overwritten (last-writer-wins). This is acceptable because
 * history is a best-effort diagnostic convenience, not a durable audit log —
 * entry loss under concurrent runs is possible by design, not a bug to fix
 * here.
 *
 * @param historyFilePath - The absolute path to the history file.
 * @param entry - The run entry to append.
 * @returns Whether the write succeeded.
 *
 * @example
 * ```ts
 * const recorded = recordHistoryEntry(
 *   "/repo/data/cache/m3l-cli/history.json",
 *   {
 *     timestamp: new Date().toISOString(),
 *     script: "exporter",
 *     parameterNames: [],
 *     exitCode: 0,
 *   },
 * );
 * // true on success; false (never a throw) on any write failure
 * ```
 */
export function recordHistoryEntry(
  historyFilePath: string,
  entry: M3LCliHistoryEntry,
): boolean {
  try {
    if (!isValidHistoryEntry(entry)) {
      return false;
    }
    const existing = readHistory(historyFilePath);
    const updated = [...existing, projectHistoryEntry(entry)].slice(
      -HISTORY_CAP,
    );
    mkdirSync(dirname(historyFilePath), { recursive: true });
    writeFileSync(
      historyFilePath,
      JSON.stringify(updated, undefined, HISTORY_JSON_INDENT),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}
