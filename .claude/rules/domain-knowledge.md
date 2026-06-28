---
paths:
  - "packages/**/*.ts"
  - "scripts/**/*.ts"
  - "**/*.test.ts"
---

# Domain knowledge base (`rules/`)

The repo root holds six in-depth standards docs under `rules/`. They are the
_why_ behind the terse path-scoped rules in `.claude/rules/` and are referenced
by number throughout the agents (e.g. the code-reviewer's "four-part checklist
(rules 01)"). They are easy to forget because they live outside `.claude/` — so
before substantial work in a domain below, read the matching doc rather than
guessing at the standard.

| Doc                                                                         | Read it when…                                                                                                                                                          |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules/01-code-quality-and-standards.md` — Code Quality & Standards         | writing/reviewing any code: the four-part quality checklist, naming, comments-explain-why, anti-patterns (context gaps, phantom deps, over-engineering, test theater). |
| `rules/02-testing.md` — Testing                                             | authoring tests or deciding coverage: the test pyramid, behavior-not-internals, deterministic/isolated discipline, what to assert.                                     |
| `rules/03-design-principles-and-patterns.md` — Design Principles & Patterns | shaping an API or class: SOLID, composition over inheritance, dependency injection, when a pattern earns its keep.                                                     |
| `rules/04-architecture.md` — Architecture                                   | decisions with structural/semver impact: the `exports` contract, module boundaries, `internal/` privacy, tree-shaking.                                                 |
| `rules/05-data-and-infrastructure.md` — Data & Infrastructure               | anything touching IO, files, AWS, config sources, or the CI pipeline ordering (fast-first).                                                                            |
| `rules/06-machine-learning-and-ai.md` — Machine Learning & AI               | working on any ML/AI-adjacent capability.                                                                                                                              |

These are reference material, not a substitute for the authoritative spec of a
given submodule (that's its `docs/reference/**` page) or the hard ESM/library
rules in `.claude/rules/library-src.md`.
