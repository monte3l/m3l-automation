# Scaffolding Validation Audit — Value Assessment

## Context

The repo has 22 canonical submodules (19 Core + 3 AWS). Only 2 are implemented (errors, events);
20 are pending. As `implement-submodule` runs get scheduled, the manual discipline required to keep
barrel re-exports, test files, and docs consistent will compound. Three Explore agents audited
(1) the bin/ scripts + CI gates, (2) the submodule directory layout, and (3) the Claude Code
hooks layer to surface the real gaps.

---

## What the Existing Tooling Already Covers Well

| What                        | How                                          | Hard gate?     |
| --------------------------- | -------------------------------------------- | -------------- |
| ESM `.js` import extensions | `guard-js-extension.mjs` (PreToolUse)        | ✅ blocks edit |
| No CommonJS                 | `guard-no-commonjs.mjs` (PreToolUse)         | ✅ blocks edit |
| `dist/` + `version` field   | `guard-protected-paths.mjs` (PreToolUse)     | ✅ blocks edit |
| Exports-map contract        | `check-exports-snapshot.mjs` + advisory hook | CI gate        |
| Doc count prose sync        | `check-doc-counts.mjs` + advisory hook       | CI gate        |
| Provenance staleness        | `check-doc-provenance.mjs` + advisory hook   | CI gate        |
| Type / lint / test in-loop  | `post-edit-verify.mjs` (PostToolUse)         | advisory       |
| 80 % coverage               | `vitest run --coverage` in CI                | CI gate        |
| Unused exports / deps       | `knip` in CI                                 | CI gate        |
| ESM correctness / types     | `publint` + `attw`                           | CI gate        |

**Nothing above has a gap worth a new mechanism.** They are solid.

---

## The One Real Gap: Barrel Re-export Consistency

**Situation:** Every submodule folder (`src/core/<module>/`) that has an `index.ts` must be
re-exported from the namespace barrel (`src/core/index.ts` or `src/aws/index.ts`). Currently no
tool catches the case where a submodule is implemented but the barrel re-export line is missing or
wrong.

**Why this matters now:**

- `knip` catches unused exports — but only at pre-publish, not during the TDD loop.
- `publint` + `attw` validate the three-entry exports map, not the barrel re-exports inside it.
- A missing re-export breaks consumer access silently; the lib builds and all _existing_ tests
  pass; the gap only surfaces when a consumer tries to import the new symbol.
- The `submodule-implementer` spoke is the entity that adds the barrel line; there is no in-loop
  feedback confirming it landed correctly.

**All other gaps identified are lower priority:**

| Gap                                            | Why lower priority                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Scaffold shape on stubs (no src/)              | Expected state — stubs have nothing to validate                                                |
| Per-symbol test coverage                       | Covered by 80 % CI gate + spec-conformance-reviewer spoke                                      |
| Test file naming (`tests/*.test.ts`)           | Covered by vitest discovery + 80 % gate                                                        |
| Symbol naming conventions                      | Low defect rate; Claude PR review catches it                                                   |
| Provenance sidecar schema (not just staleness) | Only needed post-implementation; `check-doc-provenance.mjs` already validates headings+symbols |
| Dependency gate before `pnpm add`              | Out-of-scope for a script; requires interactive approval                                       |

---

## Verdict: Add Meaningful Value? Yes — Narrowly

A scaffolding validation mechanism is **worth adding**, but only for the barrel consistency check.
A full scaffold-completeness script (test file exists, provenance exists, symbol count matches
spec, etc.) would duplicate work already owned by the `implement-submodule` skill's spoke
pipeline. The barrel re-export check is the only structural invariant that has **no owner today**
and a **real failure mode** (silent consumer breakage).

---

## Recommended Mechanism

### `bin/check-scaffold.mjs` CI script

A standalone Node.js script (pattern matches `check-doc-counts.mjs`) that:

1. Reads every folder under `packages/m3l-common/src/core/` and `src/aws/` that contains an
   `index.ts` (i.e., "implemented submodules").
2. Parses the corresponding namespace barrel (`src/core/index.ts`, `src/aws/index.ts`) for
   `export * from "./<module>/index.js"` lines.
3. Reports any module folder present in src/ but absent from its barrel, and vice-versa (barrel
   re-exports a folder that does not exist).
4. Exits 1 on any mismatch.

Wire into `ci.yml` as a step after `pnpm build` (build proves the barrel compiles; this proves
it is complete). Add `pnpm check:scaffold` to `package.json` scripts. ~60–80 lines, no new deps.

---

## Files to Create / Modify

| File                       | Action | Notes                                                            |
| -------------------------- | ------ | ---------------------------------------------------------------- |
| `bin/check-scaffold.mjs`   | Create | ~70 lines; pattern: `check-doc-counts.mjs`                       |
| `package.json` (root)      | Edit   | Add `"check:scaffold": "node bin/check-scaffold.mjs"` to scripts |
| `.github/workflows/ci.yml` | Edit   | Add `pnpm check:scaffold` step after `pnpm build`                |
| `CLAUDE.md`                | Edit   | Add `check:scaffold` row to Commands table + mention in CI table |

---

## Verification

```bash
# Happy path: all barrel re-exports match src/ folders → exits 0
pnpm check:scaffold

# Failure path: temporarily remove a re-export from src/core/index.ts → exits 1 with clear message
# Then restore it.

# CI simulation
pnpm build && pnpm check:scaffold
```
