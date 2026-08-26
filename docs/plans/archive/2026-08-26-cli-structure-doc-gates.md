# Plan: U2 — CLI structure + doc gates

**Status: shipped** — landed on `feat/cli-structure-doc-gates`, closing
issue #526. Decision:
[ADR-0053](../../adr/0053-cli-first-evolution-programme.md) §Governance.

## Context

`packages/m3l-cli` and `docs/reference/cli.md` were the only first-class
surfaces in this repo with no machine gate on their shape. Every `scripts/*`
package is held to the ADR-0022 layout by `check:script-scaffold` and its two
documents to a canonical section spec by `check:script-docs`; the CLI package
— 22 source modules, 20 test files, a 212-line contract page — had neither. A
repo-wide grep of `bin/**/*.mjs` found exactly one mention of `cli.md`
anywhere in tooling: a description string in `bin/lib/command-catalog.mjs`.
ADR-0053 §Governance named this the CLI programme's one governance gap.

It mattered now because U2 is a direct blocker for U9 (`m3l new` moves
scaffolding out of `bin/scaffold-script.mjs` into the CLI) and U10
(`m3l flow`). Both grow the CLI's `src/` tree and add `cli.md` sections;
without a structure gate that growth is unconstrained, and the `## Exit
codes` consolidation deferred to "when U2's gate lands" never happens.

## Approach / Decisions

Every claim in the issue was re-derived against `aea99ec` before any code was
written, which produced three corrections to its framing. The `package.json`
`check:*` entries are **not** alphabetical (they are thematically grouped in
rough `ci.yml` order), so the new entries went after `check:script-deps`. The
root tsconfig project reference is **already** gated by
`bin/check-scaffold.mjs`, so the new gate must not duplicate it. And
`bin/tests/**` **is** type-checked (`tsc -p bin/tsconfig.json`), so the
`.mjs` JSDoc annotations are load-bearing, not decorative. A second tracker
row was also found: `docs/ROADMAP.md` carries a U2 row alongside
`docs/plans/IMPLEMENTATION.md`, and both had to flip.

Decisions settled before implementation:

- **Single-file gates, not a `bin/lib/` split.** `check-script-scaffold.mjs`
  is split into a checker plus `bin/lib/script-scaffold.mjs` for exactly one
  documented reason: the _generator_ (`bin/scaffold-script.mjs`) and the
  _checker_ consume one manifest so they cannot drift. There is no CLI
  generator and never will be — there is exactly one `packages/m3l-cli`.
  Extending the script manifest would have been actively wrong: its stated
  invariant is "everything here is emitted by the generator", and its
  `REQUIRED_EXACT_FILES` / `packageManifestErrors` are `scripts/<name>`-shaped.
  Pure validators sit above a `process.argv[1] === fileURLToPath(...)` main
  guard instead — the `check-script-deps.mjs` pattern.
- **The dependency rule expresses zero _third-party_ runtime dependencies**,
  not `check:script-deps`'s "exactly one dependency": the library, plus any
  `@m3l-automation/*` package at `workspace:*`. `eslint.config.js` already
  says verbatim that the CLI's guarantee is mechanized at source level "the
  same way `check:script-deps` guards the scripts' manifests" — the manifest
  half was the acknowledged missing piece. But U7 makes the CLI declare the
  script packages as dependencies, so an "exactly one" rule would have been
  torn out there; this phrasing survives U7 untouched.
- **Pin only what an invariant names.** Individual command modules are
  deliberately absent from `CLI_REQUIRED_EXACT_FILES` — that set grows per
  phase (U9 `new`, U10 `flow`, U12 `completion`), and pinning
  `src/commands/doctor.ts` by name would make the gate a changelog.
  `src/history` and `src/presets` are allowed layers but not required ones:
  they are 8f feature stores ADR-0054/U7 may relocate.
- **`###` = phase, `####` = command.** The issue's plan text called for "one
  `###` per command", which contradicts both the shipped page and itself. The
  shipped two-level shape was kept and the reasoning recorded, with **zero**
  edits to `cli.md`'s `## Commands` section.
- **Ordering is enforced for `cli.md`, unlike `check:script-docs`.** That
  gate spans 22 files with sanctioned layout deviations where ordering would
  produce false positives; this is one file with an explicitly ordered
  canonical list. The divergence is recorded in the spec prose so the two
  gates are not mistaken for copies of each other.
- **Pre-push split mirrors the scripts side:** `check:cli-docs` pre-push +
  CI, `check:cli-scaffold` CI-only.

The highest-value assertion turned out to be the `## Commands` cross-check:
the command set is regex-extracted from `src/main.ts`'s
`STATIC_COMMAND_NAMES`, so U9/U10/U12 cannot ship a command without
documenting it — literally ADR-0053's Governance mandate. The technique was
already sanctioned in this repo by `packages/m3l-cli/tests/doctor.test.ts`,
which does the same extraction against `bin/lib/script-scaffold.mjs`. An
extraction that returns nothing is itself an error, so renaming that literal
fails loudly rather than silently reducing the whole cross-check to a no-op.

## Outcome

Four commits in one PR: the docs slice first (so no commit in the range is
CI-red), then each gate with its tests and its own wiring entries, then the
tracker flips.

- `bin/check-cli-scaffold.mjs` — required files, required globs, the manifest
  contract (including the absent `scripts.start` and absent `exports` that
  assert the bin-first identity), both tsconfig shapes, plus four reverse
  checks: the `src/` layer allowlist, `main.ts` as the only file directly
  under `src/`, exactly one file in `bin/`, and no `scripts/*/package.json`
  depending on the CLI. 64 unit tests.
- `bin/check-cli-docs.mjs` — title/preamble, required sections, ordering,
  conditional sections with teeth (`## Flows` needs a `###`; `## Completion`
  must name a shell), near-miss guards for the two optional headings, the
  `## Commands` docs↔code cross-check, and `## Exit codes` substance. 39 unit
  tests, including a synthetic ninth command name that proves the cross-check
  is not hard-coded.
- `docs/reference/cli.md` gained the consolidated `## Exit codes` table;
  `docs/contributing/cli-structure.md` is the new spec for both gates.
- Wired into `package.json`, `bin/lib/verify-steps.mjs`,
  `bin/lib/command-catalog.mjs`, `.github/workflows/ci.yml`, `lefthook.yml`,
  and the `CLAUDE.md` cadence row.

Each gate was verified to _bite_, not merely to pass: dropping `bin.m3l`,
renaming the `## Exit codes` heading, adding a ninth `STATIC_COMMAND_NAMES`
entry, and dropping a stray file into `packages/m3l-cli/bin/` each produced a
specific, named failure. That check was deliberate — three count/index gates
have shipped in this repo as latent no-ops because only the passing direction
was ever exercised.

Two divergences from the authored plan, both from re-deriving its claims
against the file: three of the five listed `cli.md` consolidation sites
(`list`, `inspect`, `doctor`) carried **only** command-specific exit
semantics with no generic restatement to remove, so they were left untouched
per the plan's own "keep the command-specific semantics" instruction; and the
reviewable size came in at ~77 KB rather than the plan's estimated ~51 KB
(the two test files alone are 37 KB), over ADR-0072's 75 KB soft target
though far under the 300 KB ceiling.

Follow-up found but not fixed here, worth its own issue: the reserved
command-name list exists in **four** places —
`bin/lib/script-scaffold.mjs`'s `RESERVED_CLI_NAMES`,
`src/commands/doctor.ts`'s `RESERVED_COMMAND_NAMES`, `src/main.ts`'s
`STATIC_COMMAND_NAMES`, and `src/commands/dynamic.ts` — and only the first
two are drift-guarded. Extending that existing guard to all four sites is a
clean separate change.
