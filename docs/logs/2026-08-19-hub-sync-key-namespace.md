# Work log — sync:hub key namespace (F13) (2026-08-19)

This log covers issue #480 / F13 — namespacing `sync:hub`'s `impl:` item keys by
`docs/plans/IMPLEMENTATION.md` section — plus a second defect the user folded
into scope mid-session: the six standing "unrecognized Priority cell" warnings
every `sync:hub` run emitted. It ran through the hub-and-spoke model (hub writes
`bin/**`, `test-author` writes `bin/tests/**`), and records what shipped, what
matched the plan, what diverged, and the durable lessons.

Plan of record: [`docs/plans/archive/2026-08-19-hub-sync-key-namespace.md`](../plans/archive/2026-08-19-hub-sync-key-namespace.md)

## Summary

Three signed commits on `fix/hub-sync-key-namespace`:

- **Key namespacing.** `IMPLEMENTATION_NAMESPACES` added beside
  `IMPLEMENTATION_ANCHORS` (keyed identically); all seven `IMPLEMENTATION.md`
  key sites now emit `impl:<namespace>:<slug(label)>`, with the friction and
  ADR-0035 rollout tables brought onto `slug()`. `MAJOR_BUMP_ITEM_KEYS`
  re-derived through the same map. The tracker-path/anchor/namespace constants
  moved above it, since a `const` cannot be read from its own temporal dead zone.
- **Self-healing migration.** `Item.legacyKeys` plus one exported
  `indexItemsByKey`, adopted by `planIssueSync`, `planBackfill`, and
  `bin/sync-hub-projects.mjs`. `planIssueSync`'s closed-and-resolved branch
  gained exactly one exception: a stale marker plans an `update` instead of
  `untouched`.
- **New gate** `pnpm check:hub-keys` (`bin/check-hub-keys.mjs`) — exact
  duplicates, case-variant keys, legacy aliases shadowing another item's key —
  wired into `package.json`, `command-catalog.mjs`, `verify-steps.mjs`, `ci.yml`.
  `actionableItems` now also returns `duplicateKeys` structurally.
- **Priority vocabulary.** `mapFrictionPriority` moved to `project-hub.mjs` as
  `classifyPriorityCell`; the untiered dash placeholder is now recognized, an
  empty cell deliberately is not. F12's cell moved `P3` → `P2`.
  `check:tracker-status` extended to gate Priority, over one extracted
  `findOffVocabularyCells` walker shared with the Status finder.

Results: `pnpm verify` green — **39 steps passed, 3 skipped**. Tests **1050
passing / 38 files**, up from 1009 / 37 (+41). `sync:hub` warnings **6 → 0**
with the item count unchanged at 139. Live read-only dry runs confirmed the
migration: **0 creates, 107 marker rewrites, 0 "removed from source trackers"
closes**, and the board sync planned **0 adds**. F13 flipped to Done; F14 filed.

Skills used: starting-work, writing-commits, writing-work-logs.

Spoke incidents: 1 truncation / 0 stalls / 1 resume.

## What went as planned

- **The four `/starting-work` decisions held** — shared checkout,
  `fix/hub-sync-key-namespace`, PR required, `origin <branch>`. No mid-run
  surprise from `guard-branch-isolation.mjs`, because the branch existed before
  the first write.
- **The `check:tracker-status` precedent transferred cleanly.** Its structure
  (pure finder in `project-hub.mjs`, thin `main`-guarded CLI, four wiring sites)
  was a direct template for `check:hub-keys`; `check:command-catalog` and
  `check:verify-parity` both passed first try.
- **Every collision kind was proven to fail, not just assumed to.** The new gate
  was exercised against synthetic inputs for all three kinds, and the Priority
  gate was proven against a temporarily reverted F12 cell before the fix landed.
- **The narrow closed-and-resolved exception was idempotent on first design** —
  verified by feeding `buildIssuePayload`'s own output back through
  `planIssueSync`.

## What didn't go as planned, and why

### 1. The filed issue's "live evidence" was wrong, and the fix depended on it

F13 stated that issues #469 and #377 both carried `<!-- m3l-hub-sync:impl:a2 -->`
and that `addItem` was silently merging them. Running `actionableItems` against
the real trackers showed **zero** exact duplicate keys: issue #377 carries
`impl:A2` and #469 carries `impl:a2`, and marker matching is case-sensitive. Nothing was
merged or orphaned. The five pairs were separated purely by accident — the
rollout table was the one table not passing its label through `slug()`. The
hazard was real but latent, and would have fired all five at once the moment
anyone made key derivation consistent.

**Why it happened:** the issue was filed from reading the code paths, not from
running them. Two keys differing only in case look identical when transcribed
into prose.

**Fix for future:** before designing a fix for a filed tracker/issue item,
execute the code path against live data and confirm the reported symptom
reproduces. Here a five-line `node -e` over the real trackers settled it, and it
changed the framing of the whole change (latent hazard vs. active data loss) —
including how the ADR Update had to be written.

### 2. The `test-author` spoke truncated mid-turn

The spoke fixed the 14 key-expectation failures and added the `duplicateKeys`
assertions, then stopped mid-sentence with most of the new coverage unwritten
and an unused `indexItemsByKey` import left behind. Resumed via `SendMessage`
with an explicit list of the eight outstanding items; it completed the rest.

**Why it happened:** the brief was large — 14 test fixes plus eight new coverage
areas across three files, one of them a new file. This is the repo's
most-recurring build divergence (`docs/contributing/subagent-context-management.md`).

**Fix for future:** resuming with `SendMessage` worked and preserved the
spoke's context — that is the right recovery and it should stay the default over
re-dispatching. Restating the _remaining_ items explicitly (rather than
re-sending the original brief) is what made the resume cheap.

### 3. A spoke reported "typecheck clean" that was not

The spoke's final report claimed lint, Prettier, and typecheck all clean. Editor
diagnostics simultaneously showed real TS errors in the new
`bin/tests/check-hub-keys.test.ts`. Both were true: `pnpm typecheck` runs `tsc`
per package via turbo, and **no `tsconfig` includes `bin/tests`**, so nothing in
CI type-checks that tree.

**Why it happened:** the spoke ran the repo's own gate and reported its result
honestly; the gate simply does not cover the file it had just written.

**Fix for future:** treat editor diagnostics as authoritative for `bin/tests/**`
rather than `pnpm verify`. Filed as **F14** so the gap gets closed properly
rather than remembered. Promoted to `.claude/rules/tests.md`, which loads on any
`*.test.ts` edit.

### 4. Two of my own JSDoc types were wrong in ways no gate caught

Adding `duplicateKeys` to `actionableItems`' return value, I updated the
`@returns` prose but not its type expression, so every consumer typing that
property hit TS2339. Then `findKeyCollisions` declared
`@param {ReturnType<typeof actionableItems>}` while reading only four fields,
forcing test fixtures to invent `status`/`priority`/`sourcePath`/`sourceAnchor`/
`detail`/`warnings`. Both surfaced only because the spoke's test file exercised
them.

**Why it happened:** JSDoc types in `bin/**/*.mjs` are checked by nothing in CI,
so a stale or over-broad annotation is invisible until a `.ts` file consumes it.

**Fix for future:** when adding a property to a documented return shape, update
the type expression and the prose together; and type a helper's `@param` to the
fields it actually reads. Promoted to `.claude/rules/tests.md`.

### 5. A `verify` step failed once, then passed on re-run

The first full `pnpm verify` failed at `Check test counts`; the re-run passed all
39 steps. That step spawns its own Vitest over `packages/m3l-common/tests` — a
tree this branch does not touch — immediately after `test:coverage` has already
run the suite twice.

**Why it happened:** most likely resource contention from three back-to-back
full suite runs; the spawned Vitest exited non-zero without a reproducible
failure (running the identical command standalone exits 0 with 1.7 MB of
output, well under its 10 MB `maxBuffer`).

**Fix for future:** when a `verify` step fails in a tree the branch does not
touch, re-run before investigating — but say so explicitly rather than
reporting the first run as green. Not filed as friction on one observation; if
it recurs, `check:test-counts`'s spawned run is the place to look.

## Lessons learned

- **Reproduce the reported symptom before fixing it.** A filed item's "live
  evidence" is a claim, not a fact. Executing the real code path over real data
  took minutes here and changed the framing of the entire change — including
  whether the defect was active or latent, which is what the ADR had to record.

- **An accident is not a safeguard.** Five key collisions were prevented only by
  one table forgetting to call `slug()`. Anything preserved by an inconsistency
  is one cleanup commit away from breaking, so fix the structure rather than
  documenting the accident.

- **A derived join key is a data migration.** Changing how a key is computed
  invalidates every marker already written into an external system. Self-healing
  aliases beat a migration script: there is no step to forget, and no window in
  which the planner reads a stale marker as a vanished item and closes a real
  issue.

- **Check where the majority of the data actually lives.** 97 of 108 issues were
  closed, and the closed-and-resolved branch was the one path that never
  recomputed a payload — so the migration would have silently never completed.
  Counting the population first turned a nice-to-have into a load-bearing
  requirement.

- **A green gate is not the same as a checked file.**
  `pnpm typecheck` does not cover `bin/tests/**`, so a spoke can truthfully
  report "typecheck clean" over a file with real type errors. Know which gate
  covers which tree before trusting a pass.
  _(promoted → .claude/rules/tests.md; filed → IMPLEMENTATION.md F14)_

- **Type a helper's `@param` to what it reads.** An over-broad annotation copied
  from an upstream return type forces every caller and fixture to satisfy fields
  the function ignores; narrowing it costs nothing, since the real caller still
  matches structurally. _(promoted → .claude/rules/tests.md)_

- **Resume a truncated spoke with the remainder, not the original brief.**
  `SendMessage` preserves its context, so the cheapest resume states what is
  still outstanding plus any correction — not the whole task again.

- **Complete a vocabulary; don't alias a mistake.** The dash placeholder was this
  table's own documented convention (recognize it), while `P3` was a genuine
  authoring error (keep it loud). The opposite call was correct for `In review`
  in ADR-0032's 2026-08-15 Update — the deciding question is whose vocabulary the
  token belongs to, not how many cells are affected.
