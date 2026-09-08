---
name: refreshing-typescript-guidance
description: >-
  Periodic sweep of this repo TypeScript toolchain — tsconfig flags, module
  and ESM resolution, declaration emit and packaging, typed-lint presets,
  language features — against the compiler releases shipped since the last
  sweep, then plans remediation. Use for /refreshing-typescript-guidance,
  "are we behind on TypeScript", "did TS 7 move our defaults".
---

Sweep this repo's TypeScript-facing surface against upstream TypeScript's
current state and diff it against what was true the last time this ran, then
enter plan mode with a remediation plan. **No `tsconfig*.json`, `eslint.config.js`,
rule, or hook file is edited by this skill** — the only write is the tracker
(Step 5); every actual fix goes through the user-approved plan, the same as
`auditing`.

**This skill must only run in the main (hub) agent, never inside a
subagent.** Step 6 calls `EnterPlanMode`, and Step 3 dispatches subagents via
the Agent tool; spokes carry `disallowedTools: Agent` and cannot do either. If
you find yourself executing this skill as a subagent inside a larger task,
stop and surface the refresh request back to the hub instead.

## Why this exists, not just `researching-typescript-guidance`

That skill answers "what does upstream say about X" once, for whatever X the
invoking task names. Nothing in the repo ever asks the inverse question — is
what's _already configured_ still what upstream ships? This repo hardcodes a
lot of compiler-owned surface: 20+ options in `tsconfig.base.json`,
`isolatedDeclarations` across every `tsconfig.build.json` except
`m3l-console-web`'s (which Vite, not `tsc`, ships from), the
`.js`-extension rule `guard-js-extension.mjs` enforces, `.claude/rules/scripts.md`'s
"annotate, never `satisfies`" ban, `eslint.config.js`'s unrevisited
`recommendedTypeChecked` preset choice, and `attw --profile esm-only` in
`check:exports`. None of the repo's `check:*` gates compare any of it to
upstream. `check:reference-freshness` comes closest and is **structurally
unable to**: it compares a snapshot's `tracks=` stamp against the **local
`package.json`**, so `tracks=typescript@6.0.3` reads perfectly clean while
both the pin and the snapshot sit a full major behind TypeScript 7. That gate
notices when _we_ move; this skill notices when _upstream_ moved.

## Steps

### 1 — Read the tracker and establish anchors

Read `docs/research/typescript/refresh.md` in full. Its header comment
(`<!-- typescript-refresh: last-verified=<date> typescript-version=<version> -->`)
gives the last-verified date and the newest **upstream** TypeScript version
the last sweep saw — deliberately _not_ the repo's own pin (that's
`package.json`'s job, and conflating the two is how the tracker's diff
baseline goes wrong). Its body gives the recorded claim, source, and tier for
every facet checked last time. This is what turns a sweep into a **diff**
instead of a rediscovery — Step 3's agents check "does this claim still
hold" rather than re-deriving everything from scratch. A claim seeded with
verdict `UNVERIFIED` is not yet diffable — it is a claim this run must
resolve for the first time, not read as already-confirmed.

If the tracker doesn't exist yet or has no entries for a facet, treat that
facet as first-run: no prior claims to diff against, only `NEW` findings.

Read
[`../researching-typescript-guidance/references/typescript-sources.md`](../researching-typescript-guidance/references/typescript-sources.md)
(shared with `researching-typescript-guidance` — edit that file, not this
one, when the tiering or allowlist changes). State today's date; every agent
brief in Step 3 needs it as the current-date anchor per that file.

Derive the run directory: `<session-scratchpad-dir>/ts-refresh-<today's-date>/`.

### 2 — Build the release delta

`WebFetch` `https://devblogs.microsoft.com/typescript/` (the release-announcement
index) and `https://github.com/microsoft/TypeScript/releases`. Extract every
release newer than the tracker's recorded `typescript-version`. This delta
gets passed into **all five** facet briefs in Step 3 as shared input — it is
not a sixth facet — so agents know specifically what changed recently,
rather than re-reading docs that haven't moved. Standing note to include in
every brief: `github.com/microsoft/TypeScript/wiki/Breaking-Changes` is
stale at TS 4.9 — get breaking changes from the devblog release posts, never
from that wiki page. If the devblog is unreachable, note it as a coverage
gap for this run and proceed with the remaining sources — don't block the
whole sweep on one fetch.

### 3 — Fan out five fixed facets (parallel)

Spawn all five agents **in a single message** so they run concurrently — the
facets are fixed, not derived per-run, so sweeps stay comparable to each
other and the tracker stays diffable over time. Each facet maps to concrete
repo files the agent must check the fetched guidance against:

| Facet slug                       | What it validates against upstream TypeScript                                                                                                                            | Repo files to check                                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compiler-config-flags`          | tsconfig option semantics, strict-family flag membership, defaults that moved in TS 7                                                                                    | `tsconfig.base.json`; every `packages/*/tsconfig{,.build}.json`; `.claude/skills/typescript-configuration/SKILL.md`'s strict-membership claim and its `references/typescript-configuration.md`                                                                                                |
| `modules-esm-node-interop`       | `nodenext` resolution, the required `.js` extension, `rewriteRelativeImportExtensions`, `erasableSyntaxOnly`, Node type-stripping stability (nodejs.org co-normative T1) | `tsconfig.base.json`'s module settings; `.claude/hooks/guard-js-extension.mjs`; `.claude/hooks/guard-no-commonjs.mjs`; `.claude/rules/library-src.md`; `eslint.config.js`'s `import-x/extensions`                                                                                             |
| `packaging-declaration-emit`     | `isolatedDeclarations` limitations (has the exported-`satisfies` restriction relaxed?), attw/publint semantics                                                           | every `tsconfig.build.json` except `m3l-console-web`'s (4 packages + 17 scripts as of 2026-09-08 — reconfirm the count, this set grows with every new package/script); `.claude/rules/scripts.md`'s "annotate, never `satisfies`"; `package.json`'s `check:exports`; `bin/check-dts-deps.mjs` |
| `lint-typing-rules`              | typescript-eslint preset composition, the unrevisited `recommendedTypeChecked` choice                                                                                    | `eslint.config.js`; `.claude/skills/eslint-flat-config/references/eslint-flat-config.md`'s stamp                                                                                                                                                                                              |
| `language-features-deprecations` | new/emerging surface (const type parameters, `using`/explicit resource management, decorators), upstream deprecations                                                    | `packages/*/src/**` usage patterns; `docs/contributing/style-guide.md`; `.claude/rules/library-src.md`                                                                                                                                                                                        |

Each agent brief carries:

- The facet's row from the table above (what to check, which files).
- The Step 2 release delta.
- The tracker's recorded claims for this facet from Step 1 (if any),
  including whether each is `UNVERIFIED` (a seeded claim never yet checked)
  or already diffed once (`UNCHANGED`/`CHANGED` from a prior real sweep).
- The two-tier allowlist, GitHub caveat (`microsoft` org), and current-date
  anchor from `references/typescript-sources.md`.
- The run directory and exact filename: `<run-dir>/<facet-slug>.md`.
- The **verbatim per-claim verdict format** to write to its scratchpad file:

  ```
  ## Refresh: <facet name>
  - CLAIM: <recorded claim from the tracker> — <url> (recorded <old date>, tier <T1|T2>)
    - VERDICT: UNCHANGED | CHANGED | GONE   (re-fetched <today>)
    - NOW: <what the page says today — only if CHANGED>
    - REPO-IMPACT: <file:line this invalidates, or "none">
  - NEW: <guidance found with no recorded prior claim> — <url> (tier <T1|T2>)
    - REPO-IMPACT: <file:line, or "none">
  ```

  `GONE` (the URL 404s, redirects to unrelated content, or the claim is no
  longer findable on the page) matters as much as `CHANGED`. Two concrete
  cases to watch for in this corpus: the Breaking-Changes wiki (known stale,
  see Step 2) and `microsoft/typescript-go` (archived 2026-09-01, now
  redirects to `microsoft/TypeScript`) — confirmed cited nowhere in this
  repo as of the tracker's last sweep; record that as a `NEW: no drift`
  finding if a claim references it, so a future sweep doesn't re-derive the
  same negative result.

- The **return-value instruction**: after writing the full file, return only
  a compact digest — facet name, counts of UNCHANGED/CHANGED/GONE/NEW, and
  one line per item with a non-`none` REPO-IMPACT — plus the scratchpad file
  path. Full findings stay in the file.

Use `subagent_type: "Explore"` with breadth `"very thorough"` for every
agent. Do not write any files yourself in this step.

### 4 — Aggregate

Read every scratchpad file in the run directory **in full** — digests are for
triage, not judgment; a verdict's exact wording and the file:line it cites
matter for the plan. Group findings into:

1. **Confirmed drift with repo impact** — a `CHANGED` or `GONE` verdict, or a
   `NEW` item, whose `REPO-IMPACT` names a real file:line. Verify each one
   yourself against that file before treating it as real — an agent can
   misread a page or cite a file that doesn't say what it claims.
2. **Guidance changes with no repo impact** — worth recording in the tracker
   so a later run doesn't re-flag them, but nothing to act on now.
3. **Dead or moved URLs** (`GONE`) — flag for a citation fix wherever they're
   referenced, independent of whether the underlying guidance changed.
4. **Coverage gaps** — a facet where a source was unreachable or nothing
   qualifying was found this run.

Write a concise aggregated summary using the same theme-grouped,
prefix-preserved style as `auditing` Step 3 — this keeps the two skills'
output scannable the same way.

### 5 — Update the tracker

This is the skill's only write outside plan mode. Update
`docs/research/typescript/refresh.md` in place (not a new dated file):

- Bump the header comment's `last-verified` to today and `typescript-version`
  to the newest release seen in the Step 2 delta.
- For every claim checked this run, update its recorded claim, URL, tier, and
  retrieved date under the source's facet section — whether the verdict was
  UNCHANGED (just bump the date), CHANGED (replace the claim with what the
  page says now), or the seed's `UNVERIFIED` resolving to a real verdict for
  the first time.
- Add any `NEW` sources found.
- Update the outstanding-drift list: remove items resolved since the last run
  (the user will confirm resolution status), add newly confirmed drift from
  Step 4.1.

**Do not duplicate reference-freshness tracking.** When this sweep confirms
drift touching a Context7-sourced snapshot
(`.claude/skills/typescript-configuration/references/typescript-configuration.md`,
`.claude/skills/eslint-flat-config/references/eslint-flat-config.md`,
`.claude/skills/vitest-testing/references/vitest-testing.md`), record it here
as drift **and** carry it into Step 6's plan as a "re-pull the snapshot via
context7 MCP and re-stamp `<!-- reference-freshness: ... -->`" item (ADR-0093's
existing mechanism). Never re-stamp a snapshot from this skill: the stamp
asserts what a Context7 pull returned, and this skill doesn't pull from
Context7. The two mechanisms answer different questions — the stamp tracks
the local pin against the snapshot; this tracker tracks the snapshot against
upstream.

### 6 — Enter plan mode

Call `EnterPlanMode` with a remediation plan, one section per confirmed-drift
item from Step 4.1, mirroring `auditing`'s Step 5 structure: context section,
numbered implementation sections (what to fix, where, how to verify), a
verification checklist. This skill never edits `tsconfig*.json`,
`eslint.config.js`, rules, or hooks itself outside the tracker — every
harness edit stays human-approved through the plan.

If Step 4 found no confirmed drift, skip plan mode and report a clean sweep
instead — updating the tracker (Step 5) is still worth doing so the next run
has a fresh baseline.
