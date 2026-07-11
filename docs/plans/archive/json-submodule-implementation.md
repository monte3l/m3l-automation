# Plan: Implement the `core/json` submodule

## Context

The audit confirmed the implementation tracker is accurate: **5 of 22**
submodules are implemented (`errors`, `events`, `security`, `environment`,
`utils`) and match the filesystem exactly. The `json` submodule is the next
foundational, dependency-free module in the documented build order — its spec
already exists in full at `docs/reference/core/json.md` (5 public symbols), so
this is a **spec-first greenfield implementation**, not a scaffolding task:
skip `new-subpath` and run the `implement-submodule` TDD pipeline directly.

The audit also surfaced a pre-existing inconsistency: the implemented-module
count has drifted — `README.md` says **3/22** and `docs/README.md` says
**2 of 22**, while the truth (and `CLAUDE.md` / `implementation-status.md`) is
**5/22**. `check:doc-counts` only validates the "22 documented" total, so the
implemented figure slipped through. Shipping `json` makes it **6/22**; this
plan folds the count reconciliation into the same change.

**Contract decisions (confirmed with user):**

1. **Prototype-pollution hardening** — `navigateFieldPath` and
   `M3LJSONFieldExtractor` must refuse to traverse dangerous segments
   (`__proto__`, `constructor`, `prototype`), reusing the existing
   `isDangerousKey` guard from `core/security`. A dangerous segment resolves to
   `undefined` (same as a missing segment).
2. **Field-path semantics** — object keys only; numeric segments are treated as
   ordinary object keys, **not** array indices (matches the spec examples).
3. **Doc counts** — bump all count claims to the correct value and fix the
   stale 3/22 and 2/22 drift in the same change.

## 1 — Run the `implement-submodule` pipeline for `json`

Invoke the `implement-submodule` skill targeting `core/json`. It drives the
hub-and-spoke TDD loop; the hub updates `docs/implementation-status.md` after
each phase (❌ → 🧪 → 🟢 → ✅).

- **Contract (spec-conformance-reviewer):** enumerate the exact promised
  surface from `docs/reference/core/json.md`:
  - `parseFieldPath(path: string)` → ordered path segments.
  - `navigateFieldPath(obj, path)` → value or `undefined` when any segment is
    missing **or dangerous** (decision 1).
  - `M3LJSONFieldExtractor` — field extraction built on the two functions.
  - `M3LJSONFormatDetector` — `async detect(filePath)` →
    `{ format, confidence, method, details }`.
  - `M3LJSONFormat` — `'json' | 'jsonl' | 'unknown'`.
  - The detection **depth enum** (`extension` | `shallow` | `standard` |
    `deep`), detector **options**, and the **result** type — name these
    explicitly (e.g. `M3LJSONDetectionDepth`, `M3LJSONDetectorOptions`,
    `M3LJSONDetectionResult`) and surface them through the barrel.
  - Front-load the two behavioral nuances into the contract: prototype-pollution
    guard returns `undefined`; numeric segments are object keys, not indices.
- **RED (test-author):** `packages/m3l-common/tests/json.test.ts` — happy +
  failure path per export, plus `expectTypeOf` tests where the type is the
  contract (the `M3LJSONFormat` union, the depth enum, the result shape).
  Include explicit tests for: missing-segment → `undefined`, dangerous-segment
  (`a.__proto__.x`) → `undefined`, and each detection depth level.
- **GREEN (submodule-implementer):** implement under
  `packages/m3l-common/src/core/json/` with **logic split into named files**
  (e.g. `fieldPath.ts`, `M3LJSONFieldExtractor.ts`, `M3LJSONFormatDetector.ts`)
  and a thin `index.ts` barrel — `index.ts` is coverage-excluded, so no logic
  there. Reuse `isDangerousKey` from `core/security` (relative import with `.js`
  extension). `detect()` reads files via `node:fs/promises` — no new runtime
  dependency.

Files created:

- `packages/m3l-common/src/core/json/index.ts` (+ named impl files)
- `packages/m3l-common/tests/json.test.ts`

## 2 — Surface `json` through the Core barrel

Add to `packages/m3l-common/src/core/index.ts`, in the existing order:

```typescript
export * from "./json/index.js";
```

This does **not** touch the 3-entry `exports` map in
`packages/m3l-common/package.json`, so the `check:api` snapshot
(`api-exports.json`) does not drift. `check:scaffold` enforces this barrel line
exists and points at a real directory. Commit type is **`feat:`** (minor), not
`feat!:`.

## 3 — Review fan-out

Parallel review spokes on the diff: `code-reviewer`, `spec-conformance-reviewer`
(verify zero drift vs `json.md`), `type-design-analyzer`, and
`silent-failure-hunter` (the `detect()` fs/async path + try/catch around
`JSON.parse`). Include `security-reviewer` because the module deliberately
handles the prototype-pollution surface. Iterate on must-fix items until clean.

## 4 — Provenance, doc counts, and status

- **Provenance:** create `docs/reference/core/json.provenance.json` mapping each
  documented heading to the **exported** symbols that back it, anchored at the
  implementation commit; run `pnpm check:provenance`. Match the schema in
  `docs/reference/provenance.schema.json` and the five existing sidecars.
- **Status tracker:** flip the `json` row in `docs/implementation-status.md` to
  ✅ and update the "5 of 22" summary line to **6 of 22**.
- **Doc-count reconciliation (decision 3):** update every implemented-count
  claim to **6/22** and fix the stale ones:
  - `README.md:16` badge `modules-3%2F22` → `modules-6%2F22` (and alt text).
  - `README.md:20` "3 of 22" → "6 of 22".
  - `docs/README.md:5` "2 of 22" (and the `errors` + `events` list) →
    "6 of 22" with the full implemented list.
  - `CLAUDE.md:501` "5 of 22 … (`errors`, `events`, `security`, `environment`,
    `utils`)" → add `json`, bump to 6.
    Run `pnpm check:doc-counts` to confirm.
- Run `/sync-docs` before committing (the Stop hook reminds when
  `implementation-status.md` changed).

## 5 — Work log

Run `/write-work-log` → `docs/logs/2026-06-30-core-json.md` recording what
shipped, divergences (the two contract decisions beyond the literal spec), and
lessons for the next submodule.

## Verification

- [ ] `pnpm -C packages/m3l-common build` (tsc → ESM + `.d.ts`)
- [ ] `pnpm test` — json happy/failure/type tests pass; suite green
- [ ] `pnpm test:coverage` — ≥ 80% all metrics; verify json files via
      `coverage/coverage-final.json` (the v8 text table hides 100% files)
- [ ] `pnpm typecheck` and `pnpm lint` clean (lint in-loop, not just at the gate)
- [ ] `pnpm check:scaffold` — barrel re-export present
- [ ] `pnpm check:api` — exports snapshot unchanged (no semver event)
- [ ] `pnpm check:exports` (publint + attw) clean
- [ ] `pnpm check:provenance` — json sidecar valid
- [ ] `pnpm check:doc-counts` — all counts read 6/22
- [ ] `pnpm knip` — no unused files/exports
- [ ] Manual contract checks: `navigateFieldPath` returns `undefined` for
      missing and for `__proto__`/`constructor`/`prototype` segments; numeric
      segments treated as object keys; each detection depth behaves per spec
- [ ] Commit `feat: implement core/json submodule`; `claude-pr-review` → PASS
