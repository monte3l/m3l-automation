// Single source of truth for the three guarded path globs used by the Claude
// hook layer to prevent hub-authored or branch-isolation writes into source and
// test trees. Shared by:
//   - .claude/hooks/guard-branch-isolation.mjs  (blocks writes while HEAD is main)
//   - .claude/hooks/guard-hub-src-writes.mjs    (blocks hub writes on any branch)
//
// Keeping the regex in one place means neither guard can silently diverge from
// the other when the protected glob set evolves.

/**
 * Returns true if `filePath` is under a guarded source or test path:
 *   - `packages/<pkg>/src/**`
 *   - `scripts/<pkg>/src/**`
 *   - any `tests/` segment
 *
 * Matches both relative and absolute paths (the `(^|\/)` anchor).
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isProtectedPath(filePath) {
  return (
    /(^|\/)packages\/[^/]+\/src\//.test(filePath) ||
    /(^|\/)scripts\/[^/]+\/src\//.test(filePath) ||
    /(^|\/)tests\//.test(filePath)
  );
}
