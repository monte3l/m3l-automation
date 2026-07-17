# Fleet governance enforcement tooling T1-T7 (2026-07-16)

**Status: shipped** (PRs #135, #136, #137, #138, #139, #142)

## Context

[2026-07-15-fleet-governance-reconciliation.md](2026-07-15-fleet-governance-reconciliation.md)
audited the shipped `dynamo-crud`/`sqs-etl`/`logs-insights` fleet, ratified
ADR-0028 (AWS-scoped units carry full official service names) and ADR-0029
(scripts depend only on `@m3l-automation/m3l-common`), and scheduled seven
follow-ups — T1–T7 — as tracked rows in `docs/ROADMAP.md` rather than
executing them in that pass (it was deliberately documentation-only). This
plan is where T1–T7 actually got executed: three renames plus four
enforcement/tooling items turning the two ADRs from prose conventions into
machine-checked gates, so future drift is caught automatically rather than
relying on the next audit to catch it. Every item locks in already-correct
state — the value is preventing the _next_ regression, not fixing a current
one. Two of the four tooling items (T4 count-site coverage, T7 the synthetic
`deriveCounts()` test) also closed latent gaps the 2026-07-13 aws-sqs work
log had flagged.

## Approach / Decisions

- T1–T3 (renames `dynamo-crud → dynamodb-crud`, `logs-insights →
cloudwatch-logs-insights` for both the script and the `aws/logs-insights`
  submodule) landed first and cleared the ADR-0028 noncompliance ledger.
- T4–T7 shipped as three themed PRs — A (T4+T7), B (T5), C (T6) — landed
  sequentially, each rebased onto the updated `main`, since all new/changed
  test files live under `bin/tests/**` and each PR needed an isolated branch
  to satisfy the `**/tests/**` write guard.
- **PR A (T4+T7):** added the untracked count literals to
  `bin/lib/count-sites.mjs` — an AWS-barrel-comment site mirroring the
  existing Core-barrel site, and paired numerator/denominator sites for the
  colocated `N/N` header literals in `docs/ROADMAP.md`. Added a synthetic
  `deriveCounts()`-bump test proving every site tracks an injected value
  rather than hardcoding a denominator that's "correct until the next
  module."
- **PR B (T5):** a scaffold-naming check enforcing ADR-0028 via a
  **denylist of known-bad abbreviations** (`dynamo`, `cfn`, `apigw`, …) and
  bare-capability names missing their service (`logs-insights` without
  `cloudwatch`), wired into both `scaffold-script.mjs` (block at creation)
  and `check-script-scaffold.mjs` (catch drift). An allowlist was
  deliberately deferred — it would need a service vocabulary that doesn't
  exist yet.
- **PR C (T6):** a script-dependency boundary check enforcing ADR-0029 —
  both a new `bin/check-script-deps.mjs` (asserts each
  `scripts/*/package.json` depends on exactly `@m3l-automation/m3l-common`
  at `workspace:*`, no `devDependencies`) and an ESLint `no-restricted-imports`
  hardening in the existing `scripts/*/src/**/*.ts` block, banning any bare
  import except the library and `node:` builtins.
- All new checks were kept **CI-only** (not added to `lefthook.yml`
  pre-push), matching the existing `check:deps` precedent, so no
  `check:cadence` CLAUDE.md table edit was needed.

## Outcome

`pnpm check:doc-counts`/`check:impl-counts` now track the AWS-barrel and
ROADMAP header counts; `pnpm check:script-scaffold` rejects
ADR-0028-noncompliant names; `pnpm check:script-deps` plus the ESLint
hardening enforce the ADR-0029 dependency boundary. All Governance
follow-ups T1–T7 tracked by
[2026-07-15-fleet-governance-reconciliation.md](2026-07-15-fleet-governance-reconciliation.md)
are closed.
