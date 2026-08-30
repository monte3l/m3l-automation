/**
 * `internal/storage/append-only-projection` — proves the structure of an
 * entry handed to `M3LAppendOnlyStream.append` and rebuilds it as the
 * library's own prototype-free copy: the only object the writer ever
 * serializes (ADR-0061, X7 slice 2).
 *
 * Library-internal; never re-exported through a public barrel.
 *
 * `append()` is a public method, so the value reaching it is whatever the
 * caller passed — a static `M3LAppendOnlyEntry` annotation proves nothing at
 * runtime. Serializing that object directly fails in two ways, and this
 * module exists to close both:
 *
 * - `JSON.stringify` **returns `undefined`** (it does not throw) for a plain
 *   object whose `toJSON()` returns `undefined`, and interpolating that into
 *   a template literal launders it into the nine-character text `undefined` —
 *   a line no JSON reader can consume, appended while `append()` resolves;
 * - `JSON.stringify` dispatches an **inherited** `toJSON`, so a gadget planted
 *   on `Object.prototype` rewrites the record of an entry the caller believed
 *   it had handed over. `Object.freeze` is no defence there: the property is
 *   not an own property of the entry.
 *
 * The repair is the one `core/checkpoint/M3LCheckpointStore.ts` already
 * applies to a checkpoint definition, and the agent's own
 * `decision-log-projection.ts` to a decision-log entry: read the graph
 * **once**, accept only an allowlist of value shapes, and rebuild every node
 * the library will serialize with a **null prototype** — objects via
 * `Object.create(null)`, arrays via `Object.setPrototypeOf(…, null)`. A
 * null-prototype array still serializes as a JSON array (`JSON.stringify`
 * branches on `IsArray`, not on the prototype), so detaching it costs
 * nothing and closes the one gap the checkpoint store documents as an
 * accepted scope limit: with `Array.prototype` left in place, an
 * `Object.prototype.toJSON` gadget is still reachable from every projected
 * array.
 *
 * Nothing here names a key or a value read out of the caller's input: an
 * entry carries payload, and its own key names are payload too. Every
 * failure names the field `"entry"` and the violation kind only.
 */

import type { M3LError } from "../../core/errors/index.js";
import { isDangerousKey } from "../../core/security/DangerousKeys.js";
import { isArray, isPlainObject } from "../../core/utils/guards.js";

/**
 * How deep a projected entry may nest before it is rejected.
 *
 * 512 is the ceiling `core/checkpoint/M3LCheckpointStore.ts` already applies
 * to a checkpoint definition (`DEFINITION_MAX_DEPTH`), reused here so the two
 * caller-supplied JSON graphs this library walks are bounded identically. It
 * is generous enough for any realistic audit record and small enough that the
 * recursion below cannot overflow the call stack. It is also what bounds a
 * **circular** entry: a cycle has no depth of its own, so the cap is what
 * turns "unbounded recursion" into a loud, immediate rejection.
 */
const ENTRY_MAX_DEPTH = 512;

/**
 * Builds the caller-side boundary error for a field and violation kind.
 *
 * The factory is supplied by the owner so this module never has to name a
 * public class it does not own. It is handed a violation kind only — never a
 * key or a value read out of the caller's entry.
 */
export type AppendOnlyProjectionFailure = (
  field: string,
  violation: string,
) => M3LError;

/**
 * Seals one freshly built projection node: no prototype, then frozen.
 *
 * Dropping the prototype is the load-bearing half. `JSON.stringify` looks
 * `toJSON` up the prototype chain, so a node inheriting from
 * `Object.prototype` (directly, or through `Array.prototype`) is still a
 * forgery surface even when every value in it was proven here. A node with no
 * prototype has nothing to inherit.
 */
function detached<T extends object>(value: T): T {
  Object.setPrototypeOf(value, null);
  Object.freeze(value);
  return value;
}

/**
 * Projects one array node, element by element.
 *
 * The length is captured **once** and the walk is indexed rather than
 * `for...of`: `Array.isArray` passes for a real array whose own
 * `Symbol.iterator` has been overridden, and `length` is itself a `Proxy`
 * trap surface, so an iterator-driven walk (or a re-read `length`) can yield
 * a different sequence than the one that was bounded. A hole in a sparse
 * array reads as `undefined` and is rejected by {@link projectValue} — an
 * audit record with a gap in it is a caller mistake, not a value to persist.
 */
function projectArray(
  value: readonly unknown[],
  depth: number,
  failure: AppendOnlyProjectionFailure,
): readonly unknown[] {
  const length = value.length;
  const projected: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    projected.push(projectValue(value[index], depth, failure));
  }
  return detached(projected);
}

/**
 * Projects one plain-object node onto a fresh `Object.create(null)` map.
 *
 * An own `__proto__` / `constructor` / `prototype` key is rejected rather
 * than copied: such a key reaches this library only from parsed JSON or a
 * deliberately built object, and copying it forward would carry a
 * prototype-pollution vector into every reader that later parses the line
 * back into an object. Own **symbol** keys are rejected too — they are
 * invisible to JSON, so accepting them would silently drop a field from an
 * audit record, and silent loss is the one outcome an audit stream may never
 * produce.
 */
function projectObject(
  value: Readonly<Record<string, unknown>>,
  depth: number,
  failure: AppendOnlyProjectionFailure,
): Readonly<Record<string, unknown>> {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw failure("entry", "symbol-key");
  }
  const projected: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(value)) {
    if (isDangerousKey(key)) {
      throw failure("entry", "dangerous-key");
    }
    projected[key] = projectValue(value[key], depth, failure);
  }
  return detached(projected);
}

/**
 * Projects one value of any depth, accepting only what JSON can carry back
 * out unchanged: `null`, a **finite** number, a string, a boolean, an array,
 * or a plain object.
 *
 * Everything else is a caller-side violation rather than something to coerce.
 * `undefined`, a function and a symbol all vanish under `JSON.stringify` (or
 * become `null` inside an array); a non-finite number becomes `null`; a
 * `bigint` throws from the serializer; and a class instance would serialize
 * through whatever `toJSON` it carries. Each would make the persisted line
 * disagree with the entry the caller handed over, which for an audit stream
 * is a defect, not a convenience.
 *
 * @param value - The value to prove and rebuild.
 * @param depth - The depth of the node this value sits in.
 * @param failure - Builds the error thrown for a rejected value.
 */
function projectValue(
  value: unknown,
  depth: number,
  failure: AppendOnlyProjectionFailure,
): unknown {
  if (value === null || typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw failure("entry", "non-finite-number");
    }
    return value;
  }
  if (typeof value !== "object") {
    // `undefined`, a `bigint`, a function and a symbol all land here.
    throw failure("entry", "unsupported-value-type");
  }
  if (depth >= ENTRY_MAX_DEPTH) {
    throw failure("entry", "too-deeply-nested");
  }
  if (isArray(value)) {
    return projectArray(value, depth + 1, failure);
  }
  if (!isPlainObject(value)) {
    throw failure("entry", "not-a-plain-object");
  }
  return projectObject(value, depth + 1, failure);
}

/**
 * Proves `entry` is a plain object of persistable values and returns the
 * library's own detached, null-prototype copy of it — the only object the
 * caller's stream ever serializes.
 *
 * @param entry - The value handed to `M3LAppendOnlyStream.append`.
 * @param failure - Builds the error thrown for a rejected entry; it is given
 *   the violation kind only, never a key or a value.
 * @returns A frozen, null-prototype rebuild of `entry`.
 * @throws Whatever `failure` builds when `entry` is not a plain object, or
 *   holds a value at any depth that JSON cannot carry back out unchanged.
 */
export function projectAppendOnlyEntry(
  entry: unknown,
  failure: AppendOnlyProjectionFailure,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(entry)) {
    throw failure("entry", "not-a-plain-object");
  }
  return projectObject(entry, 0, failure);
}
