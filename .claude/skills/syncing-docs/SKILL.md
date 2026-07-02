---
name: syncing-docs
description: Reconciles all doc metadata in the m3l-automation monorepo after a submodule ships or before a release. Re-stamps provenance sidecars to the current git HEAD, verifies doc counts and the implemented "N of 22" count match the filesystem, confirms every public export is documented, regenerates the reference index, and runs markdown lint — the single doc-reconciliation authority, all in one repeatable pass. Use this skill whenever the user says /syncing-docs, "sync docs", "reconcile docs", "update doc provenance", "stamp provenance", "sync doc metadata", or after the implementing-submodules pipeline finishes and the hub needs to reconcile doc state.
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

Updates every sidecar's `commit` to `git HEAD` and `retrieved` to today's
date. Only run after step 1 passed (even with staleness warnings).

### 3 — Verify doc counts and documented exports

```bash
node bin/check-doc-counts.mjs
```

Derives the canonical count from `docs/reference/core/*.md` and
`docs/reference/aws/*.md` and asserts the prose in docs/README.md`and`README.md` (root badge + prose) using the correct numbers.

If it fails, the output names the mismatched file and the value that needs
updating. Tell the user the exact edit required.

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

Also count the total number of ✅ rows across the Core and AWS tables, then
scan these five files for the "X of 22" or "X of Y" implemented-count prose
and confirm the number matches:

- `README.md` — badge URL `modules-N%2F22` and the prose callout ("N of 22
  submodules are implemented")
- `packages/m3l-common/README.md` — badge URL `modules-N%2F22` and the prose
  callout (this is the npm-facing README; it has its own badge and callout
  that must stay in sync with the root README)
- `docs/README.md` — the development-status callout line
- `docs/index.html` — the GitHub Pages landing page; check four things:
  1. The status row `<span class="value orange">N / 22 implemented</span>` —
     N must equal the ✅ count.
  2. Each implemented submodule must carry `class="done"` (rendered as `●`)
     in the module tree; every not-yet-implemented submodule must carry
     `class="not-started"` (rendered as `○`).
  3. The `<span class="value done">` text must list the names of all
     implemented modules, comma-separated (e.g. `errors, events`).
  4. The `aria-label="22 submodules"` total on the module-tree `<div>` is
     structural (the fixed total, not the implemented count) and must remain
     22 unless new submodules are added to the design.

If any value is stale, list the file, the current value, and the required
update. Do not edit unless the user asks.

```bash
pnpm check:impl-counts
```

The deterministic gate behind the manual scan above: it asserts the implemented
"N of 22" numerator matches across every badge / prose / HTML site. Run it once
`docs/implementation-status.md` reflects the true ✅ count. If it fails, the
output names the site and value that drifted.

### 6 — Test count check

```bash
pnpm check:test-counts
```

Runs Vitest with the JSON reporter and compares the per-file test counts
against the "N tests" values recorded in the Notes column of
`docs/implementation-status.md` (✅ rows only).

If it fails, the output names the submodule, the recorded count, and the
actual count. Tell the user the exact edit required in the Notes column.

### 7 — Regenerate the reference index

```bash
pnpm gen:index && pnpm check:index
```

`gen:index` rewrites `docs/reference/catalog.json` from the barrels; `check:index`
verifies it is current. This step is easy to omit and CI's `check:index` will
fail if it drifts, so treat it as mandatory whenever symbols changed.

Run it **before** any `pnpm format`/prettier pass: `gen:index` emits
non-prettier-formatted JSON, so if `format` runs first, `format:check` then fails
on the regenerated `catalog.json`. Whichever runs last wins, and the generator
must win — regenerate here, format after.

### 8 — Markdown lint

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
- Doc counts:            ✓ (Core=N, AWS=M, total=N+M) / ✗
- Documented exports:    ✓ / ✗ (check:doc-exports)
- Provenance (post):     ✓ / ✗
- Implementation status: up to date / <list rows needing attention>
- Implemented count:     ✓ (N of 22) / ✗ (check:impl-counts)
- Test counts:           ✓ (N submodules verified) / ✗
- Reference index:       ✓ (gen:index + check:index) / ✗
- Markdown lint:         ✓ / ✗
```

Replace ✓ with ✗ and include the tool's error output for any failed step.
