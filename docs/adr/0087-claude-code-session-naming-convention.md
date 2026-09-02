# 0087. Claude Code session naming convention

- **Status:** Accepted; amended by ADR-0088
- **Date:** 2026-09-02
- **Deciders:** repo maintainer

## Context and problem statement

Claude Code session naming in this repo has run on default behavior plus ad
hoc manual naming. Measured against this project's live transcript store
(`~/.claude/projects/-home-enri3l-workspaces-monte3l-m3l-automation/`): 225
sessions — 36 named, 157 auto-title-only, 32 with neither. The names that do
exist (`work-continuity-auditing`, `audit-fanout-hardening`,
`pr-review-refreshment`, `zsh-config-update`) carry no branch or work-type
signal, so a background audit and an interactive implementation are
indistinguishable in the `/resume` picker and in `ListAgents`. Name and
auto-title also drift apart inside a single session (name
`new-workflows-auditing` next to title `harden-workflow-surface`).

This is more than cosmetic. A `/researching-anthropic-guidance` round across
six official Anthropic sources (`docs/research/session-naming.md`) established
that since Claude Code 2.1.232 a **session name is an addressable
identifier**, not a display label: it routes `SendMessage`, `@`-mentions in
the prompt, `ListAgents`, and `claude --resume <name>`. With ADR-0080 already
budgeting host resources against concurrent sessions, an operator looking at
several live peers needs the name to say what each is doing.

The same research fixed two hard constraints that decide what this ADR can and
cannot ask for:

- **No hook can read or set a session name.** Hooks receive `session_id`
  read-only, and command hooks cannot invoke slash commands — a `SessionStart`
  hook cannot run `/rename` on the user's behalf. No `settings.json` key at
  any scope names a session either.
- **Reading a name back out of the transcript is constrained by ADR-0084**,
  which confines transcript reads in this repo to `bin/session-telemetry.mjs`
  and treats the JSONL entry format as officially unsupported (Anthropic
  documents it as internal and subject to change between versions).

Those two facts rule out any approach that tries to enforce naming
automatically at session start. What remains is proposing the name at the
point a human is already choosing a slug, and surfacing non-conformance on the
one documented surface that receives the name at all: the statusline's
`session_name` stdin field.

## Decision drivers

- **Work within documented mechanism only** — no reliance on the
  officially-unsupported transcript format for anything beyond what
  ADR-0084 already scopes to `bin/session-telemetry.mjs`.
- **Reuse existing vocabulary** rather than inventing new taxonomy: the
  Conventional Commit types already used for branch prefixes, and the
  `SLUG_PATTERN` kebab-case regex already enforced by `bin/worktree-new.mjs`
  and `bin/lib/mcp-tools.mjs`.
- **Visibility over enforcement** — since no gate can force a name, the
  convention must be cheap to apply (proposed automatically) and cheap to
  notice when skipped (visible in the statusline every render).
- **Single-maintainer scale** — no need for a heavyweight taxonomy; a small
  closed set of work-type prefixes suffices.

## Considered options

1. **Branch-mirror** — name equals the branch slug `starting-work` already
   picks (`feat/statusline-widgets` → `statusline-widgets`). Zero new
   vocabulary, but `main`-resident audit/research/review sessions have no
   branch to mirror and get no slug at all.
2. **Type-prefixed slug** — `<kind>-<slug>`, kind from a closed set covering
   both branch-bearing work (`feat`, `fix`) and `main`-resident harness work
   (`audit`, `research`, `docs`, `review`, `ci`, `merge`). Greppable in
   `ListAgents`, sortable in the `/resume` picker, and mirrors the branch
   prefix convention for the common case.
3. **Type + slug + PR anchor** — appends the PR number for maximum
   traceability (`feat-statusline-widgets-892`). Rejected: the PR number does
   not exist at session start, so this always requires a mid-session
   `/rename` with no way to enforce or remind — worse ergonomics than option
   2 for a small traceability gain `--from-pr` already covers.
4. **Shape-only** — mandate only kebab-case, a length bound, and no leading
   `/` (a documented, since-fixed footgun that used to break `SendMessage`
   addressing), with no taxonomy at all. Lowest friction, but carries no
   work-type signal — the exact gap this ADR exists to close.

## Decision

We chose **option 2, the type-prefixed slug**, because it covers both
branch-bearing and `main`-resident sessions with one small closed vocabulary
that already exists elsewhere in the repo (commit types, branch prefixes,
`SLUG_PATTERN`), and it is legible in `ListAgents`/the picker without needing
a PR number that doesn't exist yet.

```text
<kind>-<slug>

kind ∈ feat | fix | audit | research | docs | review | ci | merge
slug matches ^[a-z0-9]+(?:-[a-z0-9]+)*$
whole name ≤ 40 characters, never begins with "/"
```

`feat`/`fix` mirror the Conventional Commit type and the `feat/<slug>` /
`fix/<slug>` branch prefix, so a branch-bearing session's name is derivable
from its branch. The remaining kinds cover `main`-resident harness work that
has no branch to mirror (an audit, a research pass, a doc pass, a PR review, a
CI triage, a post-merge close-out).

| Session                           | Name                          |
| --------------------------------- | ----------------------------- |
| branch `feat/statusline-widgets`  | `feat-statusline-widgets`     |
| branch `fix/main-ci-failures`     | `fix-main-ci-failures`        |
| `/auditing` run on `main`         | `audit-session-naming`        |
| `/researching-anthropic-guidance` | `research-anthropic-guidance` |
| `/finishing-work` after a merge   | `merge-cleanup-pr-895`        |

Applied via `claude -n <name>` at launch or `/rename <name>` mid-session.
Duplicate live names on one machine are auto-disambiguated by Claude Code into
a `name-word-word` variant (v2.1.232+) — the convention tolerates a suffix it
did not choose, since the disambiguated name still matches the slug pattern
after the appended words.

[**Amended (2026-09-03):** the "two levers only" framing below undersold what
was possible — see [ADR-0088](0088-automatic-session-naming-via-launcher.md),
which adds a launcher wrapper (`pnpm session:launch`) that computes and
applies the name at process start, so `starting-work`'s recommendation is a
command to run rather than a name to type by hand. The vocabulary and the two
hard constraints above are unchanged; only the application mechanism moved.]

Since no hook can read or set a session name, application is through two
levers only:

- **`starting-work`** gains a sixth decision that proposes `<kind>-<slug>`
  alongside the branch it already picks, and emits the literal `/rename` (or
  `claude -n`) command to run.
- **The statusline** renders and validates `session_name` against the pattern
  above, marking a non-conforming or absent name rather than silently
  accepting whatever `session_name` happens to hold (which, for an unnamed
  session, is the AI-generated first-prompt title — a present/absent check
  alone would pass 157 of 225 sessions while conforming to nothing).

Compliance is measured, not gated: `bin/session-telemetry.mjs` gains a
naming-compliance read-out, on demand only, respecting ADR-0084's scope and
unsupported-format constraints. It never becomes a pre-push gate — there is no
way to gate what no hook can observe or set.

## Consequences

- **Positive:** live sessions become distinguishable by work type at a glance
  in `ListAgents`, the `/resume` picker, and the statusline; the vocabulary
  reuses existing conventions rather than adding new ones; compliance is
  measurable without touching the officially-unsupported transcript format
  outside its one permitted reader.
- **Negative / trade-offs:** the convention cannot be enforced — a session
  that is never named or renamed stays unnamed regardless of what the
  statusline shows; `starting-work`'s recommendation still requires the user
  to actually run the launch command (see ADR-0088 amendment above — a
  wrapper now applies the name automatically, but the user still has to
  start the session through it rather than a bare `claude`); the ~96
  plugin-launched
  `<file> security review` sessions from `/security-review` are out of this
  ADR's reach entirely (a different launch path this repo does not control)
  and will continue to crowd the picker regardless of this convention.
- **Semver impact:** none — internal harness/tooling convention, no public
  API surface.

## Links

- Supersedes / superseded by: amended by [ADR-0088](./0088-automatic-session-naming-via-launcher.md)
- Related: [ADR-0072](./0072-reviewable-slice-discipline.md) (PR sequencing
  used to land this decision), [ADR-0080](./0080-host-resource-budgeting.md)
  (concurrent-session budgeting this convention supports),
  [ADR-0084](./0084-retrospective-signal-sources.md) (the transcript-read
  boundary this ADR works within), `docs/research/session-naming.md` (the
  underlying Anthropic-sources research), `docs/contributing/contributing.md`
  § Session naming (operational rules)
