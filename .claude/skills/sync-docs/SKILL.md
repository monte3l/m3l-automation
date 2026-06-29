---
name: sync-docs
description: Reconciles all doc metadata in the m3l-automation monorepo after a submodule ships or before a release. Re-stamps provenance sidecars to the current git HEAD, verifies doc counts match the filesystem, and runs markdown lint — all in one repeatable pass. Use this skill whenever the user says /sync-docs, "sync docs", "reconcile docs", "update doc provenance", "stamp provenance", "sync doc metadata", or after the implement-submodule pipeline finishes and the hub needs to reconcile doc state.
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

### 3 — Verify doc counts

```bash
node bin/check-doc-counts.mjs
```

Derives the canonical count from `docs/reference/core/*.md` and
`docs/reference/aws/*.md` and asserts the prose in `CLAUDE.md` and
`docs/README.md` uses the correct numbers.

If it fails, the output names the mismatched file and the value that needs
updating. Tell the user the exact edit required.

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

### 6 — Markdown lint

```bash
pnpm lint:md
```

Run from the repo root. Report any failures.

## Summary report

Output after all steps complete:

```
## /sync-docs summary

- Provenance pre-flight: ✓ / ✗
- Sidecars re-stamped:   <N sidecars updated to <short SHA>>
- Doc counts:            ✓ (Core=N, AWS=M, total=N+M) / ✗
- Provenance (post):     ✓ / ✗
- Implementation status: up to date / <list rows needing attention>
- Markdown lint:         ✓ / ✗
```

Replace ✓ with ✗ and include the tool's error output for any failed step.
