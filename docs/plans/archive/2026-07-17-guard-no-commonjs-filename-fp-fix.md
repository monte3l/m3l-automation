# Fix guard-no-commonjs false positive on `*-exports.<ext>` filenames (2026-07-17)

**Status: shipped** (PR #153, commit 81c97b9)

## Context

`.claude/hooks/guard-no-commonjs.mjs` is a PreToolUse blocking hook that
rejects CommonJS constructs (`require(...)`, `module.exports`,
`exports.<name>`, `__dirname`, `__filename`) since the package is ESM-only.
Its `exports.<name>` detector used a bare `\b` boundary, which also fires
inside a kebab-case filename like `bin/check-doc-exports.mjs` — the hyphen-to-letter
transition reads as a word boundary — so any comment, import path, or
`package.json` script string mentioning that real file (or any future
`*-exports.mjs` bin script) got blocked. This false positive hit three
separate subagents mid-task during the ADR-0030 delivery, forcing workarounds
like splitting the string mid-word.

## Approach / Decisions

- Refactored the hook to match its sibling guards
  (`guard-secret-writes.mjs`, `guard-eslint-disable-red.mjs`), which already
  export their detection logic as pure, independently-testable functions and
  gate the stdin-reading CLI body behind an `import.meta.url` check —
  `guard-no-commonjs.mjs` was the one outlier with neither. Extracted
  `isGuardedFilePath()` and `findCommonJsHits()` as named exports,
  behavior-preserving (regex untouched in this step).
- Added `bin/tests/guard-no-commonjs.test.ts`, including a regression case —
  intentionally red against the still-buggy regex — asserting that both a
  `package.json` script string and an import path mentioning
  `check-doc-exports.mjs` return no hits.
- Fixed the regex with a negative lookbehind excluding a preceding
  identifier char or hyphen: `/(?<![\w-])exports\.[A-Za-z_$]/`, which still
  blocks real `exports.foo = ...` assignments but lets `*-exports.<ext>`
  filename mentions through.
- Landed as three small commits: the behavior-preserving refactor, the new
  regression test (red), then the regex fix (green).

## Outcome

`guard-no-commonjs.mjs` now matches its sibling hooks' testable-function
shape and no longer blocks legitimate mentions of `*-exports.<ext>`
filenames, while still catching real CommonJS `exports.<name>` assignments.
