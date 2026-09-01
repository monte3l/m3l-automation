/**
 * `boot/audit-rebuild` — rebuilding the `console_human_actions` index from
 * the ADR-0070 JSONL trail, and the boot trigger that decides when to
 * (X7c).
 *
 * This is the other half of `boot/audit-index.ts`'s dual store, and the
 * reason its write path may treat an index failure as a degradation rather
 * than a refusal: the index is a DERIVED projection of the trail, so a
 * missing row is recoverable and this module is how. It also discharges
 * ADR-0070's own open consequence — "dual-store audit (JSONL truth + SQLite
 * index) needs its rebuild path tested".
 *
 * **The direction is one-way, and cannot be otherwise.** Three
 * `M3LHumanActionRecord` fields (`parameterNames`, `parameterRefs`, `detail`)
 * have no column in the index, so trail → index is a projection and
 * index → trail is not expressible. That is what "the JSONL trail is the
 * source of truth" means operationally.
 *
 * **Truncate-and-reinsert, inside one transaction.** `deleteAll()` followed
 * by `insertAll()` is not idempotent on its own — `insertAll` appends, so a
 * rebuild that skipped the truncate would double every row. Both run inside
 * one `BEGIN IMMEDIATE` (`store/executor.ts`'s `withTransaction`, reached
 * through `M3LConsoleStore.transaction`), so a failure part-way cannot leave
 * a half-truncated index. `M3LConsoleAuditRepository.insertAll` opens no
 * transaction of its own precisely so a caller can supply one — see
 * `store/audit-repository.ts`'s own `@packageDocumentation`.
 *
 * **The whole trail is read BEFORE anything is written.** A read failure
 * (a corrupt line, a line over the `M3L_APPEND_ONLY_MAX_LINE_BYTES` ceiling)
 * therefore results in ZERO writes rather than an index silently holding a
 * prefix of the trail. A partial index that looks complete is the one
 * outcome an audit index may never produce.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import type { M3LHumanActionRecord } from "../audit/record.js";
import { projectHumanActionRecord } from "../audit/record.js";
import type { M3LHumanActionIndexInput } from "../store/audit-repository.js";
import type { M3LConsoleStore } from "../store/store.js";

import { projectHumanActionIndexInput } from "./audit-index.js";

/** Logged once per tolerated torn tail; see {@link readTrailIndexRows}. */
const TORN_TAIL_MESSAGE =
  "human-action audit trail ends in a torn record; it is excluded from the index rebuild";

/** Logged when the boot rebuild ran and repopulated the index. */
const REBUILT_MESSAGE = "human-action audit index rebuilt from the JSONL trail";

/** Logged when the boot rebuild itself failed; see {@link rebuildHumanActionIndexOnBoot}. */
const REBUILD_FAILED_MESSAGE =
  "human-action audit index rebuild failed; the JSONL trail is unaffected and queries against the index will under-report until the next boot";

/**
 * Reads the ENTIRE trail under `directory` and returns the index rows it
 * projects to, oldest first.
 *
 * Every line is re-narrowed through `audit/record.ts`'s own
 * {@link projectHumanActionRecord} rather than trusted: a line on disk is
 * external input by the time it is read back, and that function is already
 * the console's narrowing boundary for a human-action record — it proves
 * every container and field at runtime and refuses what it cannot represent
 * (`ERR_CONSOLE_AUDIT_RECORD_INVALID`). The cast into it is deliberate and
 * is the only place this module assumes anything about the line's shape;
 * `Core.M3LAppendOnlyStream.read()` hands back an untyped bag of
 * `M3LAppendOnlyValue`s.
 *
 * **Each entry is `structuredClone`d first, and that is load-bearing.**
 * Core's reader rebuilds every node with a NULL PROTOTYPE (see
 * `internal/storage/append-only-projection.ts` — `Object.create(null)` for
 * objects, `Object.setPrototypeOf(…, null)` for arrays), which defeats an
 * inherited `toJSON` gadget on the read path exactly as it does on the write
 * path. The consequence is easy to miss: `Array.isArray` still answers
 * `true`, but the array has no `.slice` — so handing an entry straight to
 * {@link projectHumanActionRecord} throws
 * `TypeError: values.slice is not a function` from `audit/limits.ts`'s
 * `boundedList`, NOT a classified refusal. `structuredClone` re-hydrates
 * ordinary prototypes without reviving a gadget (it never consults
 * `toJSON` and never walks a prototype chain), and unlike a
 * `JSON.parse(JSON.stringify(...))` round-trip it cannot quietly turn a
 * `-0` into `0` behind the narrowing layer's back.
 *
 * An unterminated LAST line is tolerated and logged — that is a process that
 * died mid-append, and it is the one loss this rebuild accepts rather than
 * failing over. The same fragment mid-stream is data loss, not a torn tail,
 * and Core throws for it regardless of this callback.
 */
async function readTrailIndexRows(
  directory: string,
  logger: Core.M3LLogger,
): Promise<readonly M3LHumanActionIndexInput[]> {
  const stream = new Core.M3LAppendOnlyStream({ directory });
  const rows: M3LHumanActionIndexInput[] = [];
  for await (const entry of stream.read({
    onTruncatedTail: (segment) => {
      logger.warning(TORN_TAIL_MESSAGE, {
        droppedBytes: segment.byteLength,
        segmentIndex: segment.segmentIndex,
        segmentCount: segment.segmentCount,
      });
    },
  })) {
    const record = projectHumanActionRecord(
      structuredClone(entry) as unknown as M3LHumanActionRecord,
    );
    rows.push(projectHumanActionIndexInput(record));
  }
  return rows;
}

/**
 * Truncates the index and reinserts `rows`, inside ONE `BEGIN IMMEDIATE`
 * transaction — the single place both entry points below write, so the
 * atomicity claim in this module's own `@packageDocumentation` has exactly
 * one implementation to hold true of.
 */
function truncateAndInsert(
  store: M3LConsoleStore,
  rows: readonly M3LHumanActionIndexInput[],
): number {
  return store.transaction((unit) => {
    unit.audit.deleteAll();
    return unit.audit.insertAll(rows);
  });
}

/**
 * What {@link rebuildHumanActionIndex} and
 * {@link rebuildHumanActionIndexOnBoot} both need.
 *
 * @example
 * ```ts
 * const options: RebuildHumanActionIndexOptions = {
 *   directory: resolveHumanActionAuditRoot(process.env),
 *   store,
 *   logger,
 * };
 * ```
 */
export interface RebuildHumanActionIndexOptions {
  /**
   * The trail's segment directory — the SAME answer
   * `buildHumanActionAuditPort` writes to, which is why both reach it
   * through `boot/human-action-audit.ts`'s `resolveHumanActionAuditRoot`.
   * A missing directory reads as an empty trail, not as a failure.
   */
  readonly directory: string;
  /**
   * The opened store. The full {@link M3LConsoleStore} rather than a bare
   * repository: the truncate and the reinsert must share one transaction,
   * and `transaction()` is what hands out a unit bound to it.
   */
  readonly store: M3LConsoleStore;
  /** The logger the rebuild reports through. */
  readonly logger: Core.M3LLogger;
}

/**
 * Rebuilds the index from the trail, unconditionally:
 * `deleteAll()` + `insertAll()` inside one transaction.
 *
 * Safe to run against a populated index — that is the point of the truncate,
 * and what makes repeated calls idempotent rather than cumulative.
 *
 * @param options - See {@link RebuildHumanActionIndexOptions}.
 * @returns The number of rows inserted, which equals the number of intact
 *   trail entries read.
 * @throws {@link "../errors/console-error.js".M3LConsoleError}
 *   `ERR_CONSOLE_AUDIT_RECORD_INVALID` when a trail line is not a
 *   human-action record, or a store error from the transaction. Either way
 *   NOTHING is written: the whole trail is read before the transaction
 *   opens.
 * @throws {@link Core.M3LAppendOnlyStreamReadError} when a line is malformed,
 *   oversized, or a segment sequence is missing — surfaced rather than
 *   swallowed, so a corrupt trail is never quietly indexed as a prefix.
 *
 * @example
 * ```ts
 * const rows = await rebuildHumanActionIndex({ directory, store, logger });
 * ```
 */
export async function rebuildHumanActionIndex(
  options: RebuildHumanActionIndexOptions,
): Promise<number> {
  const rows = await readTrailIndexRows(options.directory, options.logger);
  return truncateAndInsert(options.store, rows);
}

/**
 * The boot trigger: rebuilds the index when — and only when — it is EMPTY
 * and the trail is not. Never throws.
 *
 * **Why that condition, and not "every boot".** An unconditional rebuild is
 * `O(trail)` on every start, forever, and the trail is append-only and
 * unbounded. This condition is bounded and fires in exactly the two states
 * that need it:
 *
 * 1. A database opened fresh (or restored) beside a trail that outlived it.
 * 2. **After a `CHECK`-widening migration.** `store/migrations/human-actions.ts`'s
 *    v7 and v8 are `DROP` + recreate, and they were justified as loss-free
 *    partly because nothing wrote the table. X7c ended that, so the
 *    empty-table state such a migration leaves behind is now precisely this
 *    trigger — which is why a future kind-widening migration may still drop
 *    and recreate instead of needing a copy-through.
 *
 * **Why it never throws.** The index is derived; a console that cannot
 * rebuild it must still boot and serve, exactly as an index-write failure at
 * request time does not fail the operator's action (`boot/audit-index.ts`).
 * The failure is logged at `error` with the cause — a loud degradation, never
 * a silent swallow — and the trail, which is authoritative, is untouched
 * either way.
 *
 * @param options - See {@link RebuildHumanActionIndexOptions}.
 * @returns The number of rows inserted; `0` when the rebuild was skipped or
 *   failed.
 *
 * @example
 * ```ts
 * await rebuildHumanActionIndexOnBoot({ directory, store, logger });
 * ```
 */
export async function rebuildHumanActionIndexOnBoot(
  options: RebuildHumanActionIndexOptions,
): Promise<number> {
  try {
    if (options.store.audit.count() > 0) return 0;
    const rows = await readTrailIndexRows(options.directory, options.logger);
    if (rows.length === 0) return 0;
    const inserted = truncateAndInsert(options.store, rows);
    options.logger.info(REBUILT_MESSAGE, { rows: inserted });
    return inserted;
  } catch (cause) {
    // `errorFrom`, not `error(msg, { cause: getErrorMessage(cause) })`: this
    // log line is the ONLY record an operator gets of a failed rebuild, and
    // `errorFrom` promotes the outermost `code`/`context` and serializes the
    // whole recursive cause chain (redacted) rather than flattening it to one
    // message string. It never throws, which matters on a path whose entire
    // contract is that it does not.
    options.logger.errorFrom(cause, REBUILD_FAILED_MESSAGE);
    return 0;
  }
}
