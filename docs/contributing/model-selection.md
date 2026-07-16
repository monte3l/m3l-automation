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

The model that ran is recorded by the commit's `Co-Authored-By:` trailer
when one is present (canonical names: `bin/lib/claude-models.mjs`) — the
trailer itself is optional (`lint-commit.mjs` only rejects malformed claims,
not absence), so this doc is auditable against `git log` for any trailed
commit, though a handful of untrailed commits in history predate consistent
trailer discipline.

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
   For a plan-then-implement hub session (rows 1–2: audit-and-plan skills like
   `/auditing`, then implementation), prefer running the session under
   [`opusplan`](https://code.claude.com/docs/en/model-config) (`/model
opusplan` or `claude --model opusplan`) — Opus during plan mode, Sonnet once
   execution starts. This is a session-level `/model` choice, not per-agent
   frontmatter, so it cannot be machine-enforced the way spoke models are; the
   `starting-work` decision gate surfaces it as a recommendation instead.
4. **Use aliases, not pinned IDs**, where the surface allows
   (`fable` / `opus` / `sonnet` / `haiku`) so tiers auto-upgrade on release.
   The trailer records the concrete model that ran, so provenance survives the
   alias indirection. Aliases trade reproducibility for currency: the same
   alias can resolve to a different underlying model after Anthropic ships a
   new version, so a session pinned mid-task can see behavior shift between
   runs. Pin a full model ID (e.g. `claude-opus-4-8`) or set
   `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` /
   `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_DEFAULT_FABLE_MODEL` instead
   when a specific CI workflow needs a frozen snapshot (as
   `claude-pr-review.yml`/`claude-assistant.yml` already do via `--model
claude-sonnet-5`) — not for spoke frontmatter, where auto-upgrade is the
   point.
5. **Escalate on evidence.** Raise effort first, then one tier, when output
   quality misses; step back down for routine work once results hold.

## Task matrix

Every task or workflow category this project has performed, with the model tier
it should run on. "Official grounding" quotes Anthropic's published positioning.
When these URLs need refreshing — a new model/effort doc ships, or a row's
citation goes stale — run `researching-anthropic-guidance` rather than
re-Googling by hand: it fans out `Explore` agents restricted to Anthropic's
official domains and returns a dated, sourced briefing in this same
"grounding quote + URL" shape, the same convention this table and the ADR
"Evidence gathered `<date>`" links already follow.

Column 2 tags each row's workflow shape: **Coordinator workflow** = a hub
session orchestrating (and possibly dispatching) other work, **Subagent
workflow** = a spoke dispatched by a hub, **Single unit of work** = one
self-contained commit-shaped task with no dispatch. Column 3's examples are
real `<short-sha> <subject> (<date>)` triples pulled from `git log main`. A
commit's `Co-Authored-By:` trailer records the _hub_ session's model, not a
dispatched spoke's — spokes don't commit directly — so for the
subagent-workflow rows below, "examples" means the commit that shipped that
spoke's product, not a commit literally trailed with the spoke's own alias
(git has no finer grain than the hub session).

| #   | Category                                                                                                                                                                                 | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Model (alias)              | Effort                  | Official grounding / notes                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Coordinator workflow** — multi-day, multi-PR strategic hub sessions with no dispatched spokes (release audits, strategy ADRs, cross-cutting roadmaps)                                  | `572eaba` docs: record post-1.0.0 deepen-first strategy (ADR-0021) and roadmaps (2026-07-06); `1513914` docs: add pre-1.0.0 release audit resolution plan (2026-07-05); `dd1900b`+`58c33f9` consumer-script pipeline roadmap+plan, PRs #90–91 (2026-07-09); `0bcec0e` ADR-0022 workspace-restoration ratification (2026-07-09)                                                                                                                                                                                                                                              | Fable 5 (`fable`)          | `high`; `xhigh` hardest | "Long-running agents … largest, most critical projects … fewer check-ins"; plans across stages and delegates to subagents                                                                |
| 2   | **Coordinator workflow** — single-sitting hub session dispatching TDD spokes for one submodule/feature                                                                                   | `695d470` feat: implement core/json submodule (2026-07-01); `5ff949d` feat: add core/script submodule — M3LScript (2026-07-03); `26180d8` feat(aws): add clients submodule for SDK client provisioning (2026-07-03); `aec2e03` chore(agents): tier spoke models and enforce no-nesting invariant — worktree-isolation/model-tiering safety-net hardening (2026-07-01)                                                                                                                                                                                                       | Opus 4.8 (`opus`)          | `xhigh`                 | "Complex agentic coding and enterprise work"; the developer-docs default; `xhigh` is "the best setting for most coding and agentic use cases"                                            |
| 3   | **Subagent workflow** — GREEN-phase `code-implementer` spoke, dispatched inside a row-2 hub session                                                                                      | `77960ee` feat(files): implement core/files submodule (2026-07-03); `642af15` feat(importers): implement core/importers submodule (2026-07-03); `336c069` feat(text): implement core/text multi-format extraction (2026-07-02)                                                                                                                                                                                                                                                                                                                                              | `sonnet`                   | `high`                  | "Best combination of speed and intelligence … built for coding"; contract + failing tests already pin the scope                                                                          |
| 4   | **Subagent workflow** — RED-phase `test-author` spoke, dispatched alongside row 3 in the same PR                                                                                         | `16b0e4b` test(config): cover M3LConfigValidationError constructor branches (2026-07-07); `f3dbf56` test(text): cover custom extractor registration (2026-07-06); `09d0ef9` test: backfill coverage on poller, prompt, and email extractor (2026-07-06)                                                                                                                                                                                                                                                                                                                     | `sonnet`                   | `high`                  | Same tier; well-scoped from the documented contract                                                                                                                                      |
| 5   | **Subagent workflow** — high-stakes review spoke (`security-reviewer`, `type-design-analyzer`, `spec-conformance-reviewer`), findings fixed same-PR                                      | `f7d3f12` fix(storage): escape LIKE metacharacters in literal search (2026-07-03, security-shaped); `4573e79` feat(aws): make illegal login/analysis/http/exporter states unrepresentable (2026-07-04, type-design-shaped); `6935df7` fix(script): redact full serialized error in best-effort diagnostics (2026-07-05, security-shaped)                                                                                                                                                                                                                                    | `opus`                     | `xhigh`                 | SDK: "use a more capable model for high-stakes reviews"                                                                                                                                  |
| 6   | **Subagent workflow** — general review spoke (`code-reviewer`, `silent-failure-hunter`), findings fixed same-PR                                                                          | `029eeb1` refactor: resolve claude-pr-review should-fix findings in core/script (2026-07-03); `c035247` test: resolve claude-pr-review must-fix finding (2026-07-03); `9094322` feat(events): surface handler failures as best-effort diagnostics (2026-07-06, silent-failure-shaped)                                                                                                                                                                                                                                                                                       | `sonnet`                   | `high`                  | Routine-quality review; escalate to row 5 only when the diff touches public API or security                                                                                              |
| 7   | **Single unit of work** — mechanical, script-driven doc/provenance reconciliation (`/syncing-docs`: provenance, counts, index, badges)                                                   | `0a31c8a` docs: reconcile F8/F6 tracker status with landed merges (2026-07-12); `496dcaf` docs: reconcile provenance after rebasing onto main — F4/F5 (2026-07-11); `7d6b8ab` docs: reconcile trackers and provenance for the paths seam — F4/F5 (2026-07-11), among 85 total `docs:` reconciliation commits — historically over-provisioned on `opus` more often than this row recommends (spot-check: ~38% of a 16-commit Opus-4.8 sample were row-7/9-shaped mechanical edits) — a reminder to route deterministic doc/provenance work to the cheaper tier going forward | `haiku` or `sonnet`        | `low`–`medium`          | "High-volume, straightforward tasks"; the work is deterministic-script-driven — the model only orchestrates                                                                              |
| 8   | **Subagent workflow** — `docs-consistency-reviewer` spoke, findings fixed pre-docs-PR                                                                                                    | `0fa28b2` docs: refresh badge counts and resolve doc-review findings (2026-07-09); `965bcf4` docs: correct plural data-dir names in M3LPaths layout docs (2026-07-07)                                                                                                                                                                                                                                                                                                                                                                                                       | `haiku`                    | `medium`                | "Near-frontier performance … sub-agent tasks"                                                                                                                                            |
| 9   | **Single unit of work** — a small, well-scoped CI/workflow/dependency edit or merge-conflict regeneration                                                                                | `4a2a333` ci: scope workflow token permissions to job level (2026-07-06); `cc8504d` ci: raise claude pr-review max-turns from 15 to 30 (2026-07-04); `3288fd7` build(deps-dev): bump the toolchain group across 1 directory with 6 updates (2026-07-09)                                                                                                                                                                                                                                                                                                                     | `sonnet`                   | `medium`                | Small well-scoped edits; Sonnet 5 at `medium` ≈ Sonnet 4.6 at `high`                                                                                                                     |
| 10  | **Coordinator workflow (external, GitHub Action)** — the two pinned CI bots: `claude-pr-review.yml` (mandatory PR-merge gate) and `claude-assistant.yml` (on-demand `@claude` assistant) | `claude-pr-review.yml` (`--model claude-sonnet-5`) gated PR #106/#107/#108; its FAIL verdicts produced the fix commits `6676912`/`02f7e74`/`c035247` (2026-07-03…07-12); `claude-assistant.yml` (`--model claude-sonnet-5`) is the same pin, dispatched on-demand rather than on every PR                                                                                                                                                                                                                                                                                   | `claude-sonnet-5` (pinned) | workflow default        | "Frontier intelligence at scale"; if FAIL-verdict quality slips, the high-stakes rule argues for `opus` — revisit on evidence                                                            |
| 11  | **Subagent workflow** — read-only Explore/research fan-out producing an audit or plan doc                                                                                                | `1513914` docs: add pre-1.0.0 release audit resolution plan (2026-07-05); `f44db22` docs: revisit ADR-0012, re-affirm code-index MCP deferral — ADR-0023 (2026-07-11)                                                                                                                                                                                                                                                                                                                                                                                                       | `haiku`                    | `low`                   | Haiku positioning: "sub-agent tasks"; conclusions-only reporting tolerates the cheaper tier; pinned via `.claude/agents/Explore.md`, overriding the built-in's session-inherited default |
| 12  | **Single unit of work** — prose authorship (work log, lessons promotion, README/doc narrative)                                                                                           | `820fbe6` docs: add F8 preset-seam work log and promote its lessons (2026-07-11); `473c124` docs: add core/script work log and promote proxy-assertion test lesson (2026-07-03)                                                                                                                                                                                                                                                                                                                                                                                             | `sonnet`                   | `medium`                | Writing quality matters but scope is bounded                                                                                                                                             |

**Legacy note:** `Claude Sonnet 4.6` (106 bootstrap-era commits, 2026-06-29 →
07-02, plus one late straggler on 07-09) was the prior-generation daily
driver — correct at the time, since superseded by Sonnet 5 through the
`sonnet` alias.

**Note:** `Claude Opus 4.8 (1M context)` (12 commits) is the long-context
variant of the same `opus` alias, used incidentally for large-working-set
sessions (e.g. the worktree-isolation + model-tiering build-out) — not a
separate task category.

**Note (row 10):** diff-size-based scaling of `--max-turns`/`--model` for
`claude-pr-review.yml` was evaluated (2026-07-13 audit of 121 merged PRs:
mean 940.7 changes/14.6 files, median 424/10, p90 2,667/35) and deliberately
**not** implemented — Anthropic publishes no diff-size threshold for
turns/timeout/model tier (`researching-anthropic-guidance` pass, same date;
see `docs/research/pr-review-action-tuning.md`), so a size-based cutoff here
would be an unvalidated guess rather than a documented practice. The flat
100-turn/Sonnet config stays; row 10's existing "if FAIL-verdict quality
slips, the high-stakes rule argues for `opus` — revisit on evidence" is the
actual trigger for ever changing it.

**Context/output limits per tier, and their bearing on truncation risk.**
Subagent mid-turn truncation (a spoke hitting `maxTurns: 40` or an
output-token cap mid-thought — see
`docs/contributing/subagent-context-management.md`) is more likely on a
narrower window. Per the Claude API models reference
([overview](https://platform.claude.com/docs/en/about-claude/models/overview)):

| Tier                | Context window | Max output |
| ------------------- | -------------- | ---------- |
| Haiku 4.5           | 200k           | 64k        |
| Sonnet 5 / Opus 4.8 | 1M             | 128k       |
| Fable 5             | 1M             | 128k       |

`Explore` runs on `haiku` — the narrowest window of the four tiers this repo
uses — which is one more reason its prompt scopes it to excerpting rather than
reading exhaustively (row 11 above). This is not a reason to default every
spoke to a wider-context tier, though: per Anthropic's context-rot finding,
"as token count grows, accuracy and recall degrade" — a bigger window trades
one failure mode (truncation) for another (degraded recall), so tier choice
should still follow the task-shape matrix above, not just "pick the biggest
window available."

## Enforcement

`.claude/settings.json` also sets a project-scoped
[`availableModels`](https://code.claude.com/docs/en/model-config#restrict-model-selection)
allowlist — `["fable", "opus", "sonnet", "haiku"]` — as a hard ceiling on the
main session, subagents, skills, and the advisor: no session or spoke in this
repo can select a model outside those four families, regardless of what a
skill or prompt requests. Deliberately **family wildcards only, no specific
model IDs** (e.g. not `claude-sonnet-5`): Anthropic's merge rule is that "an
entry naming a specific model in a family … disables that family's wildcard
entry", so pairing `sonnet` with `claude-sonnet-5` would have silently
narrowed the `sonnet` alias to that one pinned version instead of letting it
float — the opposite of step 4 above. `enforceAvailableModels` is
deliberately unset: the four families already cover the entire current
generally-available model catalog (limited-availability families, e.g.
Mythos 5/Project Glasswing, are intentionally excluded until GA), so it would
add risk (an unreachable Default) without narrowing anything further.

The spoke and workflow rows above are machine-verified: `pnpm check:agents`
(a CI step, also run in the `pre-push` git hook — see the cadence table in
`CLAUDE.md`) asserts that every `.claude/agents/*.md` `model:`/`effort:`
frontmatter and every `--model` pin in `.github/workflows/*.yml` matches the
block below, and that every value is a legal Anthropic model alias/ID or
effort level (`bin/lib/claude-models.mjs`). Change a spoke's model or effort
here **and** in its frontmatter, in the same commit — drift in either
direction, or an illegal value, fails the check.

A third surface, `workflow-script`, covers Claude Code **dynamic-workflow
scripts** under `.claude/workflows/` (ADR-0025). Its rows come in two shapes:
exactly one required file-level row `` `<file>` `` pinning the script's
default (`inherit` model / `n/a` effort when every `agent()` call either
overrides explicitly or dispatches a typed agent), plus one optional per-step
row `` `<file>:<label>` `` for each distinct `model:`/`effort:` override,
named by the `label` of the `agent()` call that carries it. Calls using
`agentType: "<Agent>"` with no model/effort literals need no row — their
governance rides that agent's existing `agent`-surface row. Two hard rules
keep the surface statically auditable: `model:`/`effort:` values in a
workflow script must be **string literals** (a dynamic value cannot be
audited), and every script must declare an agent-count guardrail header
`// max-agents: <N>` in its first 10 lines, with `1 <= N <= 25` — the ceiling
anchored to the Workflow tool's own "large workflow" warning threshold
(>25 agents). The companion >1.5M projected-token half of that threshold is
advisory only: tokens are not statically checkable, so budget-heavy workflows
should consult `budget.remaining()` at run time instead. All of this is
machine-verified by `pnpm check:workflows` (`bin/check-workflows.mjs`, a
CI-only step — not to be confused with `check:workflows-doc`, which
reconciles the CLAUDE.md CI/CD table against `.github/workflows/`). The check
verifies per-step rows by literal presence, not call-site association — each
step row's model/effort/label must all appear in the script, but binding a
literal to its specific `agent()` call is beyond a regex scan (two calls with
swapped model-to-label pairings still pass), so PR review guards that
association. One
convention is not machine-checkable: any workflow whose agents write
`packages/*/src/**` or `**/tests/**` must dispatch those agents with
`isolation: "worktree"` (ADR-0013) — `guard-branch-isolation.mjs` blocks such
writes on `main` regardless of which agent issues them.

The legal effort ladder (`bin/lib/claude-models.mjs` `EFFORT_LEVELS`) is
`low` < `medium` < `high` < `xhigh` < `max`. Every row in this doc currently
tops out at `xhigh` — "the best setting for most coding and agentic use
cases" per the effort docs — so `max` is reserved headroom for a future
task shape that needs it, not a value any row pins today; don't read "xhigh
hardest" in row 1's notes as a hard ceiling in the code. Similarly, the legal
agent `model:` values (`AGENT_MODEL_ALIASES`) include `inherit` — a
resolution directive meaning "use the main session's model," not a model
family — which is why it has no entry in the `availableModels` ceiling above:
that allowlist restricts _families_, and `inherit` just defers to whichever
family the session already resolved to.

The hub session's model cannot be machine-enforced (it is user-selected via
`/model`); the `starting-work` decision gate surfaces the matrix row for the
task instead. GitHub-Actions `workflow` rows have no effort concept
(`--model` pins carry no `--effort` flag today), so they carry `n/a`; a
`workflow-script` file-level row may likewise carry `n/a` when the script
never relies on a default effort.

`haiku`, `sonnet`, `opus`, and `fable` are aliases that float to the current
generation on release (per step 4 below) — as of this writing that means
Haiku 4.5, Sonnet 5, Opus 4.8, and Fable 5 respectively.

<!-- BEGIN MODEL-MATRIX -->

| Surface         | Name                        | Model             | Effort   |
| --------------- | --------------------------- | ----------------- | -------- |
| agent           | `code-implementer`          | `sonnet`          | `high`   |
| agent           | `test-author`               | `sonnet`          | `high`   |
| agent           | `code-reviewer`             | `sonnet`          | `high`   |
| agent           | `silent-failure-hunter`     | `sonnet`          | `high`   |
| agent           | `security-reviewer`         | `opus`            | `xhigh`  |
| agent           | `type-design-analyzer`      | `opus`            | `xhigh`  |
| agent           | `spec-conformance-reviewer` | `opus`            | `xhigh`  |
| agent           | `docs-consistency-reviewer` | `haiku`           | `medium` |
| agent           | `Explore`                   | `haiku`           | `low`    |
| workflow        | `claude-pr-review.yml`      | `claude-sonnet-5` | `n/a`    |
| workflow        | `claude-assistant.yml`      | `claude-sonnet-5` | `n/a`    |
| workflow-script | `audit-fanout.js`           | `inherit`         | `n/a`    |
| workflow-script | `audit-fanout.js:verify`    | `sonnet`          | `medium` |

<!-- END MODEL-MATRIX -->
