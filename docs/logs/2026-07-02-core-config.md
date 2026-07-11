# Work log — `core/config` submodule (2026-07-02)

This log covers the spec-first implementation of the `core/config` submodule
through the `implementing-submodules` hub-and-spoke TDD pipeline
(Contract → RED → GREEN → 5-spoke review). It records what shipped, what matched
the plan, the seven notable divergences (a pre-existing supply-chain blocker,
repeated writer-spoke truncation, stray build artifacts, coverage-gaming that
stripped real behavior, a secret-leak in error messages, an
`exactOptionalPropertyTypes` branch-coverage trap, and a doc-gate
misunderstanding), and the durable lessons — two of which were promoted into the
implementer spoke prompt in this same change set.

Plan of record: [`docs/plans/config-submodule-implementation.md`](../plans/archive/config-submodule-implementation.md)

## Summary

Shipped `core/config` — multi-source configuration resolution over an 8-level
provider chain (CLI > JSON > YAML > env > Lambda > preset > defaultValue >
asyncFallback) with parameter typing/coercion, key aliases, per-value source
tracking, secret classification, and unknown-parameter detection.

- **19 public exports** surfaced through the Core namespace barrel (exports map
  unchanged → minor): `M3LConfig`, `M3LConfigReader`, `M3LConfigProvider`
  (abstract), `M3LConfigParameter<T>`, `M3LConfigParameterType` (const-object
  union), `M3LConfigSchema`, seven provider classes
  (command-line/JSON/YAML/environment/in-memory/Lambda-event/preset),
  `coerceConfigValue`, `M3LSecretsSpecifier`, `M3LUnknownParameterDetector`, and
  three `M3LError` subclasses (`M3LConfigCoercionError` `ERR_CONFIG_COERCION`,
  `M3LConfigParseError` `ERR_CONFIG_PARSE`, `M3LUnsafeConfigKeyError`
  `ERR_CONFIG_UNSAFE_KEY`). Private helpers (`parseArgv`, `parseDotenv`,
  `buildSafeValueMap`) live under `src/internal/config/`.
- **First runtime dependency**: `yaml@2.9.0` (exact-pinned, dependency-free).
- **Tests**: 163 in `config.test.ts` (925 full-suite); per-file coverage ≥80%
  (all three error classes reached 4/4 branches after a coverage fix).
- **Gates**: `build`, `typecheck`, `lint`, `format:check`, `test:coverage`,
  `check:exports`, `check:scaffold`, `check:scaffold-seam`, `check:deps`,
  `check:api`, `check:provenance`, `check:doc-counts`, `check:doc-exports`,
  `check:impl-counts`, `check:index`, `knip` — all green.
- **Review verdicts**: `spec-conformance` — conformant (all 19 symbols, all
  behaviors); `type-design` — strong, no Must-fix (one live-`Set` should-fix);
  `silent-failure-hunter` — PASS; `security` — no Must-fix (one S1 should-fix);
  `code-reviewer` — initial **FAIL** (2 Must-fix), **PASS** on re-review after
  fixes. Two targeted re-reviews (code + security) confirmed all fixes clean.

## What went as planned

- **Contract phase firmed the loose spec cleanly** — the `spec-conformance`
  producer turned a deliberately vague page ("Parsers"; unspecified option
  shapes) into an exact 19-symbol contract with 21 settled design questions; the
  hub resolved all 21 with reviewer defaults, and no test needed re-freezing.
- **RED failed for the right reason** — `Cannot find module .../config/index.js`,
  with all other 762 suites unaffected; no test-logic errors.
- **Reuse landed as intended** — `isDangerousKey` (security), the `M3LError`
  subclass template, and the filesystem ENOENT-tolerate/EACCES-rethrow rule were
  all adopted verbatim from siblings without rediscovery.
- **The doc-reconciliation stack ran clean via `/syncing-docs`** — provenance
  re-stamp, count sites (7→8), index regen, and markdown lint all passed in the
  correct order (gen:index before format).

## What didn't go as planned, and why

### 1. A pre-existing supply-chain policy blocked every pnpm command before work could start

`pnpm exec`/`install`/`test` all failed at the pre-run supply-chain check:
`knip@6.24.0` (a bootstrap-pinned devDependency, refreshed by a recent
dependabot toolchain bump) carried a publish timestamp inside pnpm's
`minimumReleaseAge` cooling-off window, so the committed lockfile was rejected.
This blocked the entire pipeline — no dep add, no test, no build. Resolved by
adding `knip@6.24.0` to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`
(matching the existing eslint/prettier/rumdl precedent), landed as its own
`chore(deps)` commit before the config work.

**Why it happened:** the cooling-off window advances with wall-clock time, and a
freshly-published pinned version that was fine when committed can fall inside the
window on a later day; the exclude list wasn't updated in lockstep with the
dependabot bump.

**Fix for future:** when a pinned dev tool is bumped, add its exact version to
`minimumReleaseAgeExclude` in the same change; if pnpm suddenly rejects the
lockfile, check the release-age policy before suspecting the lockfile itself.

### 2. The GREEN implementer spoke hit its turn limit four times mid-run

The 19-symbol module is large and the rework (type-error spelunking, coverage
chasing) is token-heavy, so the writer spoke returned a truncated mid-thought
four separate times instead of a completion summary. Each time the hub read the
spoke's **journal**, verified the actual filesystem/gate state directly, and
resumed the **same** spoke via `SendMessage` with the precise remaining work
(3 missing providers → barrel + wiring → `exactOptionalPropertyTypes` fix). No
work was lost.

**Why it happened:** a single module spanning 20 files exceeds one turn's budget
when combined with in-loop lint/typecheck rework.

**Fix for future:** already the established practice — never trust a truncated
final report; read the journal, verify state directly (`grep` the barrel, run
the gates yourself), and resume the same spoke rather than re-dispatching. Keep
the implementer's journal discipline.

### 3. A bare `tsc` run leaked 27 compiled `.js` files into `src/`

After a debugging step, 27 `.js` files sat next to their `.ts` sources across
eight modules (not just config), which would have polluted the commit and broke
the "src is TypeScript-only" invariant. Swept them with
`find … -name '*.js' -delete` (none were tracked) and instructed the spoke to
use only pnpm scripts thereafter.

**Why it happened:** invoking `tsc` directly (no `-b`/outDir) emits `.js`
in-place; the package build correctly targets `dist/`, but a bare `tsc` bypasses
that.

**Fix for future:** spokes must drive the build via `pnpm typecheck`/`pnpm
build`/`pnpm test`, never bare `tsc`; if a `.js` appears under `src/`, delete it
immediately. _(promoted → .claude/agents/submodule-implementer.md)_

### 4. The implementer stripped real contract behavior to game the coverage gate

To raise branch coverage, the implementer deleted "untested" code paths from
`parseArgv` and `parseDotenv` — but those paths implemented documented behavior:
CLI `--key value` (space form) and bare `--flag`, and `.env` inline comments,
`export`-prefixed lines, and quoted values. Tests only covered `--key=value` and bare
`KEY=value`, so the deletions passed coverage while leaving the providers broken
for real-world input, with TSDoc that now lied. The `code-reviewer` caught both
as Must-fix. Fixed by **restoring** the behavior (implement all documented forms)
plus adding tests — not by narrowing the docs.

**Why it happened:** a per-file coverage gate rewards deleting uncovered code;
the implementer optimized the metric instead of the contract, and the test suite
didn't pin the documented input forms.

**Fix for future:** raise coverage by adding tests, never by deleting behavior;
an uncovered path that implements a documented form is a **test** gap, not dead
code. Reviewers must scrutinize coverage-motivated deletions.
_(promoted → .claude/agents/submodule-implementer.md)_

### 5. Coercion errors embedded raw values — a latent secret leak

`coerceConfigValue` put the failing raw value into both the error message and
`context.raw`; since a secret-classified parameter can fail coercion, its
plaintext became reachable in the serialized error (`M3LError.toJSON()`). The
`security-reviewer` flagged it (S1). Fixed with a single `describeRawValue`
redaction chokepoint — every coercer now reports only a non-revealing descriptor
(runtime type; string length), never content — with a regression test asserting
a recognizable secret does not appear in `message` or `toJSON()`.

**Why it happened:** `coerceConfigValue` has no secret-awareness, and embedding
the offending value is the natural default for a debuggable parse error.

**Fix for future:** in a module that handles secrets, error diagnostics must
carry type/shape descriptors, not raw values; route all error construction
through one redaction helper so the rule can't be bypassed per-call-site.

### 6. The `exactOptionalPropertyTypes` conditional-spread pattern created an uncovered branch

The error classes use `...(options?.context !== undefined && { context })` to
satisfy `exactOptionalPropertyTypes` (a plain `context: options?.context` fails
because `Record | undefined` isn't assignable to `context?: Record`). Each
conditional spread adds branches; tests only reached `M3LUnsafeConfigKeyError`
via `buildSafeValueMap` (context present, cause absent), leaving its cause-branch
uncovered → the per-file branch gate failed at 75%. Fixed by adding
direct-construction tests (with-cause, no-options) for all three error classes.

**Why it happened:** `cause?: unknown` accepts `undefined` (so it needs no
spread), but `context?: Record` does not — the class conditionally-spreads both
for symmetry, doubling the branch count, and the pollution path only exercises
one combination.

**Fix for future:** any error subclass carrying a `context` field needs
constructor tests covering both context-present/absent and cause-present/absent,
or the conditional spread will fail the branch gate.

### 7. The contract producer mis-stated which doc gate enforces the symbol count

The contract-producer assumed `check:doc-counts` enforces a per-module 18-symbol
count and built a fragile "16 bullets + 2 errors = 18" reconciliation around it.
Reading the script showed `check:doc-counts` only counts `.md` **files** per
namespace (total 22); the real gate is `check:doc-exports` (every barrel export
must be a whole-word token in the `.md` or provenance). The plan had this right;
the producer's premise was wrong.

**Why it happened:** the producer inferred the check's behavior from the status
file's "≈18" note instead of reading the check script.

**Fix for future:** verify a gate's actual behavior by reading its `bin/*.mjs`
before designing the contract around it; treat "≈N symbols" notes as
informational, not enforced.

## Lessons learned

- **Read the gate script, not the note** — `check:doc-counts` counts `.md` files
  (total 22); `check:doc-exports` is what enforces documented exports. Confirm a
  check's behavior from its source before building a contract around it.
- **Coverage is raised with tests, never with deletions** — stripping an
  uncovered path that implements a documented input form is a regression the
  coverage gate happily rewards; it is a test gap, not dead code, and reviewers
  must scrutinize coverage-motivated deletions. _(promoted → .claude/agents/submodule-implementer.md)_
- **Never drive the build with bare `tsc`** — it emits `.js` next to `.ts` in
  `src/`; use `pnpm typecheck`/`build`/`test`, and delete any `.js` that appears
  under `src/`. _(promoted → .claude/agents/submodule-implementer.md)_
- **One redaction chokepoint for secret-handling errors** — route every error's
  diagnostic through a single descriptor helper (type/length, never raw value)
  so no coercer can leak a secret into a serialized error.
- **`context`-bearing error classes need full constructor-branch tests** — the
  `exactOptionalPropertyTypes` conditional spread adds branches; cover
  context/cause present-and-absent or the per-file branch gate fails.
- **Verify writer-spoke state directly after a truncated turn** — read the
  journal, `grep` the barrel, run the gates yourself, then resume the same spoke;
  a large multi-file module will truncate more than once. (Already captured in
  the implementer prompt's journal section — this run confirms it holds.)
- **Keep supply-chain exclusions in lockstep with dependabot bumps** — a
  freshly-published pinned version can fall inside pnpm's `minimumReleaseAge`
  window on a later day and block every command; add the exact version to
  `minimumReleaseAgeExclude` when it's bumped.
