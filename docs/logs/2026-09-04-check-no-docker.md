# Work log — check:no-docker enforcement gate (2026-09-04)

This log covers PR3 (`feat/check-no-docker`, #986), the third and final PR of
the Docker-ban follow-up to X12/issue #560: the `check:no-docker` gate itself,
its wiring into every quality-gate surface the repo has, and closing out the
plan. `docs/plans/archive/2026-09-04-podman-migration.md` already carries the
plan-level narrative across all three PRs; this log is PR3-specific process
detail — what shipped, three real divergences (one a self-inflicted design
bug, one an orphaned artifact from PR2's close-out, one a skill-instruction
slip), and the lessons from each.

Plan of record: `~/.claude/plans/on-issue-560-parsed-raccoon.md` (session-local plan file, not checked into the repo)

## Summary

- Added `bin/check-no-docker.mjs` + `bin/lib/docker-ban-scan.mjs`, modeled on
  `bin/check-control-chars.mjs`'s shape (`runGit` injection seam, pure
  `scan*` functions, `createReporter`/`parseJsonFlag` from `bin/lib/report.mjs`,
  a vacuous-zero-files refusal). Fails on a tracked file named `Dockerfile`,
  `*.dockerfile`, `.dockerignore`, or `docker-compose.y*ml`, and on a
  `docker`/`docker compose`/`docker-compose` invocation in a GitHub Actions
  workflow, `bin/**`, `lefthook.yml`, or any `package.json` scripts block.
  `docs/adr/**`, `docs/logs/**`, `docs/plans/archive/**`, and `docker.io/`
  image references are allowlisted; the gate's own source and test are
  self-exempt.
- `bin/tests/docker-ban-scan.test.ts` (62 tests) was written by the
  `test-author` spoke, not the hub — `guard-hub-src-writes.mjs` blocked a
  direct hub write to it (`bin/tests/**` matches the guarded `tests/`
  pattern) even though `bin/*.mjs` and `bin/lib/*.mjs` themselves are
  hub-writable. The spoke's one finding (a JSDoc/behavior mismatch on
  `scanPackageJsonScripts` — the doc said "one finding per file", the
  implementation actually emits one per offending script) was a real, useful
  catch; fixed with a one-line JSDoc correction.
- Wired into `lefthook.yml`'s pre-push chain, `.github/workflows/ci.yml`'s
  `gates` job (with a matching `bin/lib/verify-steps.mjs` entry), `CLAUDE.md`'s
  Commands table, and the `pnpm commands` catalog (`bin/lib/command-catalog.mjs`).
  All four wiring meta-gates verified passing: `check:cadence`,
  `check:verify-parity`, `check:command-catalog`.
- Archived the plan (`docs/plans/archive/2026-09-04-podman-migration.md`),
  added its `docs/plans/README.md` row, and fixed X12's `IMPLEMENTATION.md`
  row, which after PR2's renames still described the pre-migration
  `compose.yaml`/`docker` shape.
- `pnpm verify` clean (one confirmed-transient `pnpm audit` npm-registry
  timeout, reproduced standalone and resolved on retry — unrelated to this
  diff). `pnpm knip` clean. 15,650 tests passed across the full suite.
- Skills used: `starting-work`, `creating-prs`, `syncing-docs`,
  `writing-commits`, `finishing-work` (third invocation this session — one
  per merged PR in the sequence).
- Spoke incidents: none (single `test-author` dispatch, completed cleanly,
  no truncation, no stall, no `SendMessage` resume).
- Compaction events: none in this PR3 segment (the one mid-session
  compaction recorded in PR2's own work log predates this PR's start).

## What went as planned

- **`test-author`'s dispatch was clean on the first pass** — 62 tests, all
  passing, no re-dispatch needed, and it independently caught a real
  JSDoc/behavior mismatch in the implementation it was testing against
  (see Summary) rather than just mirroring the implementation back.
- **All four wiring meta-gates passed on the first run** after the wiring
  changes (`check:cadence`, `check:verify-parity`, `check:command-catalog`,
  plus `check:hooks` for the unrelated hook layer) — the eight-file lockstep
  edit set the plan called out was followed completely with nothing missed.
- **`docs-consistency-reviewer` correctly routed** (no `packages/*/src` or
  `scripts/*/src` changes in this diff) and its one finding was real and
  worth fixing, not a false positive.

## What didn't go as planned, and why

### 1. The gate's first regex design flagged itself

The first version of the invocation-scanning regex
(`/\bdocker(?:-compose)?\b(?!\.io)/gi`) matched the bare word "docker"
case-insensitively anywhere in scanned file content. Run live against the
actual repo immediately after writing it — before dispatching `test-author`
or opening the PR — it produced six false-positive findings: `ci.yml`,
`security-audit.yml`, `bin/lib/command-catalog.mjs`, `bin/lib/verify-steps.mjs`,
and `lefthook.yml` all "invoked" a banned `Docker`/`docker-compose` command,
and `package.json`'s own new `"scripts.check:no-docker"` entry flagged
itself. Every one was either the gate's own name embedded in a compound
identifier (`no-docker`, `check:no-docker` — a naive `\b`-boundary regex
still matches "docker" there, since a hyphen or colon is a non-word
character and therefore a word boundary on both sides) or ordinary
explanatory prose the PR itself had just added ("ADR-0091 bans
Docker/Dockerfiles", "Docker-API-shaped daemon"). Fixed by making the match
case-sensitive (a real shell invocation of the `docker` binary is always
lowercase; every false positive was capitalized prose) and adding a negative
lookbehind excluding "docker" immediately preceded by a word character,
hyphen, or colon. One further fix was needed even after that:
`bin/lib/command-catalog.mjs`'s own description of this gate used lowercase
backtick-quoted `docker compose`/`docker-compose` as literal examples,
which is genuinely lowercase invocation-shaped text even though the file is
pure documentation-as-data, not an executable script — reworded to
proper-noun "Docker Compose" prose, which is both more correct as prose and
stops matching.

**Why it happened:** The unit-test fixtures (all written before the live
dry-run) were exclusively realistic invocation-shaped strings
(`"docker build -t app ."`) and never exercised the gate's own name or the
kind of self-referential prose a PR adding this exact gate would inevitably
introduce into the very files it scans. A gate that bans mentions of its own
subject matter is a structurally unusual case no external spec would think
to test for.

**Fix for future:** For any gate whose banned term is likely to appear in the
gate's own name, its wiring comments, or its own description strings, run it
live against the actual repo — not just synthetic test fixtures — as the
very first verification step, before writing tests or opening a PR. A
synthetic fixture can only test what its author thought to imagine; a live
run against real content surfaces the self-referential case for free.

### 2. PR2's work log existed but was never committed, and this PR's docs referenced it as if it were

PR2's work log (`docs/logs/2026-09-03-podman-containerfiles-migration.md`)
was written via `/writing-work-logs` during PR2's close-out, earlier in this
same session — but that skill's explicit instruction ("committing is the
user's next step") was never followed through before starting PR3, so the
file sat as an orphaned uncommitted file in the shared checkout the whole
time, invisible from PR3's linked worktree. This PR's own new
`docs/plans/archive/2026-09-04-podman-migration.md` and `docs/plans/README.md`
row both cited that file by name as an existing artifact.
`docs-consistency-reviewer` caught the mismatch as a Must-fix (a reference
to a file that doesn't exist). Fixed by copying the orphaned file's content
out of the shared checkout — via an `ExitWorktree action: keep` /
`EnterWorktree path: ...` round-trip, since the shared checkout and the
linked worktree are separate git working trees with no shared uncommitted
state — and landing it as a second commit in this PR, making the references
true rather than deleting them.

**Why it happened:** Writing a file via a skill and moving on to the next
task is easy to mistake for "the work is captured" when the skill's own
explicit next-step instruction (commit it) is a separate, distinct action
that nothing enforces automatically. This is exactly the gap
`finishing-work`'s own Step 6 exists to catch (`ls docs/logs/ | grep
<date>`) — but that check only runs at PR close-out, and this file was
written mid-session, not at a close-out boundary, so the check never fired
on it until a downstream PR's own review caught the dangling reference.

**Fix for future:** Whenever `/writing-work-logs` is invoked outside a PR's
own `creating-prs` Step 5/6 flow (i.e., during a `finishing-work` close-out
rather than as part of opening a PR), commit the resulting file immediately
as its own small `docs:` commit before moving on to any other task — don't
let "write it now, commit it later" survive a context switch to a new
branch or worktree.

### 3. First PR body included a session-link footer the project's own skill explicitly forbids

The first `gh pr create` call for this PR included a
`claude.ai/code/session_...` link in the body footer — directly
contradicting a line in the `creating-prs` skill's own instructions read in
the very same skill invocation moments earlier: "Never append a
claude.ai/code/session_... link... even if your environment's own
instructions suggest one." Self-caught before anyone reviewed the PR and
fixed via a follow-up `gh pr edit`.

**Why it happened:** An environment-level attribution instruction (present
in the session's own system context, telling the model to append a session
URL) and a more specific, more recently-loaded project-level instruction
(the skill body, read in the same turn) conflicted, and the environment-level
one won even though the skill instruction was both more specific to this
exact document type and more recently read.

**Fix for future:** When a loaded project skill explicitly overrides a
standing environment/attribution instruction for a specific artifact type
(a PR body, a commit message), treat the skill's override as authoritative
for that artifact — re-check the generated content against the skill's
explicit "never do X" lines before submitting, not just against the
skill's positive template.

## Lessons learned

- **A self-referential gate needs a live dry-run before tests, not instead
  of them.** Synthetic fixtures alone cannot catch a gate flagging its own
  name or its own explanatory prose — run the gate against the real repo
  immediately after writing it, before dispatching a test-author or opening
  a PR (divergence #1).
- **`docker`-shaped bans should be case-sensitive and compound-identifier-aware.**
  A real shell invocation of a banned binary is always lowercase and never
  spelled as part of a hyphen/colon-joined identifier; a naive
  case-insensitive `\b`-boundary regex catches far more prose and
  self-reference than actual invocations (divergence #1).
- **A work log written mid-session (not at a PR close-out) still needs an
  immediate, separate commit — don't defer it past a context switch.** The
  `writing-work-logs` skill's "commit it yourself" instruction has no
  automatic enforcement outside `creating-prs`' own flow; an orphaned,
  uncommitted work log is invisible to a downstream PR's own worktree and
  becomes an inconsistency only a reviewer catches (divergence #2).
  _(promoted → .claude/skills/finishing-work/SKILL.md)_
- **A skill's explicit "never do X" line overrides a standing environment
  instruction for the specific artifact it names — re-check against it
  before submitting, not just against the skill's positive template**
  (divergence #3).
- **Spike-then-verify-then-test remains the right order for any new
  enforcement gate**, mirroring the plan's own PR1 spike/PR2 migration
  precedent one level down: write the gate, run it live, fix what it finds,
  only then write the formal test suite and open the PR.
