# Work log — harness-refresh-sweep (2026-09-06)

This log covers a `/refreshing-anthropic-guidance` sweep of the local Claude
Code harness against Anthropic's current guidance (Claude Code v2.1.263,
delta from the prior sweep's v2.1.260), and the docs-only remediation PR it
produced. It records what the sweep found, what matched the recommended plan,
and one methodological divergence worth generalizing: closing a
long-unpinnable coverage gap by executing against local evidence instead of
trusting another doc fetch.

Plan of record: [`docs/plans/archive/2026-09-06-harness-refresh-sweep-remediation.md`](../plans/archive/2026-09-06-harness-refresh-sweep-remediation.md)
(condensed from the session's plan-mode file, which lives outside the repo)

## Summary

Five `Explore` agents fanned out in parallel, one per fixed facet
(models-tiering, cc-features-settings, agent-subagent-design,
skills-context-engineering, hooks-lifecycle), each re-fetching the tracker's
recorded claims and reporting UNCHANGED/CHANGED/GONE/NEW verdicts. Every
claimed repo-impact was independently re-verified against the actual file
before being accepted — this caught one stale finding and confirmed several
genuine fixes.

**Result: zero correctness defects across 32 recorded claims.** The harness
remains conformant with current Anthropic guidance. The change is entirely
docs/tracker bookkeeping plus one agent-frontmatter fix:

- `docs/research/harness-refresh.md` — header bumped to
  `last-verified=2026-09-06 claude-code-version=2.1.263`; 4 outstanding-drift
  items closed (2 found already fixed elsewhere, 1 closed as not-actionable,
  1 reclassified from open drift to an accepted documented limitation); a
  prior-sweep miscount corrected (33 documented hook events, not 32); several
  claims updated where guidance moved with no repo impact.
- `.claude/agents/Explore.md` — `color: gray` → `cyan` (outside Anthropic's
  documented agent-color enum, unguarded by `check:agents`).
- `docs/contributing/model-selection.md`, `hooks-reference.md`,
  `skills-catalog.md` — a stale confirmation date, a Mythos 5.1 mention,
  `if:`'s newly-eligible hook events, a `/skill-doctor` citation.
- `docs/adr/provenance.json` — mechanical re-stamp, twice (once via
  `pnpm sync:docs`, again after a rebase conflict forced full regeneration).
- `docs/plans/README.md` + a new archive entry — this session's plan-mode
  file archived per the archival bar (changes a `.claude/agents` file).

Landed as PR [#1072](https://github.com/monte3l/m3l-automation/pull/1072),
squash-merged onto `main` as `19bc19ec`.

Skills used: `refreshing-anthropic-guidance`, `starting-work`,
`writing-commits`, `creating-prs`, `syncing-docs`, `finishing-work`,
`writing-work-logs`.

Spoke incidents: none — all five `Explore` facet agents returned complete,
non-truncated digests on their first dispatch; no `SendMessage` resumes
needed; `tmp/session-incidents.jsonl` absent (zero mechanically-detected
truncations).

Compaction events: none.

## What went as planned

- **The fan-out design worked as intended.** All five facet agents returned
  within their capped-digest format, each citing a `retrieved 2026-09-06`
  stamp and a verdict per recorded claim, exactly per the skill's brief.
- **The plan-mode gate did its job.** Four genuinely ambiguous scope
  decisions (remediation breadth, the `Explore.md` color fix, closing
  `PostCompact` as not-actionable, leaving the token-estimate gap as
  documented) were surfaced via `AskUserQuestion` before any file was
  written, and the user's answers matched the recommended option in all
  four cases.
- **`pnpm verify` passed clean on the first full run** (66 non-skipped
  steps) after the initial batch of doc edits, with only a `prettier`/`rumdl`
  formatting tug-of-war (two inline-code spans that `prettier`'s proseWrap
  broke mid-span, which `rumdl` then flagged) needing a manual rewrite to
  converge — not a substantive fix.
- **The `docs-consistency-reviewer` pre-push review found nothing** —
  clean pass across all five consistency checks it was asked to run.
- **CI passed every gate on the first push**, including the ~27-minute
  `Run skill evals` job, with no re-dispatch needed.

## What didn't go as planned, and why

### 1. A doc-fetch claim about `SessionStart`'s input field was wrong, and disproving it required checking transcripts, not re-fetching

The hooks-lifecycle facet agent reported that `SessionStart`'s compact-matcher
input field is `session_start_reason` — a fifth distinct answer across three
sweeps' worth of fetches of the same Anthropic hooks page (prior answers:
`source`, `how_started`, `how`, `start_source`). Taken at face value, this
would mean `.claude/hooks/reinject-compact-handoff.mjs`'s `shouldReinject()`
(which reads only `input.source`, and fails closed/silently on a mismatch)
has never actually worked. Rather than trust a sixth fetch of an already
unreliable page, the session greped this machine's own
`~/.claude/projects/-home-enri3l-*` session transcripts directly for the
hook's injected banner text. Result: `SessionStart:compact` had fired 49
times across local sessions, 14 of them with a populated `additionalContext`
carrying the rendered handoff — proof by execution that `input.source` is
correct and the repo's code was never broken.

**Why it happened:** The hooks documentation page has now demonstrated
fetch-summarizer instability across five independent attempts for this one
field name — a pattern the tracker had already flagged for `Notification`'s
matcher enum, now confirmed to generalize. A doc fetch cannot resolve a
question the doc's own rendering pipeline answers inconsistently.

**Fix for future:** When a specific runtime fact (a hook input field name, an
API response shape) has an observable, locally-checkable ground truth — a
transcript, a log, a live probe — verify it that way once the doc source has
already shown itself unreliable on that exact fact, rather than re-fetching a
sixth time. This generalizes `.claude/rules/subagent-dispatch.md`'s existing
"when a reader and an executor disagree about a guard, the executor wins"
lesson to research/documentation claims, not just code-review claims.

### 2. A rebase mid-flow surfaced a real merge conflict in a non-driver-covered generated file

Between opening PR #1072 and its first mergeability check, two unrelated PRs
(#1071, #1073) landed on `main`, both touching ADR files. `git rebase
origin/main` hit a content conflict in `docs/adr/provenance.json` — this file
is a fully mechanical regeneration target (`pnpm gen:adr-provenance`) but is
deliberately **not** tagged `merge=m3l-generated` in `.gitattributes` (that
tag is reserved for `docs/reference/catalog.json`/`symbol-map.json`/
`pnpm-lock.yaml`). Resolved by taking either side to unblock the rebase, then
fully regenerating the file via `pnpm gen:adr-provenance` afterward and
verifying with `pnpm check:adr-provenance` — never hand-merging the JSON.

**Why it happened:** `docs/adr/provenance.json` shares the same "fully
regenerable, safe to discard and rebuild" property as the merge-driver-covered
files, but predates or falls outside that driver's registered path list.

**Fix for future:** For any conflict in a file produced entirely by a
`pnpm gen:*` script, resolve by taking either side to unblock the rebase,
then re-run the generator and its paired `check:*` verifier — this is
already `creating-prs` Step 2's documented pattern for driver-covered files,
and it applies identically here even without the driver's automatic
resolution.

## Lessons learned

- **A doc page with a documented history of unstable renders is disproven
  by execution, not by another fetch.** `docs/research/harness-refresh.md`'s
  hooks-lifecycle facet had already flagged this instability pattern for one
  field; this sweep confirmed it generalizes and closed the gap for good by
  grepping local session transcripts instead of re-fetching a sixth time.
- **A repo-impact claim from a research agent still needs the hub to open
  the cited file.** Two of this sweep's "already resolved" tracker closures
  (`check:hooks` in `pre-push`, `CANONICAL_CLAUDE_MODELS`'s Fable 5.1 entry)
  were confirmed by the hub reading the actual file, not by trusting the
  facet agent's citation — cheap insurance against a misread page or a wrong
  file:line.
- **A non-driver-covered but fully-regenerable file needs the same
  take-either-side-then-regenerate treatment as a driver-covered one.**
  `docs/adr/provenance.json` isn't tagged `merge=m3l-generated`, but treating
  its rebase conflict the same way `creating-prs` Step 2 documents for
  `catalog.json`/`symbol-map.json` produced the correct result with no
  hand-merging.
- **A squash-merged branch's local cleanup will predictably fail `git branch
-d`, and that's expected, not a signal to investigate.** Both
  `pnpm worktree:remove` and `pnpm branch:cleanup` correctly refused to
  delete the branch (squashed commits are never ancestors of `main`); after
  independently confirming the squashed commit landed on `origin/main` with
  matching content, force-deleting with `git branch -D` was the right,
  already-anticipated next step per `finishing-work`'s own Step 3 note.

## Sweep-cadence check

5+ logs have not yet accumulated since the last `_(promoted → …)_` stamp in
this pass — no lesson here was promoted into a durable rule/agent file (both
lessons above are either sweep-specific or already implicit in existing
`.claude/rules/subagent-dispatch.md` guidance), so `/promoting-work-log-lessons`
is not recommended from this log alone.
