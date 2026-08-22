// Pure derivation for bin/check-control-chars.mjs. Nothing here reads a
// filesystem or shells out — the CLI wrapper collects `{path, bytes}` pairs and
// hands them to scanControlChars, mirroring bin/lib/label-drift.mjs's shape so
// this stays exercisable in tests without touching disk.
//
// Why this gate exists. A literal control byte in a source file makes the whole
// file BINARY to git: no diff, no review, and every existing quality gate stays
// green. Four NUL bytes reached `main` in bin/lib/hub-view-drift.mjs (PR #599)
// and survived three pushes past `prettier --check`, `eslint` and `gitleaks`
// before a reviewer noticed the file had become unreviewable. Two older files
// carried the same defect undetected for weeks.
//
// The rule is not "never express a control character" — it is "express it as an
// ESCAPE SEQUENCE, never as a literal byte". `"\x00"` and a raw NUL are
// byte-identical at runtime; only one of them is reviewable. That makes this
// gate exemption-free: every legitimate use has a legitimate spelling, so there
// is no allowlist to rot.

/**
 * File extensions whose contents are legitimately binary. Checked by extension
 * rather than by sniffing content, because sniffing is exactly the heuristic
 * this gate exists to replace — a file that "looks binary" is the failure mode,
 * not the exemption.
 */
export const BINARY_EXTENSIONS = new Set([
  ".avif",
  ".docx",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".svgz",
  ".ttf",
  ".webp",
  ".woff",
  ".woff2",
  ".xlsx",
  ".zip",
]);

/**
 * Byte values allowed to appear literally: tab and newline. Carriage return is
 * NOT allowed — this repo is LF-only (prettier enforces it), so a literal CR is
 * a line-ending accident rather than intent.
 */
const ALLOWED = new Set([0x09, 0x0a]);

/** True for a byte that must be written as an escape sequence, not literally. */
function isForbidden(byte) {
  if (ALLOWED.has(byte)) return false;
  // C0 controls plus DEL. Anything above 0x7f is a UTF-8 continuation or lead
  // byte and is not this gate's concern.
  return byte < 0x20 || byte === 0x7f;
}

/** `0x00` -> `\x00`, in the `\x..` form this repo already uses everywhere. */
function escapeFor(byte) {
  return `\\x${byte.toString(16).padStart(2, "0")}`;
}

/**
 * Scan `files` for literal control bytes, returning one finding per offending
 * file (not per byte) so a file with fifty of them produces one actionable
 * message rather than fifty.
 *
 * Reports 1-based line and column, and names the exact escape sequence to
 * substitute, because the remedy is always mechanical: the finding should be
 * fixable without re-deriving what the byte was.
 *
 * @param {{ path: string, bytes: Uint8Array }[]} files
 * @returns {string[]} one finding per file, empty when clean
 * @example
 * ```js
 * import { scanControlChars } from "@m3l-automation/workspace/bin/lib/control-char-scan.mjs";
 *
 * scanControlChars([
 *   { path: "a.ts", bytes: new TextEncoder().encode('const x = "a\\x00b";') },
 * ]);
 * // ['a.ts carries 1 literal control byte ... line 1, column 13: 0x00 — write it as `\\x00` instead ...']
 * ```
 */
export function scanControlChars(files) {
  /** @type {string[]} */
  const findings = [];

  for (const { path, bytes } of files) {
    /** @type {{ byte: number, line: number, column: number }[]} */
    const hits = [];
    let line = 1;
    let lineStart = 0;

    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte === 0x0a) {
        line += 1;
        lineStart = index + 1;
        continue;
      }
      if (isForbidden(byte)) {
        hits.push({ byte, line, column: index - lineStart + 1 });
      }
    }

    if (hits.length === 0) continue;

    // Cap the enumerated detail: past a handful, the file is either binary and
    // needs an extension entry, or wholly corrupt — neither is helped by a
    // hundred coordinates.
    const shown = hits.slice(0, 5);
    const detail = shown
      .map(
        (hit) =>
          `line ${hit.line}, column ${hit.column}: 0x${hit.byte
            .toString(16)
            .padStart(
              2,
              "0",
            )} — write it as \`${escapeFor(hit.byte)}\` instead`,
      )
      .join("; ");
    const more =
      hits.length > shown.length
        ? ` (+${hits.length - shown.length} more)`
        : "";

    findings.push(
      `${path} carries ${hits.length} literal control byte(s), which makes the ` +
        `whole file binary to git — no diff, no review, and every other gate ` +
        `still passes. ${detail}${more}. A control character written as an ` +
        `escape sequence is byte-identical at runtime and stays reviewable, so ` +
        `there is no exemption: if the file is genuinely binary, add its ` +
        `extension to BINARY_EXTENSIONS in bin/lib/control-char-scan.mjs.`,
    );
  }

  return findings;
}
