# 0015. Code-scanning tooling evaluation and supply-chain hardening

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Enrico Lionello

> **Update (2026-07-06).** The SBOM/provenance attestation described below lived
> in `release.yml`, which was removed with release automation
> ([ADR-0020](./0020-drop-release-automation.md)). The package is no longer
> published, so SBOM-at-release and npm provenance no longer apply. Everything
> else in this ADR (CodeQL, Scorecard, SHA-pinned Actions, Dependabot) stands.
>
> **Update (2026-08-13).** Two stale claims survived below the 2026-07-06
> Update, unswept, and a 2026-08 tracker-reconciliation audit found them:
>
> - The `## Decision` bullet "Attest a CycloneDX SBOM at release, alongside
>   the existing npm provenance" and the `## Consequences` line "releases
>   carry both provenance and an SBOM" (below) still read as live
>   obligations even though the 2026-07-06 Update above already made them
>   moot — the 2026-07-06 pass corrected this file's top summary but never
>   swept the body prose it was correcting. Treat both as historical record
>   of what was decided pre-ADR-0020 only; no SBOM or provenance step exists
>   or is planned, since there is no release/publish path to attest at
>   (ADR-0020).
> - The `## Context and problem statement` line "an 80% per-file coverage
>   gate" is the same stale claim `CLAUDE.md`/`.claude/rules/tests.md`
>   corrected in PR #325 (2026-08-12) — this copy was not swept. The
>   enforced gate is per-file thresholds (lines 90 / functions 83 /
>   branches 80 / statements 89, `perFile: true`), not a flat 80%.
>
> Both stale bullets are left in place below (this ADR's Decision/Context are
> a historical record, not a living spec) — this Update is the correction.
>
> **Update (2026-08-06).** GitHub's CodeQL default setup began reporting a
> single consolidated `CodeQL` check on Dependabot-actor PRs instead of the
> per-language `Analyze (javascript-typescript)` / `Analyze (actions)` checks
> this ADR originally wired as required. Because those two contexts never
> appeared on Dependabot PRs, every one of them sat permanently blocked
> despite passing every check that did run. Branch protection and the
> `main-dual-layer-protection` ruleset were repointed at the single `CodeQL`
> context, which reports reliably on both PR classes; human PRs are otherwise
> unaffected, still triggering full per-language analysis. Accepted tradeoff:
> `CodeQL` can report `neutral` on Dependabot PRs without a scan actually
> running (nothing to analyze in a manifest/lockfile-only diff) —
> `Dependency Review` and `pnpm audit` remain the substantive gate for that PR
> class. See `docs/contributing/branch-protection.md` for the current
> required-context list.

## Context and problem statement

GitHub surfaces a "code quality" / code-scanning feature and a marketplace of 70+
scanning tools (Dependency Review, SonarCloud, Semgrep, Snyk, Codacy, Codecov,
Trivy, and others). The question was whether adding any of them would bring **real**
value to this repository, or merely duplicate the gates already in place.

An audit of the live pipeline and the repository's GitHub security settings found
that the meaningful scanners are **already running**:

- **CodeQL SAST** — GitHub default setup is configured (JS/TS + Actions, `remote`
  threat model, weekly + per-PR). It has already caught and fixed a real
  `js/incomplete-sanitization` finding in `bin/check-doc-exports.mjs`.
- **Secret scanning** — four layers: a write-time hook, `gitleaks` in CI, GitHub
  native secret scanning, and push protection.
- **Dependency scanning** — `pnpm audit --audit-level=high`, the
  `dependency-review-action` (fail-on-high), the custom `check:deps` gate,
  Dependabot version updates, vulnerability alerts, and npm provenance at publish.
  The published package carries **zero runtime dependencies**.
- **Quality metrics** — ESLint (`recommendedTypeChecked`) enforcing complexity ≤ 10,
  max-depth ≤ 3, max-lines-per-function ≤ 60, no-magic-numbers, naming, and TSDoc;
  `tsc` in strict mode with the stricter flags; and an 80% per-file coverage gate.
  This already covers the core of what SonarQube provides.

So the residual value is not "more scanners" but **hardening the governance of what
already exists**, plus the one tool genuinely additive for a public, published
package.

## Decision drivers

- Avoid redundant tooling — each new gate must cover something not already covered.
- Minimal maintenance surface; prefer GitHub-native, config-level changes.
- Supply-chain integrity for a public npm package (published with provenance).
- Findings should be able to **block a merge**, not merely be advisory.

## Considered options

1. Adopt one or more marketplace platforms (SonarCloud, Semgrep, Snyk, Codacy,
   Codecov, Trivy).
2. Add nothing — the stack is already strong.
3. Harden governance of the existing scanners and add only the non-redundant tool
   (OpenSSF Scorecard) plus supply-chain hygiene (Action SHA-pinning, SBOM
   attestation).

## Decision

We chose **option 3**. Concretely:

- **Enable Dependabot security updates** — alerts were on, but automatic
  remediation PRs were disabled.
- **Make CodeQL code scanning and Dependency Review required status checks** on
  `main` — they ran but did not gate merges (only `verify` + `review` did).
- **Pin all GitHub Actions to commit SHAs** (with a trailing version comment) and
  add a `github-actions` Dependabot ecosystem so the pins stay current.
- **Add an OpenSSF Scorecard workflow** — the one genuinely additive tool for a
  public published package; it grades repo-level supply-chain posture and uploads
  SARIF into the existing Security tab.
- **Attest a CycloneDX SBOM at release**, alongside the existing npm provenance.

We **reject** the marketplace platforms as redundant here:

- **SonarQube / SonarCloud** — complexity, duplication, and coverage metrics overlap
  ESLint's complexity rules and the 80% coverage gate; the dashboard alone does not
  justify a second platform for a single-maintainer library.
- **Semgrep** — overlaps CodeQL, which is already enabled.
- **Snyk** — overlaps `pnpm audit` + `dependency-review-action` + Dependabot.
- **Codacy / CodeClimate** — overlaps ESLint.
- **Codecov / Coveralls** — the per-file v8 coverage gate already enforces the
  threshold; external trend tracking is low value for this repo.
- **Trivy** — container scanning; this project ships no images.

## Consequences

- **Positive:** high-severity scanner findings now block merges; vulnerable
  dependencies get automatic fix PRs; the Actions supply chain is pinned and
  tracked; supply-chain posture is scored and visible; releases carry both
  provenance and an SBOM.
- **Negative / trade-offs:** slightly more merge friction (two additional required
  checks); more Dependabot PR volume (npm security fixes + weekly Actions updates);
  a small ongoing maintenance surface for the Scorecard workflow.
- **Semver impact:** none — this is CI/governance only; no change to the package's
  public surface or runtime.

## Links

- Related: [ADR-0007](./0007-dependency-management-strategy.md) (automated dependency
  monitoring and security gating — this ADR extends it),
  [ADR-0011](./0011-release-and-publishing-workflow.md) (release + provenance).
- Related: `.github/workflows/scorecard.yml`, `.github/dependabot.yml`,
  `docs/contributing/branch-protection.md`.
