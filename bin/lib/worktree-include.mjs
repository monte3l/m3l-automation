// Shared parser for the repo-root `.worktreeinclude` file. Both the manual
// setup script (`worktree-setup.mjs`) and the hygiene validator
// (`check-worktree-include.mjs`) consume it, so the parse and the
// literal-vs-pattern classification live here once.
//
// The copier in `worktree-setup.mjs` only handles literal file paths; glob and
// negation patterns are surfaced (so the operator copies them manually) rather
// than expanded. The classification regex below is the single source of truth
// for "is this a literal path".

/**
 * Parse `.worktreeinclude` contents into literal file paths and non-literal
 * (glob / negation) patterns. Blank lines and `#` comments are dropped.
 *
 * @param {string} text - Raw file contents.
 * @returns {{ literals: string[], patterns: string[] }} Literal paths to copy
 *   verbatim, and glob/negation patterns the copier cannot expand.
 */
export function parseWorktreeInclude(text) {
  const entries = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  /** @type {string[]} */
  const literals = [];
  /** @type {string[]} */
  const patterns = [];

  for (const entry of entries) {
    if (/[*?![\]]/.test(entry) || entry.startsWith("!")) patterns.push(entry);
    else literals.push(entry);
  }

  return { literals, patterns };
}
