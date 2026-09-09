# Test-I/O sandbox isolation policy (issue #862)

**Status: shipped** — PR #1148 (docs correction), PR #1149 (ESLint selector
widening + `check:test-fs-isolation` gate + ADR-0100).

## Context

`docs/contributing/style-guide.md` stated the no-real-filesystem-in-tests
policy as **"no network, no filesystem — mock the I/O primitive instead"**,
tagged `[enforced]`, and named `eslint.config.js`'s `no-restricted-syntax`
rule as the mechanism. Issue #862 found the selector matched only a
**member-expression** call (`fs.mkdtempSync(...)`), not a **bare named-import**
call (`mkdtempSync(...)`) — an `Identifier` callee, invisible to the rule.
That diagnosis was correct.

The issue's evidence was not: it cited two files as the artifacts of the
hole. A full census, run before any code changed, found the gap was not two
rogue files but **~83 test files repo-wide**, all following the identical,
unwritten convention of a per-test sandbox root from `mkdtemp`/`mkdtempSync`
under `os.tmpdir()`, torn down with `rm`/`rmSync`. Nothing wrote to the repo
tree, `process.cwd()`, or a fixed path in any of them. Several suites
structurally required a real filesystem (`core/storage`'s append-only tests,
`m3l-cli`'s completion suite spawning `bash -n`). More significantly, three
files' own comments explained choosing the bare-import form _specifically to
stay outside_ the rule, citing each other as precedent — the rule was being
routed around, not violated in ignorance, because it did not describe what
the repo actually wanted. That made the issue's own option 1 (widen + migrate
everything to mocks) and option 3 (widen + carve out an exemption) both
non-starters, and option 2 (downgrade to `[advisory]`) a documentation patch
over a live, unguarded hazard.

## Approach / Decisions

**Reframe the policy to the invariant the repo actually follows, then build
the guard that enforces it — two PRs, docs honesty first.** Real filesystem
access permitted only inside a per-test `mkdtemp()` root under `os.tmpdir()`,
torn down in the same file; never the repo tree, `process.cwd()`, or
`import.meta.dirname`. `**/tests/integration/**` exempt entirely (it runs
under its own Vitest project and the policy was never written for it).

**PR #1148 — docs correction, no code.** Rewrote
`docs/contributing/style-guide.md`'s test-I/O section (renamed "the
unit-only policy" → "the test-I/O policy"), stated the policy repo-wide (it
governs every package's tests, not just `m3l-common`'s), corrected a second
stale claim that integration/E2E layers are "intentionally absent" (false
for the repo as a whole — `packages/m3l-console-server/tests/integration/`
exists), and folded the same correction into `contributing.md`,
`rules/02-testing.md`, `coding-standards.md`, and `.claude/rules/tests.md`
(which previously said nothing about fs/network at all). Every `[enforced]`
claim was tagged for what existed _at that point in time_ — the sandbox rule
itself was marked `[advisory]` "for now, pending a follow-up PR," not
`[enforced]` for a mechanism that didn't exist yet, deliberately avoiding
repeating the exact overclaim the issue was about.

**PR #1149 — the enforcement.** Widened `no-restricted-syntax` to seven
path-shape selectors (literal path, `symlink`/`link`'s argument-1 literal
path — they take `(target, path)`, not `(path, ...)` — the member-call form,
`process.cwd()`-rooted, `import.meta.dirname`-rooted, `mkdtemp` not rooted at
`tmpdir()`, plus the unchanged `fetch()` ban) and added
`bin/check-test-fs-isolation.mjs` for the one rule no per-node selector can
express: a `mkdtemp` sandbox with no matching `rm`/`rmSync` anywhere in the
file. Deliberately weak by design — a textual presence check, not dataflow
analysis — so it needed no new TypeScript-compiler-API dependency.

**Every selector was validated against the live tree with real ESLint before
being written**, not reasoned about from the AST shape alone — the practice
`.claude/rules/harness-artifacts.md` already names for a new gate, applied
here to lint selectors specifically. That discipline paid for itself twice:
once during design (a naive `arguments.0`-literal check would have flagged
`symlink()`'s target-name argument as a hard-coded path), and once more when
`claude-pr-review`'s first round on the open PR found three selectors
(`process.cwd()`, `import.meta.dirname`, the `mkdtemp`-root check) matched
only an identifier-form callee, missing every `fs.mkdirSync(...)`-style
member call — a real regression against the unconditional member-call ban
those selectors replaced. Fixed with a `sandboxFsCallEitherForm()` helper and
re-validated live before the follow-up push; the second review round came
back PASS with the Should-fix section empty.

## Outcome

Both PRs merged (#1148, #1149). `docs/adr/0100-test-fs-sandbox-isolation.md`
records the decision, the census, and the selector-coverage gap the review
round found. Full work log:
[`2026-09-09-issue-862-test-fs-sandbox-isolation`](../../logs/2026-09-09-issue-862-test-fs-sandbox-isolation.md).
