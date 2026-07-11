# Work log — pre-push parallelization (2026-07-11)

This log covers a workflow/infra change (not a submodule): parallelizing the
lefthook `pre-push` verify to stop `git push` from overrunning foreground
tool-timeouts, plus wiring push-through guidance. It ran through `/auditing`
(four parallel Explore agents) → approved plan → hub-authored config/doc edits
(no spokes; no guarded paths). It records what shipped, what matched the plan,
the pre-existing `main` breakage the change surfaced, and durable lessons.

Plan of record: the approved audit plan (pre-push timeouts).

## Summary

- **`lefthook.yml`** — the `pre-push` stage was one sequential `&&` chain
  (`format:check → lint → typecheck → test:coverage → build → check:exports`)
  plus `verify-signatures`, ~4–6 min whole-repo. Split into six independent
  commands under `parallel: true`; `build && check:exports` stays one command
  (preserves build→pack ordering — lefthook has no per-command DAG).
- **Timed result:** `lefthook run pre-push` completed in **27.5s wall-clock at
  449% CPU** — genuinely concurrent lanes (`verify-signatures` 0.6s,
  `typecheck` 1.3s, `test` 8.4s, `build-exports` 10s, `format` 12s, `lint` 26s).
  Wall-clock is now ≈ the slowest lane (`lint`) instead of the sum.
- **`check:cadence` stayed green with no CLAUDE.md token edit** — as predicted:
  the guard compares the token _set_ the block runs (`extractRunTokens` scans
  every `pnpm`/`bin` token across all `run:` lines), which restructuring leaves
  unchanged.
- **Push-through guidance wired** — `creating-prs` Step 7 and a `CLAUDE.md`
  cadence note now say the push blocks on a multi-minute parallel hook: background
  it / raise the timeout, and don't `--no-verify` to dodge the wait.
- **Also fixed a pre-existing `main` breakage** (see divergence 1).
- Gates green: `check:cadence`, `format:check`, `lint:md` (101 files),
  `check:impl-counts` (22/22), `check:test-counts`, and the full parallel
  pre-push run itself.

## What went as planned

- **The audit's central bet held empirically** — restructuring the hook into
  parallel commands did not trip `check:cadence` (token set invariant), so no
  doc-row churn was needed. `lefthook dump` confirmed the new block parses with
  all six commands before any push.
- **Parallelism delivered the intended win** — the timed run confirmed real
  concurrency and a wall-clock collapse from the serial sum to the slowest lane.
- **No spoke needed** — the change touched only `lefthook.yml`, `.claude/`,
  `CLAUDE.md`, and this log; `guard-branch-isolation` never fired.

## What didn't go as planned, and why

### 1. The parallel pre-push surfaced a latent `main` breakage

The first `lefthook run pre-push` failed on its `format` lane:
`docs/implementation-status.md` failed `prettier --check`. `git status` was
clean and the file matched `origin/main` — so **`main` itself was red**. Commit
`d0043ee` ("chore: fix config submodule tests count") had edited the config
row's test count without re-padding the markdown table column; its parent was
prettier-clean, and `main`'s CI at `51c4dc6` was `failure`. It reached `main` by
bypassing the pre-push hook (pre-push `format:check` would have caught it). Fixed
here as a separate `chore:` commit — a whitespace-only re-pad
(`git diff --ignore-all-space` empty; counts unchanged) that greens `main` and
unblocks this branch's own format lane.

**Why it happened:** a check was bypassed locally (`--no-verify` or a direct
push), landing a whole-repo `format:check` failure on `main` that the required CI
gate is red on but that no one had triaged.

**Fix for future:** treat a red first-run of the new parallel hook as possibly
pre-existing, not necessarily caused by your change — `git status` +
`git diff origin/main -- <file>` disambiguates in seconds. And the bypass is a
reminder that the pre-push is only a backstop; `main`'s health depends on not
`--no-verify`-ing past it.

## Lessons learned

- **Parallel hooks trade fast-fail for surfacing.** Dropping the `&&`
  short-circuit means every lane runs even when a cheap one fails — which cost
  nothing here and actually _exposed_ a latent breakage a fail-fast chain would
  have hidden behind the first error. Worth it because the all-pass push is the
  case that was timing out.
- **A token-set cadence guard makes structural hook edits free.** Because
  `check:cadence` compares which checks run (not how they're arranged),
  reordering or parallelizing `lefthook.yml` needs no doc edit — confirmed by
  reading `bin/check-cadence-doc.mjs` before editing rather than guessing.
- **Warming turbo does not speed the slow pre-push lanes.** `test:coverage` and
  `lint` are un-cached (turbo caches only `build`/`typecheck`), so "run the gates
  first" never shortened the timeout-prone step — the real fixes are concurrency
  and budgeting the push. _(promoted → .claude/skills/creating-prs/SKILL.md, CLAUDE.md)_
- **A red trunk can hide until something re-runs the gate.** `main` sat red on a
  formatting failure; nothing forced a local re-check until the new hook ran it.
  A periodic `main`-health glance (or not bypassing the hook) catches this sooner.
