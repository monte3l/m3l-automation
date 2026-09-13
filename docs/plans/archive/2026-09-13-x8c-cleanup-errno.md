# Cleanup failure context names the underlying cause (X8c)

**Status: shipped** — one PR (#1236, `fix/x8c-cleanup-errno`), resolving
issue #1058. ADR-0070's 2026-09-13 Update records the design.

## Context

Issue #1058 (tracker row X8c) reported that `runCleanup`'s
`context.failures[].errno` named the `M3LConsoleError` code rather than a
Node errno for any driver that wraps its failure. Exploration traced it to
`toCleanupFailure` calling `errnoCodeOf(cause)`, which reads only the caught
value's own `code`. `M3LConsoleError extends Core.M3LError`, and `M3LError`
sets `code` as an own property. So the audit-trail driver
(`M3LConsoleError` → `M3LAppendOnlyStreamReadError` → fs error) and the
telemetry driver (`M3LConsoleError` → repository throw) both reported
`ERR_CONSOLE_INTERNAL` twice. The TSDoc on `CleanupDriverFailure.errno`
already documented the defect; nothing fixed it.

Exploration also found a second, operator-facing gap the row did not name:
the `cleanup` subcommand in `bin/m3l-console-server.mjs` printed only
`error.message`, so `context.failures` never reached an operator at all.

## Approach / Decisions

Four decisions were put to the user before planning:

- **What `errno` means:** walk the `.cause` chain, skip M3L links, and let
  the first non-M3L link decide. The rejected options were a SystemError-only
  `errno` (silent for store failures), an additive `causeCode` field (keeps
  the misleading field), and no walk at all (drops every useful value).
- **CLI output:** print the failures in the same PR, one stderr line per
  entry, and nothing else from `context` or `cause`.
- **Helper location:** `errors/errno.ts`, beside `errnoCodeOf`, so its
  hardening is reused.
- **Close-out:** code, tests, `console.md`, an ADR-0070 Update, and this
  tracker row in the same PR.

The work ran hub-and-spoke: `test-author` wrote the RED tests (14 helper
cases, plus two cleanup assertions that failed with
`errno: "ERR_CONSOLE_INTERNAL"`), then `code-implementer` made them pass.
Pre-push review raised two Should-fixes, both applied. `code-reviewer` and
`silent-failure-hunter` raised them. `spec-conformance-reviewer` then found
the change conformant; its stale-prose nits were folded in.

- **Bound precision:** a wasted final `.cause` read was removed, the bound is
  now documented as "the caught value plus up to nine causes", and a
  9-versus-10-wrapper boundary test pins it.
- **Guarded CLI printing:** printing is wrapped in its own `try`/`catch`,
  with `exitCode` set first.

## Outcome

- **Helper:** `underlyingErrnoCodeOf` (`packages/m3l-console-server/src/errors/errno.ts`)
  feeds `CleanupDriverFailure.errno`. The audit-trail driver now reports
  `ENOTDIR`, and the telemetry driver reports the repository's own code.
- **CLI:** verified manually against a built `dist`. With a blocked audit
  root it exits 1 with `  auditTrail: code=ERR_CONSOLE_INTERNAL errno=ENOTDIR`
  on stderr, and a control run exits 0.
- **Tests:** the package suite passes (126 files, 3213 tests), and
  `pnpm verify` passed on the final rebased branch.
- **A clean rebase still broke the build:** the branch was rebased twice
  while in flight. The second rebase pulled in #1234, which moved
  console-server onto `@monte3l/m3l-common` and dropped the old alias. Git
  reported no conflict, because the old specifier sat only in lines this
  branch added. It still broke typecheck (TS2307) until those imports were
  moved too. The lesson: typecheck after a rebase that crosses a
  specifier or rename migration, even when git reports no conflicts.
- **Commit signing:** this box had no `~/.config/git/local.gitconfig`, so git
  had no `signingkey` and looked the key up by committer identity. That
  lookup missed the only secret key, because the key's uid carries a comment.
  The commits were signed by passing the key per command
  (`git -c user.signingkey=…`), without writing machine config. The permanent
  fix is left to the owner.
