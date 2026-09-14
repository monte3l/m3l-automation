# Work log — X8e slice 1: `errnoCodeOf` export (2026-09-14)

This log covers issue #1251 (X8e — "remaining hand-rolled errno-code
spellings"), the follow-up X8d (PR #1245) filed after hardening
`isNodeError`/`isEnoentError` to require an own-property, single-read errno
code. It records the investigation that re-derived the issue's own census
(finding two of its claims wrong), the design of a two-PR split, and PR 1's
implementation, review, and merge — the library slice: promoting `guards.ts`'s
module-private `readErrnoCode` to the public `errnoCodeOf` and converting
every `m3l-common` call site onto it. Slice 2 (`m3l-cli`, the console-server
duplicate, `bin/` tooling) is tracked separately and gets its own log once it
lands.

## Summary

- Investigated issue #1251 via three parallel Explore agents (m3l-common
  sites, m3l-cli sites + dependency posture, X8d precedent + conventions),
  then a Plan agent for the implementation design, verified against the live
  repo before writing the plan file.
- **Two claims in the issue were wrong** and corrected by re-derivation: (1)
  the issue said `m3l-cli` "cannot reach" the shared guard — false, it
  already depends on `@monte3l/m3l-common` and two CLI files already call
  `Core.isNodeError`; (2) the issue grouped `step-exec.ts`/`run/in-process.ts`
  in with the errno sites — they check `ERR_OPERATION_ABORTED`, an ADR-0049
  cancellation sentinel, not an errno.
- Also self-corrected mid-investigation: I initially described several sites
  as "double-read" via `"code" in x`, but `in` is a presence test, not a
  property read — this changed the abort-site recommendation from "harden in
  place" to "exclude, file X8f" (there was no read-count defect there at all).
- Design covered by 4 `AskUserQuestion` rounds with the user: library API
  shape (export `errnoCodeOf`), abort-site disposition (exclude + file X8f),
  extra-scope inclusion (config providers, `core/environment`, console-server
  dedup, `bin/` tooling — all selected), and PR sequencing (two PRs, library
  first).
- PR 1 (#1252, `feat/x8e-errno-codeof`) shipped: `errnoCodeOf` exported from
  `core/utils/guards.ts` (with `isNodeError`/`isEnoentError` now delegating to
  it), and five m3l-common call sites converted —
  `internal/files/copyExecution.ts` (local helper deleted outright),
  `core/config/M3LJSONConfigProvider.ts`, `M3LYAMLConfigProvider.ts`, and two
  sites in `core/environment/index.ts`. `@monte3l/m3l-common` 4.8.1 → 4.9.0.
- 15 new library test cases (`utils-guards-errno.test.ts`) plus 2
  characterization tests added post-review (`files.test.ts`). `pnpm verify`
  green (73/73) at every checkpoint; full workspace `pnpm test:coverage`
  green (22,453 tests) before the first push.
- `claude-pr-review` verdict: PASS, 1 Should-fix (missing characterization
  test for `copyExecution.ts`'s tightened tolerate/rethrow boundary), 1 Nit.
  Should-fix resolved via `/resolving-pr-comments` (2 new tests, `test:`
  commit, `Acknowledged-Should-Fix` footer).
- Merged via squash (`gh pr merge --squash`) as `e9dc5120`. Worktree/branch
  cleanup done via `finishing-work`; two pre-existing unrelated stale
  branches (`docs/x8e-errno-followup`, `fix/x8d-errno-own-property`) also
  cleaned up since `check:staleness` flagged them and their content was
  confirmed already squash-merged.
- Skills used: `starting-work`, `creating-prs`, `syncing-docs` (twice),
  `resolving-pr-comments`, `finishing-work`, `writing-work-logs`.
- Spoke incidents: none.
- Compaction events: none.

## What went as planned

- **The pre-push hook caught nothing the local `pnpm verify` runs hadn't
  already caught.** Both pushes (initial + the should-fix follow-up) passed
  `format:check`/`lint`/`typecheck`/`test:coverage`/`build-exports`/`checks`
  cleanly on the first try — the discipline of running `pnpm verify` after
  every reconstructed commit sequence paid off.
- **The pre-push review fan-out (`code-reviewer` + `spec-conformance-reviewer`
  - `silent-failure-hunter`) converged on the exact same Must-fix**
    independently — an overclaiming TSDoc paragraph in `guards.ts` about
    `packages/m3l-console-server`'s copy already delegating (it doesn't yet;
    that's slice 2). Fixed before the first push, so the bot review's own Nit
    about the same paragraph ("byte-for-byte mirror" wording) was the only
    thing left to note, not fix.
- **The bounded re-review after the should-fix fix reported clean** — no new
  Must-fix, confirming the two characterization tests were correctly scoped
  and didn't introduce mock pollution risk in `files.test.ts`.
- **`check:test-counts`/`check:doc-provenance --update` behaved exactly as
  X8d's own precedent predicted** — blob re-stamps only, no hand-derivation
  of `lines` fields needed (confirmed by diffing X8d's own historical commit,
  which showed only blobs moved, not line ranges).

## What didn't go as planned, and why

### 1. Reconstructing commits after a post-push review finding needed three full reset-and-recommit passes

The bot review's Must-fix (TSDoc fix) landed after the branch had already been
pushed once. Since nothing was pushed to a shared branch beyond my own PR at
that point, I folded the fix into the original `feat:` commit via
`git reset --soft` + re-stage + re-commit rather than adding a cosmetic
follow-up commit — but this needed **three** iterations, not one: the first
reset missed that `guards.ts`'s TSDoc edit changed its git blob, which made
`docs/reference/core/utils.provenance.json`'s stamps stale again (caught only
by a full `pnpm verify` re-run, not by the targeted gates I'd been running).
The second reset fixed that but was interrupted by a genuine mid-review
`main` update (another PR merged), forcing a real rebase with a conflict in
`docs/adr/provenance.json`.

**Why it happened:** Any edit to a file with `docs/reference/**.provenance.json`
coverage changes that file's blob SHA, which staleness-checks against —
editing source and forgetting to re-run `check:doc-provenance --update`
_after_ the edit (not just once, upfront) is an easy step to drop when the
edit itself feels like "just a comment."

**Fix for future:** After any edit to a file cited by a provenance sidecar —
including a comment-only TSDoc fix — re-run
`node bin/check-doc-provenance.mjs --update` and `pnpm verify` before
re-committing, not just once at the start of the reconstruction. Never treat
a "just a comment" edit as exempt from the blob-staleness check.

### 2. A sibling PR merged to `main` mid-review, forcing a real rebase with a conflict

Between opening PR #1252 and its should-fix round completing, PR #1253
("settle V10 contract bounds and m3l-mcp publish set") merged to `main`,
touching `docs/adr/provenance.json` — the same file my own docs-reconcile
commit had modified. `gh pr view` reported `mergeStateStatus: CONFLICTING`
after the should-fix push.

**Why it happened:** `docs/adr/provenance.json` is a blob-SHA stamp file, not
tagged `merge=m3l-generated` in `.gitattributes` (unlike `catalog.json`/
`symbol-map.json`/`pnpm-lock.yaml`), so a rebase touching a commonly-cited
source file on both sides conflicts textually rather than auto-resolving —
exactly the hazard `resolving-pr-comments`' own Step 9 rebase warning names.

**Fix for future:** On a `docs/adr/provenance.json` conflict, resolve with
either side (content doesn't matter, it's about to be regenerated) then
immediately run `pnpm gen:adr-provenance` — never trust the hand-picked side
as final. This matches the skill's own documented guidance precisely; the
divergence here was in timing (the conflict surfaced only after Step 14's
mergeability check, not during the push itself), not in the resolution
procedure.

## Insights

- **`"code" in x` tests presence, not a read — audit claimed "double reads"
  against the actual property-access count, not against `in`-check
  appearances.** Conflating the two changed a recommendation from "harden in
  place" to "there is no defect here" for the abort-predicate sites. Before
  writing a code-quality finding about redundant reads, grep the exact
  property-access syntax (`.code`, `[code]`) rather than counting mentions
  of the property name.
- **Re-deriving a tracker row's own census (per CLAUDE.md's rot rule) is
  worth doing even when the issue text reads confidently.** Two of this
  issue's own claims were wrong — one a stale technical fact (the CLI
  dependency), one a miscategorization (abort sites grouped with errno
  sites) — and both would have shaped the wrong implementation if taken at
  face value.
- **A provenance-blob staleness check must re-run after every edit to a
  cited file, not just once at the start of a multi-pass commit
  reconstruction.** `_(see divergence 1 above)_` A comment-only TSDoc fix
  still moves the blob SHA.
- **`docs/adr/provenance.json` conflicts textually on rebase, unlike the
  three `merge=m3l-generated`-tagged derived files** — always resolve either
  side then `pnpm gen:adr-provenance`, never trust the picked side.
- **A squash-merged branch's `git branch -d` refusal ("not fully merged") is
  expected, not a signal to investigate** — verify the content actually
  landed (`git log <branch> ^origin/main` plus a spot-check that the squash
  commit contains the change), then `git branch -D` confidently.
