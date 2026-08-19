# Namespace `sync:hub`'s `impl:` issue keys by section (issue #480 / F13)

**Status: shipped** — commit range on `fix/hub-sync-key-namespace`.

## Context

An item key is written into its GitHub issue body as
`<!-- m3l-hub-sync:<key> -->` and is the only thing `planIssueSync`
(`bin/lib/hub-sync.mjs`) matches an issue on, so the key namespace is the join
key for the entire hub. `docs/ROADMAP.md`'s keys were already namespaced by
section; `docs/plans/IMPLEMENTATION.md`'s were flat, while an item label is only
unique _within_ its own table. The ADR-0035 rollout and codified-procedure wave
tables both restart at A1, so A1/A2/A3/A5/A6 each denoted two different items.

**F13's premise needed one correction.** It recorded issues #469 and #377 as
both carrying `impl:a2`, with `addItem` silently merging them. Running
`actionableItems` against the real trackers showed zero exact duplicate keys:
issue #377 carried `impl:A2` and #469 carried `impl:a2`, and marker matching is
case-sensitive.
The five pairs were separated purely by accident: the rollout table was the one
table not passing its label through `slug()`. Nothing was merged or orphaned.
The hazard was real but latent, and would have fired all five at once the moment
anyone made key derivation consistent.

## Approach / Decisions

Per the user's choices during `/starting-work`:

1. **Namespace all seven `IMPLEMENTATION.md` sections**, not just the two that
   collided, and route every key through `slug()`. A gate alone was rejected: it
   would force item labels to be globally unique across every table, fighting
   the repo's own practice of restarting labels per wave — the practice that
   produced this collision in the first place.
2. **Self-healing legacy aliases** rather than a one-time migration script.
   `Item.legacyKeys` plus one shared `indexItemsByKey` used by all three marker
   consumers, so a stale marker resolves to its item and the next `--apply`
   rewrites it. No script to forget, and no window in which `planIssueSync`
   could close a real issue as "removed from source trackers".
3. **Warn + a new hard gate** (`pnpm check:hub-keys`), following this repo's
   own 2026-08-15 finding that a warning in a dry-run log is the channel that
   let issue #204 sit wrong for weeks.
4. **Retire the six standing Priority warnings** by completing the vocabulary
   and correcting the one genuine typo at source, then gating Priority the same
   way Status already is.

## Outcome

`IMPLEMENTATION_NAMESPACES` added beside `IMPLEMENTATION_ANCHORS` and keyed
identically; the tracker-path/anchor/namespace constants moved above
`MAJOR_BUMP_ITEM_KEYS`, which now derives both its entries through that map
(a `const` cannot be read from its own temporal dead zone). `indexItemsByKey`
exported and adopted by `planIssueSync`, `planBackfill`, and
`bin/sync-hub-projects.mjs`. `planIssueSync`'s closed-and-resolved branch gained
exactly one exception — a stale marker plans an `update` instead of `untouched`
— because 97 of the 108 `impl:` issues are closed and the aliases could
otherwise never retire; it is idempotent by construction. Plan entries for a
matched item now report the item's current key rather than the marker's.

`bin/check-hub-keys.mjs` added (exact duplicates, case-variant keys, and legacy
aliases shadowing another item's key), wired into `package.json`,
`bin/lib/command-catalog.mjs`, `bin/lib/verify-steps.mjs`, and `ci.yml`.
`actionableItems` now returns `duplicateKeys` structurally so the gate need not
parse warning prose.

On the Priority half: `mapFrictionPriority` moved to `project-hub.mjs` as
`classifyPriorityCell` (the gate needs the same vocabulary, and importing back
the other way would cycle), the untiered dash placeholder is now recognized, F12
moved from `P3` to `P2`, and `check:tracker-status` gates Priority cells too —
`findOffVocabularyPriorityCells` added beside `findOffVocabularyStatusCells`,
both expressed over one extracted walker. Warnings on a live `sync:hub` run went
from 6 to 0 with the item count unchanged at 139.

No `src/`, `exports`-map, or public-API change; zero semver impact — `bin/`
tooling and docs only. ADR-0032 gained a 2026-08-19 Update;
`docs/plans/IMPLEMENTATION.md:42` flipped F13 to Done.

## Operational follow-up

The next `pnpm sync:hub -- --apply` rewrites 108 issue bodies' marker lines.
It is mechanical, but it must follow the merge promptly: `check:hub-drift` fails
on a non-empty plan on pushes to `main`, and `--apply` needs a PAT so it cannot
run in CI.
