# Deterministic consumer-script production pipeline

## Context

Audit of how `scripts/*` consumer packages are planned, scaffolded, implemented, and documented (3 parallel Explore agents + hub verification). The library side has a mature deterministic pipeline (generator-less but checker-backed: `check:scaffold`, `check:scaffold-seam`, provenance, index, counts). The scripts side has the _enforcement substrate_ already live (ESLint zone incl. `process.env` ban, knip `scripts/*` workspace, branch-isolation + post-edit hooks, workspace glob) but the _production process_ is prose-only and unverified:

- The scaffold is hand-typed from fenced code blocks in `.claude/skills/scaffolding-scripts/SKILL.md` — no template files, no generator, manual root-tsconfig wiring, so two runs can diverge (naming, `hooks.ts` presence, step names, tsconfig ref form).
- No machine check verifies a `scripts/<name>` package against the ADR-0022 layout (no `check:script-scaffold` analogue); the mandated config-declaration smoke test is neither scaffolded nor checked.
- No per-script documentation artifact, no script index — `bin/lib/reference-index.mjs` hardcodes `NAMESPACES = ["core","aws"]`; `/syncing-docs`, provenance, counts, and `docs/implementation-status.md` all exclude scripts.
- Governance drift: ADR-0022 is still **Proposed** while its machinery is live, and ADR-0019 (remove scripts workspace) is still **Accepted**; `docs/guides/writing-a-script.md` §2.1 contradicts ADR-0022 (claims per-script data dirs); `docs/m3l-common-implementation.md` references the deleted `scripts/example-automation`; stale untracked build artifacts sit in `scripts/example-automation/`.

**User decisions (confirmed):** generator + checker sharing one manifest; per-script docs = colocated README **and** `docs/reference/scripts/<name>.md` with **split responsibilities** (README = how to run; reference page = contract); ADR-0022 → Accepted amended, ADR-0019 → Superseded; smoke test machine-checked, **no** coverage gate for scripts; full drift cleanup included; land as **two PRs**. Additionally: script-mode **few-shot examples go in the implementation artifacts** (implementer + test-author spokes + new skill); a **new thin `implementing-scripts` skill** encodes the script loop reusing existing spokes (no new agents); **`submodule-implementer` is renamed `code-implementer`** now that it serves both pipelines (other spokes get description-only updates).

## Step 0 — persist the plan, then `/starting-work`

1. **Persist this plan first**: copy it to `docs/plans/2026-07-09-consumer-script-pipeline.md`, commit (`docs(plans): add consumer-script pipeline plan`, signed), and **push directly to `main` before starting any work**. This is safe on `main`: `guard-branch-isolation` only blocks `src/**`/`tests/**` writes, and `docs/plans/**` is excluded from `lint:md`. Per the auditing skill's own lesson, later phases must re-validate the plan's factual claims against the live repo rather than inheriting them.
2. Run `/starting-work` before any implementation edit (writes touch guarded paths during verification and the repo mandates PR flow). Expected: shared checkout, `feat/script-pipeline` off `main` for PR 1; later `docs/script-governance` (or `fix/`) for PR 2. Signed commits, Conventional Commits throughout.

---

## PR 1 — pipeline infrastructure (`feat: add deterministic consumer-script scaffolding pipeline`)

### 1. Script templates — `templates/script/`

Real template files replacing SKILL.md's fenced blocks, content lifted from [SKILL.md](.claude/skills/scaffolding-scripts/SKILL.md) templates + ADR-0022 §8:

- `package.json.tmpl`, `tsconfig.json.tmpl` (exact shapes currently in SKILL.md Steps 2)
- `src/main.ts.tmpl` (composition root), `src/config.ts.tmpl`, `src/hooks.ts.tmpl`, `src/steps/run-__SCRIPT_NAME__.ts.tmpl` (injected-deps starter step)
- `tests/config.test.ts.tmpl` — the ADR-0022 §8 config-declaration smoke test (asserts declared parameters parse/validate); vitest's include `**/tests/**/*.test.ts` picks it up under `pnpm test` automatically
- `README.md.tmpl` — how-to-run: invocation, `.env` secrets, `M3L_*_DIR` overrides, `data/` in/out
- `docs-page.md.tmpl` — the `docs/reference/scripts/<name>.md` contract page: purpose, config schema table, steps, outputs

Conventions: `__SCRIPT_NAME__` / `__PURPOSE__` token substitution; `.tmpl` extension keeps eslint/tsc/prettier/rumdl off the files (add `templates/**` to knip `ignore` and, if needed, `.prettierignore`). Determinism tightening: `hooks.ts` is **always** emitted (ADR-0022's "omit if trivial" is amended in PR 2 — uniform layout, no optional files).

### 2. Shared manifest — `bin/lib/script-scaffold.mjs`

Single source of truth consumed by both generator and checker (the anti-drift seam, mirroring the `enumerated-literal-set-guard` lesson): required file list (relative paths, templated names resolved per script), required `package.json` contract (`name === "@m3l-automation/<dirname>"`, `private: true`, `type: "module"`, `engines.node >=24`, `@m3l-automation/m3l-common: "workspace:*"`, `build`/`typecheck`/`start` scripts), root-tsconfig reference shape (`./scripts/<name>`), and doc-artifact paths (README + reference page).

### 3. Generator — `bin/scaffold-script.mjs` (`pnpm scaffold:script <name>`)

- Validate kebab-case name; refuse if `scripts/<name>/` exists.
- Emit every manifest file from `templates/script/` with token substitution.
- Insert `{ "path": "./scripts/<name>" }` into root [tsconfig.json](tsconfig.json) `references` (sorted, idempotent) — removes SKILL.md's manual Step 4.
- Create `docs/reference/scripts/<name>.md` from `docs-page.md.tmpl`.
- Print next steps (install/build/smoke) — the _skill_ runs those, keeping the generator pure file-emission (deterministic, no network).

### 4. Checker — `bin/check-script-scaffold.mjs` (`pnpm check:script-scaffold`)

Model on [check-scaffold.mjs](bin/check-scaffold.mjs) (same structure/error style). For every `scripts/*` dir containing a tracked `package.json` (ignores artifact-only ghosts), verify against the shared manifest:

- all required files present, incl. ≥1 `steps/*.ts` and the `tests/**/*.test.ts` smoke test
- `package.json` field contract
- root tsconfig has the project reference
- `README.md` and `docs/reference/scripts/<name>.md` both exist
- reverse check: every `docs/reference/scripts/*.md` maps to an existing script (no orphan docs)

Must pass **vacuously** with zero scripts. Unit-test both generator and checker in `bin/tests/` (the established convention — see `check-cadence-doc.test.ts` etc.; the `bin/tests/**` ESLint zone at `eslint.config.js:337` relaxes `no-unsafe-*` for `.mjs` imports, and vitest's `**/tests/**` include picks them up).

### 4b. Toolchain integration (assessed against ci.yml, package.json, lefthook.yml, eslint.config.js)

- **package.json scripts**: add `"check:script-scaffold": "node bin/check-script-scaffold.mjs"` and `"scaffold:script": "node bin/scaffold-script.mjs"`. Referencing the bin files from `scripts` keeps knip's root workspace treating them as used; `bin/lib/script-scaffold.mjs` is used via imports.
- **CI ([ci.yml](.github/workflows/ci.yml))**: one new commented step in the ordered verify job, directly after `check:scaffold-seam` (~line 142) — `Check script scaffold conformance: pnpm check:script-scaffold` — matching the fast-first ordering and the existing "deterministic backstop for the scaffolding skill" comment style. No new workflow file, so `check:workflows-doc` (which validates the CLAUDE.md workflow _table_, not per-step lists) needs no change; CLAUDE.md's "every `check:*` script" CI-row prose already covers it generically.
- **lefthook ([lefthook.yml](lefthook.yml))**: **no change.** The new check is CI-only, consistent with the repo policy that every gate beyond the bypassable pre-push subset runs only in CI. This deliberately avoids touching the machine-verified cadence contract — adding it to pre-push would require synchronized edits to both `lefthook.yml` and the CLAUDE.md cadence table (`check:cadence` verifies them bidirectionally). Pre-commit/pre-push cover the new `.mjs`/test files automatically via their existing globs.
- **ESLint ([eslint.config.js](eslint.config.js))**: **no new zones** — `check:zones` unaffected. Existing zones already cover every new artifact class: `bin/**/*.mjs` zone (line 283) lints the generator/checker; the scripts design zone (lines 96, 176) lints instantiated scaffolds; the tests zone (line 313, bans mutating-fs/bare-fetch in unit tests) covers scripts' smoke tests and the new `bin/tests`. `.tmpl` files are invisible to eslint/prettier/rumdl by extension — no ignore entries needed (add knip `ignore: ["templates/**"]` only if knip flags them).
- **Template lint-compliance fix**: the scripts design zone enforces `@typescript-eslint/no-magic-numbers` (ignore list is only `-1, 0, 1` — line 159), so the current SKILL.md `config.ts` template (`defaultValue: 100`, `range(1, 10_000)`) would fail lint once instantiated. The new `config.ts.tmpl` must hoist named constants (`const DEFAULT_BATCH_SIZE = 100`, etc.); the E2E dry run's `pnpm lint` verifies every template instantiates lint-clean.
- **Non-impacts verified**: `check:test-counts` only checks ✅ rows in `docs/implementation-status.md` (unaffected); `post-edit-verify` / `guard-js-extension` / `guard-no-commonjs` hooks cover the new files at write time with no config change.

### 5. Index + doc-pipeline extension (targeted, not a rewrite)

- Extend [bin/lib/reference-index.mjs](bin/lib/reference-index.mjs): add a `scripts` section sourced from `docs/reference/scripts/*.md` ⇄ `scripts/*` dirs (no barrels — different source pair than core/aws), surfaced by `gen:index` into `docs/reference/README.md` (+ catalog/symbol-map entries as applicable) and verified by `check:index`. Run `pnpm gen:index` so the index carries the (empty) Scripts section.
- Verify `check:doc-counts` / `check:doc-exports` / `check:provenance` tolerate the new `docs/reference/scripts/` subtree; add scoped handling only where a checker would break. Scripts pages get provenance sidecars stamped like library pages (memory: scope `--update` to the changed sidecar, never repo-wide).

### 6. Skill edits (repurpose, no rewrites)

- **`scaffolding-scripts/SKILL.md`**: Steps 2–4 become "run `pnpm scaffold:script <name>`"; delete the inline fenced templates (point at `templates/script/`); add Step: fill in the generated README + reference page (split responsibilities: README = run instructions, page = contract); add final step invoking `/writing-work-logs`; note `check:script-scaffold` as the CI backstop. Keep Step 0 (`/starting-work`), Step 1 (name/purpose asks), install/build/smoke, and hub-and-spoke hand-off unchanged.
- **`syncing-docs/SKILL.md`**: add a scripts pass — `check:script-scaffold`, scripts-aware `gen:index`/`check:index`, provenance stamps for `docs/reference/scripts/*`.

### 7. New skill — `.claude/skills/implementing-scripts/SKILL.md`

Author it by invoking **`/skill-creator`** (it owns SKILL.md structure and description-triggering optimization; feed it the loop below and the sibling `implementing-submodules`/`scaffolding-scripts` skills as style anchors). Thin counterpart to `implementing-submodules`, encoding the script implementation loop with script-specific gates (reuses all existing spokes — **no new agents**):

1. Step 0: `/starting-work`; precondition: the script is scaffolded (`check:script-scaffold` green for it).
2. Contract: the script's `docs/reference/scripts/<name>.md` page + ADR-0022 conventions (spec-conformance-reviewer can seed it, pointed at the scripts page).
3. RED: `test-author` writes step tests + keeps the config smoke test honest (fail-first).
4. GREEN: `code-implementer` fills `steps/` modules (injected deps, `M3LError` chaining, `M3LPaths` I/O, config seam).
5. Review: `code-reviewer` + `security-reviewer` (+ `silent-failure-hunter` when steps have try/catch/retry).
6. Gates: `pnpm typecheck`/`lint`/`test`/`build`, `check:script-scaffold`, `knip` (proves the `workspace:*` import is exercised) — **no** coverage threshold, no exports/semver/provenance-count gates.
7. Close: fill README + reference page content, `/syncing-docs`, `/writing-work-logs`.

Update `scaffolding-scripts` Step 6 to hand off to this skill by name. Contains 2–4 script-mode few-shot examples (good/bad step module, good/bad smoke test).

### 8. Spoke updates — rename + script-mode examples

- **Rename `submodule-implementer` → `code-implementer`** (`.claude/agents/code-implementer.md`): it now officially serves both pipelines. Update its description + add a "consumer scripts" section with 1–2 few-shot pairs (injected-deps step with `M3LError` + `M3LPaths` vs. logic-in-`main.ts` / `process.env` read). Update every referencing file — `implementing-submodules/SKILL.md`, `scaffolding-scripts/SKILL.md`, the new `implementing-scripts/SKILL.md`, `CLAUDE.md` — and rely on `pnpm check:agents` to catch any missed `subagent_type` reference.
- **`test-author.md`**: description-only pipeline mention + 1–2 script-mode examples (config-declaration smoke test; step test with injected fakes, no env access).
- **`code-reviewer.md` / `security-reviewer.md` / `silent-failure-hunter.md`**: description-only updates to name script diffs in scope (they are already path-agnostic); no prompt-body rewrites.

---

## PR 2 — governance + drift cleanup (`docs: ratify script pipeline and fix scripts-doc drift`)

1. **ADR-0022** → `Status: Accepted`, amended to ratify: generator+checker+manifest, mandatory `hooks.ts`, the two-artifact doc model (README/run vs reference-page/contract), machine-checked smoke test, script index. **ADR-0019** → `Status: Superseded by ADR-0022`. Update `docs/adr/README.md` index if it lists statuses.
2. **[docs/guides/writing-a-script.md](docs/guides/writing-a-script.md)** §2.1 (~line 68): fix "input/output/config directories are derived per script" → flat `data/` root, isolation only via `M3L_*_DIR` env overrides (match `.claude/rules/scripts.md`).
3. **`docs/m3l-common-implementation.md`** (~lines 20, 151, 169, 205): remove/replace `scripts/example-automation` references (point at the scaffolding pipeline as the consumer story).
4. **`.claude/rules/scripts.md`** lines 24-26: correct the "structurally enforce" overclaim — ESLint caps complexity/exports; layout conformance is enforced by `check:script-scaffold`; composition-root purity remains reviewer-checked.
5. Remove the stale untracked `scripts/example-automation/` artifacts (`dist/`, `.turbo/`, `node_modules/` — local `rm`, no git change; its `dist/main.js` reflects a pre-1.0 API).

---

## Verification

- **Vacuous pass**: `pnpm check:script-scaffold` green with zero scripts; new `bin/tests/check-script-scaffold.test.ts` + `scaffold-script.test.ts` green; full pre-push suite green (`format:check`, `lint`, `typecheck`, `test:coverage`, `build`, `check:exports`) plus `check:index`, `check:doc-counts`, `check:provenance`, `check:workflows-doc`, `check:cadence`, `check:zones`, `pnpm knip`.
- **Agent wiring**: `pnpm check:agents` green after the `code-implementer` rename — every `subagent_type` reference in skills/CLAUDE.md resolves; grep confirms zero remaining `submodule-implementer` mentions outside work-log history.
- **End-to-end dry run** (on the PR 1 branch, before merge): `pnpm scaffold:script sample-probe` → `pnpm install` → `pnpm build` → `pnpm --filter @m3l-automation/sample-probe start` smoke-runs → `pnpm test` runs its smoke test → `check:script-scaffold`, `gen:index`, `knip` all green. Then delete the throwaway script + doc page + tsconfig ref and confirm the checker returns to vacuous-green (proves the reverse/orphan checks fire — temporarily break one manifest item first and confirm a red).
- **Idempotence/determinism**: run the generator twice with the same name → second run refuses; scaffold two different names → identical structure modulo tokens.
- **CI**: both PRs green through `ci.yml` verify + `claude-pr-review` PASS; commits signed.
