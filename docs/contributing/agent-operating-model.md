# Agent operating model (hub-and-spoke)

This repo runs a **hub-and-spoke** model. The main agent is the **hub**: it
plans, dispatches work to isolated subagents ("spokes"), reads their results,
updates the status file, and decides the next step. The hub **does not write
`src/`/test code and does not review code itself** — those run in spokes with
the right tool grants. This makes "the agent that writes code is never the one
that reviews it" structural, and keeps the hub's context lean.

- **Spokes** are defined in `.claude/agents/*.md` (plus the built-in `Explore`
  for read-only research): spec-conformance, `test-author` (RED),
  `code-implementer` (GREEN), and the review agents. They are leaf nodes —
  only the hub dispatches subagents (each carries `disallowedTools: Agent`), so
  the graph stays flat at depth 1. `pnpm check:agents` enforces this and that
  every `subagent_type` resolves to a real agent or known built-in.
- **Model tiering**: which Claude model runs which task category is documented
  in `docs/contributing/model-selection.md`; `pnpm check:agents` also enforces
  its MODEL-MATRIX block against agent `model:` frontmatter and workflow
  `--model` pins.
- **Official-guidance research**: when a design or audit decision hinges on
  what Anthropic itself recommends (agent/subagent design, model selection,
  prompt engineering, MCP, context management) rather than on something
  already decided in this repo, the hub runs `researching-anthropic-guidance`
  — it fans out `Explore` agents restricted to official Anthropic domains,
  each annotating a scratchpad file, then synthesizes the findings into a
  consensus-plus-flagged-contradictions briefing. Hub-only, like `auditing`,
  since it dispatches subagents.
- **TDD**: tests are written from the documented contract and fail first, then
  the implementer makes them pass; review follows.
- **Live status**: three living trackers, updated by the hub as work lands (they
  are the durable memory the isolated spokes do not share). `docs/implementation-status.md`
  is the source of truth for what library work is **built** vs. documented (the
  count-enforced 24/24 ledger — `pnpm gen:counts` regenerates every "N of M"
  badge/prose site and the implemented-list block from the ✅ rows;
  `check:doc-counts`/`check:impl-counts` verify them). `docs/ROADMAP.md`
  (coarse, unblock-first) and `docs/plans/IMPLEMENTATION.md` (detailed
  per-item backlog) track **pending** program work — the consumer-fleet
  waves, the library-friction F-series, and the gated D4/D5 modules, each as
  one table row per item (row-locality, ADR-0024) so status changes don't
  conflict across parallel branches. When a unit lands: flip its status in
  the relevant tracker, `git mv` any dated plan it completes into
  `docs/plans/archive/`, and a new friction item from a work log is filed
  into `IMPLEMENTATION.md` (not left narrative-only). Completed plans live in
  `docs/plans/archive/` (frozen, excluded from `lint:md`);
  `docs/plans/README.md` and `docs/logs/README.md` index them.
- The `implementing-submodules` skill encodes this loop end-to-end; `scaffolding-submodules`
  scaffolds a greenfield module and hands off to it. All 22 bootstrap submodules
  already have `docs/reference` specs, so `implementing-submodules` is the normal entry
  point; reach for `scaffolding-submodules` only to add a genuinely new (beyond-bootstrap)
  module — it surfaces through the namespace barrel, never a new `exports` subpath.
- **Consumer scripts have the same split**: `scaffolding-scripts` runs the
  deterministic generator (`pnpm scaffold:script`, templates in
  `templates/script/`, CI backstop `pnpm check:script-scaffold`) for a
  greenfield `scripts/<name>/` package, then hands off to `implementing-scripts`
  — the script-scale TDD loop reusing the same spokes (no coverage/exports
  gates; `check:script-scaffold` + knip are the backstops).
- **Current state**: see `docs/implementation-status.md` for the authoritative
  built-vs-documented tracker and suggested build order.
- **Lessons learned**: `docs/logs/` holds per-submodule work logs. The
  `core/errors` log (`docs/logs/2026-06-29-core-errors.md`) is the durable
  source for the process lessons baked into the spoke prompts — front-load exact
  contract nuances, lint in-loop, justify error-channel `eslint-disable`, read
  coverage from `coverage-final.json` (the v8 text table hides 100% files), and
  trust the CLI over the IDE/LSP.
- **Subagent mid-turn truncation** — a spoke hitting `maxTurns: 40` or an
  output-token cap mid-thought — is this repo's most-recurring build
  divergence (20+ logged occurrences). Detect it (never trust a mid-thought
  "final" report — the `SubagentStop` hook `detect-spoke-truncation.mjs` now
  flags a suspicious-looking return automatically), prevent it (decompose
  oversized dispatches up front, hand writer spokes a journal path, bound
  review-spoke input scope as well as output to a digest), and recover from it
  (run `bin/spoke-recovery.mjs` / `mcp__m3l__spoke_recover` first to automate
  the journal-parse + on-disk-verification step, then resume the SAME spoke
  via `SendMessage` on top of that recommendation rather than re-deriving
  state entirely by hand) per `docs/contributing/subagent-context-management.md`
  — the terse checklist auto-loads as `.claude/rules/subagent-dispatch.md`
  when touching `.claude/skills/**` or `.claude/agents/**`.

See also: `docs/contributing/hooks-reference.md` (the deterministic enforcement
layer underneath this advisory model) and `docs/contributing/model-selection.md`.
