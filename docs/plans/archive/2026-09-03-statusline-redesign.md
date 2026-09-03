# Statusline redesign — legibility, width safety, native subagent rows

**Status: shipped** — PR 1 `feat/statusline-redesign` (#916), PR 2
`feat/subagent-statusline` (#930, squash `c9be3caf`), PR 3
`feat/statusline-palette-hardening` (this PR).

## Context

`.claude/hooks/statusline-context-pressure.mjs` wrapped past 80 columns
(`COLUMNS`/`LINES` were never read from the environment), left values
unanchored (`ctx 72%` with no denominator, no delimiters), and never surfaced
`rate_limits.*.used_percentage` — the quota-spend signal — while its line
count shifted between 2 and 4 depending on which fields were present. Spoke
in-flight visibility lived in a hand-rolled `tmp/spoke-lifecycle.jsonl`
tracker with no version-controlled source of truth beyond what four recorded
30–60+ minute stalls had taught it to track. A follow-up request mid-sequence
("increase statusline color variety — too many greys and greens; check
emoji/icon support for Monaspace fonts") added a third slice: the shipped
5-colour palette left a real second colour axis (categorical state, not
alarm-proximity) unacknowledged, and the model row rendered five of six
segments in plain foreground.

Non-negotiable throughout: **no subprocess, no network** (ADR-0080 — the
`npx ccstatusline` respawn is the documented cause of a prior parallel-session
OOM).

## Approach / Decisions

**PR 1 — width fitter + five-row rewrite.** New sibling module
`statusline-layout.mjs` (`displayWidth`/`truncateToWidth`/`fitRow`/
`terminalColumns`, ANSI/OSC-8/Nerd-Font/emoji-aware, pure and unit-testable).
`statusline-context-pressure.mjs` rewritten to always render exactly five
gutter-labelled rows (`session`/`model`/`context`/`quota`/`work`), each
width-fit against real `COLUMNS`, with a dim `—` placeholder replacing a
collapsed row so the layout never shifts between refreshes. A preview harness
(`bin/statusline-preview.mjs`, `pnpm statusline:preview`) renders fixture
payloads at four widths for pre-wiring verification per
`.claude/rules/harness-artifacts.md`.

**PR 2 — native `subagentStatusLine`.** New `.claude/hooks/subagent-statusline.mjs`
renders each subagent's row from Claude Code's own `tasks[]` payload (`effort`,
live `tokenCount`/`contextWindowSize`, elapsed time colour-escalating at the
same 15/30-minute thresholds the retired tracker used) — strictly more detail
than the JSONL tracker could reconstruct, with no on-disk state to maintain.
`track-inflight-spokes.mjs` and its `SubagentStart`/`SubagentStop` wirings
were retired in the same change (ADR-0090). A genuine ADR-number collision
(two branches independently claimed ADR-0089 in the same landing window) hit
at rebase time — resolved by the documented provisional-numbering recovery in
`docs/adr/README.md`'s Conventions section, confirming that rule already
covers this exact case.

**PR 3 — colour-axis formalization + gate hardening + docs.** Two new
16-color-SGR-safe constants, `BLUE` (session-location identity — branch,
worktree, origin repo) and `MAGENTA` (turn configuration — effort, thinking,
fast mode, output style, vim mode, and the subagent row's own effort segment),
applied to eight previously-plain segments. The existing green/yellow/red
ramp was split, in documentation only, into two honestly-named axes: an
**alarm ramp** (proximity-to-a-limit: context, quota, memory) and a
**semantic-state ramp** (categorical: `pr.review_state`, cache warmth,
`+N`/`-N` lines, session-name conformance, `⚠ main`) that had been in use
since PR 1/2 without ever being named as distinct from the alarm ramp.
`bin/check-hooks.mjs` gained `validateStatuslineShape` (`statusLine`/
`subagentStatusLine`'s `type`/`refreshInterval` shape) and
`scanStatuslineScriptForForbiddenPatterns` (a source scan for
`node:child_process`/`node:http(s)` imports or a bare `spawn(...)`/
`exec*(...)`/`fetch(...)` call) — the ADR-0080 invariant, previously only
prose in a file header, now has a gate. The scan's `exec`/`spawn` patterns
use a negative dot-lookbehind so a legitimate `RegExp.prototype.exec(...)`
call (both statusline scripts parse `.git/HEAD` with one) doesn't
false-positive — caught by running the new gate against the live repo before
committing, exactly the "known-good input" discipline
`.claude/rules/harness-artifacts.md` asks for. Icon/emoji research (Monaspace
ships no emoji of its own; two actively-maintained Nerd-Font-patched builds
exist) confirmed no blocker to a future opt-in Nerd Font mode, but this PR
stayed ASCII-only per the maintainer's explicit choice — the original
mojibake concern was almost certainly a transport artifact, not evidence
against icons generally, but re-litigating that is out of scope here.
`docs/contributing/hooks-reference.md`'s `statusLine`/`subagentStatusLine`
sections were rewritten for the current five-row layout with a full
colour-legend table, closing the "pre-#916 layout, not yet reflected"
placeholder PR 2 had left in place.

## Outcome

- `.claude/hooks/statusline-layout.mjs` (new), `statusline-context-pressure.mjs`
  (rewritten renderer + `BLUE`/`MAGENTA`), `subagent-statusline.mjs` (new in
  PR 2, `MAGENTA`-wired in PR 3), `track-inflight-spokes.mjs` (deleted)
- `bin/statusline-preview.mjs` (new, `pnpm statusline:preview`)
- `bin/check-hooks.mjs` — `subagentStatusLine.command` recognition (PR 2),
  `validateStatuslineShape`/`scanStatuslineScriptForForbiddenPatterns` (PR 3)
- `docs/adr/0090-subagent-statusline-supersedes-lifecycle-tracker.md` (new)
- `docs/contributing/hooks-reference.md` — full statusline section rewrite
- Matching `bin/tests/**` coverage across all three PRs; `pnpm verify` clean
  on every PR (58/58 on PR 2 and PR 3)
- Narratives: `docs/logs/2026-09-03-statusline-redesign.md` (PR 1),
  `docs/logs/2026-09-03-subagent-statusline.md` (PR 2)
