/**
 * `core/logging/redact` — sensitive-value redaction helpers for log text and
 * structured log data.
 *
 * Net-new to `core/logging`. The sensitive-key *name list* used to decide
 * what to mask is intentionally independent of `core/security` — that
 * module's `DangerousKeys` targets an unrelated concern (prototype-pollution
 * vectors like `__proto__`, not secret field names). Where
 * {@link redactSensitiveLogValue} clones a caller-supplied object it *does*
 * reuse `core/security`'s `isDangerousKey` guard, for the same reason any
 * other untrusted-key clone does: a `__proto__`/`constructor`/`prototype`
 * own-key must never reach a bare `result[key] = …` assignment.
 *
 * @packageDocumentation
 */

import { isDangerousKey } from "../security/index.js";
import { isRedactableRecord } from "../../internal/logging/isRedactableRecord.js";

/** Replacement literal written in place of a redacted value. */
const REDACTED = "[REDACTED]";

/**
 * Placeholder substituted when a `Map`/`Set`-shaped value throws while
 * actually being iterated — e.g. `Object.create(Map.prototype)` or a
 * `Proxy` wrapping one, both of which pass `instanceof Map` but have no
 * real internal Map state. Degrades this one value rather than letting the
 * throw propagate and blank out every sibling field this call was also
 * redacting — the same "guard a hostile call, degrade to a safe placeholder
 * rather than propagate" pattern `run-report.ts`'s `invokeToJSONSafely`
 * already applies to a throwing `toJSON`.
 */
const UNREDACTABLE_COLLECTION = "[unredactable Map/Set omitted]";

/**
 * Writes a best-effort stderr diagnostic when a `Map`/`Set`-shaped value's
 * own iteration throws (see {@link UNREDACTABLE_COLLECTION}) — mirroring
 * `internal/logging/guardSecrets.ts`'s `reportRedactionFailure` convention
 * for the same class of structural redaction failure, but self-contained
 * here rather than imported: `guardSecrets.ts` already depends on this
 * file's own `M3LSecretNamesPort` type, and importing its value back in
 * would invert that layering. Wrapped in its own try/catch: a hostile
 * `cause` (a throwing `.stack`/`.message` getter) must not defeat the
 * diagnostic itself.
 */
function reportUnredactableCollection(
  kind: "Map" | "Set",
  cause: unknown,
): void {
  try {
    const detail =
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    process.stderr.write(
      `m3l-logging: redaction failed while iterating a ${kind}-shaped value: ${detail}\n`,
    );
  } catch {
    process.stderr.write(
      `m3l-logging: redaction failed while iterating a ${kind}-shaped value (unreadable failure detail)\n`,
    );
  }
}

/** The raw sensitive key names, each also stored as its `splitWords()` word list. */
const SENSITIVE_KEY_NAMES = [
  "token",
  "apiKey",
  "api_key",
  "password",
  "passwd",
  "pwd",
  "secret",
  "authorization",
  "auth",
  "accessKey",
  "secretKey",
  "sessionToken",
  "credential",
  "credentials",
  "privateKey",
] as const;

/**
 * Case-insensitive set of key *word sequences* considered sensitive by both
 * {@link redactSensitiveLogText} and {@link redactSensitiveLogValue}. Each
 * entry is stored as its lowercase word list (split on `_`/`-`/camelCase
 * boundaries) so a prefixed, hyphenated, or header-style variant — such as
 * `api-key`, `X-Api-Key`, or `x-amz-security-token` — is recognized as long
 * as it *contains* one of these word sequences contiguously, not only on an
 * exact whole-key match.
 */
const SENSITIVE_KEY_WORDS: readonly (readonly string[])[] =
  SENSITIVE_KEY_NAMES.map((key) => splitWords(key));

/**
 * The same sensitive names as {@link SENSITIVE_KEY_WORDS}, but concatenated
 * with no separator (`"apiKey"` → `"apikey"`). Used as a fallback when the
 * candidate key itself has no detectable word boundary (e.g. the
 * all-uppercase `APIKEY`), so `splitWords()` cannot segment it into `api`
 * + `key` for the word-run check to find.
 */
const SENSITIVE_KEY_CONCATENATED: ReadonlySet<string> = new Set(
  SENSITIVE_KEY_WORDS.map((words) => words.join("")),
);

/** Splits `key` into lowercase words on `_`/`-`/whitespace and camelCase boundaries. */
function splitWords(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-\s]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

/**
 * Returns whether `key` contains one of the sensitive word sequences as a
 * contiguous run of whole words — e.g. `X-Api-Key` contains the `api`,
 * `key` run (matching the `apiKey` entry), and `x-amz-security-token`
 * contains the standalone `token` word. Falls back to a normalized,
 * separator-free whole-key comparison for a key with no detectable word
 * boundary at all (e.g. `APIKEY`, which `splitWords()` cannot segment).
 */
function isSensitiveKey(key: string): boolean {
  const keyWords = splitWords(key);
  if (
    SENSITIVE_KEY_WORDS.some((sensitiveWords) =>
      containsWordRun(keyWords, sensitiveWords),
    )
  ) {
    return true;
  }
  return (
    keyWords.length === 1 && SENSITIVE_KEY_CONCATENATED.has(keyWords[0] ?? "")
  );
}

/** Returns whether `needle` occurs as a contiguous run within `haystack`. */
function containsWordRun(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

/**
 * Matches a bare (unquoted) `key=value` / `key: value` / `key="value"` pair.
 * The key class includes letters, digits, `_`, and `-` so hyphenated header
 * names (`X-Api-Key`, `x-amz-security-token`) are captured.
 *
 * The unquoted-value alternative is deliberately narrow: an optional,
 * case-insensitive auth-scheme prefix (`Bearer `/`Basic `/`Digest `/`Token `)
 * followed by exactly one whitespace-delimited token. This resolves a real
 * tension — `Authorization: Bearer abc123` must redact `Bearer abc123` as a
 * unit (the scheme prefix spans a space), but `token=abc123 user=alice`
 * must stop at the space so the unrelated `user=alice` pair is untouched.
 * On `Bearer abc123` the scheme group consumes `Bearer `, then the token
 * class consumes `abc123`. On `abc123 user=alice`, `abc123` is not a scheme
 * word, so the optional group is skipped and the token class alone matches
 * `abc123`, stopping before the space.
 *
 * The key class is left unbounded (`+`), guarded instead by a leading
 * negative lookbehind, `(?<![A-Za-z0-9_-])`, that excludes any candidate
 * match-start position itself preceded by another key-class character. An
 * unbounded key class immediately followed by a `[:=]` requirement that
 * keeps failing is the same catastrophic-backtracking shape
 * {@link EMBEDDED_SENSITIVE_PATTERN}'s own comment below describes: on a
 * long separator-free run of key-class characters (e.g. a base64url/JWT/hex
 * blob with no `:`/`=` anywhere inside it), the engine would otherwise
 * re-test the `[:=]` check at every shorter length from every interior
 * starting position — O(n²) total work. Measured through the public
 * {@link redactSensitiveLogText} path on such an adversarial blob: 65 KB
 * took ~3.9s and 130 KB ~15.6s (confirmed quadratic) with the fully
 * unbounded, unguarded pattern. The lookbehind eliminates those redundant
 * interior starting positions in O(1) per position before any backtracking
 * begins — within a long separator-free run, only its very first character
 * is ever attempted as a match start — bringing the same adversarial input
 * down to low tens of milliseconds. Unlike a length-bounded key class
 * (`{1,100}`), the lookbehind never truncates a long key: the captured key
 * group can still be arbitrarily long, so a sensitive word anywhere in a
 * long key/header name is still recognized. Verified against 40,000
 * randomized inputs to have zero behavioral difference from the original
 * unbounded, unguarded pattern — this is a pure performance fix, not a
 * behavioral trade-off.
 */
const BARE_KEY_VALUE_PATTERN =
  /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)(\s*[:=]\s*)("[^"]*"|(?:(?:Bearer|Basic|Digest|Token)\s+)?[^\s,;]+)/gi;

/**
 * Matches a JSON-style double-quoted `"key": "value"` (or `"key":"value"`)
 * pair, as found in an embedded JSON fragment inside otherwise free-form
 * text. Only a quoted string value is matched here — a bare/numeric JSON
 * value after a sensitive key is intentionally left to
 * {@link BARE_KEY_VALUE_PATTERN}. Quotes delimit the value, so internal
 * spaces need no special handling here, unlike the bare-value case.
 */
const JSON_KEY_VALUE_PATTERN = /"([A-Za-z0-9_-]+)"(\s*:\s*)("[^"]*")/g;

/** Escapes `text` for literal use inside a `RegExp` source string. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the second-pass "embedded sensitive word" pattern (see
 * {@link EMBEDDED_SENSITIVE_PATTERN}) directly from {@link SENSITIVE_KEY_NAMES}
 * so the two passes never drift out of sync. Names are sorted longest-first
 * so a shorter name (`auth`) cannot shadow a longer one that contains it
 * (`authorization`) within the alternation.
 *
 * The value class (`[^\s,;&?#'"]+` or a quoted `"[^"]*"`) is intentionally
 * bounded — a single non-overlapping character class with no nested
 * quantifiers — so the pattern cannot backtrack catastrophically (ReDoS) on
 * adversarial input.
 */
function buildEmbeddedSensitivePattern(): RegExp {
  const alternation = [...SENSITIVE_KEY_NAMES]
    .sort((a, b) => b.length - a.length)
    .map((name) => escapeRegExp(name))
    .join("|");
  // The boundary group requires the sensitive word to start a "token": the
  // string start, whitespace, or a URL/cookie/list delimiter (`? & ; /`) —
  // never an alphanumeric character immediately before it, so `author` does
  // not false-positive on the `auth` alternative mid-word.
  return new RegExp(
    `(^|[\\s?&;/])(${alternation})(\\s*[:=]\\s*)("[^"]*"|[^\\s,;&?#'"]+)`,
    "gi",
  );
}

/**
 * Second-pass pattern: a sensitive word (from {@link SENSITIVE_KEY_NAMES}),
 * preceded by a token boundary (string start, whitespace, or `? & ; /`), then
 * `:`/`=`, then a value bounded by common URL/cookie/list delimiters. Finds a
 * sensitive `key=value` pair *embedded* inside another field's value (a URL
 * query string, a cookie header) that {@link BARE_KEY_VALUE_PATTERN} cannot
 * reach because the outer, non-sensitive key's value consumes it whole.
 */
const EMBEDDED_SENSITIVE_PATTERN = buildEmbeddedSensitivePattern();

/**
 * A caller-supplied, structural port over a declared set of secret field
 * names — most commonly `M3LSecretsSpecifier` from `core/config`, built via
 * `deriveSecretsSpecifier` from a script's own config schema. Consulted by
 * {@link redactSensitiveLogText} and {@link redactSensitiveLogValue} as an
 * *additive* widening of the built-in heuristic in {@link isSensitiveKey} —
 * never a narrowing of it.
 *
 * @example
 * ```ts
 * import type { M3LSecretNamesPort } from "@m3l-automation/m3l-common/core";
 *
 * const secrets: M3LSecretNamesPort = {
 *   isSecret: (name) => name === "tenantRef",
 * };
 * ```
 */
export interface M3LSecretNamesPort {
  /** Returns whether `name` (a candidate key) should be treated as secret. */
  readonly isSecret: (name: string) => boolean;
}

/**
 * Optional options accepted by {@link redactSensitiveLogText} and
 * {@link redactSensitiveLogValue}.
 *
 * @example
 * ```ts
 * import type { M3LRedactOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LRedactOptions = {
 *   secrets: { isSecret: (name) => name === "tenantRef" },
 * };
 * ```
 */
export interface M3LRedactOptions {
  /**
   * A declared secrets specifier consulted alongside the built-in heuristic.
   * Omitted, `undefined`, or a port whose `isSecret` never returns `true`
   * behaves identically to the bare (no-`options`) call.
   */
  readonly secrets?: M3LSecretNamesPort | undefined;
}

/** Returns whether `key` is sensitive by the heuristic or a declared secrets port. */
function isSensitiveOrDeclaredKey(
  key: string,
  options: M3LRedactOptions | undefined,
): boolean {
  return isSensitiveKey(key) || options?.secrets?.isSecret(key) === true;
}

/**
 * Redacts one matched bare key/separator/value triple, preserving quoting.
 *
 * When `key` itself is not sensitive, the value is still checked for an
 * embedded, glued `innerKey=value`/`innerKey:value` pair the greedy value
 * class may have swallowed whole — see the inline comment below for the
 * exact shape recovered and the two shapes deliberately left as residual,
 * documented limitations.
 */
function redactBareMatch(
  match: string,
  key: string,
  separator: string,
  value: string,
  options: M3LRedactOptions | undefined,
): string {
  if (isSensitiveOrDeclaredKey(key, options)) {
    const isQuoted = value.startsWith('"') && value.endsWith('"');
    const replacement = isQuoted ? `"${REDACTED}"` : REDACTED;
    return `${key}${separator}${replacement}`;
  }

  // `key` itself isn't sensitive, but the greedy value class has no
  // internal `:`/`=` boundary, so it may have swallowed a directly
  // following, GLUED (no internal whitespace) `innerKey=value` or
  // `innerKey:value` pair whole — e.g. "failed: tenantRef=secret" swallows
  // "tenantRef=secret" as `failed`'s own value. Only checked when the
  // OUTER separator itself consumed whitespace (the "key: value" shape);
  // the glued shape ("url=https://x/?tenant-ref=abc") is a deliberate,
  // documented limitation left untouched (see `redactSensitiveLogText`'s
  // `@remarks`). A further shape — an inner key separated from ITS OWN
  // operator by a space too ("failed: tenantRef : secret") — is a second,
  // deliberate, documented residual limitation: rescuing it would require
  // the same regex-level lookahead approach that caused the sensitive-key
  // regression above, since by the time this callback runs, the outer
  // match has already consumed only "tenantRef" as `key`'s bare value,
  // stranding the inner separator and its value outside this match
  // entirely with no key characters left for them to attach to.
  if (/\s/.test(separator)) {
    const embedded = /^([A-Za-z0-9_-]+)(\s*[:=]\s*)(.+)$/.exec(value);
    if (embedded) {
      const [, embeddedKey, embeddedSeparator] = embedded;
      if (
        embeddedKey !== undefined &&
        embeddedSeparator !== undefined &&
        isSensitiveOrDeclaredKey(embeddedKey, options)
      ) {
        return `${key}${separator}${embeddedKey}${embeddedSeparator}${REDACTED}`;
      }
    }
  }

  return match;
}

/**
 * Redacts sensitive `key=value` / `key: value` / `key="value"` pairs — bare
 * or JSON-quoted, including hyphenated key names — found anywhere in
 * free-form log text, keeping the key and replacing only the value with the
 * literal `[REDACTED]`. A leading `Bearer `/`Basic `/`Digest `/`Token `
 * scheme word is masked together with its credential (e.g.
 * `Authorization: Bearer abc123` becomes `Authorization: [REDACTED]`) so the
 * token is never partially exposed; an unrelated bare value still stops at
 * the next whitespace, so `token=abc123 user=alice` redacts only the
 * `token` value and leaves `user=alice` intact. A second, additive pass
 * also catches a sensitive pair *embedded* inside another field's value —
 * a URL query string (`url=https://x/?token=secret`) or a cookie header
 * (`Cookie: token=abc; path=/`) — which the first pass alone would miss
 * because the outer, non-sensitive key's value consumes it whole. An input
 * with no matching pairs, or no sensitive keys, is returned unchanged; this
 * function does not itself throw, but see `@remarks` for the one exception.
 *
 * @remarks
 * This is a **best-effort** redactor for free-form text, not a parser — it
 * cannot always tell where a value ends. In particular:
 * - A bare (unquoted) value containing internal whitespace beyond a
 *   recognized `Bearer `/`Basic `/`Digest `/`Token ` scheme prefix is only
 *   masked up to the first whitespace; the remainder leaks. For example
 *   `password=p@ss word` redacts only `p@ss`, leaking ` word`.
 * - A value wrapped in single quotes or backticks is not recognized as
 *   quoted (only double quotes are) — `password='p@ss word'` leaks
 *   everything after the first whitespace inside the quotes.
 * - A directly-following unrelated key's value is rescued from swallowing a
 *   glued `innerKey=value`/`innerKey:value` pair, but not one where the
 *   inner key is itself separated from its own operator by whitespace —
 *   `failed: tenantRef : secret` still leaks `tenantRef`'s pairing.
 *
 * For reliable redaction of structured data, prefer
 * {@link redactSensitiveLogValue} over interpolating values into free-form
 * text and redacting the resulting string.
 *
 * A declared secrets specifier (`options.secrets`) widens the first two
 * passes only — never the third. The optional `options.secrets` port is
 * consulted on the quoted JSON-style pass (`"key": "value"`) and the bare
 * `key=value` pass only, additively alongside the built-in heuristic — it
 * can widen what gets redacted, never narrow it. It is deliberately **not**
 * consulted on the third, embedded-value pass: that pass is a single
 * regular expression precompiled once at module load from the fixed
 * built-in key-name list, and rebuilding it per call from an arbitrary,
 * mutable, caller-supplied name set would reopen the catastrophic-backtracking
 * (ReDoS) class of bug the fixed pattern was specifically hardened against.
 * A declared secret embedded inside another field's value (e.g.
 * `url=https://x/?tenant-ref=abc`) is therefore not redacted by the port —
 * only a top-level `tenant-ref=...` pair is.
 *
 * This function does not itself throw for any well-formed `string` input.
 * The one exception is a caller-supplied `options.secrets` port
 * ({@link M3LSecretNamesPort}) whose `isSecret` implementation itself
 * throws, or that is malformed at the JS runtime boundary (e.g. rehydrated
 * from untyped JSON with a non-callable `isSecret`) — such a failure
 * propagates uncaught, by design: this function does not guard third-party
 * port calls.
 *
 * @param text - The free-form text to scan and redact.
 * @param options - Optional; a declared secrets specifier to widen
 *   redaction (first two passes only, see `@remarks`). Omitted, `{}`, or
 *   `{ secrets: undefined }` behaves identically to the bare call.
 * @returns `text` with every sensitive value replaced by `[REDACTED]`.
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const safe = Core.redactSensitiveLogText("token=abc123 user=alice");
 * // "token=[REDACTED] user=alice"
 * ```
 */
export function redactSensitiveLogText(
  text: string,
  options?: M3LRedactOptions,
): string {
  const withJsonRedacted = text.replace(
    JSON_KEY_VALUE_PATTERN,
    (match, key: string, separator: string) => {
      if (!isSensitiveOrDeclaredKey(key, options)) return match;
      return `"${key}"${separator}"${REDACTED}"`;
    },
  );

  const withBareRedacted = withJsonRedacted.replace(
    BARE_KEY_VALUE_PATTERN,
    (match, key: string, separator: string, value: string) =>
      redactBareMatch(match, key, separator, value, options),
  );

  // Second, additive pass: pass 1 only redacts a *top-level* key=value pair
  // (the whole match, key through value). A sensitive pair embedded inside
  // another field's value — a URL query string (`url=https://x/?token=…`)
  // or a cookie header (`Cookie: token=…; path=/`) — is consumed whole by
  // the outer, non-sensitive key's value and never reaches pass 1's key
  // capture. This pass is keyed on the sensitive words themselves rather
  // than a generic key class, so it finds such an embedded pair anywhere in
  // the string. It can only ADD redaction on top of pass 1's result, never
  // remove it — an already-redacted `[REDACTED]` value re-matches this
  // pass's value class harmlessly (redacting "REDACTED" again is a no-op).
  return withBareRedacted.replace(
    EMBEDDED_SENSITIVE_PATTERN,
    (match, boundary: string, word: string, separator: string) =>
      `${boundary}${word}${separator}${REDACTED}`,
  );
}

/**
 * Redacts an already-collected list of `Map` entries: a string key is
 * checked for sensitivity the same way a plain object's property key is,
 * and each value is recursed into via {@link redactSensitiveLogValue}.
 * Extracted from {@link redactMapSafely} to keep that function's
 * cyclomatic/cognitive complexity within the project's lint budget, and so
 * the recursive redaction below runs OUTSIDE {@link redactMapSafely}'s
 * try/catch — an unrelated exception thrown deep inside a nested value
 * (e.g. a hostile property getter) must propagate normally, not be caught
 * by the same handler that guards the raw iteration step and mislabeled as
 * an unredactable collection.
 *
 * An entry whose key is not a `string`, or whose key is a dangerous own-key
 * name (`__proto__`/`constructor`/`prototype`), is DROPPED entirely — both
 * the key and its value — rather than carried through unredacted. A
 * non-string key has no representable key name to check for sensitivity, so
 * passing its value through unchecked would risk leaking a secret that
 * happens to be keyed by e.g. an object or symbol; a dangerous key name
 * offers nothing worth preserving either. This mirrors the existing
 * precedent in `core/diagnostics/run-report.ts`'s `normalizeMapEntries`.
 */
function redactMapEntries(
  entries: readonly (readonly [unknown, unknown])[],
  options: M3LRedactOptions | undefined,
): Map<unknown, unknown> {
  const result = new Map<unknown, unknown>();
  for (const [entryKey, entryValue] of entries) {
    if (typeof entryKey !== "string" || isDangerousKey(entryKey)) continue;
    result.set(
      entryKey,
      isSensitiveOrDeclaredKey(entryKey, options)
        ? REDACTED
        : redactSensitiveLogValue(entryValue, options),
    );
  }
  return result;
}

/**
 * Redacts an already-collected list of `Set` elements, each recursed into
 * via {@link redactSensitiveLogValue} the same way an array's elements are.
 * Extracted from {@link redactSetSafely} for the same reason
 * {@link redactMapEntries} is extracted from {@link redactMapSafely}: the
 * recursive redaction must run OUTSIDE the raw-iteration try/catch.
 */
function redactSetEntries(
  entries: readonly unknown[],
  options: M3LRedactOptions | undefined,
): Set<unknown> {
  const result = new Set<unknown>();
  for (const entry of entries) {
    result.add(redactSensitiveLogValue(entry, options));
  }
  return result;
}

/**
 * Redacts a `Map`, guarding against a `Map`-shaped value that throws while
 * actually being iterated — e.g. `Object.create(Map.prototype)` or a
 * `Proxy` wrapping one, both of which pass `instanceof Map` but have no real
 * internal Map state. Extracted from {@link redactSensitiveLogValue} to keep
 * that function's cyclomatic/cognitive complexity within the project's lint
 * budget; see {@link UNREDACTABLE_COLLECTION}'s own doc for the guard's
 * rationale.
 *
 * The try/catch below wraps ONLY the raw iteration step (spreading `value`
 * into a plain array) — never the subsequent recursive
 * {@link redactSensitiveLogValue} calls performed by {@link redactMapEntries}.
 * An unrelated exception thrown deep inside a nested value must propagate
 * normally rather than being caught here and mislabeled as an unredactable
 * Map.
 */
function redactMapSafely(
  value: ReadonlyMap<unknown, unknown>,
  options: M3LRedactOptions | undefined,
): unknown {
  let entries: (readonly [unknown, unknown])[];
  try {
    entries = [...value];
  } catch (cause) {
    reportUnredactableCollection("Map", cause);
    return UNREDACTABLE_COLLECTION;
  }
  return redactMapEntries(entries, options);
}

/**
 * Redacts a `Set`, guarding against a `Set`-shaped value that throws while
 * actually being iterated, mirroring {@link redactMapSafely}. Extracted from
 * {@link redactSensitiveLogValue} to keep that function's cyclomatic/
 * cognitive complexity within the project's lint budget.
 *
 * The try/catch below wraps ONLY the raw iteration step, mirroring
 * {@link redactMapSafely}'s own narrowed scope for the same reason.
 */
function redactSetSafely(
  value: ReadonlySet<unknown>,
  options: M3LRedactOptions | undefined,
): unknown {
  let entries: unknown[];
  try {
    entries = [...value];
  } catch (cause) {
    reportUnredactableCollection("Set", cause);
    return UNREDACTABLE_COLLECTION;
  }
  return redactSetEntries(entries, options);
}

/**
 * Recursively redacts sensitive keys' values in a plain object/array
 * structure. Returns a new, deep-cloned structure — the input is never
 * mutated. Object and array values are recursed into at any depth; string
 * leaves are additionally passed through {@link redactSensitiveLogText} so
 * an embedded `key=value` pattern inside a string value is also masked;
 * other scalars (number, boolean, null, undefined) pass through unchanged.
 *
 * A declared secrets specifier (`options.secrets`) is forwarded through
 * every recursive call — array elements, nested-record entries, and string
 * leaves alike — so a secret nested at any depth is redacted the same as a
 * top-level one, additively alongside the built-in heuristic. See
 * {@link M3LRedactOptions} and {@link redactSensitiveLogText}'s `@remarks`
 * for the one deliberate scope limitation (the embedded-value pass never
 * consults the port), which applies the same way to a string leaf here.
 *
 * @param value - The value to redact; may be a scalar, array, object, or any
 *   nested combination.
 * @param options - Optional; a declared secrets specifier to widen
 *   redaction at every depth. Omitted, `{}`, or `{ secrets: undefined }`
 *   behaves identically to the bare call.
 * @returns A redacted, deep-cloned copy of `value`.
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const safe = Core.redactSensitiveLogValue({ apiKey: "secret" });
 * // { apiKey: "[REDACTED]" }
 * ```
 */
export function redactSensitiveLogValue(
  value: unknown,
  options?: M3LRedactOptions,
): unknown {
  if (typeof value === "string") return redactSensitiveLogText(value, options);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveLogValue(item, options));
  }

  // Date/Map/Set carry their real state in internal slots invisible to
  // `Object.entries` — recursing into them as if they were plain records
  // would silently collapse each to `{}` (data loss, not redaction). This
  // function's own "never mutates input, always returns a new structure"
  // contract still applies to them, so each is cloned here. A `Map`'s own
  // state (its entries) IS recursively redacted the same way a plain
  // object's properties are: a string key is checked for sensitivity the
  // same as an object property key would be, and each value is recursed
  // into. A `Set`'s elements are each recursively redacted the same way an
  // array's elements are. `Map#set`/`Set#add` never touch the prototype
  // chain the way a plain-object bracket assignment (`result[key] = …`)
  // would, so a dangerous Map/Set key poses no prototype-pollution hazard
  // here — but `redactMapEntries` still drops a dangerous-named Map key for
  // a DIFFERENT reason: it has no representable name worth trusting, not
  // because keeping it would mutate anything.
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Map) return redactMapSafely(value, options);
  if (value instanceof Set) return redactSetSafely(value, options);

  if (isRedactableRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Skip prototype-pollution vectors outright: a `__proto__`/
      // `constructor`/`prototype` own-key must never reach a bare
      // `result[key] = …` assignment, which would corrupt the clone's
      // prototype chain instead of merely copying a data field.
      if (isDangerousKey(key)) continue;
      result[key] = isSensitiveOrDeclaredKey(key, options)
        ? REDACTED
        : redactSensitiveLogValue(entry, options);
    }
    return result;
  }

  return value;
}
