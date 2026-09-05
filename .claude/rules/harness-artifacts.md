---
paths:
  - ".claude/hooks/**"
  - ".claude/workflows/**"
  - "bin/**"
---

# Executable harness artifacts (hooks, workflow scripts & check gates)

> The files that **run**, as opposed to the ones that are read as prompts. A
> `.claude/hooks/**` or `.claude/workflows/**` script has no test suite, no
> type checker and no coverage gate — `pnpm verify` never executes one; review
> reads it, nothing runs it. A `bin/**` `check:*` gate is the opposite gap: it
> does have a test suite (`bin/tests/**`, type-checked by `pnpm typecheck`),
> but a synthetic-fixture suite can only assert what its author imagined —
> never what the live repo actually contains. Both gaps are what these rules
> cover.

- **Run a new hook or workflow script against known-good input before wiring
  it, not only against the failure cases it was built from.** A truncation
  detector built from truncated-message examples flagged a _clean_ review
  digest ending in a bullet list, because terminal punctuation is a poor proxy
  for completeness — structured output (lists, tables, code fences)
  legitimately ends without a period
  (`docs/logs/2026-07-19-subagent-stall-integration.md`). An advisory hook that
  fires on every event of a type must be proven **quiet** on that type's normal
  output; one that cries wolf trains the reader to ignore it, which is worse
  than not shipping it. The same hook broke a second, structurally different
  way once a new spoke _dispatch mode_ existed: a schema-dispatched agent
  (structured output, not free text) leaves `last_assistant_message` absent
  entirely rather than present-but-imperfect, and `looksTruncated(undefined)`
  returns `true` by design — so every schema-dispatched agent false-positived
  100% of the time, invisibly, until a live acceptance run's own side-effect
  log was read closely (`docs/logs/2026-09-02-audit-refuter-hardening.md`). A
  payload-shape-assuming hook needs re-validating whenever a new spoke
  invocation mode is introduced, not just when a new spoke type is added — a
  new mode can change which fields exist in the payload at all, which "test
  against known-good input" above doesn't catch retroactively for a mode that
  didn't exist yet when the hook was last validated.

- **A live end-to-end run on a small real input is the acceptance test for a
  workflow script — static gates and review passes cannot see runtime
  behavior.** String-encoded `args`, a backslashed `runDir` that died in
  whichever shell the agent picked, and a report file that was never written
  all passed every gate and two review rounds, and all three fell out of the
  first real run (`docs/logs/2026-07-16-audit-fanout-workflow.md`).

- **Run a new `check:*` gate live against this repo before writing its test
  suite, not after.** A synthetic fixture can only test what its author
  imagined; a live run surfaces the self-referential case for free — a
  `docker`-ban gate's first regex flagged the gate's own filename and its own
  explanatory prose (`docs/logs/2026-09-04-check-no-docker.md`), and a
  staleness gate run against three real `[gone]`-upstream worktrees exposed an
  unwired classification path in seconds
  (`docs/logs/2026-09-05-post-merge-staleness-gate.md`). This is the
  complement of `tests.md`'s "test a `bin/` checker against synthetic state"
  bullet, not a contradiction: live-run to smoke it, synthetic fixtures for
  the suite that has to keep passing tomorrow.

- **Validate arguments loudly at the top of a workflow script.** A script that
  dies mid-orchestration produces no stack context worth reading; an explicit
  guard turns a delivery-format surprise into a one-line diagnosis. Parse a
  string-encoded `args` blob rather than only rejecting it — the caller is
  usually a model following a `SKILL.md`.

- **Anything a subagent self-reports about the filesystem is a claim, not a
  fact.** Stamp derivable values (paths, facet linkage) from the input array by
  index rather than trusting an agent's echo, require agents to confirm their
  own writes landed, and give the caller a recovery rule for a missing artifact.

- **Normalize paths to forward slashes before they cross an agent boundary.**
  A backslashed path survives or dies depending on which shell the agent picks,
  which makes the failure non-deterministic and very hard to attribute.

- **A `SessionStart`/`PreCompact`/`PostCompact` hook's matcher must be checked
  against what the hook actually does, not just against the known-token list.**
  `check:hooks` validates that a wired matcher (`startup`/`resume`/`clear`/
  `compact`/`fork`) is a real token; it says nothing about whether that token
  choice is safe for the hook's own purpose. A hook that rotates/deletes state
  wired with no matcher (or too broad a matcher set) fired on `compact` and
  `resume` as well as `startup`, deleting a still-in-progress session's own
  just-recorded data the moment a mid-task auto-compaction occurred — caught
  by an external review bot, not by any local gate
  (`docs/logs/2026-09-02-session-incidents-counter.md`). `resume` in
  particular is not interchangeable with `startup` even though both are
  "the process is (re)starting": a resumed session may be recovering from a
  crash whose state hasn't been consumed yet, so it needs the same protection
  a mid-session `compact` does. Enumerate which of the five matcher values the
  hook's purpose is actually safe for as an explicit design step before
  wiring, and prefer a belt-and-suspenders in-hook check (reading the payload's
  `source` field, mirroring `reinject-compact-handoff.mjs`'s `shouldReinject()`)
  alongside the settings.json matcher, not instead of it.
