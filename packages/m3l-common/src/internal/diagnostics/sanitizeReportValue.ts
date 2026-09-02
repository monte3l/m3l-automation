/**
 * `internal/diagnostics/sanitizeReportValue` — the sanitization pipeline for
 * a value embedded in a persisted run report
 * (`core/diagnostics/run-report.ts`): cycle/depth-breaking normalization
 * (`Map`/`Set`/`toJSON` handling), name-based redaction, and URL scrubbing,
 * run in that order so a value can never reach the report unredacted.
 *
 * Extracted verbatim out of `run-report.ts` itself, which sat at exactly its
 * `check:file-budget` baseline (65,630 bytes) with no headroom left for a
 * later field addition — this module exists to relieve that ceiling, not to
 * change the pipeline's behavior.
 *
 * Private: not re-exported through any public barrel.
 *
 * @packageDocumentation
 */

import { isDangerousKey } from "../../core/security/index.js";
import {
  redactSensitiveLogValue,
  type M3LSecretNamesPort,
} from "../../core/logging/redact.js";
import { scrubUrlsInText } from "../../core/diagnostics/format-error.js";

/**
 * Placeholder substituted for a value {@link sanitizeValue} could not safely
 * redact, so a failure on any step of that pipeline degrades to a known-safe
 * string rather than ever risking unredacted data reaching the report.
 */
const UNREDACTABLE_PLACEHOLDER = "[unredactable value omitted]";

/**
 * Maximum traversal depth for {@link normalizeForRedaction}, mirroring
 * `safeJsonStringify`'s own default so a ~20k-deep acyclic value degrades to
 * `"[Max Depth]"` at the same depth instead of overflowing the stack.
 */
const MAX_NORMALIZE_DEPTH = 10;

/**
 * Narrows `value` to an object exposing a callable own or inherited `toJSON`
 * — the same method `JSON.stringify` itself would invoke, and the boundary a
 * class author uses to declare "this is my serialized (and often redacted)
 * form" (e.g. `Date`, or a credentials class that omits secret fields from
 * its `toJSON`).
 */
function hasToJSON(value: object): value is { toJSON: () => unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === "function";
}

/**
 * Invokes `value.toJSON()`, guarding the call itself: a throwing `toJSON`
 * degrades to {@link UNREDACTABLE_PLACEHOLDER} for just this node rather than
 * propagating — so one hostile `toJSON` cannot blank out sibling data that
 * would otherwise redact cleanly, and never breaks `M3LRunReporter.build`'s
 * "never throws" contract.
 */
function invokeToJSONSafely(value: { toJSON: () => unknown }): unknown {
  try {
    return value.toJSON();
  } catch {
    return UNREDACTABLE_PLACEHOLDER;
  }
}

/**
 * Converts a `Map` into a plain, key-preserving `Record`, so key-based
 * redaction (`isSensitiveKey`, applied later by `redactSensitiveLogValue`)
 * still sees e.g. `apiKey` as an object **key** rather than as an element of
 * a `[key, value]` pair array — the shape `safeJsonStringify` produces, which
 * defeats key-based redaction entirely (a documented regression this
 * function exists to fix). A non-string key has no representable key name;
 * rather than falling back to the leaking pair-array form, such an entry is
 * dropped. A dangerous key (`__proto__`/`constructor`/`prototype`) is also
 * dropped rather than assigned — bracket-assigning `"__proto__"` onto a
 * plain object literal mutates its prototype instead of adding a data
 * property, the same hazard `redactSensitiveLogValue` guards against on its
 * own clone.
 */
function normalizeMapEntries(
  map: ReadonlyMap<unknown, unknown>,
  depth: number,
  visited: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of map.entries()) {
    if (typeof key !== "string" || isDangerousKey(key)) continue;
    result[key] = normalizeForRedaction(entryValue, depth + 1, visited);
  }
  return result;
}

/**
 * Converts a non-`toJSON`, non-`Map`/`Set` object into a plain `Record`,
 * dropping dangerous keys for the same prototype-pollution reason as
 * {@link normalizeMapEntries}.
 */
function normalizePlainObject(
  value: object,
  depth: number,
  visited: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (isDangerousKey(key)) continue;
    result[key] = normalizeForRedaction(
      (value as Record<string, unknown>)[key],
      depth + 1,
      visited,
    );
  }
  return result;
}

/**
 * Reduces a `Set` to a non-reversible cardinality marker (`"[set: N items]"`)
 * instead of an array of its raw members. A `Set` holds values with no key
 * names attached — unlike a `Map`, whose entries at least carry a string key
 * {@link normalizeMapEntries} preserves for key-based redaction — so an array
 * of its elements is unredactable by a key-name-based redactor:
 * `isSensitiveKey`/`redactSensitiveLogValue` only ever inspects object
 * *keys*, and a bare array element has none, so a secret riding in a `Set`
 * would reach the persisted report completely unredacted. Emitting the
 * element count keeps the diagnostic signal (how many entries existed)
 * without carrying any of the — possibly sensitive — contents forward. Under
 * an earlier baseline (both before this module's normalize-before-redact
 * reordering, and before `redactSensitiveLogValue` itself gained `Map`/`Set`
 * support), `redactSensitiveLogValue(new Set(...))` returned `{}` (dropping
 * every member outright) — this is no worse than that baseline, and is
 * strictly more informative than it while remaining just as leak-free.
 *
 * `set.size` is read through an accessor a hostile `Set` subclass (or a
 * `Proxy` wrapping one) can override to return arbitrary content — including
 * a string carrying a secret — rather than a genuine cardinality. The result
 * is validated as a non-negative integer before interpolation; anything else
 * degrades to `0` rather than being interpolated verbatim.
 */
function describeSetCardinality(set: ReadonlySet<unknown>): string {
  const rawSize: unknown = set.size;
  const size =
    typeof rawSize === "number" && Number.isInteger(rawSize) && rawSize >= 0
      ? rawSize
      : 0;
  return `[set: ${size} item${size === 1 ? "" : "s"}]`;
}

/**
 * Dispatches an already cycle-checked, depth-checked object `value` to the
 * shape-specific normalizer: a `toJSON`-bearing object is replaced by its
 * (guarded) `toJSON()` result — recursed into, since that result can itself
 * contain a `Map`/`Set`/cycle — ahead of the `Array`/`Map`/`Set`/plain-object
 * checks, mirroring the precedence native `JSON.stringify` gives `toJSON`. A
 * `Set` is reduced to a cardinality marker via {@link describeSetCardinality}
 * rather than an array of its members — see that function's TSDoc for why an
 * array of key-less elements is unredactable.
 */
function normalizeObjectShape(
  value: object,
  depth: number,
  visited: WeakSet<object>,
): unknown {
  if (hasToJSON(value)) {
    return normalizeForRedaction(invokeToJSONSafely(value), depth + 1, visited);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForRedaction(item, depth + 1, visited));
  }
  if (value instanceof Map) {
    return normalizeMapEntries(value, depth, visited);
  }
  if (value instanceof Set) {
    return describeSetCardinality(value);
  }
  return normalizePlainObject(value, depth, visited);
}

/**
 * Converts a non-object scalar (or `undefined`) into its JSON-safe form.
 * Extracted purely to keep {@link normalizeForRedaction}'s own complexity
 * under the project's lint threshold; the exhaustive `typeof` switch covers
 * every non-`"object"` result so the "object" case itself is unreachable in
 * practice — {@link normalizeForRedaction} never calls this for an object.
 */
function scalarToRedactable(value: unknown): unknown {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return String(value);
    case "symbol":
      return value.description ?? "";
    case "function":
      return "";
    case "undefined":
      return null;
    case "object":
      return null;
  }
}

/**
 * Recursively converts `value` into a plain, JSON-safe, key-preserving
 * structure ahead of redaction — the cycle/depth-breaking, `Map`/`Set`
 * -normalizing, `toJSON`-respecting replacement for the
 * `JSON.parse(safeJsonStringify(value))` pre-pass this module used
 * previously. That pre-pass broke cycles and depth safely, but
 * `safeJsonStringify` flattens `Map` to `[[key, value], …]` pairs and `Set`
 * to `[value, …]` arrays — turning a sensitive `Map` key like `apiKey` into
 * an array *element*, which `isSensitiveKey` (keyed lookups only) can never
 * see, so the secret rode straight through redaction. This function performs
 * the same cycle/depth-breaking directly (its own `WeakSet`/depth counter,
 * not `safeJsonStringify`'s), while converting `Map` → `Record` (keeping
 * string keys as actual object keys) and `Set` → a non-reversible cardinality
 * marker (see {@link describeSetCardinality}) rather than an array of its
 * members — a `Set`'s elements carry no key names at all, so unlike a `Map`
 * entry there is no key-preserving form to convert them to; emitting them as
 * array elements would still defeat key-based redaction the same way the
 * `Map`-as-pairs shape does. It also invokes an object's own or inherited
 * `toJSON()` (guarded against a
 * throwing implementation) ahead of enumerating its properties — the
 * opposite of what the previous pre-pass did: `safeJsonStringify` never
 * calls `toJSON` at all, so a class using `toJSON` as its redaction boundary
 * (returning fewer fields than the instance actually has) was previously
 * *bypassed* and fully enumerated instead, exposing exactly the fields
 * `toJSON` was declared to omit.
 */
function normalizeForRedaction(
  value: unknown,
  depth: number,
  visited: WeakSet<object>,
): unknown {
  if (depth > MAX_NORMALIZE_DEPTH) return "[Max Depth]";
  if (value === null) return null;
  if (typeof value !== "object") return scalarToRedactable(value);

  // `value` is narrowed to a non-null `object` here — every other `typeof`
  // result already returned above via `scalarToRedactable`. `visited` is a
  // true SEEN-set for the whole traversal — deliberately never removed once
  // added, even after this node's subtree finishes normalizing. Deleting on
  // unwind (this module's own pre-fix baseline) turns `visited` into a
  // PATH-set instead: a perfectly acyclic but *shared* subgraph (the same
  // object reachable via more than one route, e.g. fan-out N × depth M) is
  // then re-expanded from scratch at every reference, which is exponential in
  // the fan-out and OOMs the process well before any genuine cycle would ever
  // be hit — strictly worse than the "[Circular]" marker below, since an OOM
  // is not catchable by `sanitizeValue`'s `try`, defeating the whole
  // never-throw contract. Collapsing a shared (non-cyclic) reference to the
  // same marker a genuine cycle gets is an accepted, documented tradeoff:
  // both are "already normalized, don't re-expand".
  if (visited.has(value)) return "[Circular]";
  visited.add(value);
  return normalizeObjectShape(value, depth, visited);
}

/**
 * Recursively applies {@link scrubUrlsInText} to every string leaf reachable
 * from `value` — an array element or plain-object property value — leaving
 * every other type unchanged. Deliberately narrower than
 * `format-error.ts`'s own `scrubUrlsInValue`: by the time {@link sanitizeValue}
 * calls this, `value` has already passed through {@link normalizeForRedaction}
 * and `redactSensitiveLogValue`, both of which, IN THIS PIPELINE'S ORDERING,
 * only ever hand this function a plain JSON shape
 * (`string`/`number`/`boolean`/`null`/array/plain record) —
 * `normalizeForRedaction` already stripped any `Map`/`Set`/class
 * instance/`toJSON` away before `redactSensitiveLogValue` is reached here;
 * `redactSensitiveLogValue` called directly elsewhere (outside this
 * pipeline) does now handle `Map`/`Set` itself, recursively, see
 * `core/logging/redact.ts`.
 *
 * Exists so `archive`, `timeline`, and `environment` get the exact same URL
 * scrub `redactContext` (`format-error.ts`) already applies to a serialized
 * error's `context` — a presigned URL's `X-Amz-Signature`/`X-Amz-Credential`
 * query params are a working bearer credential, and neither is a "sensitive
 * key name" `redactSensitiveLogValue` would otherwise recognize.
 *
 * Scrubs object **keys**, not just values: {@link normalizeForRedaction}
 * turns a `Map`'s entries into object keys (`normalizeMapEntries`), so a URL
 * used as a `Map`/plain-object key would otherwise reach the report verbatim
 * even though the identical URL riding as a *value* gets scrubbed — an
 * asymmetry a results-keyed-by-URL map (an ordinary automation shape) would
 * hit in practice. `isDangerousKey` is re-checked here (on the pre-scrub
 * key) for the same prototype-pollution reason {@link normalizeMapEntries}/
 * {@link normalizePlainObject} already check it on construction — those two
 * upstream call sites already drop such a key before it reaches here, so this
 * is defense-in-depth, not the primary guard. If scrubbing collapses two
 * distinct keys to the same string (e.g. two differently-signed URLs whose
 * origin+pathname happen to match), the later entry wins: `Object.entries`
 * preserves insertion order, so this is a plain, deterministic
 * last-write-wins overwrite, never a silent drop of both.
 */
function scrubUrlsInSanitizedValue(value: unknown): unknown {
  if (typeof value === "string") return scrubUrlsInText(value);
  if (Array.isArray(value)) {
    return value.map((entry) => scrubUrlsInSanitizedValue(entry));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isDangerousKey(key)) continue;
      result[scrubUrlsInText(key)] = scrubUrlsInSanitizedValue(entry);
    }
    return result;
  }
  return value;
}

/**
 * Redacts `value` for safe embedding into a persisted `M3LRunReport`.
 * Runs, strictly in this order: (1) cycle/depth-breaking and `Map`/`Set`/
 * `toJSON` normalization ({@link normalizeForRedaction}), (2) name-based
 * redaction (`redactSensitiveLogValue`), (3) URL scrubbing
 * ({@link scrubUrlsInSanitizedValue}) — mirroring the exact order
 * `format-error.ts`'s `redactContext` already applies to a serialized error's
 * `context`, for the same reason: `redactSensitiveLogValue` has no cycle
 * guard and throws `RangeError` on a genuinely circular value (or a
 * ~20k-deep acyclic one), so it must run after step (1), never before; and
 * running the URL scrub before redaction can strip a `key=` anchor
 * immediately adjacent to a scrub stop character (e.g. `token="secret"`),
 * stranding an unredacted value with no anchor left for the name-based pass
 * to recognize — so redaction must have the second-to-last word, and the URL
 * scrub only ever trims an already-redacted, already-safe result. Guarded
 * end-to-end so `M3LRunReporter.build` still never throws: any failure
 * at any step returns {@link UNREDACTABLE_PLACEHOLDER}, never the raw value.
 * Shared by `archive`, `timeline`, and `environment` so none of the three can
 * bypass redaction (or the URL scrub) on its way into the persisted report.
 */
export function sanitizeValue(
  value: unknown,
  secrets: M3LSecretNamesPort | undefined,
): unknown {
  try {
    const acyclic = normalizeForRedaction(value, 0, new WeakSet<object>());
    const redacted = redactSensitiveLogValue(acyclic, { secrets });
    return scrubUrlsInSanitizedValue(redacted);
  } catch {
    return UNREDACTABLE_PLACEHOLDER;
  }
}

/**
 * Sanitizes `value` and guarantees a `string` result — the typed counterpart
 * of `sanitizeValue(value) as string`. When `sanitizeValue` returns a
 * non-string (which happens when redaction of a non-string input yields a
 * non-string shape, e.g. an object whose `toJSON` returns a record), the
 * function falls back to {@link UNREDACTABLE_PLACEHOLDER} rather than
 * coercing with `String()` — coercion would silently produce `"[object Object]"`
 * for an object, which corrupts the field without any signal that the value
 * could not be stringified cleanly.
 */
export function sanitizeString(
  value: unknown,
  secrets: M3LSecretNamesPort | undefined,
): string {
  const sanitized = sanitizeValue(value, secrets);
  return typeof sanitized === "string" ? sanitized : UNREDACTABLE_PLACEHOLDER;
}
