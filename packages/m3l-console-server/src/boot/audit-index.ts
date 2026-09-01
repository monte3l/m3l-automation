/**
 * `boot/audit-index` — the ADR-0070 dual-store audit write path: the
 * projection from a JSONL trail entry to a `console_human_actions` index
 * row, and the composite {@link M3LHumanActionAuditPort} that writes both
 * (X7c).
 *
 * **Why `boot/`, and not `audit/`.** `eslint.config.js`'s ADR-0009 zone
 * table pins `src/audit/`'s `except` set at exactly `["audit", "errors"]`,
 * and `bin/check-eslint-zones.mjs:319` re-asserts that exact length — so an
 * `audit -> store` edge cannot be added without editing the gate and
 * permanently coupling the audit leaf to persistence. `src/boot/` is in no
 * zone's `target` (so it may import both `audit/` and `store/` with zero
 * config change) and in no zone's `except` (so only `main.ts` may import
 * it). A projection function must, by nature, see both vocabularies; this is
 * the only module that can legally see both. Same precedent
 * `boot/human-action-audit.ts` set for the audit gate itself.
 *
 * **The index is a LOSSY projection, not a mirror.**
 * {@link M3LHumanActionRecord} carries three fields
 * `console_human_actions` has no column for — `parameterNames`,
 * `parameterRefs` and `detail` — so the index cannot round-trip the trail.
 * It answers *who did what, when, with what outcome*; the JSONL trail
 * remains the only place a request's parameter names, its ADR-0068
 * references and the console's own detail map live. That asymmetry is what
 * makes ADR-0070's "the JSONL trail is the source of truth" load-bearing
 * rather than decorative, and it is why the rebuild path runs
 * trail → index and never the reverse.
 *
 * **The two vocabularies are separately declared, and can drift.**
 * `store/audit-repository-types.ts` duplicates `audit/record.ts`'s kind,
 * posture and outcome unions rather than importing them (the `store` zone
 * forbids the import). They are identical today, and
 * `tests/boot-audit-index.test.ts` locks that with `expectTypeOf` — a kind
 * added to one and not the other would otherwise compile here and fail at
 * the SQLite `CHECK` at runtime.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import type { M3LHumanActionAuditPort } from "../audit/port.js";
import type {
  M3LHumanActionRecord,
  M3LHumanActionTarget,
} from "../audit/record.js";
import { M3LConsoleError } from "../errors/console-error.js";
import type {
  M3LConsoleAuditRepository,
  M3LHumanActionIndexInput,
} from "../store/audit-repository.js";

/**
 * The `default`-branch escape hatch for {@link projectHumanActionIndexInput}'s
 * `switch`. The `never` parameter is the compile-time exhaustiveness proof —
 * adding an arm to {@link M3LHumanActionTarget} without a matching `case`
 * fails `tsc` here rather than at the SQLite `CHECK` in production — while the
 * cast inside reads the offending `kind` off the value so the thrown error
 * NAMES it instead of printing `[object Object]`. Reachable at runtime only
 * past a cast, which is exactly how `tests/boot-audit-index.test.ts` covers
 * it.
 */
function unhandledTargetKind(target: never): never {
  throw new M3LConsoleError(
    "ERR_CONSOLE_INTERNAL",
    `unhandled human-action target kind: ${String(
      (target as { readonly kind?: unknown }).kind,
    )}`,
  );
}

/**
 * Projects one JSONL trail entry into the row shape the SQLite index
 * accepts, renaming `target.{kind,id,scriptName}` to the index's flat
 * `targetKind`/`targetId`/`scriptName` and dropping the three fields that
 * have no column (see this module's own `@packageDocumentation`).
 *
 * A `switch` on `target.kind` rather than a spread: the index's own target
 * type is a discriminated union whose `script` arm alone carries a
 * `scriptName`, so the `script` case is the only one that may supply it and
 * every other case must pin it to `undefined`. Written this way, an
 * illegally-paired row cannot be constructed here at all — the repository's
 * runtime `requireValidTarget` guard and the table's trailing `CHECK` are the
 * second and third layers, not the first.
 *
 * @param record - The trail entry to project.
 * @returns The index row for `record`.
 * @throws {@link M3LConsoleError} `ERR_CONSOLE_INTERNAL` when `record.target`
 *   carries a `kind` outside {@link M3LHumanActionTarget}'s declared union —
 *   reachable only past a cast, and loud rather than silently indexing a row
 *   with a target the `CHECK` constraint would reject anyway.
 *
 * @example
 * ```ts
 * const input = projectHumanActionIndexInput(record);
 * repository.insert(input);
 * ```
 */
export function projectHumanActionIndexInput(
  record: M3LHumanActionRecord,
): M3LHumanActionIndexInput {
  // `action`, `posture` and `outcome` cross from `audit/record.ts`'s unions
  // into `store/audit-repository-types.ts`'s separately-declared ones by
  // structural assignability alone — the `expectTypeOf` lock in
  // `tests/boot-audit-index.test.ts` is what keeps that assignment honest.
  const common = {
    atMs: record.atMs,
    operator: record.operator,
    operatorEmailDeclared: record.operatorEmailDeclared,
    correlationId: record.correlationId,
    action: record.action,
    posture: record.posture,
    outcome: record.outcome,
  };
  const target: M3LHumanActionTarget = record.target;
  switch (target.kind) {
    case "script":
      return {
        ...common,
        targetKind: "script",
        targetId: target.id,
        scriptName: target.scriptName,
      };
    case "run":
    case "session":
    case "step":
    case "artifact":
      return {
        ...common,
        targetKind: target.kind,
        targetId: target.id,
        scriptName: undefined,
      };
    default:
      return unhandledTargetKind(target);
  }
}

/**
 * Constructor options for {@link createIndexedHumanActionAuditPort}.
 *
 * @example
 * ```ts
 * const options: IndexedHumanActionAuditPortOptions = {
 *   inner: streamPort,
 *   repository: store.audit,
 *   logger,
 * };
 * ```
 */
export interface IndexedHumanActionAuditPortOptions {
  /** The JSONL trail port — the source of truth, and the fatal half. */
  readonly inner: M3LHumanActionAuditPort;
  /** The SQLite audit index the entry is additionally projected into. */
  readonly repository: M3LConsoleAuditRepository;
  /** The logger an index-write failure is reported through, at `error`. */
  readonly logger: Core.M3LLogger;
}

/** The message an index-write failure is logged under; asserted by `tests/boot-audit-index.test.ts`. */
const INDEX_WRITE_FAILED_MESSAGE =
  "human-action audit index write failed; the JSONL trail is authoritative and a boot rebuild will recover this row";

/**
 * Wraps `inner` so every entry written to the JSONL trail is also projected
 * into the SQLite index — ADR-0070's dual-store audit, with the two halves
 * deliberately NOT symmetric:
 *
 * 1. **The trail write is awaited first, and stays fatal.** `inner.record()`
 *    rejects exactly as it did before this port existed, so an unauditable
 *    action is still refused and the index is never written for an action
 *    whose trail entry failed. That ordering is the contract, not an
 *    implementation detail — `tests/boot-audit-index.test.ts` locks it by
 *    asserting no index write is attempted after a stream failure.
 * 2. **The index write is a degradation, and is never fatal.** A failed
 *    insert is logged at `error` with the correlation id and the action, and
 *    `record()` resolves normally, so the operator's action succeeds. The
 *    index is a derived, rebuildable projection; failing a real action
 *    because a derived store hiccuped is strictly worse than the missing
 *    row, and `boot/audit-rebuild.ts`'s truncate-and-reinsert path is the
 *    recovery. This is a LOUD degradation, never a silent swallow: the
 *    `error` line carries everything needed to correlate the miss back to
 *    the trail entry that did land.
 *
 * @param options - See {@link IndexedHumanActionAuditPortOptions}.
 * @returns A port with {@link M3LHumanActionAuditPort}'s own contract: the
 *   same two error codes, thrown for the same two reasons, from the trail
 *   write alone.
 *
 * @example
 * ```ts
 * const port = createIndexedHumanActionAuditPort({
 *   inner: buildHumanActionAuditPort(process.env),
 *   repository: store.audit,
 *   logger,
 * });
 * await port.record(record);
 * ```
 */
export function createIndexedHumanActionAuditPort(
  options: IndexedHumanActionAuditPortOptions,
): M3LHumanActionAuditPort {
  const { inner, repository, logger } = options;
  return {
    async record(record: M3LHumanActionRecord): Promise<void> {
      // Fatal, and strictly first: the trail is the source of truth, so an
      // entry that never reached it must not appear in the index.
      await inner.record(record);
      try {
        repository.insert(projectHumanActionIndexInput(record));
      } catch (cause) {
        // Deliberately not rethrown — see this function's own TSDoc. The
        // action already happened as far as the trail is concerned; the only
        // thing lost is a queryable row, and it is recoverable.
        logger.error(INDEX_WRITE_FAILED_MESSAGE, {
          correlationId: record.correlationId,
          action: record.action,
          cause: Core.getErrorMessage(cause),
        });
      }
    },
  };
}
