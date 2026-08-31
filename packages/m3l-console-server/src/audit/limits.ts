/**
 * `audit/limits` — the caps a human-action audit record is bounded by, and the
 * code-point-safe truncation that enforces them (X7, ADR-0070).
 *
 * Split out of `record.ts` so the cap arithmetic and the machinery that
 * applies it sit together, apart from the record SHAPE they bound: `record.ts`
 * declares what a human-action entry is, this module holds every runtime check
 * and clamp that proves an incoming one really is that. The split is also what
 * keeps both files inside the repository's 25,000-byte file budget — the
 * narrowing layer landed here for that reason, and belongs here because
 * bounding a record and narrowing it are the same job seen from two sides.
 *
 * The only import is the console's error class: every refusal raised here
 * carries `ERR_CONSOLE_AUDIT_RECORD_INVALID`, the caller-fault half of the
 * audit trail's two codes (see {@link refuseRecord}). Nothing here reaches
 * `runs/`, `sessions/` or `auth/` — the `audit/` eslint zone forbids it, and
 * {@link isInlineArtifactRefText} is structural for exactly that reason.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";

/**
 * How many parameter names one record may carry.
 *
 * A parameter NAME is caller-influenced input landing in a durable audit
 * file, so both its count and its length are bounded here rather than
 * wherever the trail is later read.
 *
 * The four caps below are chosen JOINTLY, so that a record sitting at every
 * one of them still serializes below `Core.M3L_APPEND_ONLY_MAX_LINE_BYTES`
 * (65,536). That ceiling is a hard maximum inside the Core primitive and
 * cannot be configured away, and slice 5 makes an unauditable action a
 * REFUSED one — so a record inside its own spec that could not be appended
 * would refuse a legal input. The arithmetic, in serialized BYTES (one entry
 * costs its `JSON.stringify` form, the two surrounding quotes included, plus
 * one separating comma):
 *
 * - names: 64 x (258 + 1) = 16,576
 * - refs:  32 x (514 + 1) = 16,480
 * - joint: 33,056 — roughly half of the 65,536 ceiling
 *
 * The remaining ~32,000 bytes cover the record's other nine fields (see
 * `M3LHumanActionRecord` in `record.ts` for what they are and why they are
 * small in practice), every field key, the braces and the trailing newline.
 * The sum holds for ANY input because the per-entry caps count the ceiling's
 * own unit. A CHARACTER cap could not: one character costs 1-6 bytes escaped,
 * so 64 names of 256 all-escaped characters reach ~98,000 on their own — and a
 * name is a key of the operator's own request body, so that is reachable
 * input. Beyond the margin the append still fails LOUDLY — Core refuses the
 * over-long line and `stream.ts` maps that to
 * `ERR_CONSOLE_AUDIT_WRITE_FAILED` — rather than writing a mangled entry.
 *
 * Changing any one of these four numbers means redoing the sum above.
 *
 * @see {@link MAX_PARAMETER_NAME_BYTES}, {@link MAX_PARAMETER_REFS} and
 *   {@link MAX_PARAMETER_REF_BYTES} — the other three terms of that sum.
 *
 * @example
 * ```ts
 * import { MAX_PARAMETER_NAMES } from "./audit/limits.js";
 *
 * MAX_PARAMETER_NAMES; // 64
 * ```
 */
export const MAX_PARAMETER_NAMES = 64;

/**
 * How many serialized bytes one parameter name may cost; a longer name keeps
 * a whole-code-point prefix. 256 ASCII characters plus the two quotes
 * `JSON.stringify` writes around them, so escaping buys fewer of them.
 *
 * @see {@link MAX_PARAMETER_NAMES} — the four caps are chosen JOINTLY against
 *   Core's line ceiling, so changing this number means redoing that sum.
 *
 * @example
 * ```ts
 * import { MAX_PARAMETER_NAME_BYTES } from "./audit/limits.js";
 *
 * MAX_PARAMETER_NAME_BYTES; // 258
 * ```
 */
export const MAX_PARAMETER_NAME_BYTES = 258;

/**
 * How many ADR-0068 references one record may carry.
 *
 * @see {@link MAX_PARAMETER_NAMES} — the four caps are chosen JOINTLY against
 *   Core's line ceiling, so changing this number means redoing that sum.
 *
 * @example
 * ```ts
 * import { MAX_PARAMETER_REFS } from "./audit/limits.js";
 *
 * MAX_PARAMETER_REFS; // 32
 * ```
 */
export const MAX_PARAMETER_REFS = 32;

/**
 * How many serialized bytes one reference may cost; a longer ref keeps a
 * whole-code-point prefix. 512 ASCII characters plus the two quotes: ample
 * for an ADR-0068 `file` envelope (~130 characters), which is a POINTER. An
 * `inline` envelope is not bounded here at all — it is refused outright by
 * `record.ts` (see {@link isInlineArtifactRefText}), because its `value` IS
 * the parameter content and no prefix of a value is a reference to it.
 *
 * @see {@link MAX_PARAMETER_NAMES} — the four caps are chosen JOINTLY against
 *   Core's line ceiling, so changing this number means redoing that sum.
 *
 * @example
 * ```ts
 * import { MAX_PARAMETER_REF_BYTES } from "./audit/limits.js";
 *
 * MAX_PARAMETER_REF_BYTES; // 514
 * ```
 */
export const MAX_PARAMETER_REF_BYTES = 514;

/** What the two quotes `JSON.stringify` writes around every string cost. */
const QUOTE_BYTES = 2;

/** The serialized cost of one code point, its surrounding quotes removed. */
function codePointBytes(codePoint: string): number {
  return Buffer.byteLength(JSON.stringify(codePoint), "utf8") - QUOTE_BYTES;
}

/**
 * Truncates one entry to at most `maxBytes` of its serialized form, cutting
 * only on a whole-code-point boundary.
 *
 * The budget is spent in BYTES rather than in characters, and that choice is
 * load-bearing twice over. It is what makes the joint cap arithmetic in
 * {@link MAX_PARAMETER_NAMES} hold for any input: the ceiling this budget
 * feeds is Core's 65,536-byte LINE limit, so a cap counted in the ceiling's
 * own unit sums exactly, while a character cap does not sum at all — one
 * character costs between 1 and 6 bytes once `JSON.stringify` escapes it, so
 * 256 characters can bill anywhere from 258 to ~1,538 bytes and a
 * character-capped record could exceed the line limit by an order of
 * magnitude on input an operator can simply type. And it is what the loop
 * below can measure honestly: escaping is decided per code point, so the cost
 * of the parts sums to exactly the cost of the whole, and a running total is
 * an exact count rather than an estimate that has to be re-checked.
 *
 * The cut lands on a whole code point for the same durability reason.
 * `String.prototype.slice` cuts on a UTF-16 CODE UNIT: a budget expiring
 * inside an astral character leaves a lone surrogate on a durable file, and
 * `JSON.stringify` escapes one rather than rejecting it, so the mangling
 * persists silently until the trail is read back. Iterating the string yields
 * code points, so the prefix kept is always valid text. An entry already
 * inside the budget is returned verbatim.
 *
 * Module-private: {@link boundedList} is the only caller, and the record layer
 * reaches the budget through it.
 *
 * @param value - The entry to bound.
 * @param maxBytes - The serialized-byte budget, quotes included.
 * @returns `value` when it already fits, else its longest whole-code-point
 *   prefix that does.
 */
function boundedEntry(value: string, maxBytes: number): string {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes) {
    return value;
  }

  let used = QUOTE_BYTES;
  let kept = "";
  for (const codePoint of value) {
    const cost = codePointBytes(codePoint);
    if (used + cost > maxBytes) break;
    used += cost;
    kept += codePoint;
  }
  return kept;
}

/**
 * Whether one `parameterRefs` entry is an ADR-0068 `inline` envelope — a
 * reference that carries the parameter VALUE instead of pointing at it.
 *
 * `M3LSessionArtifactRef`'s `inline` arm is `{ kind: "inline", value }`, so an
 * encoded inline ref persists the parameter content into the audit trail: the
 * one thing `M3LHumanActionRecord`'s shape exists to make unrepresentable.
 * The check is STRUCTURAL rather than a call into `sessions/artifacts.ts`
 * because `audit/` may not import `sessions/` (the eslint zone): an audit
 * trail that imported the subsystems it audits would invert the dependency it
 * exists to observe.
 *
 * The rule is deliberately narrow — an entry qualifies only when it parses as
 * JSON yielding a non-null, non-array OBJECT whose `kind` is exactly
 * `"inline"`. References are free-form strings today and a future encoding
 * need not be JSON at all, so refusing every entry that fails to parse would
 * be a breaking overreach; a JSON primitive, a JSON array and a `kind` that
 * merely contains the word are all legal references.
 *
 * `record.ts` applies this BEFORE {@link boundedEntry}: a budget-truncated
 * inline envelope no longer parses as JSON, so a check applied afterwards
 * would wave through exactly the entries whose payloads are largest.
 *
 * Module-private: {@link refuseInlineRef} is the only caller, because the
 * refusal — not the predicate — is what the record layer needs.
 *
 * @param value - The reference entry to inspect.
 * @returns `true` when the entry is an inline envelope, else `false`.
 */
function isInlineArtifactRefText(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Not JSON at all: an opaque reference string, which stays legal.
    return false;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  return "kind" in parsed && parsed.kind === "inline";
}

/**
 * Refuses one record, naming WHERE the offending value sat and WHAT kind of
 * thing it was — never the value itself.
 *
 * An error message travels further than the audit segment it describes (logs,
 * HTTP responses, tickets), so a refusal that quoted the value would leak it
 * down a wider channel than the one being closed. `typeof` is enough to
 * diagnose the caller's mistake.
 *
 * The code is `ERR_CONSOLE_AUDIT_RECORD_INVALID`, NOT
 * `ERR_CONSOLE_AUDIT_WRITE_FAILED`: every refusal here is a caller shape
 * violation caught before any filesystem call, whereas the write code is
 * classified as a retryable 503 ("the trail may be writable again on the next
 * attempt"). Sharing one code would tell an operator to check the disk over
 * what is a console bug or a malformed request.
 *
 * @param where - Where the offending value sat, e.g. `"parameterRefs entry 0"`.
 * @param value - The offending value; only its `typeof` is ever read.
 * @param why - Why the record may not carry it; defaults to the shape rule.
 * @returns Never — this function always throws.
 *
 * @example
 * ```ts
 * import { refuseRecord } from "./audit/limits.js";
 *
 * refuseRecord("detail", "oops"); // throws ERR_CONSOLE_AUDIT_RECORD_INVALID
 * ```
 */
export function refuseRecord(
  where: string,
  value: unknown,
  why = "which the audit record may not carry",
): never {
  throw new M3LConsoleError(
    "ERR_CONSOLE_AUDIT_RECORD_INVALID",
    `human-action audit record ${where} is a ${typeof value}, ${why}`,
  );
}

/**
 * Whether `value` is a non-null, non-array object — what a record's containers
 * (`target`, `detail`, the caller's `parameters`) must be.
 *
 * @param value - The container to inspect.
 * @returns `true` for a plain object, `false` for anything else.
 *
 * @example
 * ```ts
 * import { isPlainRecord } from "./audit/limits.js";
 *
 * isPlainRecord({ attempt: 1 }); // true
 * isPlainRecord([1, 2]); // false
 * ```
 */
export function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` is an array.
 *
 * `Array.isArray` narrows an `unknown` to `any[]`, which would reintroduce
 * `any` into every element read below; this predicate narrows to
 * `readonly unknown[]` instead, so entries stay `unknown` until checked.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Narrows one verbatim-copied string field, refusing anything else.
 *
 * @param value - The field value as it arrived.
 * @param where - Where it sat, for the refusal message.
 * @returns `value`, narrowed to `string`.
 * @throws `ERR_CONSOLE_AUDIT_RECORD_INVALID` when it is not a string.
 *
 * @example
 * ```ts
 * import { stringField } from "./audit/limits.js";
 *
 * stringField("corr-1", "correlationId"); // "corr-1"
 * ```
 */
export function stringField(value: unknown, where: string): string {
  if (typeof value !== "string") refuseRecord(where, value);
  return value;
}

/**
 * Narrows one verbatim-copied number field.
 *
 * Non-finite values and negative zero are refused for the same reason a
 * `detail` number is (see {@link detailScalar}): `JSON.stringify` writes
 * non-finite numbers as `null` and serialises `-0` back out as `0`, so the
 * persisted line would disagree with the record it claims to be.
 *
 * @param value - The field value as it arrived.
 * @param where - Where it sat, for the refusal message.
 * @returns `value`, narrowed to a finite, non-negative-zero `number`.
 * @throws `ERR_CONSOLE_AUDIT_RECORD_INVALID` when it is not one.
 *
 * @example
 * ```ts
 * import { numberField } from "./audit/limits.js";
 *
 * numberField(Date.now(), "atMs"); // the timestamp
 * ```
 */
export function numberField(value: unknown, where: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Object.is(value, -0)
  ) {
    refuseRecord(where, value);
  }
  return value;
}

/**
 * Narrows one verbatim-copied boolean field, refusing anything else.
 *
 * @param value - The field value as it arrived.
 * @param where - Where it sat, for the refusal message.
 * @returns `value`, narrowed to `boolean`.
 * @throws `ERR_CONSOLE_AUDIT_RECORD_INVALID` when it is not a boolean.
 *
 * @example
 * ```ts
 * import { booleanField } from "./audit/limits.js";
 *
 * booleanField(false, "operatorEmailDeclared"); // false
 * ```
 */
export function booleanField(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") refuseRecord(where, value);
  return value;
}

/**
 * Narrows one field against a closed set of literals, returning the MEMBER
 * that matched rather than casting the caller's value into the union — the
 * returned string is then one this layer owns, not one it merely believes.
 *
 * @param value - The field value as it arrived.
 * @param members - The closed set the field declares.
 * @param where - Where it sat, for the refusal message.
 * @returns The matching member.
 * @throws `ERR_CONSOLE_AUDIT_RECORD_INVALID` when nothing matches.
 *
 * @example
 * ```ts
 * import { memberField } from "./audit/limits.js";
 *
 * memberField("auto", new Set(["auto", "confirmed"]), "posture"); // "auto"
 * ```
 */
export function memberField<T extends string>(
  value: unknown,
  members: ReadonlySet<T>,
  where: string,
): T {
  for (const member of members) {
    if (member === value) return member;
  }
  refuseRecord(where, value);
}

/**
 * Detaches one freshly built node: an own, non-callable `toJSON`, then frozen.
 *
 * The `toJSON` shadow is the load-bearing half, and it is why `record.ts`
 * rebuilds at all. `JSON.stringify` looks `toJSON` up the PROTOTYPE chain, so
 * a gadget planted on `Object.prototype` (reachable from a plain object and,
 * through `Array.prototype`, from every array) can forge the bytes a record
 * serializes to — and `Object.freeze` is no defence there, because the
 * property is not an own property. An own `toJSON` holding `undefined` is not
 * callable, so the serializer skips the hook entirely and writes the node's
 * own fields. It is non-enumerable, so it changes neither `Object.keys` nor
 * what is persisted.
 *
 * `internal/storage/append-only-projection.ts` closes the same hole inside
 * the Core primitive by dropping the prototype outright. That is not open to
 * this layer: a projected record is handed back to CONSUMERS, and a
 * prototype-free array is neither iterable nor `.slice`-able — the projection
 * has to stay idempotent over its own output.
 *
 * @param node - The freshly built node to detach.
 * @returns `node`, frozen and with its own non-callable `toJSON`.
 *
 * @example
 * ```ts
 * import { frozen } from "./audit/limits.js";
 *
 * const detail = frozen({ attempt: 1 });
 * ```
 */
export function frozen<T extends object>(node: T): T {
  Object.defineProperty(node, "toJSON", {
    value: undefined,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.freeze(node);
  return node;
}

/**
 * One list after clamping: the surviving entries, how many the count cap
 * dropped, and whether the survivors fill that cap exactly.
 *
 * @example
 * ```ts
 * import type { M3LBoundedList } from "./audit/limits.js";
 *
 * const empty: M3LBoundedList = {
 *   values: [],
 *   dropped: 0,
 *   saturated: false,
 * };
 * ```
 */
export interface M3LBoundedList {
  /** The entries that survived both caps, frozen. */
  readonly values: readonly string[];
  /** How many entries the COUNT cap discarded; `0` when nothing was dropped. */
  readonly dropped: number;
  /** Whether the surviving entries fill the count cap exactly. */
  readonly saturated: boolean;
}

/**
 * Rebuilds one string list, capped by count and by per-entry serialized bytes.
 *
 * An over-long entry keeps its prefix rather than being dropped: which
 * parameter was supplied is the fact audited, and a truncated name carries it
 * while a hole carries nothing. A per-entry truncation is NOT counted in
 * `dropped`, which reports discarded ENTRIES only.
 *
 * `values` is typed `unknown` on purpose, and the CONTAINER is checked before
 * its contents. A caller reaching the port through a cast (or from plain
 * JavaScript) can hand over a string, a number or nothing at all; without the
 * container check that caller gets a raw `TypeError` ("values.slice is not a
 * function") which no handler classifying on `M3LConsoleError` can render.
 * Without the entry check a non-string entry would be neither truncated nor
 * refused and would land on the segment carrying a parameter VALUE. Core's
 * own projection cannot catch that — a nested plain object is a legal entry
 * value there — so this is the only layer where "scalars only" can be
 * enforced.
 *
 * Validation runs over the SLICED entries, i.e. exactly what was read: an
 * array whose own `slice` returns something other than its elements is
 * validated on what `slice` returned, and a `slice` returning a non-array is
 * refused outright. Entries are read by INDEX rather than mapped, because
 * `Array.prototype.map` skips holes — `["a", , "b"]` would otherwise project
 * a `null` that never met the entry check.
 *
 * @param values - The list as it arrived, from inside or outside the types.
 * @param maxCount - How many entries may survive.
 * @param maxBytes - The per-entry serialized-byte budget.
 * @param field - The field name, for refusal messages.
 * @param guard - An extra per-entry check run on a well-typed entry BEFORE it
 *   is byte-budgeted, for a rule truncation would destroy the subject of (see
 *   {@link refuseInlineRef}).
 * @returns The clamped list and its drop count.
 * @throws `ERR_CONSOLE_AUDIT_RECORD_INVALID` for a non-array container or a
 *   non-string entry.
 *
 * @example
 * ```ts
 * import { boundedList, MAX_PARAMETER_NAMES } from "./audit/limits.js";
 *
 * boundedList(["queueUrl"], MAX_PARAMETER_NAMES, 258, "parameterNames");
 * ```
 */
export function boundedList(
  values: unknown,
  maxCount: number,
  maxBytes: number,
  field: string,
  guard?: (entry: string, where: string) => void,
): M3LBoundedList {
  if (!isUnknownArray(values)) refuseRecord(field, values);
  const read: unknown = values.slice(0, maxCount);
  if (!isUnknownArray(read)) refuseRecord(`${field} slice()`, read);

  const bounded: string[] = [];
  for (let index = 0; index < read.length; index += 1) {
    const value: unknown = read[index];
    const where = `${field} entry ${String(index)}`;
    if (typeof value !== "string") refuseRecord(where, value);
    guard?.(value, where);
    bounded.push(boundedEntry(value, maxBytes));
  }

  return {
    values: frozen(bounded),
    // A hostile own `slice` can return MORE entries than the array holds; a
    // negative drop count would be a nonsense the trail asserts about itself.
    dropped: Math.max(0, values.length - bounded.length),
    saturated: bounded.length >= maxCount,
  };
}

/**
 * Refuses a `parameterRefs` entry that is an ADR-0068 `inline` envelope.
 *
 * An inline ref carries the parameter VALUE rather than pointing at it, so
 * persisting one writes the value into the trail. Passed to
 * {@link boundedList} as its `guard`, so it runs BEFORE {@link boundedEntry}:
 * a budget-truncated envelope no longer parses as JSON, so the entries with
 * the largest payloads would evade a later check.
 *
 * @param entry - The reference entry, already known to be a string.
 * @param where - Where it sat, for the refusal message.
 * @throws `ERR_CONSOLE_AUDIT_RECORD_INVALID` when the entry is inline.
 *
 * @example
 * ```ts
 * import { refuseInlineRef } from "./audit/limits.js";
 *
 * refuseInlineRef("sess-1/step-1.json", "parameterRefs entry 0"); // returns
 * ```
 */
export function refuseInlineRef(entry: string, where: string): void {
  if (isInlineArtifactRefText(entry)) {
    refuseRecord(
      where,
      entry,
      "which is an ADR-0068 `inline` envelope carrying the parameter value itself",
    );
  }
}

/** Whether `value` belongs to the closed scalar set `detail` declares. */
function isDetailScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Narrows one `detail` value to the closed scalar set, refusing the numbers
 * JSON cannot carry back out.
 *
 * `typeof NaN === "number"`, so the scalar test alone admits `NaN`, both
 * infinities and `-0`. Core's own projection refuses all four two layers
 * later (`internal/storage/append-only-projection.ts`), which would reach the
 * operator as `ERR_CONSOLE_AUDIT_WRITE_FAILED` — "the trail is unwritable" —
 * for what is usually a console-authored value (a `durationMs` computed over
 * a missing timestamp, a `-0` falling out of `Math.round(-0.4)`). Refused
 * here it is the caller fault it actually is, and the message can name the
 * key. `-0` is refused rather than normalised to `+0`: normalising is the
 * same "the persisted line disagrees with the record" defect, moved one layer
 * up.
 *
 * @param value - The detail value as it arrived.
 * @param key - The detail key it sat under, for the refusal message.
 * @returns `value`, narrowed to the closed scalar set.
 * @throws `ERR_CONSOLE_AUDIT_RECORD_INVALID` for a non-scalar, a non-finite
 *   number or a negative zero.
 *
 * @example
 * ```ts
 * import { detailScalar } from "./audit/limits.js";
 *
 * detailScalar(1, "attempt"); // 1
 * ```
 */
export function detailScalar(
  value: unknown,
  key: string,
): string | number | boolean {
  const where = `detail value '${key}'`;
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || Object.is(value, -0))
  ) {
    refuseRecord(where, value, "which JSON cannot carry back out unchanged");
  }
  if (!isDetailScalar(value)) refuseRecord(where, value);
  return value;
}
