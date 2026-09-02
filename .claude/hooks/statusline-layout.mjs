/**
 * Pure width-fitting layout primitives for the statusLine renderer
 * (`statusline-context-pressure.mjs`). No I/O, no shebang, no direct-run
 * block — this module is only ever imported.
 *
 * Anthropic's own statusLine docs (code.claude.com/docs/en/statusline) state
 * that a statusLine script must read the `COLUMNS`/`LINES` env vars to learn
 * the terminal width; `tput cols` does not work inside a statusLine
 * subprocess. `terminalColumns` is the read side of that contract;
 * `displayWidth`/`truncateToWidth`/`fitRow` are what make a real width
 * budget actionable — segment-level priority dropping plus
 * ANSI/OSC-8-aware truncation, so a narrow terminal degrades by omitting the
 * least important segments first rather than wrapping mid-line.
 */

/** SGR (`\x1b[...m`) and OSC-8 (`\x1b]8;;URL\x07...\x1b]8;;\x07`) sequences. */
// eslint-disable-next-line no-control-regex -- intentionally matches the ESC (\x1b) and BEL (\x07) control characters that delimit ANSI/OSC-8 sequences
export const ESCAPE_SEQUENCE_RE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

const COMBINING_RANGES = [
  [0x03_00, 0x03_6f],
  [0x1a_b0, 0x1a_ff],
  [0x1d_c0, 0x1d_ff],
  [0x20_d0, 0x20_ff],
  [0xfe_20, 0xfe_2f],
];

const PUA_RANGES = [
  [0xe0_00, 0xf8_ff],
  [0xf_00_00, 0xf_ff_fd],
  [0x10_00_00, 0x10_ff_fd],
];

const WIDE_RANGES = [
  [0x11_00, 0x11_5f],
  [0x2e_80, 0x30_3e],
  [0x30_41, 0x33_ff],
  [0x34_00, 0x4d_bf],
  [0x4e_00, 0x9f_ff],
  [0xa0_00, 0xa4_cf],
  [0xac_00, 0xd7_a3],
  [0xf9_00, 0xfa_ff],
  [0xff_00, 0xff_60],
  [0xff_e0, 0xff_e6],
  [0x1f_3_00, 0x1f_a_ff],
  [0x26_00, 0x27_bf],
  [0x2_00_00, 0x3_ff_fd],
];

/**
 * @param {number} code a Unicode codepoint.
 * @param {ReadonlyArray<readonly [number, number]>} ranges inclusive
 *   `[start, end]` pairs.
 * @returns {boolean} whether `code` falls in any of `ranges`.
 */
function inRanges(code, ranges) {
  return ranges.some(([start, end]) => code >= start && code <= end);
}

/**
 * The display width of a single codepoint, per this module's East
 * Asian/Nerd-Font/combining-mark width table.
 *
 * @param {string} cp a single codepoint (as produced by iterating a string
 *   with `[...str]`).
 * @returns {0 | 1 | 2}
 */
function codepointWidth(cp) {
  const code = cp.codePointAt(0) ?? 0;
  if (code === 0xfe_0f || inRanges(code, COMBINING_RANGES)) return 0;
  if (inRanges(code, PUA_RANGES)) return 1;
  if (inRanges(code, WIDE_RANGES)) return 2;
  return 1;
}

/**
 * The terminal-column width of `str` once ANSI/OSC-8 escape sequences are
 * stripped, accounting for zero-width combining marks, Nerd Font/PUA
 * single-width glyphs, and East Asian Wide/emoji-presentation double-width
 * codepoints.
 *
 * @param {string} str
 * @returns {number}
 */
export function displayWidth(str) {
  const stripped = str.replace(ESCAPE_SEQUENCE_RE, "");
  let width = 0;
  for (const cp of stripped) {
    width += codepointWidth(cp);
  }
  return width;
}

/**
 * @typedef {{ type: "esc", raw: string }} EscToken
 * @typedef {{ type: "char", raw: string, width: 0 | 1 | 2 }} CharToken
 */

/**
 * Tokenizes `str` into an ordered list of escape-sequence and visible-glyph
 * tokens, preserving original order.
 *
 * @param {string} str
 * @returns {Array<EscToken | CharToken>}
 */
function tokenize(str) {
  /** @type {Array<EscToken | CharToken>} */
  const tokens = [];
  let cursor = 0;
  ESCAPE_SEQUENCE_RE.lastIndex = 0;
  let match = ESCAPE_SEQUENCE_RE.exec(str);
  while (match !== null) {
    if (match.index > cursor) {
      for (const cp of str.slice(cursor, match.index)) {
        tokens.push({ type: "char", raw: cp, width: codepointWidth(cp) });
      }
    }
    tokens.push({ type: "esc", raw: match[0] });
    cursor = match.index + match[0].length;
    match = ESCAPE_SEQUENCE_RE.exec(str);
  }
  if (cursor < str.length) {
    for (const cp of str.slice(cursor)) {
      tokens.push({ type: "char", raw: cp, width: codepointWidth(cp) });
    }
  }
  return tokens;
}

/**
 * Whether `raw` is an SGR sequence that opens a color/style (anything other
 * than the exact reset `\x1b[0m`).
 *
 * @param {string} raw
 * @returns {boolean}
 */
function isColorOpen(raw) {
  return raw.startsWith("\x1b[") && raw !== "\x1b[0m";
}

/**
 * Truncates `str` to fit within `maxWidth` display columns, preserving ANSI
 * color/OSC-8 sequences and never cutting mid-codepoint or mid-escape. If a
 * color was left open by the truncation point, appends a reset so the
 * cut-off segment can't bleed color into whatever follows it.
 *
 * @param {string} str
 * @param {number} maxWidth
 * @param {string} [ellipsis]
 * @returns {string}
 */
export function truncateToWidth(str, maxWidth, ellipsis = "…") {
  if (maxWidth <= 0) return "";
  if (displayWidth(str) <= maxWidth) return str;

  const tokens = tokenize(str);
  const ellipsisWidth = displayWidth(ellipsis);
  const limit = maxWidth - ellipsisWidth;

  let accumulated = 0;
  let colorOpen = false;
  const kept = [];
  for (const token of tokens) {
    if (token.type === "esc") {
      kept.push(token.raw);
      colorOpen =
        token.raw === "\x1b[0m" ? false : colorOpen || isColorOpen(token.raw);
      continue;
    }
    if (accumulated + token.width > limit) break;
    accumulated += token.width;
    kept.push(token.raw);
  }

  return kept.join("") + ellipsis + (colorOpen ? "\x1b[0m" : "");
}

/**
 * @typedef {{ id: string, priority: number, text: string, minWidth: number }} RowSegment
 */

/**
 * @param {ReadonlyArray<RowSegment>} segments original-order segment list.
 * @param {Set<string>} kept ids currently retained.
 * @param {string} separator
 * @returns {number}
 */
function currentWidth(segments, kept, separator) {
  const texts = segments.filter((s) => kept.has(s.id)).map((s) => s.text);
  return displayWidth(texts.join(separator));
}

/**
 * Fits `segments` into `budget` display columns, dropping the
 * lowest-priority segment (right-side ties dropped first) until the joined
 * width fits, then truncating a sole surviving over-budget segment as a last
 * resort. Segments are always joined and returned in their original array
 * order, never priority order. Pure: never mutates the input `segments`.
 *
 * @param {ReadonlyArray<RowSegment>} segments
 * @param {number} budget
 * @param {string} separator
 * @returns {string}
 */
export function fitRow(segments, budget, separator) {
  const kept = new Set(segments.map((s) => s.id));

  while (kept.size > 1 && currentWidth(segments, kept, separator) > budget) {
    let dropId = null;
    let dropPriority = Number.POSITIVE_INFINITY;
    for (const s of segments) {
      if (!kept.has(s.id)) continue;
      if (s.priority <= dropPriority) {
        dropPriority = s.priority;
        dropId = s.id;
      }
    }
    if (dropId === null) break;
    kept.delete(dropId);
  }

  const survivors = segments.filter((s) => kept.has(s.id));

  if (survivors.length === 1 && displayWidth(survivors[0].text) > budget) {
    const [sole] = survivors;
    return truncateToWidth(sole.text, Math.max(sole.minWidth, budget));
  }

  return survivors.map((s) => s.text).join(separator);
}

/**
 * Reads the terminal width a statusLine command was launched with. Per
 * Anthropic's statusLine docs, `COLUMNS`/`LINES` are the only reliable
 * source inside a statusLine subprocess — `tput cols` does not work there.
 *
 * @param {{ COLUMNS?: unknown } | undefined} env
 * @returns {number} the parsed column count, or `80` when absent/invalid.
 */
export function terminalColumns(env) {
  const n = Number.parseInt(String(env?.COLUMNS ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 80;
}
