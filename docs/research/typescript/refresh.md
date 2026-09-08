# TypeScript refresh tracker

<!-- typescript-refresh: last-verified=2026-09-08 typescript-version=7.0.2 -->

This is a **living tracker**, updated in place by
[`refreshing-typescript-guidance`](../../../.claude/skills/refreshing-typescript-guidance/SKILL.md)
rather than a new dated file per run — the TypeScript-program counterpart to
[`harness-refresh.md`](../harness-refresh.md), which asks the same "is our
setup still what upstream ships" question about the Claude Code harness
instead. Dated point-in-time research on a single TypeScript topic goes in
`docs/research/typescript/<topic-slug>.md` instead (written by
[`researching-typescript-guidance`](../../../.claude/skills/researching-typescript-guidance/SKILL.md));
see [`../README.md`](../README.md) for the full index of both.

`typescript-version` in the header above records the newest **upstream**
TypeScript release the last sweep verified against — deliberately distinct
from `package.json`'s own `typescript` devDependency pin, which this tracker
exists to check against, not restate. The two numbers disagreeing is not a
bug in the tracker; it's the finding.

## Outstanding drift

1. **Staying on `typescript@6.0.3` is a deliberate, evidenced hold, not
   unexamined drift.** typescript-eslint (`eslint.config.js:49`'s
   `recommendedTypeChecked`, made type-aware repo-wide by `projectService:
true` at `eslint.config.js:69`) declares support for `>=4.8.4 <6.1.0` —
   TypeScript 7 is entirely outside that range — and TS 7.0 ships **no stable
   programmatic compiler API until 7.1**, which typescript-eslint's own
   type-aware rules depend on. Moving to TS 7 today would break type-aware
   linting repo-wide. Microsoft ships `@typescript/typescript6` (a
   compatibility package re-exporting the 6.0 API) as the documented
   dual-install path for adopting TS 7 while API-dependent tooling stays on
   6.0, if that is ever pursued. **Re-check trigger:** either typescript-eslint
   publishing explicit TS 7 support, or TS 7.1 shipping the stable
   programmatic API — re-verify both at the next sweep before treating this
   as still blocked. (Retrieved 2026-09-08:
   <https://typescript-eslint.io/users/dependency-versions/>,
   <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>.)
2. **Three Context7 reference snapshots are stamp-clean but upstream-stale.**
   `.claude/skills/typescript-configuration/references/typescript-configuration.md`
   (`library=/microsoft/typescript/v6.0.2 tracks=typescript@6.0.3
snapshot=2026-09-05 refresh=major`),
   `.claude/skills/eslint-flat-config/references/eslint-flat-config.md`
   (`tracks=eslint@10.9.1,typescript-eslint@8.69.0`), and
   `.claude/skills/vitest-testing/references/vitest-testing.md`.
   `check:reference-freshness` compares each stamp's `tracks=` against the
   **local `package.json`** only, so all three pass while sitting a major
   behind upstream — confirmed structural this sweep, not a bug in the gate.
   Remediation route: re-pull via context7 MCP and re-stamp (ADR-0093),
   **from the plan a sweep produces, never from the sweep itself.** Only
   `typescript-configuration` was examined for content drift this sweep (see
   §3 of the 2026-09-08 remediation); `eslint-flat-config` and
   `vitest-testing` remain unexamined.
3. **`.claude/rules/scripts.md`'s "Annotate, never `satisfies`" holds — the
   `isolatedDeclarations` restriction has NOT relaxed in TS 6.x or 7.x.** A
   confirmed negative: the TS 6.0 GA post contains no mention of
   `isolatedDeclarations`/`satisfies`/declaration emit at all; the TS 7.0 GA
   post mentions `isolatedDeclarations` exactly once, only as a
   project-reference **build-performance** enabler, with no rule change. The
   TS 5.5 release notes' exemption list (primitive-literal initializers,
   literal-typed return expressions, an explicit **type assertion**) admits
   `as` but never names `satisfies` — and `satisfies` deliberately doesn't
   change an expression's inferred type, which is exactly what
   `isolatedDeclarations` (error TS9010) requires to come from an explicit
   annotation. **Honesty flag carried forward:** no T1 page names `satisfies`
   in the `isolatedDeclarations` context verbatim — this conclusion is
   derived from the TS 5.5 exemption list plus `satisfies`' documented
   semantics, not a direct citation. An empirical repro (`tsc --isolatedDeclarations
--declaration` against a throwaway `satisfies` export) was blocked this
   sweep by `guard-readonly-bash.mjs`'s correct
   refusal of a scratchpad write under plan mode; still worth running for
   real in a future sweep, noting any result is 6.0.3 behavior only.
   (Retrieved 2026-09-08: `typescriptlang.org/tsconfig/isolatedDeclarations.html`,
   `typescriptlang.org/docs/handbook/release-notes/typescript-5-5.html`,
   the 6.0 and 7.0 GA posts.)
4. **`eslint.config.js:49`'s `tseslint.configs.recommendedTypeChecked`
   choice has now been measured, not just examined.** Confirmed: it is the
   only preset tier spread (no `strict*`/`stylistic*` preset appears
   anywhere in the 1172-line file); `no-non-null-assertion` is already
   hand-enabled at `eslint.config.js:88`, one of the 26 rules
   `strictTypeChecked` would add — i.e. the repo already cherry-picks from
   the tier rather than adopting it. A real measurement run against a
   throwaway config (2026-09-08, both variants deleted after use, `git
status` confirmed clean) found:
   - `strictTypeChecked`: 373 findings across `packages/m3l-common` (src +
     tests) — dominated by `no-meaningless-void-operator` (76),
     `restrict-template-expressions` (64, already in `recommendedTypeChecked`
     but tightened), `no-unnecessary-condition` (54),
     `no-confusing-void-expression` (48), `no-unnecessary-type-conversion`
     (30), `no-deprecated` (29). A 2-package sample of `scripts/*`
     (`agent-operator`, `dynamodb-crud`) found 23 findings, dominated by
     `no-unnecessary-condition` (14).
   - `stylisticTypeChecked`: 342 findings across `packages/m3l-common` —
     dominated by `no-empty-function` (132),
     `non-nullable-type-assertion-style` (106), `array-type` (52),
     `prefer-optional-chain` (18), `consistent-type-definitions` (18). The
     same 2-package `scripts/*` sample found 27 findings, dominated by
     `array-type` (21).
   - A full-workspace (21-package) type-aware run OOM'd this host
     (ADR-0080's known memory-constrained-host caveat) — the numbers above
     are `packages/m3l-common` (exhaustive) plus a 2-package `scripts/*`
     sample, not a full-fleet count. A future adoption decision should
     either budget for a per-package sequential run or accept the sample as
     representative.
   - typescript-eslint's own docs caveat carried forward: `strict`,
     `strictTypeChecked`, `all`, `disableTypeChecked` and
     `stylisticTypeCheckedOnly` are **not stable under semver** — a minor
     typescript-eslint bump can add rules to them.
   - **Status: measured, not adopted.** No config change was made. Adoption
     of either preset is a separate, scoped PR if the maintainer wants to
     act on these numbers.
5. **`tsconfig.base.json` confirmed 7.0-clean**, not merely provisional.
   Checked line-by-line against the TS 7.0 GA/RC breaking-change list:
   `target: es2025` (`tsconfig.base.json:4`, unaffected by the `target: es5`
   removal); no `baseUrl`/`paths` in `tsconfig.base.json` or any of the 9
   `packages/*/tsconfig*.json` files (unaffected by `baseUrl`'s removal);
   every emitting project sets `rootDir` explicitly (unaffected by the new
   `./` default); `types: ["node"]` explicit (now the _required_ form under
   TS 7's `types: []` default, formerly redundant); `module`/
   `moduleResolution: nodenext` throughout (not the removed `node`/`node10`/
   `classic`). `noUncheckedSideEffectImports: true` (`tsconfig.base.json:16`)
   is also confirmed to become redundant-but-harmless under TS 7's new
   `true` default. (Retrieved 2026-09-08: the 7.0 GA and RC devblog posts.)
6. **Node's unsupported-syntax list — `.claude/rules/library-src.md` and this
   tracker's own prior note understated it.** `nodejs.org/api/typescript.html`
   errors (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) on enum declarations,
   `namespace`/`module` with runtime code, and constructor parameter
   properties — the three previously recorded — **plus import aliases**
   (`import x = require(...)`) **and decorators** (parser error, not yet
   native JS), which were missing from the prior note. Node type stripping is
   confirmed **Stability 2 (Stable)**: default since v23.6.0/v22.18.0, stable
   since v24.12.0/v25.2.0, `--experimental-transform-types` removed in
   v26.0.0. This repo's `>=24` floor (`.node-version`) still admits
   24.0–24.11, where the feature predates stability. (Retrieved 2026-09-08:
   `nodejs.org/api/typescript.html`.)
7. **`erasableSyntaxOnly` investigated for `scripts/*` adoption — clean,
   adopted this sweep's remediation.** It would mechanically enforce,
   compiler-side, the same four-construct ban (`enum`, runtime `namespace`,
   decorators, constructor parameter properties) that
   `eslint.config.js:499-518` hand-rolls under ADR-0042 for
   `scripts/*/src/config.ts` specifically. The flag is project-wide, not
   file-scoped, and the library legitimately uses parameter properties
   (`packages/m3l-common/src/aws/{ecs,lambda,eks,s3}/client.ts`), so it can
   never go repo-wide. A precise grep of all 208 files across every
   `scripts/*/src` (enum declarations, runtime namespace declarations,
   line-leading decorators, constructor parameter properties, `import x =
require` aliases) found **zero** occurrences of any of the five
   constructs. All 17 `scripts/*/tsconfig.build.json` files now set
   `erasableSyntaxOnly: true` alongside `isolatedDeclarations`; `pnpm
typecheck` (which runs `build` first, where the flag applies) passed clean
   across all 21 workspace packages after the change. `rewriteRelativeImportExtensions`
   remains correctly unset — it changes which extension is written in emit,
   not whether an extension is required, and targets the run-`.ts`-directly
   workflow this repo (tsc-to-`dist/`, no bundler) does not have.

**Resolved since the last sweep:** items 1, 3, 5, 6, 7 above (previously
"repo is a major behind" / "provisionally clean" / "satisfies restriction
unverified" / "understated list" / "erasableSyntaxOnly unexamined") all
closed by this sweep, 2026-09-08. Item 4 (lint preset) moved from
"unexamined" to "measured, not adopted" — still open pending an adoption
decision. Item 2 (Context7 snapshots) remains open; only partially examined.

**No drift found (recorded so it isn't re-derived):**

- `microsoft/typescript-go` is cited **nowhere** in this repo except where
  correctly labelled archived
  (`.claude/skills/researching-typescript-guidance/references/typescript-sources.md:98,162`,
  `.claude/skills/refreshing-typescript-guidance/SKILL.md`, this file). Its
  2026-09-01 archival (redirects to `microsoft/TypeScript`) has zero repo
  impact. Re-grepped clean 2026-09-08 (previously grepped 2026-09-08 at
  seeding).
- `github.com/microsoft/TypeScript/wiki/Breaking-Changes` (stale at TS 4.9,
  per `researching-typescript-guidance/references/typescript-sources.md`) is
  cited in this repo **only** where correctly labelled stale
  (`docs/decision-notes/0006-typescript-source-tiering.md:37`, both skills'
  own text, `researching-typescript-guidance`'s eval fixtures). Zero bad
  citations. Re-grepped clean 2026-09-08.
- `typescriptlang.org/tsconfig/` (the per-option reference page) is itself
  **partly stale against TS 7** — it still lists an `ES2020` default
  `target`, still documents `ES5`/`downlevelIteration`/`baseUrl` as live
  options the 6.0/7.0 release posts say are removed. The release posts were
  treated as authoritative on every conflict this sweep. Worth re-checking
  whether the reference page catches up at the next sweep.
- const type parameters (stable since TS 5.0), `using`/`await using`
  explicit resource management (stable since TS 5.2, disposable types still
  only in `lib.esnext.disposable.d.ts`, not folded into any `esYYYY` lib),
  and decorators (Stage 3 standard since TS 5.0, no flag needed; legacy
  Stage 2 still needs `experimentalDecorators`) are all unchanged by 6.0 or
  7.0 — both release posts silent on all three. The repo uses const type
  parameters (`packages/m3l-common/src/core/procedure/M3LProcedureBuilder.ts:128`,
  `.../core/config/M3LOperationDeclaration.ts:111`, undocumented in the
  style guide — a real but low-priority doc gap), does not use `using` (one
  correct, already-documented non-use at
  `packages/m3l-common/src/core/logging/M3LLogger.ts:378-381`, mirrored at
  `docs/reference/core/logging.md:102`), and does not use decorators in
  `src` outside the ADR-0042 `config.ts` ban.
- Enums and runtime namespaces: unchanged by 6.0/7.0 (the only 7.0
  namespace-adjacent removal is the legacy `module Foo {}` keyword spelling,
  not the `namespace` keyword itself). The library uses neither, preferring
  the documented const-object pattern
  (`packages/m3l-common/src/core/environment/index.ts:30`); the ADR-0042
  ESLint ban covers only `scripts/*/src/config.ts`, not the library, which
  relies on convention.

## Facets

### Compiler config & flags

- CLAIM: `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are set
  in `tsconfig.base.json` on top of `strict: true` because they are not part
  of the `strict` umbrella — `typescript-configuration/SKILL.md`,
  <https://www.typescriptlang.org/tsconfig/> (tier T1)
  - VERDICT: UNCHANGED (re-fetched 2026-09-08)
  - REPO-IMPACT: none — confirmed correct at
    `typescript-configuration/SKILL.md:52-56` and
    `references/typescript-configuration.md:33-36`; both flags genuinely set
    at `tsconfig.base.json:10,13`.
- CLAIM: `target: es2025`, `module`/`moduleResolution: nodenext`,
  `verbatimModuleSyntax: true`, `isolatedModules: true`, `skipLibCheck: true`
  are all set in `tsconfig.base.json` — direct file read (tier: repo fact)
  - VERDICT: UNCHANGED (re-fetched 2026-09-08 against the file itself)
  - REPO-IMPACT: none — all five confirmed verbatim at `tsconfig.base.json:4,7,8,14,15,36`.
- CLAIM: did TS 7 change `strict`'s membership or only its default? —
  <https://www.typescriptlang.org/tsconfig/strict.html>,
  <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/> and
  its RC post (tier T1)
  - VERDICT: CHANGED (re-fetched 2026-09-08)
  - NOW: only the **default** moved (`false` → `true`); the nine-member
    family (`alwaysStrict`, `noImplicitAny`, `noImplicitThis`,
    `strictBindCallApply`, `strictBuiltinIteratorReturn`,
    `strictFunctionTypes`, `strictNullChecks`, `strictPropertyInitialization`,
    `useUnknownInCatchVariables`) is intact. One membership nuance did
    change: `alwaysStrict` is now assumed `true` and **cannot be disabled**
    under TS 7 (it remains a family member, just no longer individually
    toggle-off-able).
  - REPO-IMPACT: `references/typescript-configuration.md:32` fixed to note
    the `alwaysStrict` exception (2026-09-08 remediation §3). Same file's
    strict-family list at `:29-31` was also missing `noImplicitThis`
    (8 of 9 members listed) — a transcription error independent of any TS 7
    delta, also fixed. `tsconfig.base.json:9`'s explicit `"strict": true`
    stays load-bearing under the pinned 6.0.3; becomes redundant-but-harmless
    under TS 7.
- NEW: `target: es5`, `baseUrl`, `moduleResolution: classic`/`node`/`node10`,
  `module: amd/umd/systemjs/none` all **removed** in TS 7.0; `rootDir`
  defaults to `./`; `types` defaults to `[]` (was `["*"]`);
  `noUncheckedSideEffectImports` defaults `true` — 7.0 GA/RC posts (tier T1)
  - REPO-IMPACT: none — `tsconfig.base.json` and every `packages/*/tsconfig*.json`
    confirmed clean against every item (Outstanding drift #5 above).

### Modules, ESM & Node interop

- CLAIM: relative imports require an explicit `.js` extension under
  `nodenext` because `tsc` does not rewrite extensions —
  <https://www.typescriptlang.org/docs/handbook/modules/reference.html>
  (tier T1)
  - VERDICT: UNCHANGED (re-fetched 2026-09-08)
  - REPO-IMPACT: none — `tsconfig.base.json:7-8`, `.claude/hooks/guard-js-extension.mjs:14`,
    `eslint.config.js:80-84` all remain correct. 7.0's module-related
    breaking changes (removed `node`/`node10`/`classic` resolution, forced
    `esModuleInterop`/`allowSyntheticDefaultImports: true`, `assert` import
    syntax banned in favor of `with`) all push toward `nodenext`, which this
    repo already sets.
- CLAIM: does `rewriteRelativeImportExtensions` change the necessity of the
  `.js` extension? — <https://www.typescriptlang.org/tsconfig/> (tier T1)
  - VERDICT: UNCHANGED — it does not. It rewrites `./x.ts` → `./x.js` at
    emit time (released TS 5.7); an extension is still mandatory either way,
    it just changes which one is written in source. Its purpose is the
    run-`.ts`-directly workflow (Node type-stripping, ts-node); this repo
    compiles with `tsc` to ESM `dist/` and never executes `.ts` directly, so
    that workflow doesn't apply here.
  - REPO-IMPACT: none — not set anywhere in the repo (confirmed by grep,
    prose-only hits).
- CLAIM: `erasableSyntaxOnly` — a Node-relevant compiler flag — <https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html>
  (tier T1)
  - VERDICT: RESOLVED — errors on `enum`, `namespace`/`module` with runtime
    code, constructor parameter properties, and non-ECMAScript `import =`/
    `export =`; recommended paired with `verbatimModuleSyntax` (already set,
    `tsconfig.base.json:14`).
  - REPO-IMPACT: now set on all 17 `scripts/*/tsconfig.build.json` files
    (2026-09-08 remediation §7, Outstanding drift #7 above); still correctly
    absent from the four `packages/*/tsconfig.build.json` files, which
    legitimately use parameter properties.
- CLAIM: Node type-stripping stability status — <https://nodejs.org/api/typescript.html>
  (tier T1, co-normative)
  - VERDICT: RESOLVED — Stability 2 (Stable), default since v23.6.0/v22.18.0,
    stable since v24.12.0/v25.2.0. Unsupported-syntax list also expanded
    (Outstanding drift #6 above: import aliases and decorators added to the
    previously recorded enum/namespace/parameter-property list).
  - REPO-IMPACT: none direct — this repo never executes `.ts` under Node —
    but the `>=24` floor still admits pre-stable 24.0–24.11.
- NOTE — two-owner divergence, surfaced not resolved: Node's page prescribes
  `erasableSyntaxOnly: true` **and** `rewriteRelativeImportExtensions: true`
  with mandatory `.ts`-in-specifier imports, for its run-`.ts`-directly
  workflow; Microsoft's tsconfig reference describes both flags neutrally
  with no such recommendation. Not a factual contradiction — Node is
  prescribing for its own workflow — but any future doc asserting "the
  recommended tsconfig" must say whose. No repo file currently makes a
  merged claim.

### Packaging & declaration emit

- CLAIM: an exported `satisfies` expression fails `isolatedDeclarations`
  (TS9010), so `.claude/rules/scripts.md` mandates "annotate, never
  `satisfies`" — <https://www.typescriptlang.org/tsconfig/isolatedDeclarations.html>,
  the TS 5.5 release notes (tier T1)
  - VERDICT: UNCHANGED (re-fetched 2026-09-08) — confirmed negative, see
    Outstanding drift #3 above for the full derivation and its honesty flag.
  - REPO-IMPACT: none — `.claude/rules/scripts.md:82-84,161-164`,
    `.claude/rules/tests.md:121-124`, `.claude/agents/code-implementer.md:78-79`
    all remain correct as written.
- CLAIM: `check:exports` runs `publint` and `attw --pack ... --profile
esm-only` against `packages/m3l-common` — <https://arethetypeswrong.github.io/>,
  <https://publint.dev/rules> (tier T2)
  - VERDICT: CHANGED (re-fetched 2026-09-08)
  - NOW: the attw CLI README states verbatim that "the `--pack` option does
    not support package managers other than npm at this time" and directs
    pnpm users to "generate the tarball yourself first (using `pnpm pack`)
    and then run `attw <packed-tarball-name>`". This repo is pnpm-managed
    end to end (ADR-0001) with no npm lockfile. The `--profile esm-only`
    choice itself is confirmed current and correct — only the packing
    mechanism was wrong. `publint`'s current rule set (~52 rules, 25
    error/17 warning/10 suggestion) and attw's three profile names
    (`strict`/`node16`/`esm-only`) are otherwise unchanged.
  - REPO-IMPACT: `package.json:56` fixed (2026-09-08 remediation §5) — now
    `node bin/check-exports.mjs`, which packs via `pnpm pack` into a temp
    dir and runs `attw` with the same `esm-only` profile against the
    resulting tarball directly. Verified end-to-end both directions: passes
    clean against the real package, and fails (exit 1) against a
    deliberately broken `exports["."].types` path, confirming the gate can
    still catch a real regression.
- COVERAGE GAP (unresolved): typescript-eslint documents no `satisfies`-
  specific carve-out anywhere; the negative conclusion above rests on
  indirect derivation, not a direct T1 statement.

### Lint & typing rules

- CLAIM: `eslint.config.js` spreads `tseslint.configs.recommendedTypeChecked`
  — <https://typescript-eslint.io/users/configs/> (tier T2 — scope limit:
  citable because this repo's own `eslint.config.js:49` composes the preset,
  not independent commentary on TypeScript itself)
  - VERDICT: UNCHANGED (re-fetched 2026-09-08) — confirmed true; see
    Outstanding drift #4 above for the full measurement.
  - REPO-IMPACT: none to the choice itself this sweep — measured, not
    adopted. See Outstanding drift #4.
- NEW: typescript-eslint's declared supported TypeScript range is
  `>=4.8.4 <6.1.0` — <https://typescript-eslint.io/users/dependency-versions/>
  (tier T2)
  - This **excludes TypeScript 7 entirely** (the upper bound is exclusive of
    6.1.0). No explicit published TS 7/tsgo stance exists on
    typescript-eslint.io — the exclusion is implicit in the version range.
  - REPO-IMPACT: `package.json:164` (`typescript: 6.0.3`) is inside the
    supported range — correct today. This is the primary evidence for
    Outstanding drift #1's "deliberate hold" reframing.
- NEW: preset lineup confirmed current, no renames/deprecations — tiers
  `recommended`/`recommendedTypeChecked`, `strict`/`strictTypeChecked`,
  `stylistic`/`stylisticTypeChecked`, plus `all`/`base`/`eslintRecommended`/
  `disableTypeChecked` and the `*TypeCheckedOnly` variants —
  <https://typescript-eslint.io/users/configs/>,
  <https://typescript-eslint.io/rules/> (tier T2)
  - `strictTypeChecked` adds 26 rules over `recommendedTypeChecked` +
    `strict`; `no-non-null-assertion` (one of the 26) is already hand-enabled
    at `eslint.config.js:88`. `stylisticTypeChecked` adds 21 (6 type-aware,
    15 not). Neither preset supplies the repo's own `.js`-extension or
    CommonJS bans (`import-x/extensions`, `import-x/no-commonjs`,
    `no-restricted-globals` at `eslint.config.js:80,103,109`) — those stay
    exactly as-is regardless of preset adoption.
  - REPO-IMPACT: informs Outstanding drift #4's measurement; no config
    change made.
- COVERAGE GAP (unresolved): exact per-rule **option defaults** for
  `strictTypeChecked` vs. `recommendedTypeChecked` are not inlined on
  typescript-eslint.io and the plugin's config source lives in a GitHub repo
  outside this sweep's allowlist; `node_modules` was not installed for the
  facet spoke. The measurement run in Outstanding drift #4 resolves this
  empirically for the two presets tested, but not exhaustively for every
  rule's option shape.

### Language features & deprecations

First-run facet — no prior claims existed to diff; every finding below is
`NEW`. See "No drift found" above for the const-type-parameter /
`using`/decorators/enum/namespace findings (all upstream-unchanged, repo
usage census done). Two additional findings:

- NEW: TS 7.0 removals beyond the previously-recorded four (`target: es5`,
  `downlevelIteration`, amd/umd/systemjs resolution, `baseUrl`): `--outFile`
  removed; `moduleResolution: classic` removed outright;
  `esModuleInterop`/`allowSyntheticDefaultImports` can no longer be set
  `false`; `alwaysStrict: false` disallowed; `asserts` import-attribute
  keyword removed (use `with`); `/// <reference no-default-lib />` no longer
  respected; `stableTypeOrdering` defaults `true` and is not disableable;
  `libReplacement` defaults `false`; CLI file paths forbidden alongside a
  `tsconfig.json` unless `--ignoreConfig`; JSDoc `@enum`/`@class`/postfix-`!`/
  Closure syntax discontinued; **no programmatic compiler API until 7.1** —
  <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>,
  its RC post (tier T1)
  - REPO-IMPACT: none — `tsconfig.base.json` already sets
    `noUncheckedSideEffectImports: true` and `verbatimModuleSyntax: true`;
    no `outFile`, no `asserts` import syntax, no `no-default-lib` reference
    anywhere in the repo.
- NEW: TS 6.0 **deprecated**, then TS 7.0 **removed**, the same items
  (escapable in 6.0 via `"ignoreDeprecations": "6.0"`) — 6.0 GA post (tier
  T1)
  - REPO-IMPACT: none — useful sequencing precedent for any future
    migration, but this repo's config was already clean of every deprecated
    item before the 6.0→7.0 transition.
- COVERAGE GAP (unresolved): no dedicated Handbook page for `using`/explicit
  resource management was located within the allowlist (the canonical
  writeup lives in the TS 5.2 release post, not fetched this sweep); the
  Decorators Handbook page documents only the legacy Stage 2 form, so Stage 3
  semantics (decorator metadata, `accessor` keyword, ordering) are
  unverified — immaterial today given zero repo decorator usage, but a real
  gap if decorators are ever adopted.
- COVERAGE GAP (unresolved): no upstream design-note or release post
  explains why `esnext.disposable` has not been folded into a stable
  `esYYYY` lib, or names a target version — `M3LLogger.ts:378`'s "not yet"
  framing is unverifiable upstream beyond its present-tense factual half.
