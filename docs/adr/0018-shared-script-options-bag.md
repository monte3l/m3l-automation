# 0018. Ratify a single shared `M3LScriptOptions` bag for CLI and Lambda

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** m3l-automation maintainers

## Context and problem statement

`M3LScript` exposes two entry points — `run()` (CLI/standalone) and
`createLambdaHandler()` (AWS Lambda) — but both are configured by one flat
options interface, `M3LScriptOptions`
(`packages/m3l-common/src/core/script/M3LScriptOptions.ts`). One field on that
bag, `prompt` (an injectable `M3LPrompt` facade for interactive input), has no
meaning under Lambda: the platform owns a non-interactive process with no TTY.
So the type today can represent an illegal state — a Lambda configuration that
carries an interactive prompt.

The pre-1.0.0 audit (`docs/plans/2026-07-05-pre-1.0.0-release-audit.md`, SF-10)
flagged this as public-type debt: reshaping the options surface after 1.0.0 is a
breaking change, so the decision must be made — or consciously ratified — before
the freeze.

## Decision drivers

- **No breaking changes outside a major release** — the shape chosen at 1.0.0 is
  the shape consumers depend on; a later split is a major bump.
- **Make illegal states unrepresentable** — the project's type-design posture
  prefers discriminated unions over "ignore this field in that mode" prose.
- **Cost vs. benefit before freeze** — the reshape is free of consumer impact
  today (unpublished `0.0.0-development`); the question is whether the added type
  surface earns its keep.

## Considered options

1. **Ratify the single shared bag.** Keep one `M3LScriptOptions`; document that
   `prompt` is CLI-only and ignored under Lambda. Zero code change; the illegal
   state remains representable but is documented as inert.
2. **Split by a `mode: "cli" | "lambda"` discriminant.** Model two option
   variants so `prompt` is unrepresentable under Lambda. Removes the illegal
   state at the cost of a larger public-type surface and more consumer ceremony
   at every construction site.

## Decision

We chose **option 1 (ratify the shared bag)** for 1.0.0 because no illegal field
is load-bearing today — `prompt` under Lambda is silently unused, not a
correctness hazard — and the single bag keeps the construction API minimal, in
line with the library's "stay lean" posture. The `mode`-discriminated split
(option 2) is recorded here as the known escalation path should the Lambda and
CLI option sets diverge materially in a future major.

The TSDoc on `M3LScriptOptions` should note which fields the Lambda path ignores;
that documentation clarification is a src-level change tracked outside this
docs-only workstream.

## Consequences

- **Positive:** no public-type churn at 1.0.0; the construction API stays a
  single flat bag; the decision is recorded so it is not relitigated.
- **Negative / trade-offs:** the `prompt`-under-Lambda illegal state remains
  representable (documented as inert rather than prevented by the type system);
  a future divergence of the two option sets would require the option-2 split
  this ADR anticipates — a major bump at that point.
- **Semver impact:** none — ratifies the existing surface; no `exports`-map or
  signature change.

## Links

- Related: `docs/plans/2026-07-05-pre-1.0.0-release-audit.md` (SF-10),
  `packages/m3l-common/src/core/script/M3LScriptOptions.ts`,
  `docs/reference/core/script.md`, rule `03-design-principles-and-patterns.md`.
