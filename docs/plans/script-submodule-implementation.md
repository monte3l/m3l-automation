# Plan: Implement Core `script` submodule (M3LScript)

## Context

`core/script` is the last of the "framework" Core submodules — it provides
`M3LScript`, the single CLI/Lambda entry point that composes config, logging,
prompts, environment detection, file archival, and (eventually) AWS credentials.
It has a full 127-line spec (`docs/reference/core/script.md`, 11 symbols) but no
code, tests, barrel re-export, or provenance sidecar; the tracker shows it ❌
(documented-only), leaving the library at **18 of 22** implemented.

The audit re-validated the long-standing "blocked until AWS lands" premise and
found it **false at the contract level**: the reference Public API lists 11
symbols, **none of them AWS types**, and "See also" links only
config/environment/errors/logging. The AWS coupling is a _conditional runtime
seam_ — the stage-5 credential check runs "only if an `aws.profile` param is
defined", and the `script.aws.clients` facade appears **only in the guide**, not
in the reference contract. All five real runtime deps (config, logging,
environment, errors, files, prompt) are implemented and reviewed. So `script` is
buildable now against its documented contract, with AWS deferred behind a seam.
This unblocks the 19th submodule without waiting on the AWS namespace.

The stored `docs/plans/script-submodule-implementation.md` is factually rotted
(claims "5 of 22", says config/logging don't exist, references the renamed
`implement-submodule`/`/sync-docs`) and will be **replaced** by this plan's
reconciliation step.

**Decisions locked (this session):** build now with AWS behind a seam · stage 5
throws a fail-loud (internal) `M3LError` when `aws.profile` is declared but AWS
isn't wired, no-op otherwise · **omit** the `script.aws` facade (not in the
11-symbol contract) · leave `writing-a-script.md` §5.4 forward-looking · replace
the rotted plan doc.

## Scope

**In:** the 11 documented symbols and the full non-AWS lifecycle. **Out:** any
AWS export, `script.aws`, `M3LAWSCredentialsManager` — those wait for the AWS
namespace and an intentional contract extension.

The 11 exports (from `docs/reference/core/script.md`): `M3LScript`,
`M3LScriptOptions`, `M3LScriptMetadata`, `M3LScriptLifecycleHooks`,
`M3LScriptHookContext`, `M3LScriptConfigLoader`, `M3LScriptPresetLoader`,
`M3LPresetUnknownKeysError`, `installProcessGuards`, `serializeError`,
`setProcessGuardRequestId`.

## 1 — Pre-flight: `/starting-work` (FIRST — mandatory)

Run `/starting-work` before any `src/`/`tests/` write. `guard-branch-isolation.mjs`
blocks those writes while `HEAD` is `main`, and we are on `main` now. Expected
outcome: branch `feat/core-script` off `main` (or a linked worktree), PR-based
landing, push to `origin feat/core-script`. Nothing below may run until this
confirms.

## 2 — Contract extraction (spec-conformance-reviewer, producer mode)

Dispatch `spec-conformance-reviewer` against `docs/reference/core/script.md` to
enumerate the exact 11 symbols + behavioral contracts (9-stage `run()` order, 8
hooks, `createLambdaHandler` per-invocation reset semantics, non-AWS-only signal
handling, process-guard singleton, preset depth cap 64 + Damerau-Levenshtein typo
suggestions, `M3LPresetUnknownKeysError` trigger). This seeds the RED tests. No
files written.

## 3 — RED phase (test-author) → status 🧪

Dispatch `test-author` to write `packages/m3l-common/tests/script.test.ts`:
happy + failure path per export, plus `expectTypeOf` where the type is the
contract (`createLambdaHandler<TEvent,TResult,TContext>` generics,
`M3LScriptLifecycleHooks` hook signatures, `M3LScriptHookContext` shape). Include
tests for the **AWS seam**: stage 5 is a no-op when no `aws.profile` param, and
throws a typed `M3LError` when `aws.profile` IS declared. Confirm tests fail for
the right reason (`Cannot find module '../src/core/script/index.js'`). Update the
`script` row in `docs/implementation-status.md` → 🧪.

## 4 — GREEN phase (submodule-implementer) → status 🟢

Dispatch `submodule-implementer` to create `packages/m3l-common/src/core/script/`
(public `.ts` files per symbol + barrel `index.ts`) with private helpers under
`packages/m3l-common/src/internal/script/`. Compose — do not reimplement —
existing modules:

- `M3LExecutionEnvironment.detect()` (core/environment) for stage 1.
- `M3LScriptConfigLoader` wraps the core/config provider chain
  (`M3LConfigParameter`, providers, `coerceConfigValue`).
- `M3LLogger` + handlers (core/logging) for `script.logger`.
- `M3LPrompt` (core/prompt) for `script.prompt`.
- `M3LFileCopier` (core/files) for stage-9 archival.
- `M3LPaths` (core/utils) for input/config/output path resolution — do **not**
  hardcode `data/`/`input/`/`output/`.
- Before writing a new Damerau-Levenshtein helper for the preset loader, check
  for an existing edit-distance/typo-suggestion util in core/utils, core/messaging,
  or core/config and reuse it.

**AWS seam (internal, not exported):** stage 5 detects a declared `aws.profile`
param; if absent → no-op; if present → throw an internal `M3LError` subclass
(e.g. code `AWS_NOT_AVAILABLE`, clear message) defined under `internal/script/`
and **never surfaced through the barrel** (callers catch `M3LError`; this keeps
the public surface at exactly 11 symbols). This is the single wiring point AWS
credentials will later replace.

**Barrel re-export (critical):** add `export * from "./script/index.js";` to
`packages/m3l-common/src/core/index.ts` in **alphabetical position** — between
`./security/index.js` and `./storage/index.js`.

Implementer runs `pnpm test && pnpm typecheck && pnpm lint && pnpm build` green.
**Hub verification before review:** list `src/core/script/` files, confirm the
barrel line is present exactly once, re-run the four gates, and check for no
stray scratch test files. Update the `script` row → 🟢.

## 5 — Review fan-out (parallel) → status ✅

Dispatch in one message: `code-reviewer`, `spec-conformance-reviewer`
(conformance mode — all 11 symbols present, none extra, lifecycle order matches),
`type-design-analyzer` (generics on `createLambdaHandler`, hook/context types,
options shapes), `silent-failure-hunter` (lifecycle try/catch isolation, `onError`
path, signal-handler + process-guard exhaustion, config async-fallback failures),
and `security-reviewer` (process guards, error serialization, no secret leakage in
archival/logging paths). Route must-fixes back to `submodule-implementer`; iterate
until clean. Update `script` row → ✅.

## 6 — Docs reconciliation (`/syncing-docs`) + replace rotted plan

Run `/syncing-docs` (the single count/provenance authority — never hand-edit):

- Generate `docs/reference/core/script.provenance.json` (11 named exports →
  source file + lines; internal AWS-seam error is **not** listed).
- Flip the implemented count **18 → 19** across all count-bearing sites: root
  `README.md` badge + prose, `packages/m3l-common/README.md`, `docs/README.md`,
  `docs/implementation-status.md` intro. Update the intro's implemented-module
  list and the `script` tracker note (drop "implement last"/AWS-blocked wording;
  note the AWS seam is deferred).
- `pnpm check:doc-exports` (11 symbols documented + in barrel), `pnpm gen:index`
  → `pnpm check:index`, `pnpm check:test-counts`, `pnpm lint:md`.
- **Replace** `docs/plans/script-submodule-implementation.md` with this validated
  plan (overwrite the rotted content).
- Optional/deferred: tighten the `src/core/index.ts` header comment (lists
  `script` as if already exported) — cosmetic, resolves once the barrel line lands;
  fold in only if trivial.

## 7 — Commit + PR

`feat:` commit (minor — new submodule via namespace barrel, `exports` map
unchanged, no breaking change): `src/core/script/**`,
`src/internal/script/**`, `tests/script.test.ts`, the `src/core/index.ts` barrel
line, provenance sidecar, count/doc updates, replaced plan doc. Then open a PR
(`/creating-prs`); the mandatory `claude-pr-review` gate must PASS to merge.

## Verification checklist

- [ ] `/starting-work` confirmed branch/PR/push off `main` before any src/test write.
- [ ] `packages/m3l-common/src/core/script/index.ts` exports exactly the 11 documented symbols — no more, no fewer.
- [ ] `src/core/index.ts` contains `export * from "./script/index.js";` exactly once, alphabetically placed.
- [ ] AWS seam: stage 5 no-ops without `aws.profile`; throws a typed `M3LError` (internal, unexported) when `aws.profile` is declared. No `script.aws`, no AWS export.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass; per-file coverage ≥ 80%.
- [ ] Review fan-out clean (code + conformance + type-design + silent-failure + security); tracker row ✅.
- [ ] `/syncing-docs` clean: provenance present, count flipped 18→19 at every site, index regenerated, `pnpm lint:md` passes.
- [ ] `docs/plans/script-submodule-implementation.md` replaced with this plan.
- [ ] `feat:` commit + PR opened; `claude-pr-review` PASS.
