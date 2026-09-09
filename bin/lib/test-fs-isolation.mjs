// Pure derivation for bin/check-test-fs-isolation.mjs — no disk or git
// access, so it is exercisable in bin/tests/**/*.test.ts against synthetic
// source strings rather than only the live repo (.claude/rules/tests.md:
// "Test a `bin/` checker against synthetic state, not just the live repo").
//
// A deliberately TEXTUAL check, not an AST walk: the question this file
// answers ("does this file's text contain a matching cleanup call
// ANYWHERE?") is a whole-file presence check, not a syntactic pattern at one
// node — exactly the shape `no-restricted-syntax` cannot express, and the
// reason this gate exists alongside the ESLint selectors rather than folded
// into one of them. See check-test-fs-isolation.mjs's header for the
// intentional-weakness rationale.

const MKDTEMP_CALL = /\bmkdtemp(?:Sync)?\s*\(/;
const RM_CALL = /\brm(?:Sync)?\s*\(/;

/**
 * @param {string} source a test file's full text
 * @returns {boolean} true when the file calls mkdtemp()/mkdtempSync() but
 *   contains no rm()/rmSync() call anywhere — a sandbox created and never
 *   torn down. False for a file with no mkdtemp call at all (nothing to
 *   check) and for a file that has both calls, regardless of whether the
 *   `rm` actually targets the `mkdtemp` root (see the module header). Both
 *   regexes match comment and string-literal text as readily as real code —
 *   a source with `mkdtemp(` only in a comment and no real cleanup call
 *   returns `true` (a false violation), and an `rm(` mentioned only in a
 *   comment or string masks a real one (a false pass). Accepted per the
 *   module header's design tradeoff, not an oversight.
 */
export function findMissingCleanup(source) {
  if (!MKDTEMP_CALL.test(source)) return false;
  return !RM_CALL.test(source);
}
