# Work log — ADR-0078 session context management rollout (2026-08-27)

> **Retroactive log, written 2026-09-02.** This log was not written during the
> session that did the work — it did not exist, and its absence was itself
> one of the findings a later `/auditing` sweep surfaced
> (`docs/research/harness-refresh.md` Outstanding drift, and the plan
> `context-management-and-engineering-eventual-quill`). Everything below is
> reconstructed from git history (commit messages, diffs, the ADR's own text)
> rather than live session context, so it is **necessarily thinner** than a
> log written in the moment: no spoke-incident counts, no first-hand "what
> went as planned" texture beyond what the commits themselves document. Treat
> the Summary and divergence items as verified against `git show`; treat
> anything not directly evidenced there as absent, not silently assumed.
> This gap — and the resulting unreliability of reconstructing it after the
> fact — is itself this log's main lesson; see below.

This log covers the delivery of [ADR-0078](../adr/0078-session-context-management.md)
("Hub session context management: honest budgets and durable-artifact
compaction"): a new context-budget gate that resolves `CLAUDE.md`'s
`@`-imports before measuring, a widened context-management doctrine doc, and
a `PreCompact`/`SessionStart(compact)` handoff-artifact hook pair. Decision of
record: [`docs/adr/0078-session-context-management.md`](../adr/0078-session-context-management.md).

## Summary

Three real commits on `main`, corresponding to the ADR's own internally
numbered "PR N of 6" labels (quoted verbatim from the commit messages below —
these labels do not map 1:1 onto GitHub PR numbers; several were squash-merged
together):

| Commit     | GitHub ref | ADR label(s)                                                                        | What shipped                                                                                                                                                                                |
| ---------- | ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a8f7dadc` | #699       | (Part B doctrine + research)                                                        | ADR-0078 itself; `subagent-context-management.md` gains "Part 1 — the hub session"; research snapshot `context-window-and-compaction.md` (43 sources)                                       |
| `f9027e98` | #700       | "PR 2 of 6", "PR 3 of 6" (#701), "PR 4 of 6" (#704), plus a follow-up hardening fix | `bin/check-context-budget.mjs` (Part A gate); `CLAUDE.md` `@`-import removal + `## Compact Instructions` section; `write-compact-handoff.mjs`/`reinject-compact-handoff.mjs` (Part C hooks) |
| `27c2339a` | #707       | "PR 6/6"                                                                            | `check:agents` enforcement of `maxTurns`/bounded-output sections; four context-handling bug fixes surfaced by the original audit                                                            |

Part D (config-knob pins — `autoCompactWindow`, `MAX_MCP_OUTPUT_TOKENS`,
prompt-cache TTLs) was PR 5 of 6 and was **dropped**, not shipped — recorded
in the ADR's own `Update (2026-08-27)` note as a deliberate maintainer call
rather than a divergence of this delivery.

`git show --format=%B -s f9027e98` preserves four squashed sub-commit
messages in full, which is where most of this log's verifiable detail below
comes from — a rare case where a retroactive reconstruction has near-live
fidelity, because the squash-merge commit body itself is the primary source.

**Skills used (inferred, not certain):** the ADR's own Context section names
`/auditing` and `/researching-anthropic-guidance` as the originating pipeline.
Every commit's `Co-Authored-By: Claude Opus 5` trailer matches
`model-selection.md`'s plan-then-implement row (`/model opusplan`). Per-PR use
of `starting-work`/`creating-prs` is standard convention for this repo but not
independently confirmed here.

**Spoke incidents:** unknown — not capturable retroactively; no journal or
transcript survives outside this repo's git history.

**Compaction events:** unknown — not capturable retroactively, and the
`Compaction events:` line convention this same PR introduces
(`.claude/skills/writing-work-logs/SKILL.md`) did not exist yet when this
work happened.

## What went as planned

- **The gate was staged deliberately, not accidentally left half-wired.**
  `f9027e98`'s first sub-commit added `bin/check-context-budget.mjs`
  explicitly _not_ wired into CI/pre-push, because at that point it would
  have failed its own hard budget check (`CLAUDE.md` resolved to ~2.9x the
  cap) and made the PR unmergeable. The next sub-commit cut `CLAUDE.md`'s
  `@`-imports first, then completed the cutover — landing a failing required
  check was avoided by sequencing, not by weakening the gate.
- **Every sub-commit reported a verified gate/test run in its own message**
  — e.g. "`pnpm check:context-budget` reports 162 lines / ~2,937 tokens (was
  393/~8,872)... full suite (327 test files, 11,821 tests) green" and "`pnpm
check:hooks` reports 23 wired hooks, all resolving; full suite (329 test
  files, 11,850 tests) green" — rather than an unverified "done" claim.
- **New tests shipped alongside every behavioral change**: 65 for the
  context-budget gate, 8 more as regression tests for two bugs found while
  writing it (below), 29 for the two compaction hooks, 5 more hardening
  malformed-input handling.
- **A scope cut was made explicitly, not silently.** The PR-3 sub-commit
  notes: "Deliberately out of scope: splitting `.claude/rules/subagent-dispatch.md`
  ... Left for a later, focused change" — a real, documented scope decision
  rather than a dropped thread.

## What didn't go as planned, and why

### 1. Two real bugs were found and fixed while building the gate itself

`globToRegExp`'s `"**"` handling required at least one intervening path
segment, contradicting its own documented "zero or more" semantics —
`"packages/**/*.ts"` failed to match `"packages/foo.ts"`. Separately,
`resolveImportedFiles` could resolve an `@`-token containing `"../"` segments
outside the repo root before the filesystem check ran.

**Why it happened:** both are the kind of edge case that only surfaces once
a glob matcher or path resolver meets real, varied input — the initial
implementation covered the common cases first.

**Fix for future:** both were caught by writing the gate's own 65-test suite
before wiring it in, and fixed with regression tests proving the fix (the
containment-check test specifically proves the guard fires _before_ any
`statSync` call, not that the filesystem happens to reject the bad path) —
the standard "test before you trust a new gate" pattern, working as intended
here.

### 2. A pre-existing bug in `check-cadence-doc.mjs`'s table parser was found as a side effect

Splitting `CLAUDE.md`'s oversized `pre-push` cadence-table row into four
shorter rows surfaced that `parseCadenceTable` overwrote a stage's token set
on every row instead of accumulating across rows — invisible until a stage
first spanned more than one row.

**Why it happened:** the bug was latent since the parser was written; no
prior cadence-table edit had ever split a single stage across rows.

**Fix for future:** the sub-commit's own verification method is worth
repeating generally — the fix was proven by temporarily reverting to the old
overwrite behavior, confirming the new regression test failed, then
restoring the fix. A regression test that was never run against the bug it
claims to catch is not verified to catch it.

### 3. `runGit`'s `.trim()` silently corrupted `git status --porcelain`'s first line

The shared `runGit` helper's `.trim()` stripped the leading space off only
the _first_ line of multi-line stdout, while preserving it on later lines —
corrupting a status code where leading-space is semantically meaningful
(`" M"` = modified in the worktree only, vs. `"M "` = staged, are different
git states).

**Why it happened:** a plain `.trim()` is the obvious first implementation
for "strip trailing whitespace" and silently does the wrong thing for
leading whitespace too, on a string where the leading character is data, not
padding — a hazard that only shows up on multi-line output starting with a
significant space.

**Fix for future:** switched to trailing-only trim (already documented in
the shipped hook's own header comment, per this same session's later reading
of it). Worth a general rule: never reach for a plain `.trim()` on a value
whose leading whitespace can be semantically significant — check what the
value's own format documents before trimming.

### 4. `security-reviewer` found two crash paths in `reinject-compact-handoff.mjs` post-hoc

A follow-up sub-commit fixes a bare `null` stdin payload (valid JSON) that
passed the try/catch unharmed but then crashed on `input.source` access, and
a well-formed-but-wrong-shape handoff artifact that crashed on
`handoff.lastCommit.sha` — the second one able to **re-crash on every
subsequent compaction** until the corrupt artifact was manually cleared,
since the throw happened before the one-shot `unlinkSync`.

**Why it happened:** the initial implementation's happy-path shape
assumptions (a `SessionStart` payload always being a plain object with a
`source` field; a handoff artifact's `lastCommit`, once truthy, always
having a string `sha`) were reasonable for the hook's own writer but not
defensive against a malformed or unexpected caller.

**Fix for future:** the self-re-crashing failure mode (a bug that persists
across sessions because the artifact that triggers it never gets consumed)
is the sharper lesson here — for any one-shot artifact-consuming hook, the
cleanup step must not be gated behind successful use of the artifact's
content, or a malformed artifact becomes permanently stuck rather than
self-healing on the next write.

### 5. The ADR's own rollout-status claim went stale five days after it was written

The `Update (2026-08-27)` note (written same-day as the ADR, after PR 6/6
landed) asserted "PRs 1-4 (Parts A-C) landed as described." A
`/auditing` sweep on 2026-09-01 — five days later — found this false for
Part C specifically: the Decision text specified the `PreCompact` artifact
carry the PR number and reuse `bin/spoke-recovery.mjs`'s journal discovery,
written to the session scratchpad; what shipped (per item 4's sub-commit
message, "Deliberately narrower than ADR-0078's original sketch") has
neither, by design, for reasons documented in the hook's own header comment.
The ADR's summary line just never caught up to what the implementing
sub-commit had already explained.

**Why it happened:** a same-day status note, written immediately after the
sequence closed, is exactly the kind of authored claim that's cheap to get
right at the moment and easy to leave unrevisited afterward — nothing
re-checks a "landed as described" line against the actual shipped diff once
it's written.

**Fix for future:** already the subject of this repo's own standing
practice — CLAUDE.md's "Re-derive any authored claim you're about to act on"
rule exists because of incidents exactly like this one. This log is a
second, independent confirmation of that rule rather than a new lesson.

## Lessons learned

- **A gate that would fail on landing gets sequenced, not weakened.** Adding
  a new budget gate unwired, then cutting the measured surface to fit before
  wiring it in, avoided both a failing required check and a loosened
  threshold. Worth repeating whenever a new gate's honest first measurement
  fails against the current tree.
- **Prove a regression test against the bug, not just the fix.** The
  cadence-doc parser fix was verified by reverting to the buggy behavior and
  confirming the new test actually failed — the only way to know a
  regression test isn't accidentally passing regardless of the code it
  claims to guard.
- **Never plain-`.trim()` a value whose leading whitespace is data.**
  `git status --porcelain`'s leading space is a status code, not padding;
  the general form of this mistake (trimming a fixed-width or
  leading-significant format) will recur on any similarly-shaped tool
  output.
- **A one-shot artifact's cleanup must not be gated behind successfully
  using its content.** Otherwise a malformed artifact re-triggers the same
  crash on every future consumption instead of ever getting cleared —
  self-healing requires the delete to run (or be reachable) even on the
  failure path.
- **An ADR's same-day rollout-status note is an authored claim like any
  other, and rots the same way.** Re-derive it against the actual shipped
  diff before trusting it, especially once other work has landed since —
  confirms the existing CLAUDE.md rule rather than adding a new one.
- **Write the work log the same session as the task.** This log itself is
  the evidence: reconstructing it eight days later from git history alone
  recovered the _what_ (commits, bugs, fixes, test counts) with high
  confidence but lost the _process_ entirely — no spoke-incident counts, no
  compaction events, no sense of what almost went wrong but didn't. The
  `writing-work-logs` skill's own opening line ("most valuable when written
  during the same session... after the session closes, that context must be
  reconstructed from memory or git history — both are less precise") is not
  a general caution here; it is a description of exactly what happened to
  this log.
