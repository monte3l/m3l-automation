# Work log — typescript-refresh-first-sweep (2026-09-08)

This log covers the first real `refreshing-typescript-guidance` sweep: the
tracker (`docs/research/typescript/refresh.md`) was seeded from PR #1129
with every facet claim `UNVERIFIED`, and this session ran the skill end to
end — five-facet fan-out, hub re-verification, a plan-mode remediation plan,
implementation, review, and merge. It records what shipped, the two
divergences (a host-memory OOM recurrence and a review-round-budget mistake
that triggered a documented override), and durable lessons from both.

Plan of record: [`docs/plans/archive/2026-09-08-typescript-refresh-first-sweep.md`](../plans/archive/2026-09-08-typescript-refresh-first-sweep.md)

## Summary

Merged as [PR #1132](https://github.com/monte3l/m3l-automation/pull/1132)
(squash commit `615d151a`), 7 commits, 35 files changed (1003
insertions/159 deletions):

- **`docs/research/typescript/refresh.md`** rewritten from seed to a real
  sweep — every facet claim resolved from `UNVERIFIED` to a real verdict.
  Headline finding: staying on `typescript@6.0.3` closed as a deliberate,
  evidenced hold (typescript-eslint's `>=4.8.4 <6.1.0` range excludes TS 7;
  TS 7 has no stable compiler API until 7.1), not unresolved drift. The
  `isolatedDeclarations`/`satisfies` restriction confirmed unrelaxed in any
  6.x/7.x release. `tsconfig.base.json` confirmed clean against every TS 7.0
  breaking change.
- **`bin/check-exports.mjs`** (new): replaced `attw --pack` (documented
  npm-only) with `pnpm pack` + direct tarball `attw` invocation —
  `package.json`'s `check:exports` now points at it. Refactored into pure,
  exported `formatRunFailure`/`findTarball`/`computeExitCode` plus
  `bin/tests/check-exports.test.ts` (14 cases, mutation-tested).
- **`erasableSyntaxOnly: true`** added to all 17 `scripts/*/tsconfig.build.json`
  and `templates/script/tsconfig.build.json.tmpl`, after a precise grep of
  all 208 files across every `scripts/*/src` found zero occurrences of the
  five constructs the flag rejects. Documented as scripts/*-only via inline
  `"//"` comments on the four `packages/*/tsconfig.build.json` files
  (`m3l-common`/`m3l-console-server` both use constructor parameter
  properties the flag would reject).
- Three transcription-error fixes in
  `typescript-configuration/references/typescript-configuration.md` (wrong
  `target` value, a missing strict-family member, a TS 7 `alwaysStrict`
  caveat) and a scope-undercount fix in
  `refreshing-typescript-guidance/SKILL.md` ("four `tsconfig.build.json`
  files" → all 21).
- `knip.json`'s `ignoreDependencies` gained `@arethetypeswrong/cli`/`publint`
  (now invoked from a subprocess, invisible to knip's static scan).
- `docs/plans/archive/2026-09-08-typescript-refresh-first-sweep.md` +
  `docs/plans/README.md` row (the plan-mode remediation plan, archived per
  its `.claude/skills/**` edits clearing the archival bar).

Gates: `pnpm verify` fully green (71 steps passed, 10 correctly skipped as
push-only/CI-only) on the final push. All required PR checks green
(`verify`, `Test`, `Build & typecheck`, `Lint`, `CodeQL`, `Governance gates`,
`review`). `docs-consistency-reviewer` pre-push review: clean, no findings.

Skills used: `refreshing-typescript-guidance`, `starting-work`,
`syncing-docs`, `creating-prs`, `finishing-work`, `writing-work-logs`.

Spoke incidents: none hook-detected (no `tmp/session-incidents.jsonl`); 2
self-observed incomplete "final" reports from `test-author` dispatches (both
stopped mid-turn waiting on their own background monitor rather than
reporting completed results) — resolved by independent on-disk verification
in both cases, no `SendMessage` resume needed.

Compaction events: none.

## What went as planned

- **The five-facet fan-out returned clean, well-sourced findings on the
  first dispatch** — no re-dispatch needed for any of the five facets, and
  every `REPO-IMPACT` a spoke reported turned out correct once the hub
  independently re-verified it against the cited file.
- **The `erasableSyntaxOnly` scope-mismatch investigation (the plan's §7)
  produced a clean, actionable yes/no** — a precise 208-file grep across
  every `scripts/*/src` found zero occurrences of any of the five rejected
  constructs, so adoption was unambiguous rather than a judgment call.
- **The lint-preset measurement (the plan's §6) surfaced genuinely
  surprising data** — the rules that actually dominated
  (`no-meaningless-void-operator`, `no-empty-function`,
  `non-nullable-type-assertion-style`) were not the ones the facet spoke had
  predicted (`no-deprecated`), which is exactly why the plan called for
  measuring instead of estimating.
- **The `pnpm pack` + `attw <tarball>` fix for `check:exports` was verified
  end-to-end in both directions before committing** — passes clean against
  the real package, and fails (exit 1) against a deliberately broken
  `exports["."].types`, confirming the gate can still catch a real
  regression rather than just confirming it doesn't crash.
- **The mutation test on `computeExitCode` had teeth on the first try** — a
  deliberate always-return-0 mutation correctly failed 4 of 14 tests,
  confirming the test suite actually guards the exit-code logic rather than
  just exercising it.
- **The worktree-ownership-loss fallback in `finishing-work` fired exactly
  as documented** — `ExitWorktree({action: "remove"})` refused with "not the
  owner" after the long session, and the documented remedy
  (`ExitWorktree({action: "keep"})` → `git checkout main && git pull` →
  `pnpm worktree:remove`) worked without incident.

## What didn't go as planned, and why

### 1. A pre-existing host-memory OOM recurred in both local `pnpm verify` and the `pre-push` hook

`pnpm lint:workspace` (full-workspace type-aware ESLint across 21 packages)
OOM'd twice — once during ad hoc measurement work, once inside `pnpm
verify`'s `lint` step, and a third time inside the `pre-push` git hook
itself on the very first push attempt (`error: failed to push some refs`
with no obvious cause until the lane summary was read, exactly as
`creating-prs`' own documented warning predicts).

**Why it happened:** this host is memory-constrained (23.4 GiB, no OOM
daemon, no `CLAUDE_CODE_TOOL_MEMORY_LIMIT` set — `pnpm check:host-resources`
flags all three) and Node's default V8 heap ceiling (~4 GB) is too small for
21-package type-aware linting in one process. This is a known, previously
logged issue (`docs/logs/2026-09-08-typescript-guidance-skills.md` records
the identical workaround for the identical symptom, four hours earlier in
the same day).

**Fix for future:** set `NODE_OPTIONS="--max-old-space-size=8192"` (or
similar) before any `pnpm verify`/`pnpm lint:workspace`/`git push` on this
host — this session did so, but only after independently rediscovering the
issue rather than checking for a prior recorded instance first. A
standing environment default (`.claude/settings.local.json`'s `env` block,
host-specific) would remove the need to rediscover this per-session.

### 2. The `erasableSyntaxOnly` fleet rollout initially skipped the scaffold template, caught by `claude-pr-review`

The plan's §7 correctly scoped adoption to the 17 existing
`scripts/*/tsconfig.build.json` files, but did not also update
`templates/script/tsconfig.build.json.tmpl` — so the next `pnpm
scaffold:script` would have silently regenerated a build config missing the
flag. `claude-pr-review` caught this as a Must-fix in round 1 (and it
recurred in round 2 since the fix-triggering push hadn't landed yet), citing
the exact precedent this pattern already has in the repo (`isolatedDeclarations`
missing from three scripts in #773) and the exact mechanism
(`tsconfigShapeErrors()` deriving expectations from the template, not an
allow-list) that made a one-line template fix sufficient. Fixing it
surfaced a second-order issue: `bin/tests/script-scaffold.test.ts` has its
own hand-written `EXPECTED_COMPILER_OPTIONS` fixture mirroring the template
verbatim rather than reading it from disk, so the template fix broke 6 of
its tests until that fixture was updated too.

**Why it happened:** `.claude/rules/scripts.md`'s own rule — "evolve
`templates/script/` + the manifest together" — was known and even quoted in
this session's own tracker findings, but wasn't checked against the actual
diff before considering the erasableSyntaxOnly work complete. The plan
named "17 `scripts/*/tsconfig.build.json` files" as the target set and
never explicitly listed the template as an eighteenth file to touch.

**Fix for future:** any change to `scripts/*/tsconfig.build.json` (or
`tsconfig.json`) shape must include `templates/script/*.tmpl` and
`bin/tests/script-scaffold.test.ts`'s fixture as a checklist item, not an
implicit consequence of "evolve template + fleet together" — the fixture in
particular is easy to miss since it's a third, indirectly-related file
`tsconfigShapeErrors()`'s own doc comment doesn't mention.

### 3. An unnecessary push to satisfy a non-required check burned the last review-round budget, triggering the documented round-limit override

After round 3's review converged to PASS, the non-required, dogfood-period
`should-fix-ack` check was still failing (it requires an explicit
`Acknowledged-Should-Fix:` commit footer even for a fully-fixed finding — "a
suppressed re-review can't prove a fix on its own," per ADR-0097). This
session pushed an `--allow-empty` acknowledgment commit to clear it,
without first checking whether `should-fix-ack` was itself a merge blocker.
It is not (`mergeStateStatus` was `UNSTABLE`, not `BLOCKED`, before that
push) — but the push retriggered the review workflow anyway, which had
already spent all 3 real rounds and auto-escalated per `MAX_REVIEW_ROUNDS`,
converting the PR from cleanly mergeable to `BLOCKED` on the _required_
`review` check. Recovery required the documented override procedure
(`docs/contributing/branch-protection.md` § Overriding a disputed
finding): investigate (confirmed the round-4 FAIL was the boilerplate
round-limit template, not a new finding), post evidence on the PR thread
citing round 3's real PASS verdict, then hand the actual merge-past-FAIL
decision to the user (never `--admin`). The user was mid-message with this
exact warning when the push had already gone out.

**Why it happened:** the fix-round mentality ("resolve every finding
before pushing again") was applied uniformly without checking which
findings actually block merge. `should-fix-ack`'s own staged-rollout design
(ADR-0097 — "runs and reports... non-required" during dogfood) exists
precisely so a team can choose not to spend a push on it yet, and this
session didn't consult `mergeStateStatus` before deciding to push.

**Fix for future:** before pushing solely to satisfy a check outside the
`Detect changed paths`/`review`/`verify`/`Governance gates`/`CodeQL`/`Test`/
`Build & typecheck`/`Lint`/`Format & Markdown`/`Dependency Review` set (i.e.
anything currently non-required, `should-fix-ack` included during its
dogfood period), check `gh pr view --json mergeStateStatus` first — if it's
already `MERGEABLE`/`UNSTABLE` rather than `BLOCKED`, the non-required check
failing is not costing anything, and every push (even an empty one) spends
one of the finite `MAX_REVIEW_ROUNDS` review attempts. _(promoted →
`.claude/skills/creating-prs/SKILL.md`)_

## Lessons learned

- **Check a prior day's own logs for an identical symptom before treating a
  recurrence as novel.** The host-memory OOM in item 1 was already logged,
  with the exact same fix, four hours earlier in the same day
  (`docs/logs/2026-09-08-typescript-guidance-skills.md`) — a quick
  `grep -rl "max-old-space-size" docs/logs/` before troubleshooting would
  have saved the rediscovery.
- **"Evolve template + fleet together" needs the fixture named explicitly,
  not implied.** A rule stated as a general principle (`.claude/rules/scripts.md`)
  didn't prevent this session from missing one of the three files a
  compiler-flag rollout touches, because the third file
  (`bin/tests/script-scaffold.test.ts`'s hand-written fixture) isn't the
  template or the fleet — it's a third thing that happens to also encode
  the same shape. _(promoted → `.claude/rules/scripts.md`)_
- **A non-required check failing is not automatically worth a push to
  fix.** `mergeStateStatus` (`BLOCKED` vs `MERGEABLE`/`UNSTABLE`) is the
  actual signal for whether a push is buying anything, and it's one API
  call away — cheaper than the round-limit escalation, evidence post, and
  human hand-off this session's skipped check cost. _(promoted →
  `.claude/skills/creating-prs/SKILL.md`)_
- **Measuring beats estimating for a "which preset/config would this
  affect" question.** The lint-preset measurement (plan §6) and the
  `erasableSyntaxOnly` grep (plan §7) both produced answers that
  contradicted what an educated guess would have predicted (different
  dominant rules; a clean grep where some hedging might have been
  reasonable) — worth defaulting to a real measurement over an estimate
  whenever the actual data is cheap to gather.
