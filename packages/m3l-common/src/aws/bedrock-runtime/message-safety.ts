/**
 * `aws/bedrock-runtime/message-safety` — the caller/model-string sanitizer
 * ({@link sanitizeForMessage}) and the {@link copyDocument} key/index trail
 * renderer ({@link formatDocumentPath}), split out of `document.ts` as its
 * own leaf module (ADR-0072's per-file size ratchet, `document.ts` at
 * 24,247 / 25,000 bytes) — "render an external value safely into an
 * `M3LError.message`" is a genuinely different concern from "copy a document
 * into a fresh mutable structure," and both `shared.ts` and `tools.ts`
 * already needed only the sanitizer, not the copier.
 *
 * Never imports `document.ts`, `tools.ts`, `shared.ts`, or `client.ts`
 * (`import-x/no-cycle`, `maxDepth: Infinity`, is a hard repo-wide gate, and
 * `pnpm check:zones` also enforces it) — `document.ts` imports from here,
 * never the reverse. Internal module — nothing here is re-exported through
 * `aws/bedrock-runtime/index`.
 *
 * @packageDocumentation
 */

/**
 * Max length one {@link sanitizeForMessage}-rendered segment is allowed
 * before truncation — a length cap discards an implausibly long
 * caller/model-controlled string in favour of a safe, bounded rendering,
 * mirroring `core/errors/M3LError.ts`'s `SAFE_CAUSE_NAME_PATTERN` length-cap
 * reasoning for the same class of problem (an external string reaching
 * `error.message`, and from there `M3LError.toJSON()`'s log projection).
 */
const MAX_SANITIZED_MESSAGE_SEGMENT_LENGTH = 100;

/** Radix for {@link sanitizeForMessage}'s `\xNN` control-character escape — hex, matching the escape's own name. */
const HEX_RADIX = 16;

/** Zero-padded digit count for {@link sanitizeForMessage}'s `\xNN` escape — exactly two hex digits per byte. */
const HEX_ESCAPE_DIGIT_COUNT = 2;

/**
 * Matches every C0/C1 control character — including `\n`/`\r` (log-line
 * forging) and ESC `\x1B` (the lead byte of every ANSI escape sequence) —
 * plus U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR, treated as line terminators
 * by some log viewers even though `\n`-splitting code ignores them),
 * U+202D/U+202E (LEFT-/RIGHT-TO-LEFT OVERRIDE, either of which can visually
 * reorder the rest of a rendered message), and U+2066–U+2069 (the
 * directional-isolate formatting characters LRI/RLI/FSI/PDI, which can
 * scope a reordering override to an attacker-chosen span without an
 * unpaired override character — Should-fix #2, 2026-08-29 security pass
 * round 5, widening round 3's Should-fix #3).
 */
const UNSAFE_CONTROL_CHAR_PATTERN =
  // eslint-disable-next-line no-control-regex -- matches control characters so they can be escaped; the rule is inapplicable here.
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202d\u202e\u2066-\u2069]/g;

/**
 * Renders a caller/model-controlled string safely for interpolation into an
 * `M3LError.message`: length-capped **before** any expansion (so an
 * oversized input is never fully processed), then every control character
 * escaped to `\xNN` so no newline, carriage return, or ANSI escape sequence
 * can pass through. Used by `shared.ts`'s `formatDiscriminant` (a
 * content-block `type` discriminant), `tools.ts`'s `refuseServerToolUse` (a
 * model-supplied `toolUseId`/`name`), and {@link formatDocumentPath}'s
 * reserved-key arm (a module-owned key name, still routed through this for
 * consistency) — all interpolate an external or semi-external string
 * directly into a thrown error's message (M2 finding: an unsanitized,
 * uncapped value here let a 200 KB `type` string produce a 400 KB
 * `toJSON()` and let ANSI injection reach a log sink, 2026-08-29 security
 * pass).
 *
 * The length cap counts **code points, not UTF-16 code units** (Should-fix
 * #4, round 3): capping via `.length`/`.slice()` can bisect a surrogate
 * pair, producing an unpaired surrogate in the rendered message. The cap is
 * enforced by an early-exit loop over `value`'s code points (`for...of` on a
 * primitive `string` is safe here — unlike an object/array, a string's
 * iterator cannot be overridden per-value) so an oversized input is never
 * iterated past the cap.
 *
 * `core/errors/M3LError.ts`'s `isSafeCauseName`/`SAFE_CAUSE_NAME_PATTERN` is
 * the right pattern for this problem but is a private, unexported module
 * symbol (not re-exported from `core/errors/index.ts`) — `aws/**`'s ESLint
 * island (ADR-0059) may import only `core/errors`'s PUBLIC surface, so
 * widening that export just for this call site would widen the island;
 * replicated locally instead, deliberately with a wider allowed charset than
 * an identifier pattern — a model-supplied tool name is not identifier-
 * shaped in general, so rejecting anything outside `[A-Za-z0-9_$]` would
 * discard legitimate diagnostic information for the common case. Do not
 * export this from `core/errors` just to reuse it here.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * function refuse(discriminant: string): never {
 *   throw new M3LError(`unexpected content-block type "${discriminant}"`);
 * }
 * ```
 */
export function sanitizeForMessage(value: string): string {
  let text = "";
  let count = 0;
  let wasTruncated = false;
  for (const codePoint of value) {
    if (count >= MAX_SANITIZED_MESSAGE_SEGMENT_LENGTH) {
      wasTruncated = true;
      break;
    }
    text += codePoint;
    count += 1;
  }
  const truncated = wasTruncated ? `${text}…` : text;
  return truncated.replace(
    UNSAFE_CONTROL_CHAR_PATTERN,
    (char) =>
      `\\x${char.codePointAt(0)?.toString(HEX_RADIX).padStart(HEX_ESCAPE_DIGIT_COUNT, "0") ?? "00"}`,
  );
}

/**
 * One step of a {@link copyDocument} key/index trail, tagged by what kind of
 * container step it was. An array's `index` is a `number` this module
 * derived, never caller data, so it is always safe to render. An ordinary
 * object step names neither the caller's key nor its value — see
 * {@link formatDocumentPath}'s doc comment for why — and instead carries
 * `ordinal`, the 1-based position among the own keys `document.ts` was
 * iterating at that level, which is derived (a loop counter), not
 * caller-supplied. A `reservedKey` step is the one exception: `document.ts`
 * refuses only a fixed, module-owned vocabulary (`__proto__`, `constructor`,
 * `prototype`), so naming which of those three fired is safe and is the
 * single most useful diagnostic in that error.
 */
type M3LBedrockDocumentPathSegment =
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "key"; readonly ordinal: number }
  | { readonly kind: "reservedKey"; readonly key: string };

/** A {@link copyDocument} key/index trail, root-to-leaf. */
export type M3LBedrockDocumentPath = readonly M3LBedrockDocumentPathSegment[];

/**
 * Formats a {@link copyDocument} key/index trail as a path-like string for an
 * error message — e.g. `$.tools[0].inputSchema.<key#1>`.
 *
 * **Deliberately positional, not `$.foo.bar[2]`-shaped.** An earlier version
 * of this function rendered the caller's own object key by name (through
 * {@link sanitizeForMessage}), reasoning that a KEY is never a VALUE. That
 * reasoning was wrong: {@link sanitizeForMessage} only escapes control
 * characters, so a fully printable secret used as a document key — e.g.
 * `{ "sk-live-ABC123...": ... }` — passed through untouched and reached
 * `error.message` verbatim, and from there `M3LError.toJSON()`'s log
 * projection (M2 finding, 2026-08-29 security pass round 4). No amount of
 * escaping fixes an already-printable string, so an ordinary object step is
 * rendered as `<key#N>` (N = the step's 1-based position among the own keys
 * encountered at that level) instead — strictly less friendly than naming
 * the key, and that tradeoff is deliberate: this library must never emit a
 * caller-supplied key name, because the key itself can be the secret. An
 * array INDEX is a `number` this module derived, not caller data, so it is
 * still rendered directly (`[3]`). The one exception is
 * {@link M3LBedrockDocumentPathSegment}'s `reservedKey` step: `__proto__` /
 * `constructor` / `prototype` come from a fixed, module-owned vocabulary,
 * never from caller data, so naming the offending key is safe and is the
 * most useful diagnostic {@link copyDocument}'s reserved-key error can give.
 */
export function formatDocumentPath(path: M3LBedrockDocumentPath): string {
  let rendered = "$";
  for (const segment of path) {
    switch (segment.kind) {
      case "index":
        rendered += `[${segment.index}]`;
        break;
      case "key":
        rendered += `.<key#${segment.ordinal}>`;
        break;
      case "reservedKey":
        rendered += `.${sanitizeForMessage(segment.key)}`;
        break;
    }
  }
  return rendered;
}
