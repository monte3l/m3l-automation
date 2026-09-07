# Work log — worktree-hook-shim-race (2026-09-07)

This log covers solving issue #1002 (H9, governance follow-up): worktrees
share `.git/hooks`, racing on concurrent `lefthook install`.

## Summary

- Re-derived H9's own claims against the live shim before fixing it (CLAUDE.md
  Task Workflow step 1) and found the premise partly wrong: the "confusing
  command not found" clause does not reproduce, because the shim's baked
  absolute path is guarded by an `-h` probe and falls through cleanly to a
  `$dir`-relative fallback present in every checkout. Removing the winning
  worktree degrades gracefully.
- Found a more severe, separate hazard while re-deriving: the shim's final
  `else` branch echoes `Can't find lefthook in PATH` with no `exit 1`, so a
  push resolving no lefthook binary at all exits 0 and silently skips every
  pre-push gate, `verify-signed-range` (ADR-0016 layer 2) included. Filed as
  a new row, **H14**, rather than fixed here — fixing it means guarding a
  generated, untracked file, a different shape of change than H9's fix.
- `bin/worktree-setup.mjs`: widened the existing `run()` helper to take an
  optional `cwd`, then re-run `pnpm exec lefthook install` from the main
  checkout (warn-only, `try`/`catch`, no `process.exit`) right after
  provisioning. The shared shim now deterministically favors the one
  checkout that is never removed, instead of whichever `pnpm install` ran
  last.
- `docs/contributing/contributing.md`: corrected the contradicted "the `.git`
  directory … is shared, so hooks work without a re-install" claim with a
  paragraph on what the installed shim actually bakes and why
  `worktree:setup`'s fix works; added a fifth Troubleshooting bullet naming
  the fail-open symptom on sight.
- `docs/ROADMAP.md`: H9 flipped to `Done` with the corrected premise recorded
  in the Notes cell; new H14 row added, `To Do`.
- Shipped as PR #NNNN (`fix/worktree-hook-shim-race`).

Skills used: `starting-work` (decision gate: linked worktree,
`fix/worktree-hook-shim-race`, PR required).

Spoke incidents: none — three Explore agents (worktree/lefthook wiring, docs
surfaces, prior governance-resolution precedent) ran in parallel during plan
mode; all three returned clean, load-bearing findings on the first pass.

Compaction events: none.

## What went as planned

- The plan's prediction that provisioning the new worktree would itself
  re-bake the shared shim — the bug reproducing during its own fix —
  happened exactly as expected: `pnpm worktree:new` baked
  `m3l-automation-worktree-hook-shim-race`'s path into the shim before a
  single line of the fix existed, giving a live before/after to verify
  against for free.
- The live-run verification sequence from the plan worked without
  surprises: `pnpm worktree:setup` after the fix flipped the baked path from
  the worktree's `node_modules` to the main checkout's, confirmed by
  `grep`-ing `.git/hooks/pre-push` before and after; the actual installed
  shim, invoked directly, resolved the main-checkout binary and began
  running real `pre-push` lanes from inside the worktree.
- The warn-only `try`/`catch` around the re-install call was verified in
  isolation (a deliberately-broken `pnpm exec lefthook <bad-subcommand>`
  call) to confirm the script logs and continues rather than exiting —
  cheaper and just as convincing as inducing the failure inside the real
  script.

## What didn't go as planned, and why

### The issue's stated failure mode didn't hold up

H9's own text ("removing the worktree whose binary path won the race breaks
another worktree's in-flight push with a confusing 'command not found'") was
the reason the issue existed, and it was wrong. Reading the generated shim
directly — rather than trusting the issue's prose about it — showed the `-h`
probe guard makes a dangling baked path harmless: it fails cleanly and falls
through to the `$dir`-relative fallback, which is present in every checkout
because it's `node_modules`-relative, not absolute. Precedent existed for
this exact move (H3/PR #1045, T11/PR #567 both recorded an inverted premise
rather than silently building around it), so the ROADMAP Notes cell states
the correction plainly instead of just fixing the symptom quietly.

### The real hazard was hiding one `else` branch further down

Reading the whole shim rather than stopping at the clause the issue named is
what surfaced the fail-open `else`/no-`exit 1` branch — a strictly worse bug
than the one being fixed, silently bypassing every push-time gate. It would
have been easy to fold this into the same PR, but the fix shapes are
different (worktree-side re-install vs. a guard on a generated file this
repo doesn't currently inspect at all), so it became its own row instead of
scope-creeping the H9 fix.

## Lessons learned

- **A tracker row authored from a personal memory (not a fresh audit) still
  needs the same re-derivation as any other authored claim before acting on
  it.** H9's text was accurate about the race existing but wrong about its
  consequence — the only way to find that was reading the generated
  `.git/hooks/pre-push` shim directly and tracing its fallback cascade,
  not trusting the prose describing it. This is the same instinct CLAUDE.md
  § Known Gotchas already states for `check:*` gates ("what a gate enforces
  is its `bin/*.mjs`, not nearby prose") — it applies just as much to a
  tracker row describing a shell script as to a script's own documentation.
- **Reading a generated artifact end-to-end, not just the clause a bug
  report names, surfaces adjacent bugs the report never mentioned.** The
  fail-open `else` branch (H14) was two lines past the clause H9's text
  actually pointed at; it would not have been found by only verifying the
  claim under test.
