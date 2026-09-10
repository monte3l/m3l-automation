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

- **A section-scoping regex combining the `m` flag with a non-greedy
  `[\s\S]*?…$` needs re-checking before you trust it.** Under `/m`, `$`
  matches before _any_ newline in the string, not just at the very end — so a
  non-greedy lookahead succeeds at the first line break and the "rest of the
  section" capture is always empty. A `bin/lib/*.mjs` heuristic extracting one
  `##` section's body this way silently flagged zero inputs instead of the
  intended subset, caught only by testing a synthetic fixture immediately
  after writing it (`docs/logs/2026-09-06-adr-governance-tooling.md`). Anchor
  `^` via `(?:^|\n)` and end the capture at the next marker or end-of-string
  via `(?=\n<marker>|$)` instead — that needs no multiline flag at all.

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

- **An idempotent `bin/` setup script's "already applied" check must compare
  the target's actual content against what it would write now, not just
  whether the target is active/present.** `setup-host-resources.mjs`'s step 1
  originally only asked `systemctl is-active earlyoom` and reported
  "already active — leaving as-is" unconditionally when true — so a fix to
  the script's own earlyoom tuning (a corrected `--prefer` regex) could never
  reach a host that had already run `--apply` once, since the check never
  looked at the on-disk drop-in's content at all. Confirmed live, not
  hypothetical: this exact host's drop-in still had the pre-fix regex until a
  `classifyEarlyoomState()`-style content comparison was added
  (`docs/logs/2026-09-08-earlyoom-process-matching.md`). Any idempotent
  script whose target configuration can itself change across script versions
  needs this comparison, not just an existence/active check.

- **A matching pattern reused as a structural template for a sibling rule
  inherits none of the reasoning that made the original correct — only its
  shape.** Three `eslint.config.js` `no-restricted-syntax` selectors copied a
  working selector's `CallExpression[callee.name=...]` anchor for a new
  check, but that anchor only covered every call form in the original
  because a _separate_, paired selector handled the member-expression case
  alongside it; reused alone, the copy silently dropped member-call coverage
  three selectors deep, caught only by a review round exercising the exact
  call shape (`docs/logs/2026-09-09-issue-862-test-fs-sandbox-isolation.md`).
  When copying a working pattern for a new rule (a selector, a regex, a
  matcher), re-derive what made the original complete and confirm the new
  context still has it — don't assume the shape alone carries the
  correctness.

- **A skill-eval harness assertion whose correctness depends on model
  behavior, not just code logic, needs a live probe before the test suite is
  written around it.** `expect_routed_to`'s first design (requiring a named
  sibling skill to itself fire, alongside the skill under test not firing)
  was internally consistent and passed a logical read, but was empirically
  wrong: two live probes against real skills
  (`implementing-scripts#3`/`refreshing-anthropic-guidance#3`) showed a model
  correctly recommending the sibling in prose — meeting every graded
  criterion — without ever invoking that sibling's `Skill` tool inline,
  since doing so would start executing the sibling's own write-capable
  procedure mid-turn. The design was corrected only after the probe; the
  test suite already written around the wrong semantics needed a follow-up
  correction too (`docs/logs/2026-09-10-skill-eval-routing-debt.md`). A
  $0.35-0.75 `pnpm eval:skills <name>` probe is cheap insurance against
  building an assertion (and its tests) around a wrong assumption about what
  a model actually does.
