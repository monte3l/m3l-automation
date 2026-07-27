/**
 * `internal/prompt/sanitize` — the F9 display-escape helper for `core/prompt`.
 *
 * Terminal emulators interpret certain Unicode code points as control
 * sequences rather than displayable text: C0/C1 control characters (category
 * `Cc`, e.g. ESC, CR, BEL, DEL), format characters (category `Cf`, e.g. the
 * bidi override/isolate characters and zero-width joiners), and the line/
 * paragraph separators (`Zl`/`Zp`). A caller-supplied string that reaches a
 * prompt message or log line unescaped can therefore manipulate the
 * terminal's cursor or visually reorder/hide surrounding text (e.g. a bidi
 * override making `rm -rf /safe-dir` visually read as something else). This
 * module is a generic string-to-string transform and can be applied to any
 * string, including one that will later be thrown as an error — but a caller
 * applying it to a value that also flows through a secret-redaction pass
 * (e.g. `core/diagnostics`'s name-based redaction) should escape *after*
 * redaction, not before: escaping first can introduce alphanumeric text that
 * breaks the redactor's word-boundary matching, letting a secret survive.
 * `confirmDestructive` is a concrete instance of this ordering constraint —
 * it deliberately leaves the string used to build its thrown `M3LError`
 * unescaped for exactly this reason, while it does escape the two purely
 * display channels (the bypass-warning log line and the confirm prompt).
 * This module is private to `core/prompt` — it never strips a code point, it
 * replaces each offending one with a visible escape literal.
 *
 * This transform is **not** injective/reversible — do not parse its output
 * back. Because the backslash character itself is left untouched (escaping
 * it would break the idempotence below), a literal `\x1b` typed by a caller
 * and a real ESC byte both escaped by this function render to the identical
 * output string; the two inputs are indistinguishable downstream. That
 * collision only runs in the fail-safe direction: it can make a benign
 * literal display as though it were a control character (an operator sees
 * more escaping than the raw input actually warranted, and is at most overly
 * cautious), never the reverse. A real control character rendering as
 * benign text — the failure mode this module exists to close — cannot occur
 * through this collision.
 *
 * The transform is idempotent: escaping an already-escaped string is a
 * no-op, because none of `\`, `x`, `{`, `}`, or a hex digit are themselves in
 * `Cc`/`Cf`/`Zl`/`Zp`. This idempotence is load-bearing for how
 * `confirmDestructive` and `M3LPrompt.confirm` compose on the confirm path
 * (`deps.yes === false`): `confirmDestructive` builds `Confirm: ...?` from an
 * already-escaped description and passes it to `deps.prompt.confirm`, which
 * escapes it again — safely, because escaping an already-escaped string
 * renders identically either way.
 *
 * @packageDocumentation
 */

/** Length of a UTF-16 surrogate pair, as returned by `String.prototype.length`. */
const SURROGATE_PAIR_LENGTH = 2;
/** Lead value of a UTF-16 high surrogate. */
const HIGH_SURROGATE_BASE = 0xd800;
/** Lead value of a UTF-16 low surrogate. */
const LOW_SURROGATE_BASE = 0xdc00;
/** Number of low-surrogate code units per high-surrogate step. */
const SURROGATE_STEP = 0x400;
/** First astral (non-BMP) code point. */
const ASTRAL_PLANE_START = 0x10000;
/** Highest code point representable by the two-digit `\xHH` escape form. */
const MAX_TWO_DIGIT_HEX_CODE_POINT = 0xff;
/** Radix for the hexadecimal escape forms. */
const HEX_RADIX = 16;
/** Digit width the `\xHH` form is zero-padded to. */
const TWO_HEX_DIGITS = 2;

/**
 * Escapes every Unicode `Cc` (C0/C1 control, including DEL) ∪ `Cf` (format
 * character) ∪ `Zl` (line separator) ∪ `Zp` (paragraph separator) code point
 * in `value` into a visible literal, leaving every other code point —
 * including the backslash character itself, NBSP, ordinary letters, CJK, and
 * emoji — byte-identical.
 *
 * A code point at or below `0xFF` becomes `\xHH` (exactly two lowercase hex
 * digits, zero-padded, e.g. `\x1b` for ESC). A code point above `0xFF`
 * becomes `\u{H+}` (lowercase hex, no leading zeros, e.g. `\u{202e}` for the
 * right-to-left override). Astral code points (above `0xFFFF`) are matched by
 * the regex as a UTF-16 surrogate pair and recombined into the true code
 * point before formatting.
 *
 * The transform is idempotent — escaping its own output is a no-op — and
 * closed — its output never itself contains a `Cc`/`Cf`/`Zl`/`Zp` code point.
 *
 * @param value - The untrusted string to escape (e.g. a prompt message or a
 *   destructive-action description).
 * @returns `value` with every `Cc`/`Cf`/`Zl`/`Zp` code point replaced by a
 *   visible `\xHH` or `\u{H+}` escape literal.
 * @example
 * ```ts
 * import { escapeTerminalControls } from "./sanitize.js";
 *
 * escapeTerminalControls("prod\x1b[2K\u202estaging");
 * // => "prod\\x1b[2K\\u{202e}staging"
 * ```
 */
export function escapeTerminalControls(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (match) => {
    const high = match.charCodeAt(0);
    const codePoint =
      match.length === SURROGATE_PAIR_LENGTH
        ? (high - HIGH_SURROGATE_BASE) * SURROGATE_STEP +
          (match.charCodeAt(1) - LOW_SURROGATE_BASE) +
          ASTRAL_PLANE_START
        : high;

    return codePoint <= MAX_TWO_DIGIT_HEX_CODE_POINT
      ? `\\x${codePoint.toString(HEX_RADIX).padStart(TWO_HEX_DIGITS, "0")}`
      : `\\u{${codePoint.toString(HEX_RADIX)}}`;
  });
}
