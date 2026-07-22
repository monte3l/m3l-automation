// Single source of truth for the Claude model names allowed in
// `Co-Authored-By:` git trailers, plus read-time normalization for the
// non-canonical variants that already exist in history. Consumed by
// bin/lint-commit.mjs (write-time validation at the commit-msg stage) and
// bin/gen-commit-stats.mjs (read-time trailer aggregation, published as
// endpoint badges by bin/gen-commit-stats-endpoint.mjs).
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

/**
 * Legal values for a `.claude/agents/*.md` `model:` frontmatter field, per
 * Anthropic's documented subagent configuration
 * (https://code.claude.com/docs/en/sub-agents). Consumed by
 * bin/check-agents.mjs to validate the MODEL-MATRIX block in
 * docs/contributing/model-selection.md and every agent's frontmatter — not
 * just that they agree with each other, but that the shared value is itself
 * legal. `inherit` is included even though no agent in this repo currently
 * uses it (every spoke pins an explicit tier), since it is a documented,
 * valid frontmatter value.
 */
const AGENT_MODEL_ALIASES = Object.freeze([
  "sonnet",
  "opus",
  "haiku",
  "fable",
  "inherit",
]);

/**
 * Legal values for a `--model` pin on a GitHub Actions workflow. Broader than
 * {@link AGENT_MODEL_ALIASES}: workflows may also use the session-level
 * aliases `default`, `best`, and `opusplan` (opus during plan mode, sonnet
 * for execution), plus the `opus[1m]` long-context variant. Full model IDs
 * are still validated via the `claude-<family>-<n>` ID pattern.
 */
const WORKFLOW_MODEL_ALIASES = Object.freeze([
  ...AGENT_MODEL_ALIASES,
  "default",
  "best",
  "opusplan",
  "opus[1m]",
]);

/**
 * Legal effort levels for a subagent's `effort:` frontmatter field, low to
 * high. Every agent/matrix row today tops out at `xhigh` (see
 * docs/contributing/model-selection.md, "Enforcement"); `max` is included as
 * reserved headroom for a future task shape, not because any row uses it yet.
 */
const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/** Matches a full Anthropic model ID, e.g. `claude-opus-4-8` or `claude-sonnet-5`. */
const MODEL_ID_PATTERN = /^claude-[a-z]+-[a-z0-9-]+$/;

/**
 * Is `value` a legal `model:` value for a `.claude/agents/*.md` subagent —
 * one of {@link AGENT_MODEL_ALIASES} or a full model ID?
 *
 * @param {string | undefined} value
 * @returns {boolean}
 */
export function isValidAgentModel(value) {
  if (value === undefined) return false;
  return AGENT_MODEL_ALIASES.includes(value) || MODEL_ID_PATTERN.test(value);
}

/**
 * Is `value` a legal `--model` pin for a GitHub Actions workflow — one of
 * {@link WORKFLOW_MODEL_ALIASES} or a full model ID?
 *
 * @param {string | undefined} value
 * @returns {boolean}
 */
export function isValidWorkflowModel(value) {
  if (value === undefined) return false;
  return WORKFLOW_MODEL_ALIASES.includes(value) || MODEL_ID_PATTERN.test(value);
}

/**
 * Is `value` a legal `effort:` value for a subagent?
 *
 * @param {string | undefined} value
 * @returns {boolean}
 */
export function isValidEffort(value) {
  if (value === undefined) return false;
  return EFFORT_LEVELS.includes(value);
}
