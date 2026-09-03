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

## Cross-cutting hazards

These live here rather than in a narrower extract because they recur in trees
`library-src.md` (scoped to `packages/m3l-common/src/**`) and `tests.md` do
not cover.

- **A migration `user_version` is provisional until it is pushed.** It is drawn
  from one monotonic sequence that concurrent sessions consume, exactly like an
  ADR number — and `docs/adr/README.md`'s "a drafted-but-unpushed ADR number is
  provisional, not reserved" applies verbatim, with a worse failure mode. An
  ADR collision surfaces as a rebase conflict; a version collision lands a
  second migration on a taken number and carries its drift digest with it, so
  the registry and the recorded history disagree. Never carry the number from a
  plan, an issue, or an earlier turn: read `schemaVersion` against a migrated
  database at the moment you write the entry. A plan that names a version has
  already gone stale if any sibling PR merged since it was written
  (`docs/logs/2026-09-03-x8-open-items.md` — a plan said v10, v10 was taken
  mid-flight, the migration shipped as v11).
- **`*/` inside a block comment closes it.** Writing a glob in prose inside
  `/** … */` — a package-wildcard `src` pattern, or one matching a `tests`
  subtree — ends the comment early and turns the remainder into live code.
  Prettier then reformats that code, so the reported error lands on a line you
  never wrote. Describe the pattern in prose instead: "every package's `src`
  tree". The tell: prettier reports a file changed after a comment-only edit.
