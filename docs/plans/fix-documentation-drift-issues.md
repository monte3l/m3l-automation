# Plan: Doc consistency fixes + structured provenance metadata

## Context

Branch `chore/documentation-provenance-metadata`. Repeated changes to the
codebase have left the prose docs drifted from reality, and there is **no
machine-readable provenance** linking documented claims back to source. Three
read-only Explore audits + direct verification confirmed two workstreams:

1. **Accumulated doc drift** — counts, version floor, and implementation status
   are stale and contradict each other across `CLAUDE.md`, `docs/README.md`, and
   the namespace barrels.
2. **No provenance layer** — the only structured metadata in the repo today is
   `packages/m3l-common/api-exports.json` (guarded by
   `bin/check-exports-snapshot.mjs`). Reference pages cite source only loosely
   in backticked prose, with no dates, no symbols, no drift detection.

**Decisions (confirmed with user):** sidecar JSON storage; anchor claims by
**symbol + line range + commit SHA + retrieval date** (SHA makes line numbers
verifiable and staleness detectable); scope = **fix drift now + pilot provenance
on `errors` and `events`** (the only two implemented submodules) and wire the
step into the `implement-submodule` pipeline so future modules add it as they
ship.

**Outcome:** accurate docs, plus a reusable, validated provenance mechanism that
catches future doc-vs-source drift instead of letting it accumulate.

---

## Phase 1 — Fix the doc inconsistencies (`docs:` change)

Edit only **mutable, consumer-facing** docs. Treat ADRs, `docs/plans/**`, and
`docs/logs/**` as **immutable point-in-time records** (per the project's ADR
convention and the [[feedback-plans-are-immutable]] rule) — do **not** rewrite
their counts; the canonical live count lives in `docs/implementation-status.md`.

| File / line                                    | Fix                                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md:17`                                 | `Node.js 22 LTS floor` → `Node.js 24 LTS floor` (matches ADR-0003, `package.json` engines, `.node-version`)                                        |
| `CLAUDE.md:151`                                | `18 submodules surfaced here` → `19 submodules` (19 files exist in `docs/reference/core/`)                                                         |
| `CLAUDE.md:498`                                | `documented scaffold — 0 of 21 submodules are implemented` → `2 of 22 implemented (errors, events); see docs/implementation-status.md`             |
| `docs/README.md:5`                             | `all 21 submodules are documented but none are implemented yet` → `22 submodules documented; errors + events implemented (2 of 22)`                |
| `docs/implementation-status.md:5-6`            | Update the "documented-but-empty scaffold … every submodule is unimplemented" intro to reflect errors + events done (the table is already correct) |
| `packages/m3l-common/src/aws/index.ts:5`       | `authentication (credentials)` → `credentials` (comment-only; public name is `credentials`)                                                        |
| `docs/plans/core-events-coverage-log-pr.md.md` | Rename → `core-events-coverage-log-pr.md` (untracked; safe — fixes the double `.md.md`)                                                            |
| `docs/README.md` (TOC)                         | Add the orphaned `docs/m3l-common-implementation.md` to the index                                                                                  |

**Canonical count rule:** going forward, `docs/implementation-status.md` is the
single source of the submodule count (19 Core + 3 AWS = 22). Other prose should
link to it rather than restate a number.

> Note on immutable docs: ADR-0011 (lines 28, 69) and `docs/m3l-common-implementation.md`
> (a plan-shaped doc) also say "21". Leave them as historical text — do not edit.
> If desired later, supersede via a new ADR rather than editing in place.

## Phase 2 — Provenance schema + validation tool

**Schema** — `docs/reference/provenance.schema.json` (JSON Schema, referenced via
`$schema` in each sidecar). Sidecar shape (one per reference page, named
`<doc>.provenance.json` next to the `.md`):

```jsonc
{
  "$schema": "../provenance.schema.json",
  "doc": "core/errors.md",
  "sections": [
    {
      "heading": "M3LError", // must match an actual ## / ### in the .md
      "sources": [
        {
          "file": "packages/m3l-common/src/core/errors/M3LError.ts",
          "symbol": "M3LError", // exported name, verifiable in the file
          "lines": "12-48",
        },
      ],
      "commit": "cf05fc9", // git SHA at retrieval — makes lines verifiable
      "retrieved": "2026-06-29",
    },
  ],
}
```

**Validator** — `bin/check-doc-provenance.mjs`, modeled on the existing
`bin/check-exports-snapshot.mjs` (same deterministic-JSON + `--update` style):

- **Default (verify):** for every sidecar — validate shape against the schema;
  assert each `heading` exists in the sibling `.md`; assert each `source.file`
  exists on disk and contains an `export` of `source.symbol`. **Fail** on any of
  these (schema / missing file / missing symbol).
- **Drift detection (warn):** if `git diff --quiet <commit> -- <file>` shows the
  source changed since the recorded `commit`, emit a "stale — re-verify" warning
  naming the section. This is the mechanism that surfaces future drift.
- **`--update`:** re-stamp `commit` (current `HEAD`) and `retrieved` (today) for
  sections whose source is unchanged; used after a deliberate re-verification.

Add `"check:provenance": "node bin/check-doc-provenance.mjs"` to root
`package.json` scripts. No `lint:md` change needed (sidecars are `.json`, not
linted by rumdl); sidecars must be `prettier`-clean since `format` covers `.json`.

## Phase 3 — Pilot sidecars (errors + events)

Author and stamp two sidecars against the **real** source that exists:

- `docs/reference/core/errors.provenance.json` — map the `### M3LError` (line 22)
  and `### M3LResult<T, E>` (line 33) sections, plus the Public API list, to
  `src/core/errors/M3LError.ts`, `M3LResult.ts`, and `M3LErrorUtils.ts`.
- `docs/reference/core/events.provenance.json` — map `### M3LEventEmitterBase`
  (line 19) to `src/core/events/M3LEventEmitterBase.ts`.

Run `node bin/check-doc-provenance.mjs --update` to stamp `commit`/`retrieved`,
then verify clean.

## Phase 4 — Wire into the pipeline + CI

- **`.claude/skills/implement-submodule/SKILL.md`:** add a checklist item and a
  step after Phase 4 (✅) / inside step 7 — "generate/update the module's
  `<doc>.provenance.json` and run `pnpm check:provenance`." The hub already owns
  the `docs/implementation-status.md` bookkeeping write; the sidecar is the
  machine-readable, source-mapped sibling to that and the work log.
- **`.github/workflows/ci.yml`:** add a `check:provenance` step alongside
  `check:api` / `lint:md` so drift fails CI.
- **Optional:** extend `.claude/hooks/guard-protected-paths.mjs` to flag manual
  edits of `*.provenance.json` (steer authors to `--update`). Defer unless wanted.

## Phase 5 — Drift-prevention automations

Root cause of the drift: facts are **hand-restated in prose** (counts in
`CLAUDE.md`/`docs/README.md`, status in two places, version floor in three).
Philosophy: _derive or verify, don't restate._ These mirror the precedent the
repo already trusts — snapshot-diff in CI (`check-exports-snapshot.mjs`) +
advisory hook in the edit loop (`guard-exports-semver.mjs`) + read-only spoke.

### CI / bin (strongest, binds everyone)

- **`bin/check-doc-counts.mjs`** + `"check:doc-counts"` script: **derive** the
  canonical count from `docs/reference/{core,aws}/*.md` and assert the prose
  numbers in `CLAUDE.md`, `docs/README.md`, and `docs/implementation-status.md`
  match; fail on mismatch. Makes "18 vs 19" / "21 vs 22" impossible to merge —
  same guarantee `check-exports-snapshot.mjs` gives the exports map.
- **CI steps:** add both `check:doc-counts` and `check:provenance` to `ci.yml`
  next to `check:api` / `lint:md`.

### Hooks (advisory, in the edit loop — `.claude/hooks/` + `.claude/settings.json`)

- **`guard-doc-counts.mjs`** — PostToolUse on Write/Edit of `docs/reference/**`:
  when a reference page is added/removed, warn if the derived count no longer
  matches the prose counts. Non-blocking nudge (like `guard-exports-semver.mjs`);
  shares the count-derivation logic with `bin/check-doc-counts.mjs`.
- **`guard-provenance-staleness.mjs`** — PostToolUse on Write/Edit of
  `packages/m3l-common/src/**`: run `node bin/check-doc-provenance.mjs --affected
<file>` and surface a "re-verify the sidecar" reminder in the same edit loop,
  so the writer catches staleness (analogue of `post-edit-verify.mjs`).

### Subagent — `.claude/agents/docs-consistency-reviewer.md` (read-only)

Generalizes the cross-cutting audit the Explore agents just ran by hand
(version-floor consistency, submodule counts, implemented-vs-documented status
table vs actual barrel exports, orphaned/duplicate doc files). Complements the
existing per-submodule `spec-conformance-reviewer`. Hub dispatches it before any
`docs:` PR; also runnable headless in CI. Tools: Read, Grep, Glob, Bash.

### Skill — `.claude/skills/sync-docs/SKILL.md` (user + Claude invocable)

One repeatable `/sync-docs` action that reconciles after a submodule ships or
before a release: `check:doc-provenance --update` (re-stamp sidecars),
reconcile `implementation-status.md`, and rerun `check:doc-counts` +
`check:provenance`. This is the home for the Phase 4 pipeline step.

> MCP servers: none needed — all checks are local-repo verification; library-docs
> lookup is already covered by the `ctx7` CLI.

---

## Critical files

- Reuse precedent: `bin/check-exports-snapshot.mjs`, `packages/m3l-common/api-exports.json`,
  `.claude/hooks/guard-exports-semver.mjs`, `.claude/hooks/post-edit-verify.mjs`
- New (provenance): `bin/check-doc-provenance.mjs`, `docs/reference/provenance.schema.json`,
  `docs/reference/core/errors.provenance.json`, `docs/reference/core/events.provenance.json`
- New (automations): `bin/check-doc-counts.mjs`, `.claude/hooks/guard-doc-counts.mjs`,
  `.claude/hooks/guard-provenance-staleness.mjs`, `.claude/agents/docs-consistency-reviewer.md`,
  `.claude/skills/sync-docs/SKILL.md`
- Edited prose: `CLAUDE.md`, `docs/README.md`, `docs/implementation-status.md`,
  `packages/m3l-common/src/aws/index.ts`
- Pipeline/CI/config: `.claude/skills/implement-submodule/SKILL.md`,
  `.github/workflows/ci.yml`, `.claude/settings.json`, root `package.json`

## Verification

1. `node bin/check-doc-provenance.mjs` → passes for both pilot sidecars.
2. Tamper test: bump a line range or rename a symbol in a sidecar → validator
   **fails** with the right message; revert.
3. Drift test: set a sidecar `commit` to an older SHA where the source differs →
   validator emits the "stale — re-verify" **warning**; `--update` clears it.
4. `pnpm format:check` (sidecars + schema are prettier-clean) and `pnpm lint:md`
   (no `.md` regressions) pass.
5. `pnpm build && pnpm test && pnpm typecheck` unaffected (the `aws/index.ts`
   change is comment-only).
6. `node bin/check-doc-counts.mjs` passes; add a temp `docs/reference/core/x.md`
   → it **fails** naming the mismatch; remove it → passes again.
7. Hooks: edit `packages/m3l-common/src/core/errors/M3LError.ts` → the
   `guard-provenance-staleness` reminder fires for `errors.provenance.json`;
   add/remove a reference page → `guard-doc-counts` warns.
8. `docs-consistency-reviewer` subagent run reports a clean cross-doc state after
   Phase 1 fixes; `/sync-docs` runs end-to-end without manual steps.

## Commits (Conventional Commits, no semver impact)

- `docs: correct submodule counts, Node floor, and impl status across docs`
- `chore: add doc-provenance schema, validator, and errors/events sidecars`
- `chore: wire check:provenance into implement-submodule pipeline and CI`
- `chore: add doc-count guard, drift hooks, sync-docs skill, and consistency reviewer`
