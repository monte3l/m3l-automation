/**
 * `internal/aws/pagination` — a shared "repeated page cursor" guard for the
 * `aws/dynamodb` and `aws/s3` page generators (`queryItems`, `scanSegment`,
 * `listObjects`). Each of those generators loops
 * `do { … } while (cursor !== undefined)`, driven entirely by a cursor the
 * SDK response hands back (`LastEvaluatedKey`/`NextContinuationToken`). A
 * misbehaving SDK, mock, or local endpoint that returns the same defined
 * cursor forever turns that loop into an unbounded spin — this guard bounds
 * *that* case by treating the cursor value itself as the progress witness
 * (unlike `internal/polling/progress.ts`'s {@link ProgressTracker}, there is
 * no caller-supplied witness function to sample; the cursor IS the witness).
 * Scope is deliberately narrow: only two consecutive identical observations
 * trip it — a longer alternating cycle (`a → b → a → …`) is not detected,
 * since a repeated cursor is the only shape that's unconditionally
 * pathological (a cycle could coincidentally be legitimate paging state).
 *
 * Private to `internal/`; never re-exported through a public barrel.
 */

import { M3LNoProgressError } from "../polling/errors.js";

/** A page cursor — a plain continuation token, or a composite key object. */
type PageCursor = string | Record<string, unknown>;

/**
 * The `stalledAttempts` value pagination guards report to
 * {@link M3LNoProgressError}. Fixed at `1`, not caller-configurable — unlike
 * the opt-in `maxStalledAttempts` on `M3LPollerOptions`/
 * `M3LRetryRunnerOptions`, a page cursor guard has no witness/threshold
 * option and trips on the very first repeated cursor.
 */
const PAGINATION_STALL_THRESHOLD = 1;

/**
 * A stateful guard that trips when the same page cursor is observed twice in
 * a row.
 *
 * Instantiate one fresh guard per generator invocation (call
 * {@link createPageCursorGuard} once at the top of the generator function
 * body, outside its page loop) so concurrent invocations of the same
 * generator track progress independently — mirrors
 * `internal/polling/progress.ts`'s {@link ProgressTracker} per-call-frame
 * instantiation convention.
 */
export interface PageCursorGuard {
  /**
   * Observe the cursor that is about to drive the next page fetch.
   *
   * A `undefined` cursor is always a no-op (the loop is ending normally,
   * regardless of prior history). A defined cursor identical to the
   * previously observed defined cursor throws; a defined cursor that differs
   * updates the guard's baseline and does not throw.
   *
   * @param cursor - The cursor about to be used for the next page, or
   *   `undefined` when the current page was the last one.
   * @throws {@link M3LNoProgressError} when `cursor` equals the previously
   *   observed defined cursor.
   */
  readonly check: (cursor: PageCursor | undefined) => void;
}

/**
 * Converts a `bigint` to a tagged string so {@link JSON.stringify} never
 * throws on it — its default behavior on an unconverted `bigint` is to throw
 * a `TypeError`. The `n` suffix distinguishes a serialized bigint from a
 * same-valued string or number, keeping the comparison sound.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}

/**
 * Serializes a cursor into a value stable enough to compare with `===`.
 *
 * A composite-key object cursor (e.g. DynamoDB's `LastEvaluatedKey`) must
 * compare equal regardless of its own key insertion order — the SDK gives no
 * guarantee two structurally identical keys serialize with the same key
 * order — so object cursors are normalized by sorting their own keys before
 * serializing. A `Uint8Array` nested inside the object serializes
 * deterministically as its own index-keyed JSON shape (`{"0":1,"1":2,...}`)
 * without special handling; a nested `bigint` needs {@link bigintReplacer} to
 * avoid a `TypeError`.
 */
function serializeCursor(cursor: PageCursor): string {
  if (typeof cursor === "string") {
    return cursor;
  }
  // Object.entries never yields two identical own keys, so a two-way
  // comparator (no equal-keys arm) suffices — a three-way comparator would
  // leave its unreachable "equal" arm permanently uncovered.
  const sortedEntries = Object.entries(cursor).sort(([left], [right]) =>
    left < right ? -1 : 1,
  );
  return JSON.stringify(sortedEntries, bigintReplacer);
}

/**
 * Creates a fresh {@link PageCursorGuard}, isolated from any other guard
 * instance.
 *
 * @returns A new guard with its own independent baseline/attempt state.
 * @example
 * ```ts
 * import { createPageCursorGuard } from "./pagination.js";
 *
 * const guard = createPageCursorGuard();
 * let cursor: string | undefined = "token-1";
 * guard.check(cursor); // baseline — does not throw
 * guard.check(cursor); // same cursor again — throws M3LNoProgressError
 * ```
 */
export function createPageCursorGuard(): PageCursorGuard {
  let previous: string | undefined;
  let attempts = 0;

  return {
    check(cursor: PageCursor | undefined): void {
      if (cursor === undefined) {
        return;
      }

      attempts += 1;
      const serialized = serializeCursor(cursor);

      if (previous !== undefined && serialized === previous) {
        throw new M3LNoProgressError(
          "pagination cursor did not advance between pages",
          { attempts, stalledAttempts: PAGINATION_STALL_THRESHOLD },
        );
      }

      previous = serialized;
    },
  };
}
