# Plan: Register `script` with blocking prerequisites (no implementation yet)

## Context

The audit of submodule implementation status confirmed: 5 of 22 submodules are
implemented (`errors`, `events`, `security`, `environment`, `utils`); `script`
is **documented but not scaffolded** — it has a full 127-line spec at
`docs/reference/core/script.md` (11 symbols) and a tracker row, but no
`src/core/script/`, no tests, no barrel re-export, no provenance sidecar.

`script` is slated **last (Phase 7)** because its documented execution flow
_orchestrates_ config, logging, and AWS credentials. Of its four collaborators,
only `environment` is implemented; `config`, `logging`, and the `aws/*` modules
do not exist yet, so a faithful GREEN implementation is impossible today — it
cannot import three modules that aren't there.

**Decision (from clarifying questions):** Do **not** scaffold or implement
`script` now. Instead, **annotate its prerequisites as blocking hard
requirements that must be checked before implementation starts**, and operationalize
that check. **Make no changes to the count machinery** — `script` stays ❌, so
the implemented count remains `5 of 22` (nothing to bump); any future
reconciliation rides the existing `/sync-docs` reminder flow, never a hand-edit.

## Scope guardrails

- **No `src/`, no tests, no barrel edits.** `script` is not being built.
- **No count edits.** The `5 of 22` numerator is untouched; `check:doc-counts`
  only gates the denominator (22), which is unchanged because `script.md`
  already exists.
- **No edits to `bin/check-doc-counts.mjs` or `.claude/skills/sync-docs/`.**

## 1 — Declare `script`'s blocking prerequisites in the SSOT

**File:** `docs/implementation-status.md`

- Replace the terse `script` row note ("composes config/env/logging/aws —
  implement **last**") with an explicit, enumerated blocking-prerequisite list:
  `config`, `logging`, `aws/models`, `aws/credentials`, `aws/clients`
  (`environment` ✅ already satisfied). State plainly that `script`
  implementation is **blocked** until every listed prerequisite is ✅.
- Keep `script` status at ❌. Do **not** change the "5 of 22" prose anywhere.
- Optionally add a one-line legend/convention note near the status legend
  explaining that a "blocked-by" note means the `implement-submodule` preflight
  will hard-stop until prerequisites are ✅ (ties the doc to the gate in §2).

## 2 — Gate implementation start on prerequisites

**File:** `.claude/skills/implement-submodule/SKILL.md` (the "Resolve the
target" preflight step)

- Add a hard-stop to the preflight: after confirming the spec page exists, read
  the target's row in `docs/implementation-status.md`; if it declares
  blocking prerequisites, verify each prerequisite submodule shows ✅. If any is
  unmet, **stop before authoring RED tests** and report exactly which
  prerequisites are missing.
- Name `script`'s five prerequisites explicitly as the worked example so the
  rule is unambiguous: invoking `implement-submodule` for `script` today must
  hard-stop listing `config`, `logging`, `aws/models`, `aws/credentials`,
  `aws/clients` as unmet.
- This is the skill's existing dependency-gate philosophy (already used for
  runtime-dep approval) extended to _submodule_ prerequisites — keep it
  lightweight prose in the playbook, reading the human SSOT table; do not build
  a separate machine-readable manifest.

## 3 — Count handling: explicitly no change

- Confirm in the plan record that **no count tooling changes** are made.
- `script` remains ❌ → implemented count stays `5 of 22` → nothing to bump.
- Document the expectation (no code): when `script` eventually ships, reconcile
  the numerator via `/sync-docs` step 5's reminder flow, not by hand-editing the
  four prose locations.

## Optional cleanup (low priority, mention only)

- `packages/m3l-common/src/core/index.ts` header comment lists all 19 Core
  submodules and says they "are re-exported here as they are implemented," which
  reads ambiguously since only 5 are actually re-exported. Tightening this
  wording is unrelated to `script` and can be deferred; note it but do not block
  on it.

## Verification

1. `pnpm check:doc-counts` — still passes (denominator 22 unchanged; `5 of 22`
   prose untouched).
2. `pnpm lint:md` — passes on the edited `docs/implementation-status.md`.
3. `pnpm check:doc-sync` and `pnpm check:scaffold` — unaffected (no `src`, no
   script, no barrel changes).
4. Mental dry-run of the updated `implement-submodule` preflight: targeting
   `script` hard-stops and lists `config`, `logging`, `aws/models`,
   `aws/credentials`, `aws/clients` as unmet prerequisites.
5. Provenance gates unaffected (no new sidecar — `script` is not implemented).
6. After editing `docs/implementation-status.md`, the `remind-sync-docs` Stop
   hook will fire; run `/sync-docs` to re-stamp/verify — counts will not change.

## Commit

- Single `docs:` (and `chore:` for the skill prose) commit; **no semver event**
  (no `src/` or `exports` change). Conventional Commit, e.g.
  `docs: declare script submodule blocking prerequisites and gate its build`.
