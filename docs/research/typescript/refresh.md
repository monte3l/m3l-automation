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

## Seeding note

This is a **seeded first sweep**, not a full agent-driven run: the facets
below record what a read of the repo against upstream's 2026-09-08 state
establishes without a five-agent fan-out. `refreshing-typescript-guidance`'s
first real run should diff against these entries rather than treat them as
already verified — every claim below marked `UNVERIFIED` is a claim to
resolve, not to skip. Facets 4 and 5 carry the thinnest coverage; they are
the first sweep's highest-value target.

## Outstanding drift

1. **The repo is a full TypeScript major behind.** `package.json`
   devDependencies pins `typescript@6.0.3`; TypeScript 7.0 has been GA since
   2026-07-08 (Go-native compiler now mainline; latest ~7.0.2). Every claim in
   facets 1-3 below is stated against 6.0.3 behavior and needs re-verifying
   against 7.x before it can be trusted. Blocks nothing today; blocks
   everything downstream in this tracker.
2. **Three Context7 reference snapshots are stamp-clean but upstream-stale.**
   `.claude/skills/typescript-configuration/references/typescript-configuration.md`
   (`library=/microsoft/typescript/v6.0.2 tracks=typescript@6.0.3
snapshot=2026-09-05 refresh=major`),
   `.claude/skills/eslint-flat-config/references/eslint-flat-config.md`
   (`tracks=eslint@10.9.1,typescript-eslint@8.69.0`), and
   `.claude/skills/vitest-testing/references/vitest-testing.md`.
   `check:reference-freshness` compares each stamp's `tracks=` against the
   **local `package.json`** only, so all three pass while sitting a major
   behind upstream — a structural blind spot in that gate, not a bug in it.
   Remediation route: re-pull via context7 MCP and re-stamp (ADR-0093),
   **from the plan a sweep produces, never from the sweep itself.**
3. **`typescript-configuration/SKILL.md` asserts strict-family membership
   that TS 7 may have moved.** Its "Two extra strict flags are set _on top_
   because they're **not** part of `strict`" claim (`noUncheckedIndexedAccess`,
   `exactOptionalPropertyTypes`) is stated against TS 6. TS 7 changed
   `strict`'s **default** to `true`; whether it changed `strict`'s
   **membership** is unverified. The same claim is duplicated in
   `references/typescript-configuration.md`.
4. **`eslint.config.js`'s `tseslint.configs.recommendedTypeChecked` choice
   has never been revisited.** No record exists of `strictTypeChecked`/
   `stylisticTypeChecked` having been considered and rejected. Not drift
   against upstream — an _unexamined_ choice, which facet 4 exists to
   examine.
5. **`.claude/rules/scripts.md`'s "Annotate, never `satisfies`" may be
   over-broad.** The rule encodes an `isolatedDeclarations` limitation (it
   rejects an exported `satisfies` expression, TS9010) that may have relaxed
   in TS 7. Blast radius: four `tsconfig.build.json` files plus
   `.claude/rules/tests.md`'s TS9010 bullet and `.claude/agents/code-implementer.md`.
6. **`tsconfig.base.json` is provisionally 7.0-clean, unverified.**
   `target: es2025` (unaffected by the `target: es5` removal); no `baseUrl`
   set (unaffected by its removal); build projects set `rootDir: src`
   explicitly (unaffected by the new `./` default); `types: ["node"]` is
   explicit (now the _correct_ form under TS 7's `[]` default, formerly
   redundant under the old `["*"]` default). Recorded so the first real
   sweep confirms rather than rediscovers.
7. **Neither `erasableSyntaxOnly` nor `rewriteRelativeImportExtensions` is
   set anywhere in the repo.** Both are named in
   `typescript-configuration/references/typescript-configuration.md` as
   options that exist. Whether either _should_ be set — given ESM-only +
   Node 24+ + `guard-js-extension.mjs` already enforcing explicit `.js` — is
   an open question for facet 2, not a defect.

**Resolved since the last sweep:** none — this is the first sweep.

**No drift found (recorded so it isn't re-derived):** `microsoft/typescript-go`
is cited **nowhere** in this repo (grepped `docs/`, `.claude/`, `packages/`,
`scripts/`, `bin/` on 2026-09-08). Its 2026-09-01 archival (it now redirects
to `microsoft/TypeScript`) therefore has zero repo impact.

## Facets

### Compiler config & flags

- CLAIM: `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are set
  in `tsconfig.base.json` on top of `strict: true` because they are not part
  of the `strict` umbrella — `typescript-configuration/SKILL.md`
  (recorded 2026-09-08, tier T1, typescriptlang.org tsconfig reference)
  - VERDICT: UNVERIFIED (seeded 2026-09-08, not re-fetched against TS 7's
    tsconfig reference)
- CLAIM: `target: es2025`, `module`/`moduleResolution: nodenext`,
  `verbatimModuleSyntax: true`, `isolatedModules: true`, `skipLibCheck: true`
  are all set in `tsconfig.base.json` (recorded 2026-09-08, tier T1)
  - VERDICT: UNVERIFIED (seeded 2026-09-08 — provisionally 7.0-clean per
    Outstanding drift item 6, not re-fetched)
- COVERAGE GAP: whether TS 7's `strict` default change or `types: []` default
  change materially affects this repo's explicit settings has not been
  fetched from devblogs.microsoft.com/typescript's 7.0 announcement.

### Modules, ESM & Node interop

- CLAIM: relative imports require an explicit `.js` extension under
  `nodenext` because `tsc` does not rewrite extensions
  (`guard-js-extension.mjs`, `library-src.md`; recorded 2026-09-08, tier T1)
  - VERDICT: UNVERIFIED (seeded 2026-09-08 — `rewriteRelativeImportExtensions`
    exists upstream and is not adopted here; whether that changes the
    necessity claim is unresolved)
- NEW: `erasableSyntaxOnly` — a Node-relevant compiler flag not set anywhere
  in this repo (tier T1, co-normative — nodejs.org/api/typescript.html)
  - REPO-IMPACT: none confirmed; open question for the first real sweep
- NEW: `rewriteRelativeImportExtensions` — not set anywhere in this repo
  (tier T1)
  - REPO-IMPACT: none confirmed; open question for the first real sweep
- COVERAGE GAP: Node's type-stripping stability status (stable since which
  Node version) has not been fetched from nodejs.org/api/typescript.html.

### Packaging & declaration emit

- CLAIM: an exported `satisfies` expression fails `isolatedDeclarations`
  (TS9010) under `tsconfig.build.json`, so `.claude/rules/scripts.md`
  mandates "annotate, never `satisfies`" (recorded 2026-09-08, tier T1)
  - VERDICT: UNVERIFIED (seeded 2026-09-08 — Outstanding drift item 5; this
    is the highest-value single claim for the first real sweep to resolve,
    since it gates a live authoring rule)
- CLAIM: `check:exports` runs `publint` and `attw --pack ... --profile
esm-only` against `packages/m3l-common` (recorded 2026-09-08, tier T2)
  - VERDICT: UNVERIFIED (seeded 2026-09-08, not re-fetched against current
    attw/publint rule versions)
- COVERAGE GAP: whether `isolatedDeclarations`'s `satisfies` restriction has
  relaxed in any TS 6.x or 7.x release has not been fetched from
  devblogs.microsoft.com/typescript.

### Lint & typing rules

- CLAIM: `eslint.config.js` spreads `tseslint.configs.recommendedTypeChecked`
  (recorded 2026-09-08, tier T2 — typescript-eslint.io)
  - VERDICT: UNVERIFIED (seeded 2026-09-08 — this is Outstanding drift item
    4, an unexamined choice rather than confirmed drift; the first real
    sweep should establish what `strictTypeChecked`/`stylisticTypeChecked`
    would add before recommending anything)
- COVERAGE GAP: preset composition (exactly which rules `recommendedTypeChecked`
  includes versus the stricter presets) has not been fetched from
  typescript-eslint.io/users/configs.

### Language features & deprecations

- COVERAGE GAP: const type parameters — not fetched.
- COVERAGE GAP: `using`/explicit resource management — not fetched.
- COVERAGE GAP: decorators — not fetched.
- COVERAGE GAP: upstream deprecations/removals beyond the TS 7.0
  announcement's own list (`target: es5`, `downlevelIteration`, amd/umd/system
  module resolution, `baseUrl`) — no later release's deprecation list has
  been fetched.
