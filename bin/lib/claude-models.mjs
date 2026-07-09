// Single source of truth for the Claude model names allowed in
// `Co-Authored-By:` git trailers, plus read-time normalization for the
// non-canonical variants that already exist in history. Consumed by
// bin/lint-commit.mjs (write-time validation at the commit-msg stage) and
// bin/gen-commit-stats.mjs (read-time aggregation for the README badges).
// The convention itself is documented in docs/contributing/contributing.md.

/** The only email sanctioned for Claude co-author trailers. */
export const CO_AUTHOR_EMAIL = "noreply@anthropic.com";

/**
 * Canonical Claude model names, exactly as they must appear in a
 * `Co-Authored-By:` trailer. Ordered by capability tier (see
 * docs/contributing/model-selection.md). Extend this list when Anthropic
 * ships a new model; never edit history to match it.
 */
export const CANONICAL_CLAUDE_MODELS = Object.freeze([
  "Claude Fable 5",
  "Claude Opus 4.8",
  "Claude Sonnet 5",
  "Claude Sonnet 4.6",
  "Claude Haiku 4.5",
]);

/**
 * Non-canonical model names that landed in history before validation
 * existed, mapped to their canonical form. Read-time only: counting and
 * reporting fold these into the canonical name, but new commits using them
 * are rejected by bin/lint-commit.mjs.
 */
export const HISTORICAL_ALIASES = Object.freeze({
  "Claude Opus 4.8 (1M context)": "Claude Opus 4.8",
});

/**
 * Parse a `Co-Authored-By` trailer value of the form `Name <email>`.
 *
 * @param {string} value
 * @returns {{ name: string, email: string } | null}
 */
export function parseCoAuthor(value) {
  const match = value.trim().match(/^(.+?)\s*<([^<>]*)>$/);
  if (match === null) return null;
  return { name: match[1].trim(), email: match[2].trim() };
}

/**
 * Resolve a trailer model name to its canonical form, folding historical
 * aliases. Returns `null` for names outside the sanctioned set.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function normalizeClaudeModel(name) {
  if (CANONICAL_CLAUDE_MODELS.includes(name)) return name;
  return HISTORICAL_ALIASES[name] ?? null;
}
