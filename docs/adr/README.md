# Architecture Decision Records

This directory records the architecturally significant decisions for
`@m3l-automation/m3l-common` and the surrounding monorepo. Each ADR captures one
decision: its context, the choice made, and the consequences.

We use a lightweight [MADR](https://adr.github.io/madr/)-style format. Start from
[`template.md`](./template.md).

## Conventions

- One decision per file, named `NNNN-short-title.md` (zero-padded sequence),
  e.g. `0001-esm-only-output.md`.
- Status is one of: `Proposed`, `Accepted`, `Rejected`, `Deprecated`,
  `Superseded by ADR-NNNN`.
- ADRs are immutable once `Accepted`. To change a decision, add a new ADR that
  supersedes the old one and update the old one's status.
- Decisions with semver impact (e.g. changes to the `exports` map) should be
  backed by an ADR.

## When to write an ADR

Write a new ADR when:

- A decision affects the **public contract** — adding, removing, or renaming an
  entry in the `exports` map; changing the minimum Node.js version; changing the
  ESM/CJS output strategy.
- A **new runtime dependency** is introduced (or a major one removed) and the
  reasoning should be recorded for future maintainers.
- A **foundational design choice** is made — error model, result type, module
  topology — that will be hard to reverse without a major semver bump.
- There is genuine **disagreement or uncertainty** among deciders: record what was
  decided and why, so it is not relitigated.
- A decision is **superseded**: the new ADR records the change; the old ADR's
  status is updated to `Superseded by ADR-NNNN`.

You do **not** need an ADR for implementation details that stay behind the module
boundary (internal helpers, test utilities, refactors that do not touch the public
surface).

## Index

| ADR  | Title                                                                                                                           | Status                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 0001 | [Development toolchain choices](./0001-toolchain-choices.md)                                                                    | Accepted               |
| 0002 | [ESM-only output](./0002-esm-only-output.md)                                                                                    | Accepted               |
| 0003 | [Node 24 as the minimum runtime floor](./0003-node-24-floor.md)                                                                 | Accepted               |
| 0004 | [Three-entry exports map as the public contract](./0004-exports-map-contract.md)                                                | Accepted               |
| 0005 | [M3LError and M3LResult as the error model](./0005-error-hierarchy.md)                                                          | Accepted               |
| 0006 | [Apache 2.0 license adoption](./0006-license-choice.md)                                                                         | Accepted               |
| 0007 | [Automated dependency monitoring and security gating](./0007-dependency-management-strategy.md)                                 | Accepted               |
| 0008 | [Replace @commitlint/cli with a thin wrapper around @commitlint/lint](./0008-commitlint-cli-replacement.md)                     | Accepted               |
| 0009 | [Dependency-direction guard: import-x/no-restricted-paths vs dependency-cruiser](./0009-dependency-direction-guard.md)          | Accepted               |
| 0010 | [Enforce formatting and Markdown linting in CI, with rumdl as the Markdown linter](./0010-markdown-lint-and-format-ci-gates.md) | Accepted               |
| 0011 | [Release and publishing workflow](./0011-release-and-publishing-workflow.md)                                                    | Superseded by ADR-0020 |
| 0012 | [Defer external code-index MCP; use native LSP + generated catalog](./0012-defer-external-code-index-mcp.md)                    | Accepted               |
| 0013 | [Git worktrees for task isolation and parallelization](./0013-git-worktrees-for-task-isolation.md)                              | Accepted               |
| 0014 | [Symmetric worktree tooling and corrected prune semantics](./0014-symmetric-worktree-tooling.md)                                | Accepted               |
| 0015 | [Code-scanning tooling evaluation and supply-chain hardening](./0015-code-scanning-tooling-evaluation.md)                       | Accepted               |
| 0016 | [Signed-commit enforcement and the pre-work decision gate](./0016-signed-commits-and-decision-gate.md)                          | Accepted               |
| 0017 | [Dependency loading, declaration, and pinning standard](./0017-dependency-loading-standard.md)                                  | Accepted               |
| 0018 | [Ratify a single shared `M3LScriptOptions` bag for CLI and Lambda](./0018-shared-script-options-bag.md)                         | Accepted               |
| 0019 | [Remove the `scripts/` example-automation workspace](./0019-remove-scripts-workspace.md)                                        | Accepted               |
| 0020 | [Drop release automation](./0020-drop-release-automation.md)                                                                    | Accepted               |
