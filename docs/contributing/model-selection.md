# Claude model selection

Which Claude model runs which kind of task in this repo, and why. Grounded in
Anthropic's official guidance — the
[choosing-a-model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model)
and [models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
pages, the [effort docs](https://platform.claude.com/docs/en/build-with-claude/effort),
Claude Code [model configuration](https://code.claude.com/docs/en/model-config),
and the Agent SDK
[subagents guidance](https://code.claude.com/docs/en/agent-sdk/subagents) — and
calibrated against this project's own history (326 Claude-co-authored commits,
cross-tabulated by task type; see the README badges).

The model that actually ran is always recorded by the commit's
`Co-Authored-By:` trailer (canonical names: `bin/lib/claude-models.mjs`), so
this doc is auditable against `git log` at any time.

## The procedure

Apply these steps in order when planning a task:

1. **Tune effort before switching models.** Anthropic: "Tuning effort is often
   a better lever than switching models" and "if you observe shallow reasoning
   on complex problems, raise effort rather than prompting around it."
2. **Pick the tier by task shape** using the matrix below — not by habit, and
   not by copying whatever the last session used.
3. **Hub vs spoke.** The hub session carries planning and orchestration and
   gets the capable tier; spokes get their model from the `model:` frontmatter
   in `.claude/agents/*.md`, which must match the enforcement block below
   (verified by `pnpm check:agents`). This is the SDK's tiering pattern: "use
   a more capable model for high-stakes reviews", cheaper workers elsewhere.
4. **Use aliases, not pinned IDs**, where the surface allows
   (`fable` / `opus` / `sonnet` / `haiku`) so tiers auto-upgrade on release.
   The trailer records the concrete model that ran, so provenance survives the
   alias indirection.
5. **Escalate on evidence.** Raise effort first, then one tier, when output
   quality misses; step back down for routine work once results hold.

## Task matrix

Every task category this project has performed, with the model tier it should
run on. "Official grounding" quotes Anthropic's published positioning.

| #   | Task category                                                                                        | Historical examples                                                       | Model (alias)              | Effort                  | Official grounding / notes                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Multi-phase overhauls, release audits, strategy ADRs — multi-sitting hub work                        | script-pipeline PRs #90–91, pre-1.0.0 audit plan, ADR-0021 (all Fable 5)  | Fable 5 (`fable`)          | `high`; `xhigh` hardest | "Long-running agents … largest, most critical projects … fewer check-ins"; plans across stages and delegates to subagents                     |
| 2   | Submodule/feature implementation hub sessions — single-sitting complex agentic coding                | the 22 submodules, WS-3…WS-9, safety-net hardening (Opus 4.8)             | Opus 4.8 (`opus`)          | `xhigh`                 | "Complex agentic coding and enterprise work"; the developer-docs default; `xhigh` is "the best setting for most coding and agentic use cases" |
| 3   | GREEN-phase implementation spoke (`code-implementer`)                                                | every submodule's `src/**`                                                | `sonnet`                   | `high`                  | "Best combination of speed and intelligence … built for coding"; contract + failing tests already pin the scope                               |
| 4   | RED-phase test authoring spoke (`test-author`)                                                       | every submodule's tests                                                   | `sonnet`                   | `high`                  | Same tier; well-scoped from the documented contract                                                                                           |
| 5   | High-stakes review spokes (`security-reviewer`, `type-design-analyzer`, `spec-conformance-reviewer`) | every review gate                                                         | `opus`                     | `xhigh`                 | SDK: "use a more capable model for high-stakes reviews"                                                                                       |
| 6   | General review spokes (`code-reviewer`, `silent-failure-hunter`)                                     | every review gate                                                         | `sonnet`                   | `high`                  | Routine-quality review; escalate to row 5 only when the diff touches public API or security                                                   |
| 7   | Mechanical doc reconciliation (`/syncing-docs`: provenance, counts, index, badges)                   | 85 `docs:` reconciliation commits (historically over-provisioned on Opus) | `haiku` or `sonnet`        | `low`–`medium`          | "High-volume, straightforward tasks"; the work is deterministic-script-driven — the model only orchestrates                                   |
| 8   | Docs-consistency audit spoke (`docs-consistency-reviewer`)                                           | pre-docs-PR checks                                                        | `haiku`                    | `medium`                | "Near-frontier performance … sub-agent tasks"                                                                                                 |
| 9   | CI/workflow config tweaks, dependency chores, merge-conflict regeneration                            | pr-review turn bumps, Dependabot follow-ups                               | `sonnet`                   | `medium`                | Small well-scoped edits; Sonnet 5 at `medium` ≈ Sonnet 4.6 at `high`                                                                          |
| 10  | CI PR-review bot (`claude-pr-review.yml`, blocking gate)                                             | every PR                                                                  | `claude-sonnet-5` (pinned) | workflow default        | "Frontier intelligence at scale"; if FAIL-verdict quality slips, the high-stakes rule argues for `opus` — revisit on evidence                 |
| 11  | Explore/research fan-out subagents (audits, searches)                                                | audit fan-outs                                                            | `haiku` or inherit         | `low`                   | Haiku positioning: "sub-agent tasks"; conclusions-only reporting tolerates the cheaper tier                                                   |
| 12  | Work logs, lessons promotion, README/prose docs                                                      | `docs/logs/*.md`                                                          | `sonnet`                   | `medium`                | Writing quality matters but scope is bounded                                                                                                  |

**Legacy note:** `Claude Sonnet 4.6` (106 bootstrap-era commits, 2026-06-29 →
07-02) was the prior-generation daily driver — correct at the time, since
superseded by Sonnet 5 through the `sonnet` alias.

## Enforcement

The spoke and workflow rows above are machine-verified: `pnpm check:agents`
(a CI step) asserts that every `.claude/agents/*.md` `model:` frontmatter and
every `--model` pin in `.github/workflows/*.yml` matches the block below.
Change a spoke's model here **and** in its frontmatter, in the same commit —
drift in either direction fails CI.

The hub session's model cannot be machine-enforced (it is user-selected via
`/model`); the `starting-work` decision gate surfaces the matrix row for the
task instead.

<!-- BEGIN MODEL-MATRIX -->

| Surface  | Name                        | Model             |
| -------- | --------------------------- | ----------------- |
| agent    | `code-implementer`          | `sonnet`          |
| agent    | `test-author`               | `sonnet`          |
| agent    | `code-reviewer`             | `sonnet`          |
| agent    | `silent-failure-hunter`     | `sonnet`          |
| agent    | `security-reviewer`         | `opus`            |
| agent    | `type-design-analyzer`      | `opus`            |
| agent    | `spec-conformance-reviewer` | `opus`            |
| agent    | `docs-consistency-reviewer` | `haiku`           |
| workflow | `claude-pr-review.yml`      | `claude-sonnet-5` |
| workflow | `claude-assistant.yml`      | `claude-sonnet-5` |

<!-- END MODEL-MATRIX -->
