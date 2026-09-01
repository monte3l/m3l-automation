/**
 * `core/orchestration/step-reference` — the addressable step-result
 * reference grammar (promoted from the console's X6 workbench-sessions
 * module, slice 2, ADR-0068).
 *
 * A reference is caller-facing text of the shape
 * `step-<ordinal>.output(.<ident> | [<index>] | ["<quoted>"])*`, naming a
 * value nested inside a previously recorded step's output. {@link
 * parseStepReference} and {@link formatStepReference} are exact inverses of
 * each other for every valid input; {@link resolveStepReference} walks a
 * parsed reference through an arbitrary `unknown` value, refusing the three
 * prototype-pollution vector property names outright (this repo's standard
 * `isDangerousKey` guard, applied here to a new untrusted-path surface).
 *
 * @packageDocumentation
 */

import { isDangerousKey } from "../security/index.js";
import { isObject } from "../utils/index.js";

import { M3LStepReferenceError } from "./M3LStepReferenceError.js";
import { assertStepReferenceShape } from "./shape.js";

/** The literal prefix every valid reference text starts with. */
const STEP_PREFIX = "step-";

/** The literal that must immediately follow the ordinal. */
const OUTPUT_SUFFIX = ".output";

/** A property-name path segment (the `.ident` or `["quoted"]` forms). */
interface M3LStepReferencePropertySegment {
  /** Discriminant tag. */
  readonly kind: "property";
  /** The property name, decoded from either the dotted or bracket-quoted form. */
  readonly name: string;
  /** Mutually exclusive with {@link M3LStepReferenceIndexSegment.index} — always absent on a property segment. */
  readonly index?: never;
}

/** An array-index path segment (the `[<digits>]` form). */
interface M3LStepReferenceIndexSegment {
  /** Discriminant tag. */
  readonly kind: "index";
  /** The zero-based array index. */
  readonly index: number;
  /** Mutually exclusive with {@link M3LStepReferencePropertySegment.name} — always absent on an index segment. */
  readonly name?: never;
}

/**
 * One path segment of a {@link M3LStepReference}: either a property-name
 * segment or an array-index segment, tagged by `kind`. Reach it through
 * {@link M3LStepReference.segments}.
 *
 * @example
 * ```ts
 * import { parseStepReference } from "@m3l-automation/m3l-common/core";
 *
 * const { segments } = parseStepReference("step-1.output.Queues[0]");
 * for (const segment of segments) {
 *   console.log(segment.kind === "property" ? segment.name : segment.index);
 * }
 * ```
 */
export type M3LStepReferenceSegment =
  M3LStepReferencePropertySegment | M3LStepReferenceIndexSegment;

/**
 * A parsed step-output reference: the 1-based ordinal of the step whose
 * output it names, plus the path segments walking into that output.
 *
 * @example
 * ```ts
 * import type { M3LStepReference } from "@m3l-automation/m3l-common/core";
 *
 * const reference: M3LStepReference = {
 *   ordinal: 1,
 *   segments: [{ kind: "property", name: "userId" }],
 * };
 * ```
 */
export interface M3LStepReference {
  /** The 1-based ordinal of the step whose recorded output this names. */
  readonly ordinal: number;
  /** The path segments walking into that step's output value. */
  readonly segments: readonly M3LStepReferenceSegment[];
}

/** Returns `true` when `char` is an ASCII digit. */
function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/** Returns `true` when `char` is a valid identifier character (`[A-Za-z0-9_$]`). */
function isIdentChar(char: string | undefined): boolean {
  return (
    char !== undefined &&
    ((char >= "a" && char <= "z") ||
      (char >= "A" && char <= "Z") ||
      isDigit(char) ||
      char === "_" ||
      char === "$")
  );
}

/** Escapes `name` for embedding inside a bracket-quoted segment: every `\` becomes `\\` and every `"` becomes `\"`, the exact inverse of {@link parseQuotedSegment}'s decoding. */
function escapeQuotedSegment(name: string): string {
  return name.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Returns `true` when `name` re-parses as a valid dotted identifier segment. */
function isIdentSafe(name: string): boolean {
  if (name.length === 0 || isDigit(name[0])) return false;
  for (const char of name) {
    if (!isIdentChar(char)) return false;
  }
  return true;
}

/** Throws the standard reference-invalid error, naming the malformed source text and the reason. */
function failReference(text: string, reason: string): never {
  throw new M3LStepReferenceError(
    `malformed step reference "${text}": ${reason}`,
  );
}

/**
 * The maximum digit-run length accepted for an ordinal or index literal,
 * checked on the raw digit string BEFORE calling `Number()` — comfortably
 * under `Number.MAX_SAFE_INTEGER`'s 16-digit range, so every legitimate
 * value still parses, while an arbitrarily long digit run (which would
 * otherwise silently produce `Infinity` or a precision-lossy value) is
 * rejected instead.
 */
const MAX_DIGIT_RUN_LENGTH = 15;

/** Throws when `digits` exceeds {@link MAX_DIGIT_RUN_LENGTH}, before any `Number()` conversion is attempted. */
function checkDigitRunLength(
  text: string,
  digits: string,
  label: string,
): void {
  if (digits.length > MAX_DIGIT_RUN_LENGTH) {
    failReference(
      text,
      `${label} digit run longer than ${String(MAX_DIGIT_RUN_LENGTH)} digits`,
    );
  }
}

/** Throws when `name` is one of the forbidden prototype-pollution vector names, fail-closed at parse time. */
function checkSegmentNameSafe(text: string, name: string): void {
  if (isDangerousKey(name)) {
    failReference(
      text,
      `refuses to parse the forbidden property name "${name}"`,
    );
  }
}

/**
 * A minimal single-pass cursor over reference text, tracking a private read
 * position. `parseStepReference` and its helpers are the only consumers —
 * every mutation happens through an instance method (never a raw parameter
 * assignment), so the read position always stays internally consistent.
 */
class ReferenceCursor {
  readonly #text: string;
  #pos = 0;

  constructor(text: string) {
    this.#text = text;
  }

  /** The current read position. */
  get position(): number {
    return this.#pos;
  }

  /** Returns `true` when the cursor has consumed the whole text. */
  atEnd(): boolean {
    return this.#pos >= this.#text.length;
  }

  /** Returns the character at the current position, or `undefined` at end of text. */
  peek(): string | undefined {
    return this.#text[this.#pos];
  }

  /** Returns `true` when `literal` appears starting at the current position. */
  startsWithHere(literal: string): boolean {
    return this.#text.startsWith(literal, this.#pos);
  }

  /** Advances the read position by `count` characters. */
  skip(count: number): void {
    this.#pos += count;
  }

  /** Consumes and returns the longest run of characters satisfying `predicate`, starting at the current position. */
  consumeWhile(predicate: (char: string | undefined) => boolean): string {
    const start = this.#pos;
    while (predicate(this.peek())) this.#pos++;
    return this.#text.slice(start, this.#pos);
  }
}

/** Parses the `step-<ordinal>` prefix, advancing `cursor` past it. Returns the ordinal. */
function parseOrdinal(text: string, cursor: ReferenceCursor): number {
  if (!cursor.startsWithHere(STEP_PREFIX)) {
    failReference(text, `must start with "${STEP_PREFIX}"`);
  }
  cursor.skip(STEP_PREFIX.length);

  const digits = cursor.consumeWhile(isDigit);
  if (digits.length === 0) failReference(text, "missing ordinal digits");
  if (digits[0] === "0") {
    failReference(text, "ordinal must be >= 1 with no leading zero");
  }
  checkDigitRunLength(text, digits, "ordinal");
  return Number(digits);
}

/** Consumes the literal `.output` suffix, or throws. */
function expectOutputSuffix(text: string, cursor: ReferenceCursor): void {
  if (!cursor.startsWithHere(OUTPUT_SUFFIX)) {
    failReference(text, `expected "${OUTPUT_SUFFIX}" after the ordinal`);
  }
  cursor.skip(OUTPUT_SUFFIX.length);
}

/**
 * Parses a bracket-quoted property segment (`["..."]`), assuming `cursor`
 * sits just past the opening `["`. Implements the grammar's
 * `quoted = '"' ( char | '\"' | '\\' )* '"'` escape handling: `\"` decodes
 * to a literal `"` and `\\` decodes to a literal `\` in the resulting
 * `name`; any other backslash-escape sequence, or an unterminated quote,
 * throws.
 */
function parseQuotedSegment(
  text: string,
  cursor: ReferenceCursor,
): M3LStepReferencePropertySegment {
  let name = "";
  for (;;) {
    if (cursor.atEnd()) failReference(text, "unterminated quoted segment");
    const char = cursor.peek();
    if (char === '"') {
      cursor.skip(1); // consume closing quote
      break;
    }
    if (char === "\\") {
      cursor.skip(1);
      const escaped = cursor.peek();
      if (escaped === undefined) {
        failReference(text, "unterminated quoted segment");
      }
      if (escaped !== '"' && escaped !== "\\") {
        failReference(
          text,
          `invalid escape sequence "\\${escaped}" in quoted segment`,
        );
      }
      name += escaped;
      cursor.skip(1);
      continue;
    }
    name += char;
    cursor.skip(1);
  }
  if (cursor.peek() !== "]") {
    failReference(text, 'expected "]" after quoted segment');
  }
  cursor.skip(1); // consume closing bracket
  checkSegmentNameSafe(text, name);
  return { kind: "property", name };
}

/** Parses a numeric-index segment (`[<digits>]`), assuming `cursor` sits just past the opening `[`. */
function parseIndexSegment(
  text: string,
  cursor: ReferenceCursor,
): M3LStepReferenceIndexSegment {
  const digits = cursor.consumeWhile(isDigit);
  if (digits.length === 0) {
    failReference(text, "expected a numeric index inside [...]");
  }
  if (digits.length > 1 && digits[0] === "0") {
    failReference(text, "index must have no leading zero");
  }
  checkDigitRunLength(text, digits, "index");
  if (cursor.peek() !== "]") failReference(text, "unterminated bracket");
  cursor.skip(1); // consume closing bracket
  return { kind: "index", index: Number(digits) };
}

/** Parses a dotted property segment (`.ident`), assuming `cursor` sits just past the `.`. */
function parseDottedSegment(
  text: string,
  cursor: ReferenceCursor,
): M3LStepReferencePropertySegment {
  const name = cursor.consumeWhile(isIdentChar);
  if (name.length === 0) failReference(text, "empty property segment");
  if (isDigit(name[0])) {
    failReference(text, `ident segment cannot start with a digit: "${name}"`);
  }
  checkSegmentNameSafe(text, name);
  return { kind: "property", name };
}

/** Parses one path segment — dotted property, bracketed index, or bracket-quoted property. */
function parseSegment(
  text: string,
  cursor: ReferenceCursor,
): M3LStepReferenceSegment {
  const char = cursor.peek();
  if (char === ".") {
    cursor.skip(1);
    return parseDottedSegment(text, cursor);
  }
  if (char === "[") {
    cursor.skip(1);
    if (cursor.peek() === '"') {
      cursor.skip(1);
      return parseQuotedSegment(text, cursor);
    }
    return parseIndexSegment(text, cursor);
  }
  return failReference(
    text,
    `unexpected character "${char ?? ""}" at position ${String(cursor.position)}`,
  );
}

/**
 * Parses caller-facing reference text into a {@link M3LStepReference}.
 *
 * The grammar is `step-<ordinal>.output(.<ident> | [<index>] | ["<quoted>"])*`,
 * where `<ordinal>` matches `[1-9][0-9]*` (no leading zero, minimum 1).
 * Never returns a partial/best-effort result — any
 * malformed input, including trailing garbage after an otherwise-valid
 * prefix, throws rather than truncating at the failure point.
 *
 * @param text - The reference text to parse.
 * @returns The parsed reference.
 * @throws {@link M3LStepReferenceError} with code `ERR_STEP_REFERENCE_INVALID`
 *   when `text` does not match the grammar.
 * @example
 * ```ts
 * import { parseStepReference } from "@m3l-automation/m3l-common/core";
 *
 * const reference = parseStepReference("step-1.output.Queues[0]");
 * // { ordinal: 1, segments: [{ kind: "property", name: "Queues" }, { kind: "index", index: 0 }] }
 * ```
 */
export function parseStepReference(text: string): M3LStepReference {
  if (typeof text !== "string") {
    throw new M3LStepReferenceError(
      `text must be a string, got ${typeof text}`,
    );
  }

  const cursor = new ReferenceCursor(text);
  const ordinal = parseOrdinal(text, cursor);
  expectOutputSuffix(text, cursor);

  const segments: M3LStepReferenceSegment[] = [];
  while (!cursor.atEnd()) {
    segments.push(parseSegment(text, cursor));
  }

  return { ordinal, segments };
}

/**
 * Formats a {@link M3LStepReference} back into caller-facing reference text
 * — the exact inverse of {@link parseStepReference}. A property segment
 * formats as the dotted `.ident` form when its name would itself re-parse
 * as a valid identifier, and as the bracket-quoted `["..."]` form otherwise
 * (e.g. a name containing `:`). An index segment always formats as a
 * bracketed integer with no preceding dot.
 *
 * `reference` must round-trip through {@link parseStepReference}: every
 * screen the parser applies — the {@link isDangerousKey} prototype-pollution
 * guard on every property-segment name, the 15-digit run cap, and a
 * safe-integer check on both the ordinal and every index — is re-applied
 * here, on the same private helpers the parser uses, so this function can
 * never emit text the parser turns around and rejects.
 *
 * @param reference - The reference to format.
 * @returns The formatted reference text.
 * @throws {@link M3LStepReferenceError} with code `ERR_STEP_REFERENCE_INVALID`
 *   when `reference` is not a well-formed `M3LStepReference` — including a
 *   `segments` array containing a malformed element (not a plain object, an
 *   unrecognised `kind`, or a `name`/`index` of the wrong type for its
 *   `kind`) — or when it carries an ordinal/index/property-name value
 *   {@link parseStepReference} would refuse to produce.
 * @example
 * ```ts
 * import { formatStepReference } from "@m3l-automation/m3l-common/core";
 *
 * formatStepReference({
 *   ordinal: 2,
 *   segments: [{ kind: "property", name: "aws:cloudformation:stack" }],
 * }); // 'step-2.output["aws:cloudformation:stack"]'
 * ```
 */
export function formatStepReference(reference: M3LStepReference): string {
  const validated = assertStepReferenceShape(reference, "reference");

  if (!Number.isSafeInteger(validated.ordinal) || validated.ordinal < 1) {
    throw new M3LStepReferenceError(
      `ordinal must be a positive safe integer, got ${String(validated.ordinal)}`,
    );
  }

  let text = `${STEP_PREFIX}${String(validated.ordinal)}`;
  checkDigitRunLength(text, String(validated.ordinal), "ordinal");
  text += OUTPUT_SUFFIX;

  for (const segment of validated.segments) {
    if (segment.kind === "index") {
      const index = segment.index;
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new M3LStepReferenceError(
          `index must be a non-negative safe integer, got ${String(index)}`,
        );
      }
      const digits = String(index);
      checkDigitRunLength(`${text}[${digits}]`, digits, "index");
      text += `[${digits}]`;
    } else {
      const name = segment.name;
      checkSegmentNameSafe(text, name);
      text += isIdentSafe(name)
        ? `.${name}`
        : `["${escapeQuotedSegment(name)}"]`;
    }
  }
  return text;
}

/** Returns `true` when `value` can be walked into by a property-name segment (any non-null object, including arrays). */
function isWalkableByProperty(
  value: unknown,
): value is Record<string, unknown> {
  return isObject(value);
}

/**
 * Sentinel returned by a per-segment resolver to mean "well-formed but
 * absent — the caller should see `undefined`", distinct from every real
 * resolved value (including a legitimate `undefined`) by identity.
 */
const ABSENT: unique symbol = Symbol("step-reference-absent");

/**
 * Resolves one property-name segment against `current`, or {@link ABSENT}
 * when the property doesn't exist.
 *
 * `segment.name` is hoisted into a local on first read, then re-read once
 * more to confirm stability — a getter-backed `name` that returns a safe
 * value on one read and `"__proto__"` on the next would otherwise defeat
 * the {@link isDangerousKey} guard entirely (check the safe read, use the
 * dangerous one): a TOCTOU gap between the check and the use. Any observed
 * change between the two reads is rejected outright, since there is no way
 * to know which of the two values the caller actually intended; every
 * subsequent reference to the segment's name in this function then uses
 * the hoisted local, never `segment.name` again.
 */
function resolvePropertySegment(
  current: unknown,
  segment: M3LStepReferencePropertySegment,
): unknown {
  const name = segment.name;
  // A getter-backed `name` that returns a DIFFERENT value on a second read
  // than it did on the first is exactly the TOCTOU shape this guard exists
  // to defeat — reading once cannot tell which of the two values is the
  // "real" one, so any observed instability is treated as untrusted input
  // and rejected outright, before it ever reaches the dangerous-key check.
  if (segment.name !== name) {
    throw new M3LStepReferenceError(
      "refuses to walk a property segment whose name changed between reads",
    );
  }
  if (isDangerousKey(name)) {
    throw new M3LStepReferenceError(
      `refuses to walk the forbidden property name "${name}"`,
    );
  }
  if (!isWalkableByProperty(current)) {
    throw new M3LStepReferenceError(
      `cannot read property "${name}" of a non-object value`,
    );
  }
  try {
    return Object.hasOwn(current, name) ? current[name] : ABSENT;
  } catch (cause) {
    throw new M3LStepReferenceError(`reading property "${name}" threw`, {
      cause,
    });
  }
}

/**
 * Resolves one array-index segment against `current`, or {@link ABSENT}
 * when the index is out of bounds.
 *
 * `segment.index` is read exactly ONCE into a local (the same TOCTOU
 * discipline as {@link resolvePropertySegment}), and that local is required
 * to be an actual `number` and a safe non-negative integer BEFORE any bounds
 * check or array access is attempted. This closes an `Array.prototype`/
 * `Array` constructor leak: `array[segment.index]` is a property-key
 * coercion, which consults the index's `toString()` — not its `valueOf()` —
 * when the index is an object. An index whose `valueOf` reports `0` (passing
 * a naive numeric bounds check) but whose `toString` reports `"constructor"`
 * or an inherited method name like `"at"` would reach `Array.prototype`
 * undetected; requiring `typeof index === "number"` up front rejects any
 * such object outright, before it can be coerced into a property key.
 */
function resolveIndexSegment(
  current: unknown,
  segment: M3LStepReferenceIndexSegment,
): unknown {
  const index = segment.index;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    throw new M3LStepReferenceError(
      `index must be a non-negative safe integer, got ${String(index)}`,
    );
  }
  if (!Array.isArray(current)) {
    throw new M3LStepReferenceError(
      `cannot index [${String(index)}] into a non-array value`,
    );
  }
  const array: readonly unknown[] = current;
  try {
    return index < array.length ? array[index] : ABSENT;
  } catch (cause) {
    throw new M3LStepReferenceError(`reading index [${String(index)}] threw`, {
      cause,
    });
  }
}

/**
 * Walks `source` through `reference.segments`, returning the value the
 * reference names.
 *
 * Returns `undefined` when a segment names an absent-but-well-formed path
 * (a missing property, or an out-of-bounds array index). Throws when the
 * walk is impossible given the data actually present — e.g. indexing into a
 * non-array value, or reading a property off a non-object value — since
 * that means the reference no longer matches the data it names. Also
 * throws, before attempting any property access at every segment (not just
 * the first), when a property-name segment is exactly `__proto__`,
 * `constructor`, or `prototype` — the standard prototype-pollution vector
 * names ({@link isDangerousKey}).
 *
 * @param reference - The parsed reference to walk.
 * @param source - The value to walk, typically a step's recorded output.
 * @returns The resolved value, or `undefined` for an absent-but-well-formed path.
 * @throws {@link M3LStepReferenceError} with code `ERR_STEP_REFERENCE_INVALID`
 *   when `reference` is not a well-formed `M3LStepReference` — including a
 *   `segments` array containing a malformed element (not a plain object, an
 *   unrecognised `kind`, or a `name`/`index` of the wrong type for its
 *   `kind`), which is rejected outright rather than silently resolving to
 *   `undefined` — when the walk is impossible given the data actually
 *   present, or when a segment names a forbidden property.
 * @example
 * ```ts
 * import {
 *   parseStepReference,
 *   resolveStepReference,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const reference = parseStepReference("step-1.output.Queues[0]");
 * resolveStepReference(reference, { Queues: ["queue-a"] }); // "queue-a"
 * ```
 */
export function resolveStepReference(
  reference: M3LStepReference,
  source: unknown,
): unknown {
  const validated = assertStepReferenceShape(reference, "reference");
  let current: unknown = source;

  for (const segment of validated.segments) {
    const next =
      segment.kind === "property"
        ? resolvePropertySegment(current, segment)
        : resolveIndexSegment(current, segment);
    if (next === ABSENT) return undefined;
    current = next;
  }

  return current;
}
