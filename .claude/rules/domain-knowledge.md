---
paths:
  - "packages/**/*.ts"
  - "scripts/**/*.ts"
  - "**/*.test.ts"
---

# Domain knowledge base (`rules/`)

The canonical code, test, and refactoring **style guide** is
[`docs/contributing/style-guide.md`](../../docs/contributing/style-guide.md) — read
it first for how to write and change code/tests, with each rule tagged
`[enforced]` vs `[advisory]`. The path-scoped `.claude/rules/*` files
(`library-src.md`, `tests.md`, `refactoring.md`, `scripts.md`) are its
auto-loading extracts; this file is the deeper index — reach for it before
substantial work in a domain not already covered by those extracts.

This repo deliberately uses path-scoped rules instead of nested per-directory
CLAUDE.md files: conventions here are cross-cutting (one library, one style
guide) rather than owned per-directory, so a single `.claude/rules/*` layer is
the right tool per Anthropic's own decision matrix for when to prefer rules
over nested CLAUDE.md.

This is reference material, not a substitute for the authoritative spec of a
given submodule (that's its `docs/reference/**` page) or the hard ESM/library
rules in `.claude/rules/library-src.md`.
