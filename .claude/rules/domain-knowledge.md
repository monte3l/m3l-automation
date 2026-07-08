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
auto-loading extracts.

The repo root holds six in-depth standards docs under `rules/`. They are the
deeper _why_ behind the style guide and the terse path-scoped rules, and are
referenced by number throughout the agents (e.g. the code-reviewer's "four-part
checklist (rules 01)"). They are easy to forget because they live outside
`.claude/` — so before substantial work in a domain below, read the matching doc
rather than guessing at the standard.

| Doc                                                                         | Read it when…                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules/01-code-quality-and-standards.md` — Code Quality & Standards         | the deeper _why_ behind the style guide: quality hierarchy, four-part review checklist, anti-patterns (context gaps, phantom deps, over-engineering, test theater). Concrete code/refactoring rules live in the style guide. |
| `rules/02-testing.md` — Testing                                             | test-pyramid theory and the TDD cycle. **Note:** this library is unit-only (see the style guide); the integration/E2E layers here are aspirational, not present.                                                             |
| `rules/03-design-principles-and-patterns.md` — Design Principles & Patterns | shaping an API or class: SOLID, composition over inheritance, dependency injection, when a pattern earns its keep.                                                                                                           |
| `rules/04-architecture.md` — Architecture                                   | decisions with structural/semver impact: the `exports` contract, module boundaries, `internal/` privacy, tree-shaking.                                                                                                       |
| `rules/05-data-and-infrastructure.md` — Data & Infrastructure               | anything touching IO, files, AWS, config sources, or the CI pipeline ordering (fast-first).                                                                                                                                  |
| `rules/06-machine-learning-and-ai.md` — Machine Learning & AI               | working on any ML/AI-adjacent capability.                                                                                                                                                                                    |

These are reference material, not a substitute for the authoritative spec of a
given submodule (that's its `docs/reference/**` page) or the hard ESM/library
rules in `.claude/rules/library-src.md`.
