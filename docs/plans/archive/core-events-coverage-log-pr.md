# Plan: Harden the implement-submodule pipeline from core/events lessons

## Context

The `core/events` work log (`docs/logs/2026-06-29-core-events.md`) identified
two process failures that each cost an extra spoke round, and one knowledge gap
that caused a bad must-fix dispatch. This plan translates those lessons into
targeted edits to four agent/skill files so future submodules (19 remain) don't
repeat them.

**Current-state summary (from reading the files):**

| File                                          | Relevant gap                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/agents/submodule-implementer.md`     | Step 3 lists `pnpm lint` run-on with `-C packages/m3l-common typecheck`, creating scope ambiguity; no instruction to flag test-file violations to the hub |
| `.claude/agents/test-author.md`               | Step 7 uses per-file `pnpm exec eslint <file>` only; no workspace-root final check before handing back                                                    |
| `.claude/skills/implement-submodule/SKILL.md` | Step 7 (final verify) has no pre-commit `git log` check and no "strip process metadata" instruction                                                       |
| `.claude/agents/spec-conformance-reviewer.md` | Mode 2 has no caveat distinguishing `Record<string, unknown>` spec language from `object` TypeScript requirement for plain interfaces                     |

---

## Changes

### 1 — `submodule-implementer.md`: explicit lint scope + test-file flagging

**Root cause:** In core/events the spoke ran lint in a package-scoped context,
missing violations in `tests/` (outside its write scope). The current text
lists `pnpm lint` as part of a run-on phrase alongside `-C packages/m3l-common
typecheck`, which an LLM can silently interpret as the same scope.

**Edit step 3** (lines 29–37). Two additions:

- Separate `pnpm lint` from the `-C` commands with an explicit parenthetical:
  `pnpm lint` **(workspace root, no `-C` flag — this matches the hub's gate and
  covers `tests/` as well as `src/`)**.
- After the existing "Clear eslint findings yourself" sentence, add: **"If
  `pnpm lint` reports violations in `tests/` (outside your write scope), do not
  attempt to fix them — report them to the hub immediately so a `test-author`
  spoke can be dispatched before the gate."**

---

### 2 — `test-author.md`: add workspace-root final lint step

**Root cause:** `pnpm exec eslint <file>` is a per-file invocation that may not
resolve the full TypeScript project graph that type-aware rules
(`no-redundant-type-constituents`, `require-await`) need. The hub's gate uses
`pnpm lint` at workspace root; the test-author's verify step should match.

**Edit step 7** (line 47). Keep the per-file command for iteration but append a
mandatory final check:

> Run `pnpm exec eslint <your test file>` to iterate quickly. Before handing
> back, run **`pnpm lint` (workspace root, no `-C` flag)** and confirm the file
> is clean — this matches the hub gate exactly and surfaces type-aware findings
> that per-file eslint can miss.

---

### 3 — `implement-submodule/SKILL.md`: pre-commit style check + no process metadata

**Root cause:** The hub composed a dense prose commit body with process metadata
(review verdicts, test counts) because step 7 gives no guidance on body style or
what to exclude.

**Edit step 7** (after the existing `pnpm ... build && ...` gate line). Append
two sentences:

> When drafting the commit body, first run **`git log --format="%B" -3`** and
> match the bullet-point structure of the last 2–3 substantive commits. Strip all
> process metadata (review verdicts, test counts, coverage percentages) from the
> body — those belong in `docs/logs/`, not git history.

---

### 4 — `spec-conformance-reviewer.md`: generic constraint caveat

**Root cause:** The reviewer flagged `extends object` as a DRIFT against the
spec's `Record<string, unknown>`, which is correct as a spec-text comparison but
wrong as a must-fix: plain interfaces (`{ ping: string }`) don't satisfy
`Record<string, unknown>` in TypeScript's structural type system, so applying the
tighter constraint breaks real callers.

**Edit Mode 2** (after the four finding examples, before the closing sentence).
Add a new callout:

> **Constraint-tightening caveat:** When flagging a generic bound as drifted
> (e.g. code uses `extends object`, spec says `extends Record<string, unknown>`),
> verify whether the tighter constraint accepts a plain interface:
> `new Cls<{ x: number }>()` must still compile. Plain interfaces have no index
> signature and don't satisfy `Record<string, unknown>`. Tag these findings as
> **verify-before-fix** rather than must-fix, and note the TypeScript structural
> typing reason.

---

### Optional automation (not in scope for this PR, worth a follow-up)

A non-blocking advisory Bash hook (`.claude/hooks/guard-lint-scope.mjs`) that
intercepts commands matching `pnpm.*-C.*m3l-common.*lint` and emits a reminder
to also run workspace-root `pnpm lint` before handing off. Lower priority than
the prompt changes above since the prompt changes are the primary prevention.

---

## Verification

1. `pnpm lint` after edits — the four `.md` files should be clean (rumdl covers
   markdown lint in CI).
2. On the next submodule run (`core/security` is next in suggested order), the
   test-author handoff report should explicitly confirm "workspace-root `pnpm
lint` clean" and the implementer handoff should show the same, with a note if
   any test-file violations were found.
