/**
 * `history/store` — the best-effort, never-throwing run-history ring buffer
 * `commands/run.ts`/`commands/dynamic.ts` append to after a spawn resolves,
 * and `commands/history.ts` reads back for display. Entries never carry a
 * parameter's resolved *value* — only its declared name — so this store
 * cannot leak a secret through the read path. The read path
 * ({@link readHistory} → {@link projectHistoryEntry}) re-validates and
 * projects every persisted entry to the exact declared fields, so no extra
 * field reaches `history --json` output. The write path
 * ({@link recordHistoryEntry}) relies on the caller constructing a
 * well-formed {@link M3LCliHistoryEntry} with no extra fields; TypeScript's
 * excess-property check enforces this at every current call site.
 *
 * @packageDocumentation
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { M3LCliRunOutcome } from "../run/envelope.js";
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
 * their resolved values. The read path ({@link projectHistoryEntry}) projects
 * every persisted entry to exactly these declared fields, so no extra field
 * can appear in `history --json` output; the write path relies on the caller
 * constructing a well-formed entry.
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
    typeof exitCode === "number"
  );
}

/**
 * Projects a {@link ParsedHistoryEntry} down to exactly the declared
 * {@link M3LCliHistoryEntry} fields, so a hand-added extra field cannot pass
 * through into `history --json` output. The predicate only checked the four
 * required fields, so `outcome` and `retryAttempts` arrive as `unknown` here
 * and are re-validated before being included.
 *
 * @param entry - An entry already confirmed well-formed by
 *   {@link isValidHistoryEntry}.
 * @returns A new object carrying only the declared fields.
 */
function projectHistoryEntry(entry: ParsedHistoryEntry): M3LCliHistoryEntry {
  const outcome = toRunOutcome(entry.outcome);
  // Read each accessor exactly once: a getter on a proxy or Proxy-like object
  // could return a different value on a second read, letting a value that
  // passed the type/finite check diverge from the value stored in the output.
  const retryRaw: unknown = entry.retryAttempts;
  const retryAttempts =
    typeof retryRaw === "number" && Number.isFinite(retryRaw) ? retryRaw : null;
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
 * dropped first). Never throws — any failure (permission, disk-full, an
 * unexpectedly unreadable existing file, etc.) is reported via the boolean
 * return, since history recording must never affect a command's resolved
 * exit code.
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
    const existing = readHistory(historyFilePath);
    const updated = [...existing, entry].slice(-HISTORY_CAP);
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
