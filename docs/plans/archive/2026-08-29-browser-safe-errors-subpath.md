# A browser-safe `./core/errors` exports subpath

**Status: shipped** — branch `feat/browser-safe-errors-subpath`, commit
`3688dd93`. Resolves issue #724 (filed F32), a follow-up from PR #723 (X9,
`m3l-console-web` skeleton).

## Context

PR #723 hit a real architectural gap: `claude-pr-review` flagged
`M3LConsoleWebError extends Error` for not extending `Core.M3LError`, but
there was no way to reach `M3LError` without importing the whole `./core`
namespace barrel — which drags the entire Node-oriented library (AWS SDK
credential providers, `inquirer`, `unzipper`, `mailparser`) into a browser
bundle. Empirically verified in #723's own investigation: adding
`Core.M3LError` to `main.tsx` took `vite build` from 20 transformed modules to
4,823, with dozens of `node:fs`/`node:crypto`/`node:child_process`
externalization warnings — directly contradicting ADR-0067's "deliberately
thin dependency policy" for `m3l-console-web`. The `review` required check on
#723 was overridden with issue #724 as the recorded justification, and
`console-web-error.ts` was left a plain `Error` subclass.

The blocking prior decision was ADR-0004: "The map has exactly three entries"
and its Consequences section named `…/core/errors` by name as a rejected
fine-grained import, calling the rejection "intentional." Any fix here had to
either reverse that decision narrowly or find another way to satisfy #723's
review finding.

## Approach / Decisions

1. **Verify before planning.** Re-derived every claim in issue #724 against
   current repo state rather than trusting the filed text: confirmed
   `core/errors` is a closed 6-file graph (`M3LError.ts`, `catalog.ts`,
   `M3LErrorUtils.ts`, `M3LOperationAbortedError.ts`, `M3LResult.ts`,
   `index.ts`) with zero `node:`/third-party imports, and confirmed the
   `exports` map has exactly three entries. One claim did not survive
   scrutiny: the issue argued X10/X11 would need the subpath to _reference_
   `M3LErrorOrigin`/`M3LErrorRetryable`, but `tsconfig.base.json`'s
   `verbatimModuleSyntax: true` already erases `import type` at build time —
   a type-only reference through the existing `./core` barrel is free. Only a
   _value_ import (`extends`, `instanceof`) actually needs the subpath.
2. **Amend, don't reverse, ADR-0004.** A dated `## Update` block carves a
   narrow, two-condition exception rather than reopening per-submodule
   entries generally: (a) a real browser-target consumer needs a value
   import a type-only reference can't serve, and (b) the submodule's whole
   transitive source-import graph is machine-proven node-free. Condition (a)
   is what the `verbatimModuleSyntax` finding narrows — most future asks
   here will fail it.
3. **Back the exception with a gate, not a comment.** `pnpm
check:browser-safe-subpath` (`bin/check-browser-safe-subpath.mjs` +
   `bin/lib/browser-safe-subpath.mjs`) walks each registered subpath's TS
   _source_ import graph (not built `dist/`, so it runs pre-build in CI
   alongside `check:api`) and fails on any `node:` builtin or bare
   third-party specifier reachable from it. Without this, the exception is a
   comment someone could invalidate by adding one `node:crypto` import three
   hops into the graph — exactly the drift class `check:api`/`check:exports`
   don't catch, since they validate the map's shape, not what its entries
   transitively import.
4. **Adopt it end-to-end, not just add the entry.** `M3LConsoleWebError` now
   `extends M3LError` via the new subpath (closing the original review
   finding), and `api/client.ts`'s hand-rolled error-envelope type gained the
   `origin`/`retryable` fields it was silently dropping from the server's
   ADR-0066 envelope contract — proving the subpath is actually consumed, not
   just exported.
5. **Adopt #724 as a tracker row rather than leave it hub-sync-blind.** The
   issue carried no `<!-- m3l-hub-sync:… -->` marker (hand-created, wearing
   hub-managed labels — the same failure mode issue #576 hit). Filed as
   **F32** in `docs/plans/IMPLEMENTATION.md`'s Library friction section,
   then the marker was grafted onto #724's body so `pnpm sync:hub` adopts the
   existing issue instead of creating a duplicate.

## Outcome

Verified empirically, not just gate-green: `vite build` for
`m3l-console-web` now transforms **26 modules** with **zero**
`node:*`-externalization warnings — down from 4,823 modules and dozens of
warnings before this change. `check:api`/`check:exports` pass unmodified
against the real built `dist/core/errors/`; `check:exports-semver`
classifies the added key `additive`, so no breaking marker was needed.

One unrelated flake surfaced during verification:
`packages/m3l-console-server/tests/handler.test.ts`'s "a handler that throws
(5xx) still ends with ctx.signal aborted" failed twice under a full
`pnpm verify` run (concurrent host load — two other Claude sessions were
active) but passed cleanly 304/304 files in an isolated `vitest run
--coverage`. Matches this repo's documented F15/#489 resource-pressure
pattern; `packages/m3l-console-server` is untouched by this branch's diff.

`check:command-catalog` caught a real omission mid-verify: the new
`check:browser-safe-subpath` script needed its own `bin/lib/command-catalog.mjs`
row, same as every other `pnpm` script — a good example of the gate doing
its job on a brand-new script rather than an established one.

`pnpm verify -- --continue`: 49 steps passed, 9 skipped (push-only/gh-session
gates CI itself runs push-only, plus e2e hardware gates).
