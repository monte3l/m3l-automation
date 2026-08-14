# `M3LSecretsSpecifier` producer + redaction consumer — closing issue #337

**Status: shipped** — branch `feat/config-secrets-specifier-producer`; closes
issue #337 and reconciles the corresponding
`docs/plans/IMPLEMENTATION.md` tracker row and ADR-0042.

## Context

ADR-0042's "Library prerequisite for 8f" required two things before the m3l
CLI's presets/history phase: an additive `secret?: boolean` on
`M3LConfigParameter`, and a real producer for `core/config`'s
`M3LSecretsSpecifier` (previously a standalone name-set class with no
producer anywhere in the repo). Only the first half shipped, in PR #416 — the
producer never did, and 8f/8g shipped on top of the gap anyway, because the
CLI solved secrecy a different way (its own serializable
`M3LCliParameterDescriptor.secret: boolean`, since a live class instance
cannot survive the CLI's JSON discovery cache). The tracker row and a `@see`
block on `M3LSecretsSpecifier` kept asserting the producer existed. It didn't.

Issue #337 tracked closing that gap. Investigating it surfaced a second,
independent finding: redaction in `core/logging` was purely heuristic (a
fixed key-name word list), so a schema-declared `secret: true` parameter
whose name didn't match that list was logged in the clear regardless of the
declaration — a real, live security gap the missing producer had been
masking.

## Approach / Decisions

- **The producer is a standalone free function**, `deriveSecretsSpecifier(schema,
options?)` in a new `core/config/deriveSecretsSpecifier.ts`, not a
  `M3LConfigSchema` method — matching the existing `coerceConfigValue.ts`
  free-function convention rather than adding a method to a class that reads
  as an immutable declaration elsewhere. An independent design pass caught
  this after an initial plan had specified a method; the in-flight
  test-author/code-implementer spokes were redirected mid-task rather than
  left to build against the weaker contract.
- **Alias inclusion is an explicit option**, `{ includeAliases?: boolean }`,
  defaulting to `true` — a secret is reachable under any declared alias (the
  CLI accepts aliases as flags; `M3LConfigReader` resolves through them), so
  a redaction consumer needs them included by default; an iteration consumer
  (a future preset/listing UI) opts out for a clean 1:1 parameter-name set.
- **The redaction consumer is a structural port**, `M3LSecretNamesPort`
  (`{ isSecret(name): boolean }`, tightened to property syntax for
  contravariant strictness) accepted via a new optional `M3LRedactOptions` on
  `redactSensitiveLogText`/`redactSensitiveLogValue` — not a direct
  `core/logging` → `core/config` import, which would pull the entire config
  barrel (including the `yaml` dependency) into every logger/breadcrumb
  consumer. This follows the same ports pattern already established in
  `core/diagnostics/collect.ts` for the same kind of boundary.
- **The port applies to two of three internal redaction passes only.** The
  third (embedded-value) pass is a single regex precompiled once at module
  load from a fixed word list, specifically hardened against a previously
  measured ReDoS incident on that exact construction. Extending it to a
  caller-supplied, mutable specifier per call would reopen that class of bug.
  This is a deliberate, documented scope limitation, locked by a negative
  test, not an oversight.
- **5-spoke review** (code, security, silent-failure, type-design,
  spec-conformance) found no Must-fix. Cheap Should-fix items were applied
  same-branch: a stale TDD-process comment, a duplicate `@remarks` TSDoc
  block, an overclaiming "never throws" doc line, and a compiler-unchecked
  structural-conformance gap between `M3LSecretsSpecifier` and
  `M3LSecretNamesPort` (closed with a one-line `expectTypeOf` pin). Two
  architectural suggestions (phantom-branding the derivation mode; narrowing
  the producer's return type away from the concrete class) were deliberately
  deferred as scope creep beyond a minimal, already-well-audited change.

## Outcome

`m3l-common` 2.3.0 → 2.4.0 (additive, no `exports`-map change). Four new
public symbols: `deriveSecretsSpecifier`, `M3LDeriveSecretsSpecifierOptions`
(`core/config`), `M3LSecretNamesPort`, `M3LRedactOptions` (`core/logging`).
7211 tests passing repo-wide; the two changed source files at 100%/97%+
coverage. `docs/plans/IMPLEMENTATION.md`'s stale "Deferred" row flipped to
"Done"; ADR-0042 amended to record the gap and its closure; the
`docs/logs/2026-08-14-m3l-cli-build-out.md` work log's stale "open" PR
statuses corrected. `pnpm sync:hub -- --apply` closes issue #337 once this
lands on `main`.
