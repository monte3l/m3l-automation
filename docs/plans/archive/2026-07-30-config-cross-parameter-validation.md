# F1b — cross-parameter config validation seam

**Status: shipped** — PR #281 (library seam) and PR #282 (fleet retrofit).

## Context

A backlog sweep of `docs/ROADMAP.md`, `docs/plans/IMPLEMENTATION.md`, and the
16 open GitHub issues found the program backlog effectively closed: Priority 0
and Priority 1 fully `Done`, all 16 open issues `Deferred` behind a gate
verified still shut, except one row — **F1b (#197)**, the only item marked
`To Do` in either tracker.

The problem: `M3LConfigParameter.validate` can only inspect one parameter's
own coerced value. A constraint spanning two or more parameters (`sort`
requires `limit`; `start` must be strictly before `end`) has no declarative
home, so every script that needs one hand-rolls it as an imperative run-start
guard — untyped, per-script, and invisible to the config layer that owns
every other validation rule.

**Scope correction found during audit.** `IMPLEMENTATION.md`'s F1b row cited
three call sites as evidence the gate was met. Checked individually, they did
not retrofit equally: `json-etl`'s `sort⇒limit`/`sort∈fields` and
`cloudwatch-logs-insights`'s `start<end` are genuine cross-_parameter_
constraints, but `cloudformation-stacks`'s `template`/`input` conflict guard
compares a config parameter against the **contents of a parsed input JSON
file** read from disk at run time — at config-load time that file is unread
and `input` is just a filename, so it is not expressible by a schema-level
pass at all. The plan below targeted the two sites that genuinely retrofit and
left `cloudformation-stacks` untouched.

## Approach / Decisions

Two-PR chain, matching every prior W5 promotion precedent (#260/#261,
#266/#267, #269/#270/#271):

- **Validator input:** the schema-level validator receives the live
  `M3LConfig` directly (not a narrowed read-only view, not a plain snapshot) —
  zero new types, composes with `Core.M3LConfigAccessor` for free. Mutation
  via `.set()` is a documented contract, not a type-enforced one.
- **Error identity:** reuse the existing `M3LConfigValidationError`/
  `ERR_CONFIG_VALIDATION`, discriminated by `context: { validatorIndex,
reason }` — no new error code, no catalog registration, no completeness-test
  churn.
- **PR 1 (library):** `M3LConfigSchema` gains an optional second constructor
  argument (`readonly Core.M3LConfigSchemaValidator[]`, source-compatible with
  every existing single-arg call site) and a `validate(config)` method — runs
  once, after every declared parameter resolves, fail-fast on the first
  string reason. `M3LScriptConfigDeclaration` gains an optional `validate`
  field; `M3LScript.loadConfig()` invokes it right after config resolves and
  before `configLoaded` flips true.
- **PR 2 (fleet retrofit):** `json-etl` and `cloudwatch-logs-insights` each
  gain a `configValidators` export in `config.ts`, wired into `main.ts`'s
  `M3LScript` construction; the corresponding imperative guards are deleted
  from their `steps/` modules. `cloudformation-stacks` is untouched per the
  scope correction above.

A 4-agent review fan-out on PR 1 (code-reviewer, spec-conformance-reviewer,
silent-failure-hunter, security-reviewer) found zero must-fix but three
should-fix findings, all converging on the same TSDoc overclaim: "`context`
never carries a config value, safe to log for any parameter, secret or not."
Security review proved this too strong by execution — a **custom** validator's
returned reason string is author-controlled free text and reaches both
`message` and `context.reason` unredacted (name-based redaction only matches
`key=value`-shaped text). Narrowed to the accurate claim across
`M3LConfigValidationError.ts`, `M3LConfigSchemaValidator.ts`, and the doc page:
the library itself never places a value into `context`, but an author who
embeds a secret's value in their reason string defeats the guarantee.

A 3-agent review fan-out on PR 2 (code-reviewer, spec-conformance-reviewer,
silent-failure-hunter) found two must-fix bugs, independently corroborated by
two reviewers each:

1. **Precision mismatch** — `cloudwatch-logs-insights`'s new validator compared
   `start`/`end` at raw millisecond resolution, but the guard it replaced (and
   `resolve-settings.ts`'s downstream `parseEpochSeconds`) compared floored
   epoch **seconds**. A sub-second inverted-but-same-second range silently
   passed validation and produced an empty-window run instead of a config
   error. Fixed by flooring both values to seconds before comparing.
2. **Contract violation** — `json-etl`'s "sort name must be a fields column"
   validator embedded the rejected `sort` value directly in its failure
   reason, violating the very "never embed a value" contract PR 1 had just
   documented. Fixed to name only the allowed column set, mirroring
   `M3LConfigValidators.oneOf`'s established pattern.

A should-fix (a `fieldName()` helper duplicated between `config.ts` and
`run-json-etl.ts`) was also addressed by extracting it into a small shared
`src/lib/field-spec.ts` module.

## Outcome

- `Core.M3LConfigSchemaValidator` (1 new type export) and `M3LConfigSchema`'s
  `validators`/`validate()` members shipped in PR #281, additive
  semver-minor, no `exports`-map change.
- `json-etl` and `cloudwatch-logs-insights` retrofitted in PR #282; both
  scripts' contract pages (`docs/reference/scripts/{json-etl,cloudwatch-logs-insights}.md`)
  updated to describe config-load-time enforcement.
- `docs/ROADMAP.md` and `docs/plans/IMPLEMENTATION.md`'s F1b rows flipped to
  `Done`; `IMPLEMENTATION.md`'s Source column corrected to drop
  `cloudformation-stacks` as evidence. Issue #197 closed.
- No further work items remain scheduled in either tracker as of this PR — the
  remaining 15 open issues are all verified gate-blocked (see the appendix in
  the originating session's plan for the per-issue gate audit).
