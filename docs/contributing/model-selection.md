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
4. **Pin full model IDs on every machine-enforced surface**, and keep the
   aliases (`fable` / `opus` / `sonnet` / `haiku`) for the surfaces where a
   floating tier is actually wanted. Aliases trade reproducibility for
   currency: the same alias can resolve to a different underlying model once
   Anthropic ships a new version, so two runs of the same spoke weeks apart can
   execute on different models — which would make the matrix below a record of
   intended _tier_ rather than of what ran. Every spoke in `.claude/agents/*.md`
   therefore pins an exact ID (`claude-sonnet-5`, `claude-opus-5`,
   `claude-haiku-4-5`), as do the CI workflows (`claude-pr-review.yml` via
   `--model claude-opus-5`, `claude-assistant.yml` via
   `--model claude-sonnet-5`), and the `audit-fanout.js` verify step. The cost is
   deliberate and accepted: a new generation no longer reaches the spokes for
   free, so an upgrade becomes an explicit commit that moves frontmatter and the
   MODEL-MATRIX block together — which `check:agents` already forces.
   `run-skill-evals.mjs`'s per-case grading invocation pins the same way
   (`DEFAULT_MODEL`/`DEFAULT_EFFORT` in the script, overridable via
   `M3L_EVAL_MODEL`/`M3L_EVAL_EFFORT`), but sits outside this matrix — it is
   a `bin/` script, not a `.claude/workflows/*.js` Workflow-tool script, so
   `check:workflows`'s `workflow-script` row type (R1) does not apply to it.
   Unpinned
   values still govern the surfaces that cannot or should not freeze: the
   `inherit` directive (the `audit-fanout.js` file-level row), the hub's
   user-selected `/model`, and the `availableModels` family wildcards. `ANTHROPIC_DEFAULT_OPUS_MODEL` /
   `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` /
   `ANTHROPIC_DEFAULT_FABLE_MODEL` remain the way to redirect an alias
   wholesale without touching pins. The `Co-Authored-By:` trailer records the
   concrete model that ran either way, so provenance never depended on this
   choice.
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

| #   | Category                                                                                                                                                                                 | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Model (alias)                                                       | Effort                  | Official grounding / notes                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Coordinator workflow** — multi-day, multi-PR strategic hub sessions with no dispatched spokes (release audits, strategy ADRs, cross-cutting roadmaps)                                  | `572eaba` docs: record post-1.0.0 deepen-first strategy (ADR-0021) and roadmaps (2026-07-06); `1513914` docs: add pre-1.0.0 release audit resolution plan (2026-07-05); `dd1900b`+`58c33f9` consumer-script pipeline roadmap+plan, PRs #90–91 (2026-07-09); `0bcec0e` ADR-0022 workspace-restoration ratification (2026-07-09)                                                                                                                                                                                                                                              | Fable 5 (`fable`)                                                   | `high`; `xhigh` hardest | "Long-running agents … largest, most critical projects … fewer check-ins"; plans across stages and delegates to subagents                                                                |
| 2   | **Coordinator workflow** — single-sitting hub session dispatching TDD spokes for one submodule/feature                                                                                   | `695d470` feat: implement core/json submodule (2026-07-01); `5ff949d` feat: add core/script submodule — M3LScript (2026-07-03); `26180d8` feat(aws): add clients submodule for SDK client provisioning (2026-07-03); `aec2e03` chore(agents): tier spoke models and enforce no-nesting invariant — worktree-isolation/model-tiering safety-net hardening (2026-07-01)                                                                                                                                                                                                       | Opus 5 (`opus`)                                                     | `xhigh`                 | "Complex agentic coding and enterprise work"; the developer-docs default; `xhigh` is "the best setting for most coding and agentic use cases"                                            |
| 3   | **Subagent workflow** — GREEN-phase `code-implementer` spoke, dispatched inside a row-2 hub session                                                                                      | `77960ee` feat(files): implement core/files submodule (2026-07-03); `642af15` feat(importers): implement core/importers submodule (2026-07-03); `336c069` feat(text): implement core/text multi-format extraction (2026-07-02)                                                                                                                                                                                                                                                                                                                                              | `sonnet`                                                            | `high`                  | "Best combination of speed and intelligence … built for coding"; contract + failing tests already pin the scope                                                                          |
| 4   | **Subagent workflow** — RED-phase `test-author` spoke, dispatched alongside row 3 in the same PR                                                                                         | `16b0e4b` test(config): cover M3LConfigValidationError constructor branches (2026-07-07); `f3dbf56` test(text): cover custom extractor registration (2026-07-06); `09d0ef9` test: backfill coverage on poller, prompt, and email extractor (2026-07-06)                                                                                                                                                                                                                                                                                                                     | `sonnet`                                                            | `high`                  | Same tier; well-scoped from the documented contract                                                                                                                                      |
| 5   | **Subagent workflow** — high-stakes review spoke (`security-reviewer`, `type-design-analyzer`, `spec-conformance-reviewer`), findings fixed same-PR                                      | `f7d3f12` fix(storage): escape LIKE metacharacters in literal search (2026-07-03, security-shaped); `4573e79` feat(aws): make illegal login/analysis/http/exporter states unrepresentable (2026-07-04, type-design-shaped); `6935df7` fix(script): redact full serialized error in best-effort diagnostics (2026-07-05, security-shaped)                                                                                                                                                                                                                                    | `opus`                                                              | `xhigh`                 | SDK: "use a more capable model for high-stakes reviews"                                                                                                                                  |
| 6   | **Subagent workflow** — general review spoke (`code-reviewer`, `silent-failure-hunter`), findings fixed same-PR                                                                          | `029eeb1` refactor: resolve claude-pr-review should-fix findings in core/script (2026-07-03); `c035247` test: resolve claude-pr-review must-fix finding (2026-07-03); `9094322` feat(events): surface handler failures as best-effort diagnostics (2026-07-06, silent-failure-shaped)                                                                                                                                                                                                                                                                                       | `sonnet`                                                            | `high`                  | Routine-quality review; escalate to row 5 only when the diff touches public API or security                                                                                              |
| 7   | **Single unit of work** — mechanical, script-driven doc/provenance reconciliation (`/syncing-docs`: provenance, counts, index, badges)                                                   | `0a31c8a` docs: reconcile F8/F6 tracker status with landed merges (2026-07-12); `496dcaf` docs: reconcile provenance after rebasing onto main — F4/F5 (2026-07-11); `7d6b8ab` docs: reconcile trackers and provenance for the paths seam — F4/F5 (2026-07-11), among 85 total `docs:` reconciliation commits — historically over-provisioned on `opus` more often than this row recommends (spot-check: ~38% of a 16-commit Opus-4.8 sample were row-7/9-shaped mechanical edits) — a reminder to route deterministic doc/provenance work to the cheaper tier going forward | `haiku` or `sonnet`                                                 | `low`–`medium`          | "High-volume, straightforward tasks"; the work is deterministic-script-driven — the model only orchestrates                                                                              |
| 8   | **Subagent workflow** — `docs-consistency-reviewer` spoke, findings fixed pre-docs-PR                                                                                                    | `0fa28b2` docs: refresh badge counts and resolve doc-review findings (2026-07-09); `965bcf4` docs: correct plural data-dir names in M3LPaths layout docs (2026-07-07)                                                                                                                                                                                                                                                                                                                                                                                                       | `haiku`                                                             | `medium`                | "Near-frontier performance … sub-agent tasks"                                                                                                                                            |
| 9   | **Single unit of work** — a small, well-scoped CI/workflow/dependency edit or merge-conflict regeneration                                                                                | `4a2a333` ci: scope workflow token permissions to job level (2026-07-06); `cc8504d` ci: raise claude pr-review max-turns from 15 to 30 (2026-07-04); `3288fd7` build(deps-dev): bump the toolchain group across 1 directory with 6 updates (2026-07-09)                                                                                                                                                                                                                                                                                                                     | `sonnet`                                                            | `medium`                | Small well-scoped edits; Sonnet 5 at `medium` ≈ Sonnet 4.6 at `high`                                                                                                                     |
| 10  | **Coordinator workflow (external, GitHub Action)** — the two pinned CI bots: `claude-pr-review.yml` (mandatory PR-merge gate) and `claude-assistant.yml` (on-demand `@claude` assistant) | `claude-pr-review.yml` gated PR #106/#107/#108 on `claude-sonnet-5`; its FAIL verdicts produced the fix commits `6676912`/`02f7e74`/`c035247` (2026-07-03…07-12) — now pinned `claude-opus-5` (see the row-10 note below); `claude-assistant.yml` stays `claude-sonnet-5`, dispatched on-demand rather than on every PR                                                                                                                                                                                                                                                     | `claude-opus-5` (pr-review) / `claude-sonnet-5` (assistant, pinned) | workflow default        | "Frontier intelligence at scale"; SDK/advisor guidance backs pairing the stronger model with the high-stakes gate specifically                                                           |
| 11  | **Subagent workflow** — read-only Explore/research fan-out feeding an audit or plan doc the hub writes                                                                                   | `1513914` docs: add pre-1.0.0 release audit resolution plan (2026-07-05); `f44db22` docs: revisit ADR-0012, re-affirm code-index MCP deferral — ADR-0023 (2026-07-11)                                                                                                                                                                                                                                                                                                                                                                                                       | `haiku`                                                             | `low`                   | Haiku positioning: "sub-agent tasks"; conclusions-only reporting tolerates the cheaper tier; pinned via `.claude/agents/Explore.md`, overriding the built-in's session-inherited default |
| 12  | **Single unit of work** — prose authorship (work log, lessons promotion, README/doc narrative)                                                                                           | `820fbe6` docs: add F8 preset-seam work log and promote its lessons (2026-07-11); `473c124` docs: add core/script work log and promote proxy-assertion test lesson (2026-07-03)                                                                                                                                                                                                                                                                                                                                                                                             | `sonnet`                                                            | `medium`                | Writing quality matters but scope is bounded                                                                                                                                             |

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
would be an unvalidated guess rather than a documented practice. The model
tier did change on 2026-07-25 — row 10's "if FAIL-verdict quality slips, the
high-stakes rule argues for `opus`" was acted on, moving `claude-pr-review.yml`
from `claude-sonnet-5` to `claude-opus-5` on release of Claude Opus 5.
`claude-assistant.yml` was left on `claude-sonnet-5`: it's a lower-stakes,
on-demand surface, not the mandatory merge gate.

**Update (2026-08-19):** the flat 100-turn cap and default `high` effort were
reassessed once `ci.yml` itself dropped to 70–170s, making the review bot the
new merge-latency floor (measured baseline: 8–28 turns actually used, median
~215s, median $1.70/run). A follow-up `researching-anthropic-guidance` pass
found the effort docs framing `medium` as Sonnet-5's/Opus-5's cost-saving
step-down from default `high`, and the Code Review docs describing lower
effort as reporting only the highest-confidence findings. `claude-pr-review.yml`
now runs `claude-opus-5` at `--effort medium` with `--safe-mode` to drop
review-irrelevant
context (CLAUDE.md, skills, hooks, MCP servers). Model tier is unchanged —
only effort and turn cap moved; see the addendum in
`docs/research/pr-review-action-tuning.md` for full sourcing.

The turn cap set here (`--max-turns 35`, chosen as "still above the observed
max of 28") did not hold. By 2026-08-20 real reviews were using 20-34 turns
with ~30% of every budget lost to permission denials, and the cap was raised
to 60 and moved into a single `MAX_TURNS` job env. See the 2026-08-20
addendum in the same research doc.

**Context/output limits per tier, and their bearing on truncation risk.**
Subagent mid-turn truncation (a spoke hitting `maxTurns: 40` or an
output-token cap mid-thought — see
`docs/contributing/subagent-context-management.md`) is more likely on a
narrower window. Per the Claude API models reference
([overview](https://platform.claude.com/docs/en/about-claude/models/overview)):

| Tier              | Context window | Max output |
| ----------------- | -------------- | ---------- |
| Haiku 4.5         | 200k           | 64k        |
| Sonnet 5 / Opus 5 | 1M             | 128k       |
| Fable 5           | 1M             | 128k       |

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
entry", so pairing `sonnet` with `claude-sonnet-5` would silently narrow the
`sonnet` alias to that one pinned version for every surface that still resolves
through it — `inherit`, the hub's own `/model` selection, and any future spoke
that wants a floating tier. This ceiling's job is to bound which _families_ may
run at all, not to choose versions inside them; version pinning belongs in the
per-spoke `model:` frontmatter and the `--model` flags (step 4), where it is
visible in the matrix and machine-checked. `enforceAvailableModels` is
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
reconciles the docs/contributing/ci-cd.md CI/CD table against `.github/workflows/`). The check
verifies per-step rows by literal presence, not call-site association — each
step row's model/effort/label must all appear in the script, but binding a
literal to its specific `agent()` call is beyond a regex scan (two calls with
swapped model-to-label pairings still pass), so PR review guards that
association. The same check also enforces R8: every `agentType: "<Agent>"`
literal must name a defined `.claude/agents/*.md` spoke, and if that spoke is
structurally read-only (`bin/lib/agent-roster.mjs`'s `readOnlyAgentNames()`),
the script must not carry a write-instruction phrase for it — a small,
explicit denylist (`WRITE_INSTRUCTION_PATTERNS` in `bin/check-workflows.mjs`:
a phrase like "write your findings to … .md" or "to exactly this file"),
not a call-site-bound check, so treat it as a heuristic safety net rather
than a guarantee. R8 exists because nothing previously
caught `audit-fanout.js` dispatching a read-only `Explore` agent with a
prompt instructing it to write a scratchpad report file — Explore holds no
`Write`/`Edit` tool and `guard-readonly-bash.mjs` blocks every shell write
route, so the instruction was silently unsatisfiable; the workflow now
returns each report inline instead. One
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

The `docs-consistency-reviewer` and `Explore` rows' `effort:` values
(`medium`/`low`) are **inert on the platform**: `claude-haiku-4-5` is absent
from the effort-supported model list
(`platform.claude.com/docs/en/build-with-claude/effort`, confirmed
2026-09-01) — Haiku 4.5's effort is "Not supported" per the models overview
page. They cannot carry `n/a` like the workflow rows above, because
`check:agents` requires every `agent`-surface row (and its matching
frontmatter) to hold a legal `EFFORT_LEVELS` value, with no Haiku-specific
exception in that check today. Kept as the closest schema-legal placeholder
rather than a real lever for these two spokes; each agent file carries the
same note inline above its `effort:` line.

`haiku`, `sonnet`, `opus`, and `fable` are aliases that float to the current
generation on release — as of this writing Haiku 4.5, Sonnet 5, Opus 5, and
Fable 5.1 respectively. The `agent` and `workflow` rows below no longer ride that
float (step 4): they pin exact IDs, and `claude-haiku-4-5` resolves to the
`claude-haiku-4-5-20251001` snapshot. The float still reaches the hub's
`/model` selection and the `availableModels` family wildcards above, and
`inherit` still defers to whichever family the session already resolved to.

<!-- BEGIN MODEL-MATRIX -->

| Surface         | Name                        | Model              | Effort   |
| --------------- | --------------------------- | ------------------ | -------- |
| agent           | `code-implementer`          | `claude-sonnet-5`  | `high`   |
| agent           | `test-author`               | `claude-sonnet-5`  | `high`   |
| agent           | `code-reviewer`             | `claude-sonnet-5`  | `high`   |
| agent           | `silent-failure-hunter`     | `claude-sonnet-5`  | `high`   |
| agent           | `security-reviewer`         | `claude-opus-5`    | `xhigh`  |
| agent           | `type-design-analyzer`      | `claude-opus-5`    | `xhigh`  |
| agent           | `spec-conformance-reviewer` | `claude-opus-5`    | `xhigh`  |
| agent           | `docs-consistency-reviewer` | `claude-haiku-4-5` | `medium` |
| agent           | `Explore`                   | `claude-haiku-4-5` | `low`    |
| workflow        | `claude-pr-review.yml`      | `claude-opus-5`    | `n/a`    |
| workflow        | `claude-assistant.yml`      | `claude-sonnet-5`  | `n/a`    |
| workflow-script | `audit-fanout.js`           | `inherit`          | `n/a`    |
| workflow-script | `audit-fanout.js:verify`    | `claude-sonnet-5`  | `medium` |

<!-- END MODEL-MATRIX -->
