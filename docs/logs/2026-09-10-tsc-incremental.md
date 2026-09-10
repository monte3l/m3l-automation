# Work log — tsc-incremental (2026-09-10)

This log covers P3.2 of the adaptive-host-budgeting wave: adding TypeScript's
`incremental`/`tsBuildInfoFile` caching to every "tooling" tsconfig (the
`composite: false, noEmit: true` projects a package's `typecheck` script and
`bin/tsconfig.json` actually compile) plus `bin/tsconfig.json` itself. It
records the three design decisions confirmed with the user, the live
measurements taken to validate the design, a scaffold-checker gap discovered
and fixed mid-task, and the resulting lessons.

Plan of record: [`docs/plans/2026-09-08-adaptive-host-budgeting.md`](../plans/2026-09-08-adaptive-host-budgeting.md)

## Summary

`tsconfig.base.json`'s `composite: true` gives build-oriented
(`tsconfig.build.json`) projects free incremental caching, but every tooling
project explicitly overrides `composite` to `false`, losing that inherited
behavior. Fixed by adding `"incremental": true` + `"tsBuildInfoFile"` to each
tooling tsconfig, with every `.tsbuildinfo` centralized under one shared root
(`node_modules/.cache/tsc/<name>.tsbuildinfo`), mirroring P3.1's
`node_modules/.cache/prettier` convention.

Three design decisions were confirmed with the user via `AskUserQuestion`
before implementing (all three "(Recommended)" options accepted):

1. Scope — all tooling tsconfigs get incremental caching, not a subset.
2. `.tsbuildinfo` location — centralized under `node_modules/.cache/tsc/`,
   not scattered per-project.
3. `turbo.json`'s `typecheck` task outputs — left untouched (turbo's own
   cache already tracks staleness independently of tsc's incremental state).

**Files changed** (29): `bin/tsconfig.json`, 5 package tsconfigs
(`m3l-cli`, `m3l-common`, `m3l-console-server`, `m3l-console-web` +
`tsconfig.e2e.json`), 17 `scripts/*/tsconfig.json`,
`templates/script/tsconfig.json.tmpl`, `bin/bench-gates.mjs`,
`bin/lib/script-scaffold.mjs`, `bin/check-script-scaffold.mjs`, and 2 test
files (`bin/tests/bench-gates.test.ts`, `bin/tests/script-scaffold.test.ts`).

**Live measurements**: ran real cold/warm `bench-gates` runs for both
`turbo:typecheck` and `tsc:bin` lanes to confirm the cache actually reduces
warm-run time, and deliberately broke a type under a warm cache to confirm
`tsc` still catches it (incremental caching does not mask real errors).

**Gates**: `pnpm verify` green. PR #1156 — `review: pass` and
`should-fix-ack: pass` on the first round, all 18 checks green.

Skills used: writing-work-logs, resolving-pr-comments (invoked, no findings
to act on — PASS on first round), finishing-work, starting-work.
Spoke incidents: none.
Compaction events: 1 compaction (context limit, mid-task) / 1 recovered via
handoff — the PreCompact/SessionStart handoff correctly preserved the branch,
open PR, and in-flight step; no state was lost.

## What went as planned

- **The three `AskUserQuestion` design decisions all resolved to their
  recommended option** — scope (all tooling tsconfigs), cache location
  (centralized under `node_modules/.cache/tsc/`), and turbo.json (left
  untouched) — with no back-and-forth needed.
- **Both `test-author` dispatches returned clean, fully mutation-verified
  results with zero follow-up fixes**: `bin/tests/bench-gates.test.ts`
  (60/60 tests, 4/4 targeted mutants killed) and
  `bin/tests/script-scaffold.test.ts` (126/126 tests, 6/6 mutants killed).
- **The bot review passed on the first round** — no Must-fix or Should-fix
  findings, so `resolving-pr-comments` had nothing to loop on.
- **`pnpm check:script-scaffold` passed live against all 17 scaffolded
  scripts** after the tsconfig changes, with no manual per-script fixup
  needed.

## What didn't go as planned, and why

### 1. `tsconfigShapeErrors` assumed the template had zero per-script variance

`bin/lib/script-scaffold.mjs`'s `expectedTsconfigShape` read the live
`templates/script/tsconfig.json.tmpl` file as the literal, universal
"expected" shape for every scaffolded script's tsconfig. That assumption held
only because the template had never before contained a per-script-varying
value. Adding `tsBuildInfoFile: ".../__SCRIPT_NAME__.tsbuildinfo"` broke it —
every real script's tsconfig would now legitimately differ from the raw
template by exactly the substituted name, which the checker would have
flagged as drift.

Discovered by tracing the existing `__SCRIPT_NAME__` scaffold-token mechanism
in `packages/m3l-cli/src/scaffold/manifest.ts` (already used for other
generated files) and recognizing the tsconfig template needed the same
substitution instead of a literal, non-varying cache path (which would have
broken the very first script scaffolded after this change, since two
different scripts writing to the same `.tsbuildinfo` file would corrupt each
other's incremental state).

**Why it happened:** the checker's "expected shape" function had an implicit
invariant — the template is byte-comparable, modulo JSON parsing, to any
conforming instance — that nothing enforced and that only held by accident
until this task introduced the first per-script-varying template value.

**Fix for future:** when a scaffold template gains its first token
substitution, treat the corresponding shape-checker as needing a matching
update, not just the generator. Search for the checker whenever a shared
template file changes, not only when the generator's `emitFile()` call site
changes.

## Lessons learned

- **A template's shape-checker can silently assume "no per-instance
  variance" until the first templated value breaks it.** Grep for a
  scaffold template's own consumers (both the generator and any
  conformance-checker reading the same file) before adding the first
  token substitution to a previously-static template.
- **`turbo --force` only bypasses turbo's own cache layer — it does not
  clear a package's underlying `tsc` incremental state.** A "forced" cold
  turbo run can still silently reuse a stale `.tsbuildinfo` file unless the
  shared cache directory is cleared separately. This is the same
  measurement-purity bug class P3.1's first bot-review round caught for the
  `format` lane; `bench-gates.mjs`'s `clearLaneCacheDir` now handles both
  lanes identically via the shared `cacheDir: "node_modules/.cache/tsc"`.
- **Live-verify a design before dispatching its tests.** Running real
  cold/warm `bench-gates` measurements and a deliberate warm-cache type
  break, both before `test-author` codified the behavior, caught nothing
  wrong — but confirmed the mechanism actually worked rather than trusting
  the design intent alone, consistent with the pattern P3.1 established.
