# 0006. Apache 2.0 license adoption

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Enrico Lionello

## Context and problem statement

The repository was created with `"license": "UNLICENSED"` as a placeholder. Before the first public release the project needed a proper open-source license. This is a personal project; IP belongs to Enrico Lionello. This ADR records the license chosen, the rationale, and the IP confirmation so they are not relitigated.

## Decision drivers

- The project targets enterprise automation consumers, including corporate environments, that require a permissive open-source license for procurement approval.
- A patent-retaliation clause is desirable to protect contributors and consumers.
- Attribution-only burden must be minimal (no copyleft/share-alike obligations on consumers).
- IP is personal; no employer approval is required.

## Considered options

1. **Remain `UNLICENSED`** — keeps code proprietary; not viable for a publicly released library; consumers cannot legally use it.
2. **MIT** — permissive, widely understood, zero friction. No explicit patent grant or retaliation clause.
3. **Apache 2.0** (chosen) — permissive, equally widely understood, includes an explicit patent grant and a patent-retaliation clause that terminates the grant if a consumer sues contributors for patent infringement.

## Decision

We chose **Apache License 2.0**. Like MIT it imposes no share-alike obligation, but it adds an explicit grant of patent rights and a retaliation clause that MIT lacks. For a utility library used inside corporate automation pipelines — where patent exposure is a real procurement concern — the Apache 2.0 grant provides meaningful protection for both contributors and consumers. The license was adopted in 2026; copyright is held by Enrico Lionello (personal IP, confirmed). The `packages/m3l-common/package.json` sets `"license": "Apache-2.0"`; the root `package.json` is `private: true` and does not need a license field.

## Consequences

- **Positive:** consumers may freely use, modify, and distribute; explicit patent grant removes a common corporate procurement blocker; patent-retaliation clause protects contributors.
- **Negative / trade-offs:** Apache 2.0 requires preserving the copyright and license notice in redistributions (like MIT), plus the `NOTICE` file convention if one exists. No `NOTICE` file is present at adoption time.
- **Semver impact:** none.

## Links

- Related: `LICENSE` (root, Apache 2.0, © 2026 Enrico Lionello), `packages/m3l-common/package.json` (`"license": "Apache-2.0"`).
