# First real refreshing-typescript-guidance sweep

**Status: shipped** — PR #1132.

## Context

`docs/research/typescript/refresh.md` and the `refreshing-typescript-guidance`
skill shipped together in PR #1129 (see
[`2026-09-08-typescript-guidance-skills.md`](./2026-09-08-typescript-guidance-skills.md)),
but the tracker was **seeded**, not swept — every facet claim carried verdict
`UNVERIFIED`, a read of the repo against upstream's state without the actual
five-agent fan-out. `refreshing-typescript-guidance`'s own Step 1 explicitly
calls this out: a seeded `UNVERIFIED` claim is one the first real run must
resolve, not read as already confirmed. This PR is that first real run.

## Approach / Decisions

Ran the skill end to end: read the seeded tracker and the shared
`researching-typescript-guidance/references/typescript-sources.md`
allowlist, built the release delta (empty — TypeScript 7.0.2, published
2026-08-20, was already the newest release the seed recorded), then fanned
out all five fixed facets in parallel against T1/T2 sources only. Every
`REPO-IMPACT` a facet spoke reported was independently re-verified by the
hub against the cited file — this caught real problems no facet spoke
found on its own: `references/typescript-configuration.md`'s wrong `target`
value (`es2024` vs the actual `es2025`) and its missing `noImplicitThis`
strict-family member, and the skill's own "four `tsconfig.build.json`
files" undercount (there are 21).

The headline finding closed the tracker's largest open item as a **negative**:
typescript-eslint declares support for `>=4.8.4 <6.1.0`, excluding TypeScript
7 entirely, and TS 7 ships no stable programmatic compiler API until 7.1 —
since `eslint.config.js` makes every lint run type-aware via
`projectService: true`, moving to TS 7 today would break linting repo-wide.
"The repo is a major behind" reframed from unresolved drift into a named,
evidenced blocker with an explicit re-check trigger, rather than either
ignoring it or reaching for an unsafe upgrade.

Two decisions taken beyond the sweep's own remit, both explicitly authorized
by the approved plan rather than discovered mid-flight:

- **Measure, don't guess, the unrevisited `recommendedTypeChecked` choice.**
  Ran `strictTypeChecked`/`stylisticTypeChecked` against the real codebase
  via a throwaway config (deleted after use) instead of estimating —
  373/342 findings against `packages/m3l-common`, dominated by different
  rules than expected (`no-meaningless-void-operator`,
  `no-empty-function`/`non-nullable-type-assertion-style`, not the
  predicted `no-deprecated`). Recorded as measured-not-adopted; no config
  changed.
- **Investigate, then adopt, `erasableSyntaxOnly` for `scripts/*`.** A
  precise grep of all 208 files across every `scripts/*/src` found zero
  occurrences of the five constructs the flag rejects (enum, runtime
  namespace, decorators, parameter properties, import aliases) — a clean
  yes per the plan's own gate — so all 17 `scripts/*/tsconfig.build.json`
  files now set it, verified against a full `pnpm typecheck` pass.

Landed as four commits: `fix(exports)` (the `attw --pack`/pnpm
incompatibility — attw's own README documents `--pack` as npm-only, and
this repo has no npm lockfile), `feat(scripts)` (the `erasableSyntaxOnly`
adoption), `docs(typescript)` (the tracker rewrite plus the two reference-doc
fixes), and `docs: reconcile doc metadata` (`/syncing-docs`'s
`docs/adr/provenance.json` re-stamp).

## Outcome

`docs/research/typescript/refresh.md` now carries a real first sweep instead
of a seed — every facet has an actual verdict, and the tracker's Outstanding
drift list reflects genuine open items (the lint-preset measurement, the
three still-stale Context7 snapshots) rather than unresolved placeholders.
`check:exports` no longer depends on `npm` being on `PATH`. All 17
`scripts/*` packages compile under `erasableSyntaxOnly`. Full narrative
(the WSL/lint OOM recurrence inside both `pnpm verify` and the `pre-push`
hook itself, worked around the same way the prior sweep-skill PR's log
already recorded — a raised `NODE_OPTIONS --max-old-space-size`, never
`--no-verify`) is not separately logged; this archive entry is the durable
record.
