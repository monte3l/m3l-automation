# V2 — CLI machine-surface hardening (#539, ADR-0063)

**Status: shipped** (PRs #686, #687; branches `feat/cli-run-help-json-plumbing`, `feat/cli-run-json-envelope`)

## Context

An agent driving `m3l run` got an exit code and inherited stdio — nothing
structured. ADR-0063 named three concrete defects: `run` parsed `--json` but
never read it; dynamic dispatch hardcoded `jsonOutput` to `false`; and
`run <script> --help` printed generic usage while only the dynamic form
(`m3l <script> --help`) redirected to `inspect`. All three were re-verified
against `origin/main` before work started (the ADR's `main.ts:347` citation
was still exact).

The complication: ADR-0035 classifies the run report as a sensitive,
crash-dump-class artifact, so the fix could never simply re-emit it.

## Approach / Decisions

- Isolation: new linked worktree, two sequential branches/PRs off `origin/main`
  (ADR-0072 slicing) — plumbing first, the larger envelope second — so a
  12-line symmetry fix didn't sit behind a 3-module security-sensitive review.
- **Slice 1** (`--help` redirect + `--json` dynamic-dispatch plumbing): a new
  `cli/flags.ts` (`JSON_FLAG`/`partitionJsonFlag`) reserves `--json` the same
  way `--help`/`-h` already was, shadowing a script's own same-named
  parameter; `run <script> --help` redirects to `inspect`. `main.ts` was
  already at 23,416/25,000 chars post-U9 merge, so a preparatory
  `refactor(cli): extract cache/history path resolution into cli/paths.ts`
  landed first to free budget headroom for slice 2's own addition.
- **Slice 2** (the envelope): three new `run/` modules —
  `envelope.ts` (pure allowlist projection: script, timing, exit code +
  its ADR-0035 registry name, a validated 5-literal `outcome`,
  timeline/recovery counts, the report's own path — nothing else),
  `report-lookup.ts` (scans the shared `data/output` tree for the
  newest, in-window, timestamp-named directory matching the invoked
  script — deliberately read-tolerant, a documented departure from the
  usual re-throw-EACCES convention, since a throw here would discard the
  child's already-resolved exit code), and `execute.ts` (the one shared
  spawn+envelope tail `run.ts`/`dynamic.ts` both call, so the two
  invocation forms cannot diverge). `spawn.ts` gained a stdout-to-stderr
  redirect under `--json`, so the envelope is the only line on stdout
  without losing the child's own output.
- Three independent review passes before opening the PR: `code-reviewer`
  (approve), `security-reviewer` (adversarial probes against the built
  `dist/` — planted-secret canaries, path traversal, symlink following,
  ReDoS timing, prototype pollution; no leak found), `silent-failure-hunter`
  (one HIGH finding: the report scan aborted the _entire_ directory scan on
  the first unreadable/malformed candidate, even when an older, unrelated
  candidate held the invoked script's own valid report — `data/output` is a
  flat tree shared across every invocation. Fixed to remember only the
  first stop reason as a fallback and keep scanning for a genuine match).
- `claude-pr-review`'s CI bot caught two more things after the PR opened: a
  new unit test spawned a real child process and touched the real
  filesystem (rewritten to mock `node:child_process` instead), and the
  envelope pipeline's best-effort catch swallowed a genuine bug with zero
  diagnostic (now surfaces via a guarded `context.output.error`, still
  never altering the resolved exit code). A pre-push coverage gate also
  caught two files whose "hostile getter throws" catch branches were never
  actually exercised by any "hostile lookup" test (those only added extra
  fields, never a real throwing accessor) — closed with targeted tests.
- Gitleaks flagged a deliberately secret-shaped test placeholder
  (`"sk-PLANTED-1234"`, used to prove `JSON.parse`'s failure path never
  leaks file content) — allowlisted via `.gitleaksignore`, matching this
  repo's existing precedent for the same false-positive shape.

## Outcome

Both PRs squash-merged to `main` (#686, #687). The V2 tracker row flipped
`To Do` → `Done` in `docs/plans/IMPLEMENTATION.md` and `docs/ROADMAP.md` in
the same PR that shipped the envelope. GitHub's own closing-keyword
detection closed issue #539 on merge (the PR body's "closes #539" phrasing);
`pnpm sync:hub`'s dry run afterward reported 0 changes needed — fully
consistent. Its `status:todo` label is stale (GitHub's native close bypassed
hub-sync's own label-reconciliation step, which only fires when hub-sync
itself performs the close) — a known, documented gap in `bin/lib/hub-sync.mjs`
(the closed-and-resolved issue is deliberately left alone to preserve the
tool's idempotency guarantee), not something corrected here.
