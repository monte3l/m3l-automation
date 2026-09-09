# 0100. Test I/O is governed by sandbox isolation, not by an I/O ban

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deciders:** Enrico Lionello (maintainer); Claude (audit + design)

## Context and problem statement

Issue #862 found that `docs/contributing/style-guide.md`'s test-I/O policy — "no
network, no filesystem — mock the I/O primitive instead", tagged `[enforced]` and
citing `eslint.config.js`'s `no-restricted-syntax` rule — overclaimed. The selector
matched only a **member-expression** call (`fs.mkdtempSync(...)`); a **bare
named-import** call (`mkdtempSync(...)`) has an `Identifier` callee and was
invisible to it.

The issue cited two files as evidence of the gap. A full repo census, run before
any code changed, found the gap was not two rogue files but **~83 test files
repo-wide**, all following the identical, unwritten convention of a per-test
sandbox root from `mkdtemp`/`mkdtempSync` under `os.tmpdir()`, removed with
`rm`/`rmSync` in teardown. Nothing writes to the repo tree, `process.cwd()`, or a
fixed path in any of them. Several suites — `core/storage`'s append-only tests
(`O_NOFOLLOW` refusal, cold-start segment discovery), `m3l-cli`'s completion suite
(spawns `bash -n <file>`, a real out-of-process shell parser) — structurally
require a real filesystem; mocking `fs` there would mock the behavior under test,
violating `.claude/rules/tests.md`'s own "never mock the behavior the test exists
to validate" rule.

More significantly, the gap was not accidental. Three files' own comments explain
choosing the bare-import form **specifically to stay outside** the member-expression
selector, citing each other as precedent:

- `packages/m3l-common/tests/checkpoint.test.ts` (pre-fix): "the repo's
  `no-restricted-syntax` guard bans mutating … _member-expression_ calls in tests,
  but a bare identifier call (`mkdtemp(...)`) is unaffected — the same pattern
  `tests/files.test.ts` already relies on."
- `packages/m3l-common/tests/exporters.test.ts` (pre-fix): same wording, "mirrors
  the pattern in `tests/checkpoint.test.ts`."
- `packages/m3l-console-server/tests/integration/store.integration.test.ts`
  (pre-fix): same, adding that the file is an integration test whose entire point
  is real filesystem I/O.

The rule was being routed around, not violated in ignorance, because **the rule as
written did not describe what this repo actually wants.** Widening the selector to
also ban the bare-import form (issue #862's option 1) would have banned the exact
pattern ~83 files use safely today; a narrowly-scoped exemption (option 3) would
have had to cover the majority of the test suite. Downgrading the tag to
`[advisory]` (option 2) would have been honest but left the real hazard — an
un-sandboxed real-fs mutation — unguarded.

A second document (`docs/contributing/contributing.md`) restated the same false
claim, and a third (`rules/02-testing.md`) separately claimed the repo's
integration/E2E layers are "aspirational … intentionally absent" — false for the
repo as a whole (`packages/m3l-console-server/tests/integration/` runs under its
own `vitest.integration.config.ts`), though accurate for `m3l-common` alone. Both
were corrected in the same pass (PR #1148).

## Decision drivers

- The rule must describe an invariant the repo actually wants, not the shape of a
  particular call — the mismatch between the two is what produced the workaround.
- No migration should be required to ship the fix. A design that demands rewriting
  most of the test suite (or that suites doing real-fs work for a real reason)
  repeats issue #862's underlying mistake at larger scale.
- Every selector shipped must be validated against the live tree with the real
  tool before being written into `eslint.config.js`, per
  `.claude/rules/harness-artifacts.md`'s rule for a new `check:*` gate — not
  reasoned about from the AST shape alone.

## Considered options

1. Widen the selector to also ban the bare-import form, then migrate every real-fs
   test onto mocks.
2. Downgrade the `[enforced]` tag to `[advisory]`, documenting exactly which call
   shape is caught.
3. Widen the selector and carve out an explicit, narrowly-scoped exemption for the
   suites that need real fs.
4. Replace the call-shape rule with a path-shape rule expressing the sandbox
   invariant the repo already follows: real fs permitted only inside a per-test
   `mkdtemp()` root under `os.tmpdir()`, torn down in teardown; never the repo
   tree, `process.cwd()`, `import.meta.dirname`, or a fixed path.

## Decision

We chose **option 4**. Real filesystem access in a test is permitted precisely
when it is confined to a sandbox root created by `mkdtemp`/`mkdtempSync` under
`os.tmpdir()` and torn down in the same file; it is banned when the path is a
string/template literal, is rooted at `process.cwd()` or `import.meta.dirname`, or
when a `mkdtemp` root is not itself rooted at `tmpdir()`. `**/tests/integration/**`
is exempt from this policy (and from the network ban) entirely — it runs under its
own Vitest project and the sandbox policy was never written for that layer;
`packages/m3l-console-server/tests/integration/handler.integration.test.ts` had
been routing around the network ban with `node:http`'s `request` specifically
because of this, which is no longer necessary.

Enforcement splits across two mechanisms, because ESLint's per-node selector model
cannot express a whole-file "this file lacks pattern X" check:

- **`eslint.config.js`'s widened `no-restricted-syntax`** — seven selectors, each
  independently verifiable: a bare `fetch()` call (unchanged, already fully
  enforced); a mutating fs call with a literal path in argument 0; the same for
  `symlink`/`link`'s argument 1 (see below); the same shapes via a
  member-expression call (`fs.mkdirSync(...)`); a `process.cwd()`-rooted path
  anywhere in the call's argument subtree; an `import.meta.dirname`-rooted path;
  and a `mkdtemp`/`mkdtempSync` call whose argument subtree contains no `tmpdir()`
  call.
- **`bin/check-test-fs-isolation.mjs`** (new `pnpm check:test-fs-isolation`,
  wired into `pre-push` and CI) — the one rule no selector can express: a file
  that creates a `mkdtemp` sandbox but contains no matching `rm`/`rmSync`
  anywhere. **Deliberately weak by design**, not a placeholder for a stronger
  version: it is a textual presence check, not an AST walk, so it can both
  false-positive (a comment mentioning `mkdtemp(x)` with no real cleanup) and
  false-negative (an `rm(...)` mentioned only in a comment or string), and
  proving the real `rm` call reaches that _specific_ root needs dataflow
  analysis this gate does not attempt regardless. It catches the blatant
  omission — a sandbox created and never torn down — and a green result
  proves no more than that.

**Every selector was run with real ESLint against the entire live test tree (608
tracked test files, `**/tests/integration/**` excluded) before being written into
`eslint.config.js`, not merely reasoned about.** That run was green — zero
hits — confirming the design ships with no migration required, and it caught a
real defect in the originally planned selector set before it shipped:
`symlink`/`symlinkSync`/`link`/`linkSync` take **`(target, path)`**, not
`(path, ...)`. Argument 0 is the link's target name — often a bare relative
string on purpose, e.g.
`symlink("2026-01-01-0003.jsonl", path.join(dir, "2026-01-01-0002.jsonl"))` in
`packages/m3l-common/tests/storage-append-only-segments-listing.test.ts`. A
selector checking `arguments.0.type='Literal'` uniformly across every fs mutator
flagged that call as a hard-coded path when it is nothing of the sort. The
shipped selector set checks `arguments.1` for these two functions specifically —
a concrete demonstration of why the live-validation step in the decision drivers
above is load-bearing, not procedural box-ticking.

This also meant `bin/check-test-fs-isolation.mjs` needed no TypeScript-compiler-API
dependency: a plain substring/regex presence check over each file's text is
sufficient for its one whole-file check, so `bin/lib/browser-safe-subpath.mjs`
remains this repo's only consumer of the TypeScript compiler API (its `MAJOR_HOLDS`
reasoning in `bin/check-deps.mjs` about that fact is unaffected by this ADR).

## Consequences

- **Positive:** The `[enforced]` tag on the test-I/O policy is true again, and true
  of an invariant the repo actually follows — no test file needs to change, and no
  future test needs a workaround comment to stay compliant. The gate is provably
  correct against the current tree at the moment it ships, not merely designed to
  be.
- **Negative / trade-offs:** The whole-file `check:test-fs-isolation` gate is
  intentionally imprecise (it cannot prove a torn-down sandbox is the _right_
  one), so it can pass a file with unrelated `mkdtemp`/`rm` calls that don't
  actually correspond. This is accepted: the alternative (dataflow analysis) is
  disproportionate to the failure mode being guarded against.
- **Semver impact:** none — internal tooling and documentation only, no public
  API surface.

## Links

- Related: [issue #862](https://github.com/monte3l/m3l-automation/issues/862),
  PR #1148 (docs correction), this PR (enforcement)
- `docs/contributing/style-guide.md` § Runner, layout & the test-I/O policy
- `.claude/rules/tests.md`
- `.claude/rules/harness-artifacts.md` ("run a new `check:*` gate live against
  this repo before writing its test suite")
