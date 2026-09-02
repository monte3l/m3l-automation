# 0089. Skill invocation stance, the listing-budget ceiling, and where routing guidance lives

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Repo maintainer

## Context and problem statement

With 22 skills, this repo had no recorded decision on how the model chooses
among them, or on what happens as the count keeps growing. An audit (the
plan this ADR closes out) found the choice already has a mechanical answer
with a measurable failure mode, and that the repo already computed the
number proving it without ever checking it.

Claude Code merges custom commands into skills: `.claude/commands/x.md` and
`.claude/skills/x/SKILL.md` both create `/x`. `/name` invocation is a
deterministic dispatch, resolved by the harness before the model reasons
about the request at all. Prose invocation ("open a PR for this") instead
depends on the model matching the request against every skill's
`description`, which is injected into the model's context inside a **skill-
listing budget** — documented at roughly 1% of the active context window. On
overflow, Claude Code drops descriptions starting with the **least-invoked
skills** — so a rarely-used skill degrades silently, exactly where it is
least likely to be noticed.

Measured before this ADR's PR sequence: 22 descriptions totaled 21,684
characters (~5,421 tokens) — 2.7x over the ~2,000-token budget a 200,000-
token context window enforces, and comfortably within budget only at a
1,000,000-token window. `bin/check-context-budget.mjs` already printed
`Skill listing: 22 description(s), 21684 total chars` and never compared it
to any budget.

## Decision drivers

- Make the invocation contract explicit and enforced, not merely observed
  once during an audit.
- Stop the listing from silently overflowing again as skills are added.
- Give evals the ability to detect a skill that loads correctly but is never
  actually selected — the CI-run-33390425486 defect (`--restricted` hiding
  `.claude/skills/` from the model) was a loading-level failure; a skill that
  loads but never gets chosen is the same blind spot one level up, and
  nothing asserted against it before this ADR's PR sequence.
- Add a routing surface, since Anthropic publishes no guidance for how a
  maintainer of a large skill set should navigate it, and this repo's own
  harness documentation (`CLAUDE.md`, `.claude/rules/*.md`,
  `docs/contributing/agent-operating-model.md`) is uniformly addressed to
  Claude, not to the maintainer — none of it can be used to look something
  up the way a human would.

## Considered options

1. **Do nothing** — accept that prose triggering degrades unpredictably as
   the skill count grows, and that a maintainer navigates the skill set by
   memory or by grepping `.claude/skills/`.
2. **Raise `skillListingBudgetFraction`** in `settings.json` to accommodate
   the full, untrimmed listing rather than trimming it.
3. **Gate the listing budget, then trim to fit; add a routing surface both
   as a durable doc and as an explicit-only skill.**

## Decision

We chose **option 3**.

**Invocation stance:** `/skill-name` is preferred whenever the maintainer
already knows which skill to use — it is deterministic, never depends on
listing-budget headroom, and costs nothing extra to type. Prose invocation
is fully supported and actively measured (see the eval extension below), not
deprecated — most of the corpus's 88 eval cases are prose prompts, and prose
remains the natural entry point for common skills like `starting-work` or
`creating-prs`, whose descriptions sit comfortably within budget.

**The listing-budget ceiling is now a governed constraint, not an
observation.** `bin/check-context-budget.mjs` gained a hard-fail check
(`checkSkillListingBudget`) comparing total description characters against
the budget at both a 200,000-token and a 1,000,000-token reference window,
failing the push on 200k-window overflow. The trim that followed brought the
listing from 21,684 to 7,734 characters — under the ~8,000-character budget
with headroom, while preserving each skill's trigger keywords and negative-
scoping clauses (the parts of a description that actually make prose
matching work).

**Option 2 was rejected** because raising the fraction hides the growth
signal rather than addressing it — the listing would keep growing
unboundedly with no counter-pressure, and the next skill added past whatever
raised ceiling would face the identical overflow with no established
practice for handling it.

**Skill-fired assertion.** Eval verdicts previously came only from a self-
graded `structured_output` field — a case could pass on response quality
even if the skill under test never actually got selected via the `Skill`
tool. `bin/run-skill-evals.mjs` switched from `--output-format json` to
`stream-json` (plus the `--verbose` the CLI requires alongside it), which
surfaces a `Skill` tool invocation as an observable `tool_use` block mid-
stream. A new assertion (`evaluateSkillFired`) fails a case whose skill
under test never fired, as an addition to the existing pass/fail verdict —
closing the selection-level version of CI-run-33390425486's defect. A probe
while building this found the mechanism has one structural blind spot: a
prompt invoking a skill via a literal leading `/slug` is resolved by the CLI
before the model's turn, so no `Skill` tool_use block appears even though
the skill's instructions are genuinely followed — cases written that way opt
out via `expect_skill_fired: false` (see `evaluateSkillFired`'s JSDoc for
both opt-out reasons).

**Placement: both a durable doc and an in-session surface.**
`docs/contributing/skill-routing.md` is the durable, user-facing lookup
table — organized by intent ("I want to add a new AWS wrapper") rather than
by usage frequency, unlike `skills-catalog.md`. `.claude/skills/harness-
guide/SKILL.md` is the in-session equivalent, reachable only via
`/harness-guide` — its frontmatter carries `disable-model-invocation: true`,
which Anthropic's docs describe as omitting a skill's description from the
model's listing entirely. `bin/check-context-budget.mjs`'s
`collectSkillDescriptions` was extended to exclude any skill with that
frontmatter key from the listing-budget total, so the exclusion is verified
by the same gate the budget itself is enforced by — confirmed empirically:
adding `harness-guide` left the listing at 22 counted descriptions / 7,734
chars, unchanged.

**Telemetry pointer.** `skills-catalog.md`'s "How to re-check usage" section
previously recommended only a skill-name grep across `docs/logs`/git
history — the same document's own findings section records that this
undercounted `resolving-pr-comments` (narrated by what it produced, not its
own name) to a false zero. It now points first at `pnpm telemetry:sessions`
(ADR-0084's session-transcript adapter), which reports a `by_skill`
breakdown of real invocation counts independent of how a commit or log
happens to describe the work, keeping the grep as a secondary check for a
skill's documentation trail further back than the transcript retention
window covers.

## Consequences

- **Positive:** the listing-budget ceiling is now a machine-checked
  constraint (`pnpm check:context-budget`), not something that has to be
  independently re-derived to notice regression; a skill that loads but is
  never selected now fails its eval rather than passing silently; a
  maintainer has a single place to look up "which skill for X" instead of
  re-deriving it from memory or from documents written for Claude, not for
  them.
- **Negative / trade-offs:** the trim traded verbosity for headroom — five
  descriptions needed restoring after an initial trim over-cut trigger
  phrases the eval suite depended on, and the fired-skill assertion carries
  a documented gap for slash-command-form prompts (`expect_skill_fired:
false` is a manual opt-out, not something the runner can detect on its
  own). `docs/contributing/skill-routing.md` also has no automated
  enforcement keeping it in sync with the skill roster the way
  `check:skill-frontmatter` enforces `skills-catalog.md` coverage — a new
  skill can land without a routing-table row and nothing will fail the push
  over it.
- **Semver impact:** none — this is internal harness tooling and
  documentation; no `@m3l-automation/m3l-common` public API changed.

## Links

- Related: `docs/contributing/skill-routing.md`,
  `docs/contributing/skills-catalog.md`, `docs/plans/archive/2026-09-03-skill-invocation-and-listing-budget.md`
- Related: ADR-0082 (harness-refresh cadence — the sibling self-polling
  discipline this ADR's listing-budget gate mirrors), ADR-0084 (session
  telemetry adapter this ADR's usage-recheck pointer consumes)
