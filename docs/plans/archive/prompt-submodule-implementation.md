# Plan: Add the `prompt` submodule to the implementation queue (plan file only)

## Context

The audit of submodule implementation status found that `core/prompt` is
**documented but unbuilt and unqueued**. Its spec already exists
(`docs/reference/core/prompt.md`, ~6 public symbols) and it has a row in
`docs/implementation-status.md` (status ❌, note "inquirer + spinner libs"),
and it is named in the Core barrel JSDoc (`src/core/index.ts`) — but it is
**not** in the live `export *` block, has no `src/core/prompt/`, no
`tests/prompt.test.ts`, and no provenance sidecar.

Unlike the six other in-flight submodules (`analysis`, `config`, `files`,
`json`, `logging`, `messaging`) — each of which has a
`docs/plans/<name>-submodule-implementation.md` plan locking its decisions
before `implement-submodule` runs — **`prompt` has no plan file**. This is the
single missing artifact.

**Deliverable (scope: plan file only):** create
`docs/plans/prompt-submodule-implementation.md`, matching the established
precedent, so `prompt` joins the queue for a later `implement-submodule` run.
No source, tests, barrel edits, or dependency changes happen now.

**Count constraint (verified):** `bin/check-doc-counts.mjs` validates only the
_total_ documented count (22, from `docs/reference/**`), never the implemented
_numerator_. Adding a file under `docs/plans/` does not change the total, so
there is **no count impact and no manual count bump** — consistent with the
instruction to rely on `/sync-docs` for any future numerator reconciliation.

## 1 — Create `docs/plans/prompt-submodule-implementation.md`

Model it on `docs/plans/config-submodule-implementation.md` (the closest
precedent — also a spec-first module that takes one runtime dep). The new file
must contain these sections:

### Context

- `prompt` is documented (`docs/reference/core/prompt.md`) but unimplemented:
  no `src/core/prompt/`, no `tests/prompt.test.ts`, no provenance sidecar;
  listed in the Core barrel JSDoc but **not** in the live `export *` block.
- Spec-first → use `implement-submodule` directly; **do not run `new-subpath`**.
- Settled decisions: (1) the one runtime dependency is `@inquirer/prompts`;
  `M3LMultiSpinner` + `M3LLoadingBar` are implemented **in-house** (pure ANSI,
  no spinner library); (2) full module in a single
  Contract→RED→GREEN→Review pass.
- The `exports` map stays at three entries (`.`, `./core`, `./aws`); `prompt`
  is surfaced only via the namespace barrel → `feat:` (minor), not breaking.

### Contract (from `docs/reference/core/prompt.md`)

Enumerate the documented public surface so the spec-conformance producer phase
has a firm starting point:

- `M3LPrompt` — unified facade composing a multi-spinner, a loading bar, and an
  injected `@inquirer/prompts` adapter (constructor injection → mockable).
  Prompt methods: `text`, `password`, `number` (with `min`/`max`), `confirm`,
  `select`, `multiselect`, `autocomplete` (custom suggest fn).
- `M3LMultiSpinner` + `M3LMultiSpinnerOptions` — two modes: multi-spinner
  (`spin`/`spinSucceed`/`spinFail`/`spinWarn` keyed by id) and the
  backward-compatible single-spinner subset
  (`startSpinner`/`updateSpinner`/`spinnerStop`/`spinnerFail`).
- `M3LLoadingBar` + `M3LLoadingBarOptions` — progress bar, configurable fill
  chars (default `█`/`░`), `update(percentage 0–100, message)`.
- **Nuances to front-load:** exact option-shape names beyond those listed are
  not fixed by the spec — the Contract phase must firm them up and surface
  genuinely undefined choices back to the hub before tests freeze.

### Dependency gate: add `@inquirer/prompts`

- Recommended single runtime dep (reasoning recorded here): the spec names only
  `@inquirer/prompts`; the spinner/bar are described behaviorally and built
  in-house to honor the minimal-deps / shallow-import-graph rule.
- Add via `pnpm add @inquirer/prompts --filter @m3l-automation/m3l-common`
  (package dep, not root, not devDeps); pin an exact version; never hand-edit
  the lockfile.
- After adding, `pnpm knip` + `pnpm check:deps` must stay green (the dep must be
  _used_ by `src/`).

### Implementation pipeline (hub-and-spoke TDD)

1. **Contract** (`spec-conformance-reviewer`, producer mode) — enumerate exact
   symbols/behaviors; firm up undefined option shapes.
2. **RED** (`test-author`) — `tests/prompt.test.ts`: each prompt method
   (happy + failure), spinner multi/single modes, loading-bar clamping/format,
   TTY vs non-TTY rendering (ANSI stripped when not interactive), inquirer
   adapter mocked via constructor injection, `expectTypeOf` for the facade and
   option types. Confirm RED for the right reason.
3. **GREEN** (`submodule-implementer`) — `src/core/prompt/`: barrel `index.ts`
   `export *`-ing named files (e.g. `M3LPrompt.ts`, `M3LMultiSpinner.ts`,
   `M3LLoadingBar.ts`); private helpers under `src/internal/prompt/` only.
4. **Review fan-out** — `code-reviewer`, `spec-conformance-reviewer`
   (conformance), `type-design-analyzer` (new public types),
   `silent-failure-hunter` (async prompt paths / cancellation). Security-reviewer
   optional (no secrets persisted, though `password` input should never be
   logged — call that out).

### Reuse (do not reinvent)

- **Environment**: `M3LExecutionEnvironment.isInteractive()` (already shipped,
  `core/environment`) + `process.stdout.isTTY` drive the live-vs-plain decision.
- **Errors**: throw `M3LError` subclasses with `cause` chaining; never bare
  strings (`core/errors`).
- **Utils**: `core/utils` guards/`safeJsonStringify` for any diagnostics; never
  log `password` values.

### Hard rules

- ESM relative imports carry `.js`; named exports only; no `any`; no non-null
  `!`; TSDoc + `@example` on every export.
- Add `export * from "./prompt/index.js";` to the live block in
  `src/core/index.ts` (ordered alongside the existing five). Do **not** touch
  the `exports` map.

### Verify (final gate, future implement-submodule run)

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
pnpm test:coverage      # 80% gate; read coverage/coverage-final.json
pnpm knip               # confirms @inquirer/prompts is used
pnpm check:exports      # publint + attw, exports map unchanged
pnpm check:scaffold     # barrel ↔ filesystem sync
pnpm check:deps
```

### Doc metadata: rely on `/sync-docs`, do **not** hand-bump counts

- Update the `prompt` row in `docs/implementation-status.md` to ✅/✅/✅ when
  built (hub-owned status file).
- Run `/sync-docs` to stamp `docs/reference/core/prompt.provenance.json` to HEAD
  and run `check:doc-counts` + `lint:md`.
- **Do not edit the "N of 22 implemented" numerator** in README.md /
  docs/README.md / CLAUDE.md — `check-doc-counts.mjs` validates only the total
  (22), `prompt.md` is already on disk, so the total is unchanged. Leave
  numerator reconciliation to `/sync-docs` and the coordinated in-flight plans.

### Work log + commit (future run)

- `/write-work-log` for lessons (in-house spinner vs library decision; inquirer
  adapter injection for testability).
- Commit the eventual implementation as `feat:` (minor, new barrel surface).

## 2 — Verification of _this_ deliverable

- [ ] `docs/plans/prompt-submodule-implementation.md` exists and follows the
      precedent structure (Context, Contract, Dependency gate, Pipeline, Reuse,
      Hard rules, Verify, Doc metadata, Work log, Verification checklist).
- [ ] It records the settled decisions: single dep `@inquirer/prompts`,
      in-house spinner/bar, spec-first (no `new-subpath`), barrel-only surface.
- [ ] It explicitly states **no manual count bumps** and defers to `/sync-docs`.
- [ ] No other files changed (no `src/`, tests, barrel, deps, lockfile, or count
      prose). `docs/plans/**` is excluded from `lint:md`; the file is
      prettier-formatted by the post-edit hook.
- [ ] Plan-immutability respected: this is a **new** plan file, not an edit to
      any existing `docs/plans/` file.
