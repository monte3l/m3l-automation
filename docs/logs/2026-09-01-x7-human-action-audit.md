# Work log — X7 human-action audit close-out (2026-09-01)

This log covers the close-out of tracker row **X7 — human-action audit +
correlation** and its derived hub-sync issue #555. The task was framed as
"verify X7's claims, then archive the row", and verification changed the shape
of the work twice: a written-but-never-pushed slice had to be landed first, and
X7's own claims turned out to be only half true. It records what shipped, what
matched the plan, the five defects landing the orphaned slice surfaced, and the
durable lessons.

Plan of record: the session's `/loop`-free implementation plan for issue #555
(ship slice 4a → narrow X7 → file X7b → hub sync).

## Summary

Two PRs:

- **[#823](https://github.com/monte3l/m3l-automation/pull/823)** (code, merged
  `5fa5f9e1`) — slice 4a, the append-only stream read path. Public surface added
  through the existing `core/storage` barrel, **no new `exports` subpath**:
  `M3LAppendOnlyStream.read()`, `M3LAppendOnlyStreamReadError`,
  `M3LAppendOnlyReadOptions`, `M3LAppendOnlyTruncatedSegment`, and
  `M3L_APPEND_ONLY_MAX_SEGMENT_BYTES` / `_SEGMENT_AGE_MS` / `_LINE_BYTES`.
  Additive minor. Nine commits.
- **This PR** (docs) — X7 → `Done` narrowed to what actually shipped, new
  **X7b** row for the unshipped half, `docs/ROADMAP.md` X7 → `Done`, this log.

Final gate state on #823: `test:coverage` 13,667 + 2,425 + 260 + 31 passing with
every per-file threshold met; `storage-append-only-read.test.ts` 41 → **47**
tests; `storage-append-only-stream.test.ts` 96 unchanged; reference index
809 → **812** symbols; `M3LAppendOnlyStream.ts` 25,312 → **20,951** bytes with no
size-baseline raise. `lint`, `typecheck`, `build`, `check:exports`,
`check:provenance`, `check:index`, `check:file-budget`, `check:test-counts`,
`check:review-size`, `check:signed-range`, `knip` all green. CI reached
`mergeStateStatus: CLEAN`.

Review verdicts: `spec-conformance-reviewer` CONFORMANT (no findings);
`silent-failure-hunter` no Must-fix / no Should-fix; `code-reviewer` 1 Must-fix
(stale security comments) + 4 Should-fix + 2 nits; `security-reviewer` no
Must-fix + 1 Should-fix (the `null` silent path) + 2 nits; `claude-pr-review`
**PASS**, no Must-fix, 2 Should-fix + 1 nit.

Skills used: starting-work (prior session), syncing-docs, creating-prs,
writing-work-logs.

Spoke incidents: 2 truncations / 0 stalls / 0 resumes. Both truncations were
40-turn-limit stops on `test-author` (once mid-verification, once mid-report);
in both cases the work was already written to disk and the hub verified it
directly rather than resuming, so neither cost a redo.

## What went as planned

- **The rebase was genuinely clean.** `git merge-tree` predicted no conflicts
  onto `origin/main` and the actual rebase produced none, across 21 commits of
  drift and later a second rebase over 2 more.
- **The signature chain held.** All nine commits kept `%G? = G` through two
  rebases and one `--amend`; `check:signed-range` passed every time.
- **The one-guard mutation check worked exactly as designed.** Neutering the
  `nlink`/`isFile` FIFO-and-hardlink refusal failed precisely the two named
  tests that claim to cover it and nothing else — the commit's "mutation-verified"
  claim was true for the guard sampled.
- **`internal/` privacy held under scrutiny.** `spec-conformance-reviewer`
  independently confirmed no `internal/` symbol reaches a public barrel, and
  the three documented `M3L_APPEND_ONLY_MAX_*` values still matched the doc page
  after being moved between files.

## What didn't go as planned, and why

### 1. A "complete, security-reviewed" slice carried five defects, because it had never been pushed

The plan described Step 1 as "landing and verification, not authoring" — the
commit was authored, signed, and self-described as mutation-verified. Landing it
surfaced five real defects: a zero-coverage validation `throw`; an internal
helper leaking into the public API through the barrel's `export *`; a provenance
sidecar that both mis-anchored three moved constants and omitted all three new
exports; a silent torn-tail path on `onTruncatedTail: null`; and six comment
blocks asserting that a live security guard was absent. Each was fixed in its
own commit.

**Why it happened:** the branch was committed at 10:50 and never pushed, so it
had never met `pre-push`, and never met CI at all. Every one of these defects is
caught by a gate — but only by a gate that runs on push or in CI. A commit that
exists only locally has been reviewed by nobody and gated by nothing, regardless
of how thorough its message is.

**Fix for future:** treat an unpushed branch as unreviewed work, not as finished
work awaiting a merge. Budget landing it as an implementation task with a full
gate loop, not as a formality.

### 2. `check:index` was passing vacuously

The `core/storage` provenance sidecar was missing `M3LAppendOnlyReadOptions`,
`M3LAppendOnlyTruncatedSegment` and `M3LAppendOnlyStreamReadError` entirely.
Because `gen:index` derives the catalog from the **sidecar**, not the barrel,
generated and committed output agreed — both omitted all three — so `check:index`
reported "up to date" while the index was missing three shipped exports. The
gate only started telling the truth once the sidecar was repaired: 809 → 812
symbols.

**Why it happened:** this is the trap `/syncing-docs` documents ("a new export
must be in the sidecar `sources[]`, not just the barrel"), and it is invisible
precisely because the gate is green. `check:doc-exports` walks the barrel and
would have caught it — but it runs in the same lane that was already failing on
a different error, so it never got the chance until the first error was cleared.

**Fix for future:** after adding a public export, treat a **no-op `gen:index`**
as the alarm. If a symbol was just added and the generator produces no diff, the
sidecar is the missing link — do not read the green `check:index` as
confirmation.

### 3. Three gate failures were only reachable at push or in CI

`check:file-budget` (25,312 vs the 25,000 ceiling), `knip` (two unused exported
types), and the ESLint heap OOM all passed or were invisible locally and failed
at `pre-push`/CI. The file-budget failure was self-inflicted: the four-line
comment explaining the `null` fix pushed a file that was already at ~24,940
bytes over the line.

**Why it happened:** `knip` is a CI-only gate absent from the pre-push cadence,
`check:file-budget` runs only at `pre-push`, and the OOM depends on ambient host
memory rather than on the code. The local `pnpm <gate>` runs that were green were
green honestly — they simply are not the same set CI runs.

**Fix for future:** before pushing a branch that adds files or exports, run the
CI-only gates explicitly (`pnpm knip`, `pnpm check:file-budget`) rather than
inferring coverage from the pre-push list. And re-run `check:file-budget` after
any comment-sized edit to a file already near the ceiling — "it passed earlier"
does not survive a later edit. _(promoted → CLAUDE.md)_

### 4. A test suite can look exhaustive and still not discriminate the bug

`claude-pr-review` found the reader enforced `maxLineBytes` one byte more
loosely than the writer: the writer measures `content + "\n"`, the reader
measured content alone, so a line of exactly `maxLineBytes` content bytes read
back as genuine despite being unwritable — the documented contract says the
ceiling is "newline included". The slice's own S2 regression suite exists to
catch exactly this defect class, and it stayed green with the bug present: it
asserts 2045/2046/2047-byte content at `maxLineBytes: 1024`, all far over the
ceiling under either rule.

**Why it happened:** the S2 tests were written to reproduce a specific observed
exploit (~2x the ceiling), not to pin the boundary. Reproducing an exploit and
pinning a limit are different jobs, and passing the first does not imply the
second.

**Fix for future:** when a test suite guards a numeric limit, assert **both
sides of the exact boundary** (`limit - 1` accepted, `limit` rejected), not a
comfortably-over value. Then mutation-check it: if flipping the comparison fails
nothing, the boundary is unguarded.

### 5. The plan's own evidence had rotted between authoring and use

Two of the plan's factual claims did not survive re-derivation. It said X7b
should note that ADR-0070's display-vs-persist rule "still needs its ADR-0035
Update" — that Update already exists, dated 2026-08-20, shipped under X1. And
its "nothing imports the audit port" framing, while true of `audit/port.ts`,
reads as false against `runs/orchestrator.ts`, which does pass a `ctx.audit` —
that being `runs/audit.ts`, a deliberate X4-era sibling sink for machine
transitions that ADR-0070 explicitly does not replace. Both were corrected
before they reached the X7b row.

**Why it happened:** the plan was authored against a repo state that had already
moved, which is the standing hazard CLAUDE.md's "re-derive any authored claim"
rule exists for.

**Fix for future:** re-derive every evidence claim a tracker row will assert,
_at the moment of writing the row_ — a row is a durable public statement, and an
inherited claim in one is indistinguishable from a verified one.

## Lessons learned

- **An unpushed commit is unreviewed work.** No gate has run on it, however
  confident its commit message is. Landing an orphaned branch is an
  implementation task with a full gate loop, not a merge formality. _(promoted → docs/contributing/contributing.md)_

- **A green gate can be a vacuous gate.** `check:index` passed while the index
  was missing three exports, because generator and committed artifact were
  derived from the same incomplete sidecar. A gate comparing two derived
  outputs proves they agree, not that either is right — a no-op `gen:index`
  right after adding an export is the tell.

- **Enumerate gates from `package.json`, not from the pre-push list.** `knip`
  and `check:file-budget` are real gates that the pre-push cadence does not
  cover; both failed after a fully-green local run. _(promoted → .claude/rules/tests.md)_

- **Pin both sides of a numeric boundary.** A test at 2x the limit passes
  whether the limit is right or one byte loose. Assert `limit - 1` accepted and
  `limit` rejected, then mutation-check that flipping the comparison actually
  fails something.

- **Mutation-test the guard you are trusting, not the one that is convenient.**
  Sampling one of six claimed guards confirmed that guard and nothing more; the
  genuinely broken behaviour (`onTruncatedTail: null`) sat in a different code
  path that no test touched.

- **A shipped port with no importer is not a shipped feature.** The X7 audit
  layer passed every gate in the repo while having zero production consumers,
  because no gate asserts that an exported port is imported anywhere. "The
  slices merged" and "the tracker row is done" are different claims, and only
  the first is machine-checked. _(promoted → docs/contributing/contributing.md)_

- **Two review spokes can disagree, and the specific one can be right.**
  `silent-failure-hunter` reasoned that `context.onTruncatedTail?.(…)` "cannot
  short-circuit silently" — true for `undefined`, false for `null`, which is
  exactly the value that broke it. Reading the code settled it; taking the
  broader clean verdict at face value would not have.

- **A comment that misstates a security control is a defect, not a nit.** The
  suite claimed the `nlink` hardlink check was "deliberately NOT mirrored" and
  "harmless" while the reader applied it and two named tests depended on it.
  Deleting a guard on the strength of a stale comment is a plausible next edit.

## Follow-ups filed

Filed as tracker row **X7b — audit wiring, view actions & correlation
threading** in `docs/plans/IMPLEMENTATION.md` (evidence re-derived at filing
time, not copied from the plan): no importer of `audit/port.ts` outside its own
tests; no `view.*` member in `M3LHumanActionKind`; zero `AsyncLocalStorage`
hits; `M3LScriptRunOptions` lacking `correlationId` (a semver event needing plan
mode) with `launchRun` dropping the id before `startRun`. The row also carries
the two non-blocking findings from #823's review that were deliberately not
fixed there — `read()` ignoring unknown option keys, and the reader's `finally`
swallowing a `close()` failure on the success path.

X7b is a **sibling** of X7, not a child: hub-sync parenting is epic-only and
derives nothing from the ID suffix.
