# 0084. Which improvement signals the retrospective loop consumes

- **Status:** Accepted
- **Date:** 2026-09-01
- **Deciders:** repo maintainer

## Context and problem statement

This repo's **forward** loop is mature and self-enforcing: a plan or ADR feeds
a TDD hub-and-spoke pipeline, 51 `check:*` gates fence the result, and every
change lands through a PR. The **retrospective** loop is not. Two skills exist
to close it — `/promoting-work-log-lessons` and `/refreshing-anthropic-guidance`
— but nothing in the repo ever _triggers_ the first of them, and the signal
sources that would feed it have no consumer at all. A lesson surfaced in a
session dies with that session unless a human happens to remember it.

Three candidate sources were measured on this machine on 2026-09-01. They are
very unequal:

| Source                  | Machine-readable?            | Measured state                               |
| ----------------------- | ---------------------------- | -------------------------------------------- |
| Auto-memory store       | Yes — Markdown + frontmatter | 54 memories, 232 KB; drifting and ungoverned |
| `/insights`             | **No** — HTML only           | `~/.claude/usage-data/` absent; never run    |
| `session-report --json` | Yes                          | Installed; no consumer in the repo           |

The auto-memory store is the only one of the three that is both
machine-readable and scoped to this project, and it is unhealthy. Measured
against the store at `~/.claude/projects/-home-…-m3l-automation/memory/`:

1. **Index drift** — 54 memory files against 52 `MEMORY.md` entries. Two
   memories (`check-index-passes-vacuously.md`, `unpushed-branch-is-ungated.md`)
   are on disk but absent from the index that is actually loaded into context,
   so they are written but never recalled.
2. **A corrupt memory** — `write-tool-control-byte-trap.md` is reported `data`
   rather than text by `file(1)`. It carries a literal `0x00` and a literal
   `0x1f` at byte offsets 446 and 448, inside the sentence describing a
   sanitizer regex. The memory documenting the Write-tool control-byte trap was
   itself corrupted by that exact trap. `check:control-chars` structurally
   cannot see this: `bin/control-char-scan.mjs` scans _tracked repo files_, and
   the memory store lives outside the repo.
3. **Broken `[[wikilinks]]`** — `[[build-pipeline]]` and
   `[[mutation-test-your-guards]]` resolve to no memory `name:`; both are
   near-misses for real files (`m3l-automation-build-pipeline`,
   `feedback-mutation-test-your-guards`).
4. **`MEMORY.md` headroom** — 52 lines / 9.7 KB against a 200-line / 25 KB
   load cap. Not yet a problem; unmonitored, and the growth is monotonic.

The work-log half is as blind. Of 112 logs in `docs/logs/`, **24 carry no
promotion marker** — and the marker scheme has no way to say _"swept, nothing
durable found"_. An unswept log and a barren one are indistinguishable, so the
backlog cannot even be counted, let alone worked down. The "every 5 logs"
cadence documented in `/writing-work-logs` is checklist-only; nothing polls it,
which is precisely the failure mode ADR-0082 named ("a reminder nobody reads is
not a cadence") and fixed for the harness-refresh half.

Finally, the `remember` plugin is enabled in `.claude/settings.json` but inert.
After seven days, `.remember/` holds only `logs/` and `tmp/`, a single hook log
line from 2026-08-25, and no `now.md`, `recent.md`, or `archive.md` was ever
written. Its own marker file records that "its hooks were not registered for
that session".

### Two research findings constrain the design

Five fan-out passes over official Anthropic sources (`/researching-anthropic-guidance`)
returned two constraints that are not negotiable design preferences:

- **The transcript JSONL is officially unsupported to parse.** Anthropic
  documents the format as internal to Claude Code and subject to change between
  versions, and points integrators at the Agent SDK instead. `analyze-sessions.mjs`
  parses exactly that format, so anything the repo builds on it degrades
  _silently to zeros_ on a Claude Code upgrade unless it asserts its input shape.
- **"Agents observe and suggest; humans validate and implement."** This was
  consistent across ten sources. No autonomous self-editing of `CLAUDE.md`,
  skills, agents, or rules. This matches the choice ADR-0082 already made for
  `/refreshing-anthropic-guidance` (sweep proposes, `EnterPlanMode` gates) and
  rules out any auto-applying automation here.

## Decision drivers

- A cadence must be **self-polling**. ADR-0030's retired reminder and this
  repo's own unswept 24-log backlog are two independent demonstrations that a
  prose checklist item is not a mechanism.
- **Consume only machine-readable, project-scoped signal.** A source that
  requires a human to read an HTML page cannot be gated on.
- **Any consumer of an unsupported format must fail loudly, never quietly.**
  A telemetry adapter that reports zeros after an upstream change is worse than
  no adapter, because it looks like a healthy answer.
- **Harness edits stay human-approved** (the research constraint above, and
  ADR-0082's existing precedent).
- **Prefer extending an existing instrument to adding one.** The repo already
  runs three knowledge stores (auto-memory, `docs/logs/`, `.claude/rules/`);
  a fourth is duplication, not coverage.

## Considered options

1. **Consume auto-memory + `session-report --json`; extend the existing
   `/promoting-work-log-lessons`; add one non-blocking `check:*` gate for loop
   health.** Reuses ADR-0082's proven shape (tracker with a machine-readable
   header + advisory gate + human-approved remedy skill).
2. **Add a 24th skill** dedicated to the retrospective sweep, leaving
   `/promoting-work-log-lessons` as-is. Cleaner separation, but two skills
   would read the same `docs/logs/` corpus and the routing between them would
   be a judgment call at every invocation.
3. **Consume all three sources, including `/insights`**, by scraping
   `report.html`. Maximum coverage, but it means parsing a rendered HTML
   artifact of a global (not per-project) dataset — a second unsupported-format
   dependency layered on the first.
4. **Adopt the structured alternatives Anthropic does support** — the Analytics
   Admin API or OpenTelemetry export — instead of the transcript store. Fully
   supported, and the correct answer at organisation scale.
5. **Fix the `remember` plugin** (`/remember:doctor`) and make it the capture
   layer, rather than governing the built-in auto-memory store.

## Decision

We chose **option 1**.

**On the three sources.** Auto-memory and `session-report --json` are consumed;
`/insights` is not. `/insights` has no machine-readable export — it emits only
`~/.claude/usage-data/report.html` — and its scope is global across all 145
project directories on this machine rather than per-project. It is recorded here
as a **manual, occasional human tool**, deliberately outside every gate. Option
3 is rejected on that basis. Option 4 is rejected as a scale mismatch: the
Analytics Admin API and OpenTelemetry are organisation-scale instruments and a
poor fit for a single-maintainer local repo with no collector to ship to; they
remain the right migration target if this ever becomes a team repo.

**On the JSONL instability.** The `session-report` adapter
(`bin/session-telemetry.mjs`) is the _only_ thing in the repo permitted to touch
the transcript store, and it **asserts the shape of its output** — every
expected top-level key — and exits non-zero naming the transcript-format
instability when one is missing. This converts the unsupported-format risk from
a silent degradation into a loud, attributable failure. It is deliberately
**never a `pre-push` gate**: it is on-demand, invoked by the sweep skill. The
full transcript store measured 1,759 files / 932 MB, so the adapter always
scopes `--dir` to this project and bounds `--since` (default `30d`) — an
unscoped scan is exactly the workload ADR-0080 budgets against.

**On propose-only.** The sweep proposes; the maintainer approves; nothing
auto-edits `.claude/rules/`, `.claude/agents/`, skills, or `CLAUDE.md`. Per the
research this is a documented boundary, not a nicety.

**On extending rather than adding.** Option 2 is rejected: `/promoting-work-log-lessons`
already owns the "narrative history → durable rule" transformation, and adding
sources to it is a smaller change than splitting one corpus across two skills.

**On retiring `remember`.** Option 5 is rejected and the plugin is **removed**
from this repo's `enabledPlugins`. It registers `SessionStart` +
`UserPromptSubmit` + `PostToolUse` hooks and makes a Haiku call per tool-use
batch, to populate a fourth knowledge store alongside three the repo already
maintains — and it captured nothing in seven days. `.remember/` self-gitignores
(its `.gitignore` is a bare `*`), so no history is lost by deleting it.

The entry is set to an explicit **`false`**, not deleted. The identical entry
in `~/.claude/settings.json` is user-scope, outside this repo, and left
alone — disabling the plugin globally is the maintainer's call to make, not
this repo's to make on their behalf. But settings scopes _merge_, and project
scope takes precedence over user scope: simply removing the project key would
leave the user-scope `true` in force and the plugin still enabled here, free
to recreate `.remember/`. Only an explicit `false` retires it repo-locally
while leaving the global setting the maintainer's to decide.

The same commit enables `claude-security@claude-plugins-official`, an unrelated
change that was already pending in the working tree; it is folded in here
because it touches the same `enabledPlugins` block.

## Consequences

- **Positive:** the retrospective loop becomes self-polling in the way ADR-0082
  made the harness-refresh loop self-polling. `check:retrospective` surfaces
  memory-store corruption in a blind spot `check:control-chars` cannot reach,
  and surfaces sweep staleness on every `pre-push`. The sweep tracker's
  `no-durable-lesson` outcome makes a barren log distinguishable from an unswept
  one, which the marker-only scheme cannot express.
- **Negative / trade-offs:** the gate is advisory (warns, never blocks), so a
  maintainer can ignore it indefinitely — the same accepted trade-off as
  `check:harness-freshness` and `check:context-budget`. The memory store lives
  outside git, so the gate reports on state no PR can review and CI can never
  see; on CI the store is absent and the gate is a clean no-op. The telemetry
  adapter depends on an officially unsupported format and on a plugin whose
  cache path may move; both failures are loud by construction, but they are
  still failures the maintainer must act on.
- **`/insights` stays a blind spot by choice.** Cache-efficiency and
  cost-per-session signal that only `/insights` surfaces will not reach any
  gate. Accepted: `session-report --json` covers `cache_breaks` and per-prompt
  cost for this project, which is the subset that matters here.
- **Semver impact:** none — internal tooling and harness change only; no
  `packages/m3l-common` export touched.

## Links

- Supersedes / superseded by: none
- Related: ADR-0082 (established the tracker + non-blocking-gate + human-approved-skill
  shape this ADR reuses for a second cadence), ADR-0080 (host resource
  budgeting — why the telemetry adapter bounds its scan), ADR-0072 (the
  five-PR slicing this change lands under), ADR-0030's 2026-08-14 amendment
  ("a reminder nobody polls is not a cadence"),
  `.claude/skills/promoting-work-log-lessons/SKILL.md`,
  `docs/research/retrospective.md`, `bin/check-retrospective.mjs`,
  `bin/session-telemetry.mjs`
