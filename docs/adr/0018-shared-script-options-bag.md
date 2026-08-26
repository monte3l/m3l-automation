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

The pre-1.0.0 audit (`docs/plans/archive/2026-07-05-pre-1.0.0-release-audit.md`, SF-10)
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

## Update (2026-08-18) — the event-source half of the bag is deliberately dormant

A capability audit established that the event-source half of the shared options bag
this ADR ratified is **built, documented, and entirely unconsumed**.

`M3LScript.createLambdaHandler()` and `M3LLambdaEventConfigProvider` both exist and
are documented, and the config-precedence work of 2026-08-13 wired the handler's
event into the provider chain. Yet there are **zero references to either symbol
under `scripts/*/src/`** (the only matches in the tree are gitignored
`.tsbuildinfo` build artifacts). There is additionally no packaging path — no
bundle, archive, or container build for any consumer script — and no scheduled
trigger anywhere that executes one; the two cron-triggered workflows in
`.github/workflows/` are repository maintenance, not script execution.

**This is recorded as deliberate, not as a defect.** The seam was built so that one
`main()` could serve both a terminal and an event source, and that design remains
correct; it simply has no consumer yet. Recording it here stops the observation
being re-derived as a finding at every audit, and stops it being mistaken for dead
code to remove.

**Activation trigger:** a consumer script that must run from an event source or on
a schedule. Until then the seam stays as-is — unconsumed, and not exercised
end-to-end outside its own tests. Anything that presupposes unattended dispatch
(deadline budgeting, execution fencing, pinning a definition digest into a
dispatched command) is gated behind this same trigger.

## Update (2026-08-26) — a scaffolding template does not flip C2's dormant status

U9 (`m3l new` + Lambda scaffold variant, ADR-0053, issue #533) added a Lambda
composition-root template to `templates/script/` — `m3l new --variant lambda`
now generates a script whose `src/main.ts` exports a
`M3LScript.createLambdaHandler()`-wired handler, closing the audit finding
that no such template existed. The U9 plan
([`2026-08-20-cli-evolution.md`](../plans/2026-08-20-cli-evolution.md#u9-m3l-new--lambda-scaffold-variant))
deferred deciding whether this flips C2's dormant status to this ADR's Update.

**It does not.** The 2026-08-18 Update's recorded activation trigger is "a
consumer script that must run from an event source or on a schedule" — a real
deployment, packaged and triggered. A scaffolding template is generation-time
infrastructure: nothing under `scripts/*/src/` consumes
`createLambdaHandler()`/`M3LLambdaEventConfigProvider` as a result of U9, no
script is packaged or deployed by it, and no event-source or scheduled trigger
exists. Making the seam easier to _reach for_ is not the same as it being
_reached_ — the seam remains exercised only by its own tests, same as before.

**Recorded as deliberate, not as a gap.** A future audit should not re-derive
"the Lambda template exists but nothing deploys it" as a new finding — it is
the same dormancy the 2026-08-18 Update named, now with a scaffolding path
available in addition to a hand-written one. C2 flips to active the moment a
real consumer script ships with a real trigger, template-scaffolded or not.

## Links

- Related: `docs/plans/archive/2026-07-05-pre-1.0.0-release-audit.md` (SF-10),
  `packages/m3l-common/src/core/script/M3LScriptOptions.ts`,
  `docs/reference/core/script.md`, rule `03-design-principles-and-patterns.md`.
- U9: [ADR-0053](./0053-cli-first-evolution-programme.md),
  [`2026-08-20-cli-evolution.md`](../plans/2026-08-20-cli-evolution.md#u9-m3l-new--lambda-scaffold-variant),
  issue #533.
