# Retire ADR-0016's Bash-write observation trigger (issue #210)

**Status: shipped** — commit pending on `docs/retire-adr-0016-bash-write-trigger`.

## Context

Issue #210 tracks "Bash-write bypass of `Write|Edit` PreToolUse guards" — file
writes issued through `Bash` (`echo >`, heredocs, `tee`) skip
`guard-secret-writes`/`guard-js-extension`/the other write-time guards. It is a
derived issue: its only authored source is `docs/plans/IMPLEMENTATION.md:267`,
and `pnpm sync:hub` owns its GitHub state. It was closed as Rejected on
2026-07-25, then reopened on 2026-08-13 when PR #399 flipped the row back to
`Deferred` on the grounds that ADR-0016 keeps the trigger live: "Revisit if a
`Bash`-mediated bypass of one of these guards is ever observed in practice"
(`docs/adr/0016-signed-commits-and-decision-gate.md:26-27`).

The user asked `/auditing` to assess whether #210 should be closed
definitively along with its milestone/project items. A three-facet parallel
audit — hub-sync mechanics, the technical substance of the Bash-write concern,
and precedent for definitive closure — established:

1. **The gate is unfired and structurally unpollable.** A sweep of all 73
   `docs/logs/*.md` work logs found zero Bash-mediated guard bypasses. The
   three recorded incidents of the hub writing to a guarded path
   (`docs/logs/2026-07-24-w5-promote-destructive-gate.md:133-139`,
   `2026-07-26-w5-promote-checkpoint-store.md:137-147`,
   `2026-07-27-scripts-codepipeline-ops.md:82-88`) all used the `Edit` tool,
   not `Bash`. More decisively: nothing in the repo polls for this condition —
   it can only ever arrive as a logged incident, which is exactly the ground
   `33cb838` used to retire ADR-0030's gh-CLI-vs-MCP revisit trigger and close
   issue #344.
2. **The gap's own framing overstates itself.**
   `docs/contributing/hooks-reference.md:41-45` and ADR-0016:22-23 both claim
   the `Write|Edit` guards "cannot see" or "do not see" file writes made
   through `Bash`. But `.claude/hooks/guard-readonly-bash.mjs` — added
   2026-07-12, the _same day_ as the hardening pass that wrote those notes —
   already runs on a `PreToolUse: Bash` matcher and pattern-matches
   `>`/`>>`/`>|` redirection, `tee`, and `sed -i`. It is scoped to read-only
   subagents only (keyed on the hook payload's `agent_type` field), never the
   hub's own Bash calls. The accurate statement is that the _write-time
   content guards_ are not wired to `Bash`, not that Bash writes are
   unseeable — this repo already has the parsing machinery #210 would ask for.
3. **The observed guard hole is a different one than #210 names.**
   `guard-branch-isolation` is the one `Write|Edit` guard with no non-hook
   backstop — branch protection stops an unsigned/unreviewed _push_, not a
   `main`-branch working-tree write — and nothing catches a **hub-authored**
   `Edit` into `src/`/`tests/` on a feature branch. That gap is the one
   actually observed three times in the logs above, with the ask already
   recorded verbatim at `docs/logs/2026-07-26-w5-promote-checkpoint-store.md:200`.

## Decision

**Reject issue #210.** Grounds are that the ADR-0016 trigger is
**structurally unpollable** — an "observed in practice" condition with nothing
in the repo that could ever observe it — mirroring the #344/ADR-0030
precedent exactly. This is deliberately not any variant of the "W1–W5 closed,
no further script planned" D4/D5 template; #210 sits in a different part of
the tracker and was never gated on fleet completion.

**This is not a reversion to the 2026-07-25 rejected verdict.** That close was
a bookkeeping artifact of the tracker cell reading `Rejected` at the time, and
PR #399 correctly reverted it because ADR-0016's trigger was still live and
unevaluated. This decision accepts ADR-0016's reading in full, evaluates the
trigger on its merits, and retires it because no periodic re-check can ever
observe the condition it names — not because the earlier verdict was
reinstated. Both the tracker row and the ADR Update say so explicitly.

**ADR-0016 is amended, not reverted.** ADR-0016 is Accepted and unsuperseded;
its 2026-07-12 Update stays in place as history. A new `## Update (2026-08-17)`
section retires the observation trigger, corrects the two framing points
above, and replaces the trigger with a concrete, deliberately narrow re-open
condition: a `docs/logs/` entry recording an actual `Bash`-mediated write into
a guarded path that a `Write|Edit` guard would have blocked.

**The real observed gap is filed, not folded into #210's rationale.** A new
`Deferred` row is added to the same P2 gated table for the hub-authored-`Edit`
guard hole, so retiring the never-observed hole does not leave the observed
one untracked. `pnpm sync:hub -- --apply` will file it as its own issue.

## Outcome

One `docs:` commit:

- `docs/plans/IMPLEMENTATION.md` — the Bash-write-bypass row's ID cell is
  **unchanged** (its slug is the hub-sync item key that #210's body marker
  matches on); Status `Deferred` → `Rejected` with a rejection-specific
  rationale; closes issue #210. A new row is added for the hub-`Edit` gap
  (Status `Deferred`).
- `docs/adr/0016-signed-commits-and-decision-gate.md` — new
  `## Update (2026-08-17)` section retiring the `:26-27` trigger, correcting
  the `:17-27` framing against `guard-readonly-bash.mjs`, and stating the
  replacement re-open condition. Status line unchanged (`Accepted`).
- `docs/contributing/hooks-reference.md` — the "Known gap (accepted risk)"
  note (`:41-45`) narrowed from "guards cannot see Bash writes" to "write-time
  content guards are not wired to Bash", cross-referencing
  `guard-readonly-bash.mjs` and its read-only-subagent scope.
- This archive record + one new index row in `docs/plans/README.md`.

`docs/ROADMAP.md` carries no duplicate row for this item (verified by grep),
so no matching ROADMAP edit is needed — unlike the DocumentDB precedent.

No `src/`, test, or `exports`-map change; zero semver impact;
`check:impl-counts`/`check:doc-provenance` are no-ops by construction.
`pnpm sync:hub -- --apply` is left for the maintainer to run from `main` after
merge, matching the #428/#205 precedent — running it earlier would plan
against a `main` that lacks these tracker edits.

### Milestone/project fallout (automatic, no manual GitHub edits)

- Issue #210 closes with `state_reason: not planned` and the standard
  `sync:hub` comment "Item marked rejected in source trackers."
- Its milestone stays `Priority 2`, closed — `planMilestones` never plans a
  delete/close, matching all 13 prior `NOT_PLANNED` closures.
- Its project-board card is archived automatically by `planProjectSync` on
  any issue close.
- The new hub-`Edit`-gap row files a fresh issue on `Priority 2` and a new
  `Pending` board card in the same sync run.
