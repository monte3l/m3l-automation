/**
 * `retention-walk` — shared primitives for the two X8 retention-policy
 * drivers: {@link "./run-output-retention.js".pruneRunOutputs} (slice 5b)
 * and {@link "./session-artifact-retention.js".pruneSessionArtifacts} (slice
 * 5b-ii).
 *
 * Extracted so that a forthcoming fix to the raw root-`readdir` re-throw
 * (commit 2) lands once rather than twice, and to keep both consumers under
 * the 25,000-byte `SRC_CEILING_BYTES` ceiling enforced by
 * `check:file-budget`.
 *
 * This module imports **nothing** from either retention module — the
 * dependency direction is strictly one-way.
 *
 * @packageDocumentation
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";

import { CONFIG_INVALID_CODE } from "./config/settings.js";
import { M3LConsoleError } from "./errors/console-error.js";
import { errnoCodeOf } from "./errors/errno.js";

/**
 * One accumulated deletion failure, paired internally with the original
 * caught value so the thrown {@link M3LConsoleError}'s `cause` can chain the
 * FIRST failure's original error unchanged (by identity) while
 * `context.failures` publishes only the narrow `T` shape for every failure.
 *
 * `T` is the module-specific published failure shape:
 * - `RunOutputPruneFailure` for
 *   {@link "./run-output-retention.js".pruneRunOutputs}
 * - `SessionArtifactPruneFailure` for
 *   {@link "./session-artifact-retention.js".pruneSessionArtifacts}
 */
export interface AccumulatedFailure<T extends object> {
  readonly published: T;
  readonly cause: unknown;
}

/**
 * The mutable counters each retention driver accumulates across one walk:
 * one for every entry that was deleted, skipped as live, skipped as too
 * young, or counted as an orphan. Shared between
 * {@link "./run-output-retention.js".pruneRunOutputs} and
 * {@link "./session-artifact-retention.js".pruneSessionArtifacts}.
 */
export interface MutableOutcome {
  deleted: number;
  retainedLive: number;
  retainedYoung: number;
  orphaned: number;
}

/**
 * The discriminated return of {@link readdirRoot}: either the root was
 * present and its `Dirent` entries are available, or it was absent (an
 * `ENOENT` `readdir` failure). Any other errno raises an
 * {@link M3LConsoleError} with code `"ERR_CONSOLE_INTERNAL"`, chaining the
 * original as `cause`.
 */
export type RootReaddirOutcome =
  | { readonly present: true; readonly entries: readonly Dirent[] }
  | { readonly present: false };

/**
 * Validates `retentionMs` before either retention driver touches the
 * filesystem, against the exact predicate `config/retention.ts` enforces at
 * boot for the same windows (`m3l.console.runs.output.retention.ms` for
 * {@link "./run-output-retention.js".pruneRunOutputs};
 * `m3l.console.sessions.artifact.retention.ms` for
 * {@link "./session-artifact-retention.js".pruneSessionArtifacts}) —
 * deliberately shared here rather than duplicated, because both public
 * functions are callable with a hand-built `retentionMs` that never passed
 * through `loadRetentionConfig` (X8 slice 5c's operator CLI subcommand is
 * exactly such a caller, and `Number("30d")` is `NaN`). The retention window
 * is the ONLY thing bounding deletions: with a `NaN` on the right-hand side,
 * `endedAtMs >= nowMs - retentionMs` is always `false`, so every eligible
 * entry falls through to deletion; a negative value puts the cutoff in the
 * future, so every eligible entry is "old enough" immediately. Either failure
 * mode is unbounded deletion, not merely a wrong number, so this re-validates
 * a value the loader may already have checked rather than trusting every
 * caller to have gone through it.
 *
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_CONFIG_INVALID"`
 *   when `retentionMs` is not a finite integer of at least 1.
 *
 * @example
 * ```ts
 * import { validateRetentionMs } from "@m3l-automation/m3l-console-server/retention-walk";
 *
 * validateRetentionMs(7_776_000_000); // ok — 90 days in ms
 * validateRetentionMs(0);             // throws M3LConsoleError
 * validateRetentionMs(NaN);           // throws M3LConsoleError
 * ```
 */
export function validateRetentionMs(retentionMs: number): void {
  if (!Number.isInteger(retentionMs) || retentionMs < 1) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      "'retentionMs' must be an integer of at least 1",
      { context: { retentionMs } },
    );
  }
}

/**
 * Validates the value returned by the resolved `nowMs()` clock, read once at
 * the top of each retention driver before any entry is classified. A `NaN`
 * clock reading has the same effect as an invalid `retentionMs`: the
 * eligibility comparison `endedAtMs >= nowMs - retentionMs` becomes `false`
 * for every eligible entry, so a broken clock silently turns a bounded sweep
 * into an unconditional one. Used by both
 * {@link "./run-output-retention.js".pruneRunOutputs} and
 * {@link "./session-artifact-retention.js".pruneSessionArtifacts}.
 *
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_CONFIG_INVALID"`
 *   when `now` is not a finite number.
 *
 * @example
 * ```ts
 * import { validateNowMs } from "@m3l-automation/m3l-console-server/retention-walk";
 *
 * validateNowMs(Date.now()); // ok
 * validateNowMs(NaN);        // throws M3LConsoleError
 * validateNowMs(Infinity);   // throws M3LConsoleError
 * ```
 */
export function validateNowMs(now: number): void {
  if (!Number.isFinite(now)) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      "the resolved 'nowMs()' clock reading must be a finite number",
      { context: { now } },
    );
  }
}

/**
 * Sorts directory entries by name, used by both
 * {@link "./run-output-retention.js".pruneRunOutputs} and
 * {@link "./session-artifact-retention.js".pruneSessionArtifacts} to make
 * their walks deterministic — `readdir` makes no ordering guarantee, and
 * without a defined order the "one failure does not abort the walk" guarantee
 * is not verifiable across invocations or filesystems.
 *
 * @example
 * ```ts
 * import { sortByName } from "@m3l-automation/m3l-console-server/retention-walk";
 *
 * const sorted = sortByName([{ name: "c" }, { name: "a" }, { name: "b" }]);
 * // [{ name: "a" }, { name: "b" }, { name: "c" }]
 * ```
 */
export function sortByName<T extends { readonly name: string }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/**
 * Performs the root-directory `readdir` with the `ENOENT` guard shared by
 * both retention drivers: returns `{ present: true, entries }` when the root
 * exists, or `{ present: false }` when it is absent. Any other `readdir`
 * errno raises an {@link M3LConsoleError} with code `"ERR_CONSOLE_INTERNAL"`,
 * chaining the original as `cause` and carrying `{ errno }` in `context`
 * (never the absolute path — the filesystem layout is not something an error
 * surface should publish).
 *
 * The caller is responsible for mapping `{ present: false }` to its own
 * module-specific zero outcome (e.g. `{ ...zeroOutcome, rootExisted: false }`),
 * since those shapes differ between the two modules and must stay in the
 * caller.
 *
 * @param rootPath - The root directory to enumerate.
 * @param subject - A caller-supplied label that lets an operator tell the two
 *   roots apart in error messages (e.g. `"runs output"` or
 *   `"session artifact"`). Passed rather than hard-coded so this one helper
 *   serves both retention modules without being duplicated.
 *
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_INTERNAL"` when
 *   `readdir` fails for any reason other than `ENOENT`.
 *
 * @example
 * ```ts
 * import { readdirRoot } from "@m3l-automation/m3l-console-server/retention-walk";
 *
 * const result = await readdirRoot("/var/lib/m3l/console/runs", "runs output");
 * if (!result.present) {
 *   return { ...zeroOutcome, rootExisted: false };
 * }
 * // result.entries is Dirent[]
 * ```
 */
export async function readdirRoot(
  rootPath: string,
  subject: string,
): Promise<RootReaddirOutcome> {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    return { present: true, entries };
  } catch (cause) {
    const errno = errnoCodeOf(cause);
    if (errno === "ENOENT") {
      return { present: false };
    }
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      `${subject} root readdir failed: ${String(errno)}`,
      { cause, context: { errno } },
    );
  }
}
