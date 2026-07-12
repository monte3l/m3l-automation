---
name: syncing-docs
description: Reconciles all doc metadata in the m3l-automation monorepo after a submodule or consumer script ships or before a release. Re-stamps provenance sidecars to the current git HEAD, regenerates every "N of 22" doc-count site and the implemented-list block via gen:counts and verifies them, confirms every public export is documented, verifies script scaffold/doc conformance (check:script-scaffold), regenerates the reference index (library catalog + consumer-scripts catalog), and runs markdown lint — the single doc-reconciliation authority, all in one repeatable pass. Use this skill whenever the user says /syncing-docs, "sync docs", "reconcile docs", "update doc provenance", "stamp provenance", "sync doc metadata", or after the implementing-submodules or implementing-scripts pipeline finishes and the hub needs to reconcile doc state.
---

Reconcile all documentation metadata for `@m3l-automation/m3l-common`. This
task touches **only** docs metadata (provenance sidecars, count checks, markdown
lint) — never source code, tests, or barrel exports.

## Steps

Run in order. **Fail fast**: stop at the first failing step, report the full
error output, and tell the user what to fix before re-running.

### 1 — Pre-flight: verify provenance sidecars

```bash
node bin/check-doc-provenance.mjs
```

Checks that every `*.provenance.json` sidecar in `docs/reference/` has valid
structure — headings exist in the sibling `.md`, source files exist, symbols
are exported. Staleness warnings (`⚠ stale — re-verify`) are fine here; they
will be cleared in step 2.

Stop if exit code is 1 (hard errors). Fix the sidecar content (wrong heading,
missing file, removed symbol) before proceeding.

### 2 — Re-stamp provenance to current HEAD

```bash
node bin/check-doc-provenance.mjs --update
```

Staleness is content-addressed (git blob SHA per source file), not
commit-addressed, so the bare `--update` is now safe to run repo-wide: it
stamps `blob` and bumps `retrieved` only for sections whose source content
actually changed, and skips writing any sidecar with nothing stale. A rebase
or an unrelated module's change never re-stamps sidecars it didn't touch.
Only run after step 1 passed (even with staleness warnings).

Scoping with `--affected <path/to/changed-source-file>` still works and is a
useful optimization when you already know which sidecars are in play (fewer
sidecars to re-verify), but it is no longer required for correctness.

### 3 — Regenerate and verify doc counts

```bash
pnpm gen:counts
```

Regenerates every "N of 22" badge/prose site (both the denominator — total
documented — and the numerator — implemented count) plus the generated
implemented-list block in `docs/implementation-status.md`, all from the
filesystem-derived counts. Idempotent — a clean tree produces no diff. Site
inventory lives in `bin/lib/count-sites.mjs`, shared with the two checkers
below so they can never disagree with the generator about what a site should
say.

```bash
node bin/check-doc-counts.mjs
```

Verifies the denominator: derives the canonical count from
`docs/reference/core/*.md` and `docs/reference/aws/*.md` and asserts the
prose in `docs/README.md`/`README.md` (root badge + prose) uses the correct
numbers. Should always pass immediately after `gen:counts`; a failure here
means a site isn't in `bin/lib/count-sites.mjs`'s inventory yet.

```bash
pnpm check:doc-exports
```

Fails if any public export (surfaced through a namespace barrel) is missing from
its `docs/reference` page. A newly shipped submodule that added exports must have
them all documented; this is the gate that catches an undocumented symbol before
it reaches CI. Report the exact undocumented symbols if it fails.

### 4 — Final provenance check (post-stamp)

```bash
node bin/check-doc-provenance.mjs
```

Confirm all sidecars are structurally clean and staleness-free after stamping.

### 5 — Implementation-status check

Read `docs/implementation-status.md`. If the current task context or user
description mentions a newly shipped submodule, verify its row in the table
already shows ✅ reviewed/done. If it still shows ❌, 🧪, or 🟢, surface a
reminder — but do not edit the file unless the user asks.

```bash
pnpm check:impl-counts
```

Verifies the numerator: asserts the implemented "N of 22" count matches
across every badge/prose site listed in `bin/lib/count-sites.mjs` (`README.md`,
`packages/m3l-common/README.md`, `docs/README.md`,
`docs/implementation-status.md`), **and** byte-verifies the generated
implemented-list block (the `<!-- BEGIN/END GENERATED IMPLEMENTED-LIST -->`
sentence near the top of `docs/implementation-status.md`) against a fresh
render — so a hand edit inside the markers is caught too. Should already pass
after step 3's `pnpm gen:counts`; if it doesn't, the Status column in
`docs/implementation-status.md` disagrees with what step 3 derived — fix the
✅ row, then re-run `gen:counts`.

### 6 — Test count check

```bash
pnpm check:test-counts
```

Runs Vitest with the JSON reporter and compares the per-file test counts
against the "N tests" values recorded in the Notes column of
`docs/implementation-status.md` (✅ rows only).

If it fails, the output names the submodule, the recorded count, and the
actual count. Tell the user the exact edit required in the Notes column.

### 7 — Consumer-script docs check

```bash
pnpm check:script-scaffold
```

Verifies every `scripts/<name>/` package against the ADR-0022 shape, including
its two documentation artifacts: the colocated `README.md` (how to run) and the
contract page `docs/reference/scripts/<name>.md` — plus the reverse direction
(no orphan contract page without a package). Passes vacuously when no scripts
exist. If a script's config schema changed, also eyeball that the contract
page's schema table still matches `src/config.ts` — that content sync is not
machine-checked.

### 8 — Regenerate the reference index

```bash
pnpm gen:index && pnpm check:index
```

`gen:index` rewrites `docs/reference/catalog.json` (and `symbol-map.json`) from
each module's **provenance sidecar** `sections[].sources[]` — **not** the source
barrel — **and** the consumer-scripts catalog block in
`docs/reference/README.md` from `docs/reference/scripts/` + `scripts/`;
`check:index` verifies both are current. This step is easy to omit and CI's
`check:index` will fail if it drifts, so treat it as mandatory whenever symbols
or scripts changed.

**A new export must be in the sidecar `sources[]`, not just the barrel.** Because
the index derives from the sidecars, a scoped restamp (step 2,
`--update --affected …`) refreshes `commit`/`retrieved` timestamps but never
**adds** the new symbol — you must hand-add it to `sources[]` (in every relevant
section) in the same change set. The tell that you forgot: `gen:index` produces
**no diff** right after you added a public export, and `check:index` passes
_vacuously_ (generated == committed, both missing the symbol) even though
`check:doc-exports` — which walks the barrel — is green. If a just-added export
yields a no-op `gen:index`, its sidecar `sources[]` is the missing link.

Run it **before** any `pnpm format`/prettier pass: `gen:index` emits
non-prettier-formatted JSON, so if `format` runs first, `format:check` then fails
on the regenerated `catalog.json`. Whichever runs last wins, and the generator
must win — regenerate here, format after.

**Not part of this pass:** `pnpm gen:commit-stats` (the AI co-authorship
badges) is deliberately **main-only** (ADR-0024) — running it on a feature
branch bakes that branch's own commits into the badge count, producing
README churn that conflicts with every other open branch on rebase. Run it
post-merge on `main`, or during release grooming; never as part of this
branch-time reconciliation.

### 9 — Markdown lint

```bash
pnpm lint:md
```

Run from the repo root. Report any failures.

## Summary report

Output after all steps complete:

```
## /syncing-docs summary

- Provenance pre-flight: ✓ / ✗
- Sidecars re-stamped:   <N sidecars updated to <short SHA>>
- Doc counts regen:      ✓ (gen:counts — N site(s) updated / already current)
- Doc counts:            ✓ (Core=N, AWS=M, total=N+M) / ✗
- Documented exports:    ✓ / ✗ (check:doc-exports)
- Provenance (post):     ✓ / ✗
- Implementation status: up to date / <list rows needing attention>
- Implemented count:     ✓ (N of 22) / ✗ (check:impl-counts)
- Test counts:           ✓ (N submodules verified) / ✗
- Script docs:           ✓ (N script(s) conformant / none) / ✗ (check:script-scaffold)
- Reference index:       ✓ (gen:index + check:index) / ✗
- Markdown lint:         ✓ / ✗

Commit-stats badges are main-only (not part of this pass) — see step 8's note.
```

Replace ✓ with ✗ and include the tool's error output for any failed step.
