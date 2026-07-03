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

/** Replacement literal written in place of a redacted value. */
const REDACTED = "[REDACTED]";

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
 */
const BARE_KEY_VALUE_PATTERN =
  /([A-Za-z0-9_-]+)(\s*[:=]\s*)("[^"]*"|(?:(?:Bearer|Basic|Digest|Token)\s+)?[^\s,;]+)/gi;

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

/** Redacts one matched bare key/separator/value triple, preserving quoting. */
function redactBareMatch(
  match: string,
  key: string,
  separator: string,
  value: string,
): string {
  if (!isSensitiveKey(key)) return match;

  const isQuoted = value.startsWith('"') && value.endsWith('"');
  const replacement = isQuoted ? `"${REDACTED}"` : REDACTED;
  return `${key}${separator}${replacement}`;
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
 * because the outer, non-sensitive key's value consumes it whole. Never
 * throws — an input with no matching pairs, or no sensitive keys, is
 * returned unchanged.
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
 *
 * For reliable redaction of structured data, prefer
 * {@link redactSensitiveLogValue} over interpolating values into free-form
 * text and redacting the resulting string.
 *
 * @param text - The free-form text to scan and redact.
 * @returns `text` with every sensitive value replaced by `[REDACTED]`.
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const safe = Core.redactSensitiveLogText("token=abc123 user=alice");
 * // "token=[REDACTED] user=alice"
 * ```
 */
export function redactSensitiveLogText(text: string): string {
  const withJsonRedacted = text.replace(
    JSON_KEY_VALUE_PATTERN,
    (match, key: string, separator: string) => {
      if (!isSensitiveKey(key)) return match;
      return `"${key}"${separator}"${REDACTED}"`;
    },
  );

  const withBareRedacted = withJsonRedacted.replace(
    BARE_KEY_VALUE_PATTERN,
    (match, key: string, separator: string, value: string) =>
      redactBareMatch(match, key, separator, value),
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
 * Recursively redacts sensitive keys' values in a plain object/array
 * structure. Returns a new, deep-cloned structure — the input is never
 * mutated. Object and array values are recursed into at any depth; string
 * leaves are additionally passed through {@link redactSensitiveLogText} so
 * an embedded `key=value` pattern inside a string value is also masked;
 * other scalars (number, boolean, null, undefined) pass through unchanged.
 *
 * @param value - The value to redact; may be a scalar, array, object, or any
 *   nested combination.
 * @returns A redacted, deep-cloned copy of `value`.
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const safe = Core.redactSensitiveLogValue({ apiKey: "secret" });
 * // { apiKey: "[REDACTED]" }
 * ```
 */
export function redactSensitiveLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveLogText(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveLogValue(item));
  }

  if (isPlainRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Skip prototype-pollution vectors outright: a `__proto__`/
      // `constructor`/`prototype` own-key must never reach a bare
      // `result[key] = …` assignment, which would corrupt the clone's
      // prototype chain instead of merely copying a data field.
      if (isDangerousKey(key)) continue;
      result[key] = isSensitiveKey(key)
        ? REDACTED
        : redactSensitiveLogValue(entry);
    }
    return result;
  }

  return value;
}

/** Narrows `value` to a plain, non-null, non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
