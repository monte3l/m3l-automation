# 0036. Inbound dependency license policy

- **Status:** Accepted
- **Date:** 2026-08-10
- **Deciders:** Enrico Lionello

## Context and problem statement

ADR-0006 chose Apache-2.0 for the license `packages/m3l-common` is
**published under** — the outbound side. Nothing in the repo gates the
license terms of the dependencies it **ingests** — the inbound side.
`pnpm audit --audit-level=high` and `dependency-review.yml`'s
`fail-on-severity: high` gate known vulnerabilities; neither looks at a
dependency's declared license. A copyleft or share-alike transitive
dependency could land in `packages/m3l-common`'s runtime tree unnoticed and
defeat the exact procurement concern ADR-0006 was written to address —
Apache-2.0 was chosen partly because it removes a common corporate
procurement blocker, and a GPL-family runtime dependency reintroduces one.

An audit against a reference tooling review (`bins/` review, comparison
task) surfaced this as the one unambiguous capability gap in this repo's
`bin/` fleet: the reference repo's `check-license-report.mjs` gates
dependency licenses via an SPDX-expression-aware allow-list; nothing here
does. `pnpm licenses list --json` (built into pnpm 11.9, no new
devDependency needed) makes the same capability cheap to add here.

## Decision drivers

- Close the inbound counterpart to ADR-0006 without reintroducing the
  procurement risk ADR-0006 removed.
- Zero new runtime or dev dependencies — `pnpm licenses list` already ships
  with the pinned `packageManager`.
- Do not fail the build on build-time tooling licenses that are never
  linked into a shipped artifact — that would be enforcing a policy on
  packages the policy was never meant to reach.
- SPDX expressions (`OR`/`AND`/`WITH`) are common in real `package.json`
  `license` fields (verified against this repo's live tree: `(MIT OR
WTFPL)`, `(MIT AND Zlib)`, `(BSD-2-Clause OR MIT OR Apache-2.0)`) and must
  be evaluated correctly, not treated as opaque strings.

## Considered options

1. **No gate** (status quo) — rejected; leaves the procurement risk
   ADR-0006 exists to close entirely unmonitored.
2. **`dependency-review.yml` `allow-licenses` only** — PR-time only (does
   not run on push to `main`), no local reproduction via `pnpm verify`, no
   per-license summary, and does not distinguish prod from dev-tooling
   licenses on its own terms.
3. **`bin/check-licenses.mjs` only** — reproducible locally and in the CI
   `verify` job on every push, but misses the earlier PR-diff-time signal
   GitHub's native action provides for free.
4. **Both** (chosen) — `dependency-review.yml`'s `allow-licenses` catches a
   license change in the diff before a dependency is ever installed;
   `bin/check-licenses.mjs` catches the resolved state of the whole tree,
   locally and in CI, on every push (not just PRs).

## Decision

We gate at **two layers**, both using the same allow-list: `MIT`,
`Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `0BSD`, `CC0-1.0`,
`Unlicense`. No copyleft, no share-alike, nothing requiring downstream
disclosure — matching ADR-0006's Apache-2.0 rationale.

**Layer 1 — `dependency-review.yml`:** `allow-licenses` set to the same
list, PR-time, GitHub-native, zero added script.

**Layer 2 — `bin/check-licenses.mjs` (`pnpm check:licenses`), wired into
the CI `verify` job and `pnpm verify`:** spawns `pnpm licenses list --json`
(no new dependency) and evaluates each reported license through a
recursive-descent SPDX expression parser (`bin/lib/licenses.mjs`) handling
`AND`/`OR`/`WITH`/parentheses — `OR` passes if any operand is allowed,
`AND` requires all operands allowed, `WITH` exceptions always fail
(conservative: an exception changes legal terms a base-license allow-list
does not model).

**Severity is split by whether the package is actually shipped:**

- **PROD scope (error, fails the build):** `packages/m3l-common`'s runtime
  `dependencies`, plus its optional `peerDependencies` — a consumer who
  installs a peer is exposed to its license terms exactly like a hard
  dependency, so a peer is gated, not skipped.
- **DEV scope (warn, does not fail):** everything else — build/lint/test
  tooling never linked into a shipped artifact, where ADR-0006's
  procurement concern does not reach.

**Implementation note surfaced during verification against the live
tree:** `pnpm licenses list --prod`, run at the workspace root or filtered
to `packages/m3l-common`, reports `dependencies` and
`optionalDependencies` only — it does **not** surface `peerDependencies`,
because a peer is supplied by the consumer rather than resolved into this
repo's own tree. m3l-common's six optional peers (`adm-zip`, `cheerio`,
`mailparser`, `mammoth`, `read-excel-file`, `unpdf`) happen to be installed
here too, as devDependencies, purely so they can be exercised in tests —
`check-licenses.mjs` reads their names directly from
`packages/m3l-common/package.json`'s `peerDependencies` and resolves their
license via the unfiltered `pnpm licenses list --json` call, unioning them
into PROD scope by name. If a peer is ever removed from devDependencies
(and so no longer resolves anywhere in the tree), the check warns that its
license could not be verified rather than silently passing it.

Verified against the live tree at authoring time: the **PROD scope passes
today with zero exceptions** (62 MIT, 54 Apache-2.0, 10 ISC, plus four
single-package `OR`-expressions that resolve allowed through an MIT/BSD/
Apache-2.0 operand). The **DEV scope has real, non-blocking outliers**:
`eslint-plugin-sonarjs` (`LGPL-3.0-only`), `lightningcss` /
`lightningcss-linux-x64-gnu` (`MPL-2.0`), `lru-cache` / `minimatch`
(`BlueOak-1.0.0`), `pako` (`(MIT AND Zlib)` — `Zlib` alone is not
allow-listed, so the `AND` fails even though `MIT` alone would pass),
`argparse`'s `2.0.1` resolution (`Python-2.0` — a second, differently
licensed version of the same package name also resolves in the tree, so
both are checked independently), `duck` (bare non-SPDX `"BSD"`, distinct
from the allow-listed `BSD-2-Clause`/`BSD-3-Clause`), and `nodemailer`
(`MIT-0`). None of these ship in the published package; all are correctly
warn-only.

## Consequences

- **Positive:** the inbound counterpart to ADR-0006 is closed. A future
  copyleft transitive dependency in the runtime or peer set fails CI
  immediately, with the offending package, version, and license named. A
  clean local reproduction (`pnpm check:licenses`) exists alongside the
  PR-time GitHub-native signal.
- **Negative / trade-offs:** two lists (`bin/lib/licenses.mjs`'s
  `ALLOWED_LICENSES` and `dependency-review.yml`'s `allow-licenses`) must
  be kept textually identical by hand — no machine gate binds them, since
  they run in different systems (a local/CI Node script vs. a GitHub
  Action). Both carry an explicit comment pointing at the other and at this
  ADR. `pnpm licenses list --prod`'s peer-dependency blind spot means the
  gate depends on m3l-common's optional peers staying present as
  devDependencies for coverage to hold — noted above and in
  `check-licenses.mjs`'s own warning when a peer goes missing.
- **Semver impact:** none — this is tooling, not a public API change.

## Links

- Related: ADR-0006 (outbound license choice, the counterpart this ADR
  closes), ADR-0010 (root devDependency exact-pinning), ADR-0017
  (dependency loading/declaration/pinning standard), `bin/check-licenses.mjs`,
  `bin/lib/licenses.mjs`, `.github/workflows/dependency-review.yml`.
