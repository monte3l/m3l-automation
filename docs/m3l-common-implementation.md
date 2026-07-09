# Plan: Align m3l-common with its documented spec (implement all 21 submodules)

> **Historical — build-phase plan.** This document captured the initial bootstrap
> strategy from 2026-06-28, when `src/` was an empty scaffold. As of 2026-07-05 all
> **22 submodules are implemented and reviewed** — see
> [Implementation status](implementation-status.md). The present-tense "empty
> scaffold" framing and the "21 submodules" count below describe that starting
> state, not the current one; the file is retained for process history.

## Context

`@m3l-automation/m3l-common` is a **fully-specified but empty scaffold**. The
audit (3 Explore agents + direct reads of `docs/implementation-status.md` and
`.claude/skills/implementing-submodules/SKILL.md`) confirms:

- **Infrastructure is complete and correct**: the 3-entry `exports` map
  (`.`, `./core`, `./aws`), the three barrels (`src/index.ts`,
  `src/core/index.ts`, `src/aws/index.ts` — all `export {}` placeholders),
  `src/internal/.gitkeep`, `data/{config,input,output}`, the example consumer
  `scripts/example-automation/`, the toolchain (turbo, vitest, eslint, lefthook,
  knip, publint/attw), and all enforcement hooks.
- **Zero runtime code exists**: all **18 Core + 3 AWS = 21 submodules** are
  `❌ not-started` in `docs/implementation-status.md`. Only `tests/index.test.ts`
  (2 infrastructure-level tests) exists.
- **The full contract is already written**: 22 spec pages under
  `docs/reference/{core,aws}/` (~180 public symbols) plus cross-module contracts
  in `docs/m3l-common-architecture.md`.

**Desired state**: every submodule implemented, tested, and reviewed
(`✅ reviewed/done`), surfaced through the namespace barrels, with the 3-entry
`exports` map unchanged.

**This plan does not invent a new process.** It applies the project's existing
`implementing-submodules` hub-and-spoke TDD pipeline across all 21 submodules in the
documented dependency order. The plan is the orchestration schedule; each
submodule's contract lives in its `docs/reference` page (authoritative).

**Decisions (confirmed with user):** Scope = all 21 submodules. Dependency
approval = **gate per phase** (stop and list deps with rationale for approval
before any `pnpm add`, per the skill).

---

## The repeating unit of work (per submodule)

Every submodule is built with the **exact loop from
`.claude/skills/implementing-submodules/SKILL.md`**. The main agent is the **hub**:
it coordinates only and never writes `src/`/tests or reviews code. The one
bookkeeping write the hub owns is `docs/implementation-status.md`.

1. **Resolve target** — confirm the `docs/reference/<ns>/<module>.md` page exists
   (all 21 do); pick the next module per the order below.
2. **Dependency gate** — if the module needs a runtime dep, **stop, list each dep
   - one-line rationale, wait for explicit approval, then `pnpm add`** (never
     hand-edit `pnpm-lock.yaml`). Dep-free modules skip this.
3. **Phase 1 — Contract** → dispatch `spec-conformance-reviewer` (contract mode).
   Returns exact exports (names + shapes) + behavioral contracts. Keep the text.
4. **Phase 2 — RED** → dispatch `test-author` with the contract + target test
   path `packages/m3l-common/tests/<module>.test.ts`. Tests must fail for the
   right reason (symbols absent). → mark module `🧪` in status file.
5. **Phase 3 — GREEN** → dispatch `code-implementer` with the contract +
   failing tests. Writes `src/<ns>/<module>/index.ts` (private helpers under
   `src/internal/`), re-exports from `src/<ns>/index.ts`, drives `pnpm test` +
   `pnpm typecheck` green **without touching the `exports` map**. → mark `🟢`.
6. **Phase 4 — Review (parallel)** → dispatch `code-reviewer` +
   `spec-conformance-reviewer` (conformance mode), plus `security-reviewer` for
   any security-sensitive surface (all of `aws/*`, and anything touching secrets,
   credentials, deserialization, or logging — i.e. `config`, `logging`,
   `security`, `text`, `importers`). Send **Must-fix** items back to the
   implementer; re-run until clean. → mark `✅`.
7. **Per-submodule verify + commit** — `pnpm -C packages/m3l-common build &&
pnpm test && pnpm lint && pnpm typecheck`. Commit `feat: implement <module>`
   (minor — a new submodule via the barrel does not change the 3-entry exports
   map). Small, incremental, meaningful commits per CLAUDE.md.

**Hard rules every spoke must honor** (from `rules/`, `.claude/rules/library-src.md`,
ESLint, hooks): ESM `.js` extension on every relative import; no `any` (use
`unknown` + narrow); no non-null `!`; named exports only; no CommonJS; throw
`M3LError` subclasses chained with `cause`; validate external input at the public
boundary; TSDoc + `@example` on every exported symbol; `internal/` never
re-exported; exhaustive `switch`; ≥80% coverage; Conventional Commits.

---

## Execution schedule (documented dependency order)

Order is taken verbatim from `docs/implementation-status.md` → _Suggested
implementation order_ (foundational/dep-free first). Each phase ends with a
checkpoint: status file updated, full verify green, work committed.

### Phase A — Foundations (no deps)

`errors` → `events` → `security` → `utils` → `environment` → `json`

- `errors` first: `M3LError`/`M3LResult` underpin everything. `utils` brings
  `M3LPaths` + type guards; `environment` drives `M3LPaths` mode detection.
- No dependency gate. Representative paths: `src/core/errors/index.ts`,
  `src/core/utils/index.ts`, re-exported from `src/core/index.ts`.

### Phase B — Pure logic (no deps)

`analysis` → `messaging`

- `messaging` is abstract interfaces only; `analysis` is the threshold evaluator.

### Phase C — Services

`config` → `logging` → `files` → `polling` → `network`

- **Dependency gate (open at phase start):** `config` needs a **YAML parser**
  (`yaml`); `network` needs **`undici`**. List both with rationale; await
  approval before `pnpm add`. `logging`, `files`, `polling` are dep-free.
- `logging` may lean on `files`/exporters for its file handler; build `config`
  and `logging` before `script` consumes them.

### Phase D — Tabular I/O

`importers` → `exporters`

- **Dependency gate:** `importers` → **`csv-parse`**; `exporters` →
  **`csv-stringify`**. `importers`/`exporters` are security-sensitive (parse
  external files) → include `security-reviewer` in Phase 4.

### Phase E — Heavy/optional deps

`storage` → `text` → `prompt`

- **Dependency gate:** `storage` → **`better-sqlite3`** (native; flag the native
  build implication); `text` → **`unpdf`, `mammoth`, `read-excel-file`,
  `mailparser`, `cheerio`, `adm-zip`** (6 libs); `prompt` → **inquirer
  (`@inquirer/prompts`) + a spinner lib**. `text` is security-sensitive
  (zip-bomb guard, untrusted documents) → include `security-reviewer`.

### Phase F — AWS

`aws/models` → `aws/credentials` → `aws/clients`

- `models` is shared types only (no runtime). **Dependency gate:** `credentials`
  → **`@aws-sdk/client-sts`, `@aws-sdk/credential-providers`**; `clients` →
  **`@aws-sdk/*` service clients** (lazy). All of `aws/*` is security-sensitive →
  **always** include `security-reviewer` (SSO handling, STS validation, no
  credential logging).

### Phase G — Orchestrator (last)

`script`

- `M3LScript` composes `environment`, `config`, `logging`, and `aws`; it must be
  last. Security-sensitive (process guards, preset loading, config) →
  `security-reviewer` included.
- After `script` lands, update `scripts/example-automation/src/main.ts` to use
  the real `Core.M3LScript` lifecycle (the intended shape is already commented in
  that file) — done via a spoke, then verify the example builds.

---

## Critical files

- **Per submodule (written by spokes, never the hub):**
  `packages/m3l-common/src/<ns>/<module>/index.ts`,
  `packages/m3l-common/tests/<module>.test.ts`, private helpers under
  `packages/m3l-common/src/internal/`.
- **Barrels (append re-export only; never add an `exports` entry):**
  `packages/m3l-common/src/core/index.ts`, `packages/m3l-common/src/aws/index.ts`.
- **Hub-owned bookkeeping:** `docs/implementation-status.md` (update after every
  phase transition `❌→🧪→🟢→✅`).
- **Authoritative contracts (read-only):** `docs/reference/{core,aws}/*.md`,
  `docs/m3l-common-architecture.md`.
- **Final integration:** `scripts/example-automation/src/main.ts` (after `script`).
- **Do NOT touch:** `packages/m3l-common/package.json` `exports` map; `version`;
  `dist/`; `pnpm-lock.yaml` (only via `pnpm add` at an approved gate).

## Reuse (don't re-invent)

- Foundational modules are dependencies for later ones: reuse `M3LError`/
  `M3LResult` (errors), `M3LEventEmitterBase` (events) in importers/exporters/
  network, `M3LPaths`/type guards/`safeJsonStringify` (utils), `isDangerousKey`
  (security) in any config/JSON deserialization, `M3LExecutionEnvironment`
  (environment) for path + rendering decisions. Building in order guarantees
  these exist before consumers need them.

---

## Verification

**Per submodule (Phase 4 + step 7):**

- `pnpm vitest run packages/m3l-common/tests/<module>.test.ts` — tests pass.
- `pnpm -C packages/m3l-common build && pnpm test && pnpm lint && pnpm typecheck`
  — all green (≥80% coverage enforced by `vitest.config.ts`).

**Per phase checkpoint:**

- `docs/implementation-status.md` reflects `✅` for the phase's modules.
- Commits are `feat:` with Conventional Commit format (lefthook `commit-msg`).

**Final (after Phase G):**

- All 21 rows in `docs/implementation-status.md` = `✅ reviewed/done`.
- `pnpm build && pnpm test && pnpm lint && pnpm typecheck` green.
- `pnpm knip` (no unused files/exports/deps) and `pnpm check:exports`
  (publint + attw, esm-only profile) pass — the publish-hygiene gate.
- `pnpm check:api` (exports snapshot) confirms the 3-entry `exports` map is
  unchanged (no accidental semver break).
- `scripts/example-automation` builds and runs against the real `Core.M3LScript`.

---

## Notes / risks

- **Volume**: ~180 symbols across 21 submodules. This is a long, multi-session
  loop; `docs/implementation-status.md` is the durable cross-session memory — the
  hub must keep it current after every phase.
- **Dependency gates** will pause execution 5 times (Phases C, D, E, F twice-ish).
  Exact package choices for the loosely-specified deps (`config` YAML parser,
  `prompt` spinner lib) are decided at the gate, guided by each spec page.
- **Native dep**: `better-sqlite3` (storage) compiles natively on install — call
  this out at the Phase E gate.
- The hub never writes `src/`/tests or reviews — those are structural spoke
  responsibilities (writer ≠ reviewer).
