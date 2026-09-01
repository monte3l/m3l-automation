# U12 — `m3l completion` (bash/zsh/fish)

**Date:** 2026-09-01
**Issue:** [#536](https://github.com/monte3l/m3l-automation/issues/536)
**PRs:** #836 (command + renderers + docs), #837 (parameters + operations),
plus this close-out.
**Tracker:** [`../plans/IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md) row U12.

## What shipped

`m3l completion <bash|zsh|fish>` prints a self-contained shell-completion
script to stdout. The generated script completes:

- the 10 static commands and the 17 discovered script names at the first
  positional;
- `bash`/`zsh`/`fish` after `completion`;
- a script name after `inspect`/`presets`/`run` (not after `new`, whose
  positional must _not_ already exist);
- each script's own parameter flags after that script's name, including one
  flag per declared alias;
- each operation-declaring parameter's operation names after any of that
  parameter's flags;
- the CLI-reserved flags where each is valid — `--json`/`--help`/`-h`/
  `--version` everywhere, `--in-process`/`--dry-run` on dynamic dispatch only.

A bare `m3l completion` is a usage error (exit `2`); there is no `$SHELL`
auto-detection. An unknown shell reuses `ERR_CLI_INVALID_PARAMETER_VALUE`
(already exit `2`) with Damerau–Levenshtein suggestions. `--json` emits one
`{ shell, script }` object.

Two new modules, no new `src/` layer (so `check:cli-scaffold` stayed green):
`src/commands/completion.ts` (validation + model building) and
`src/cli/completion-script.ts` (three **pure** renderers).

## What went as planned

- **Static generation was the right call.** Every `m3l` invocation costs
  ~550 ms — Node startup plus module load, even for `--version`, which never
  touches discovery. A callback-per-TAB design would have put that on every
  TAB press. Everything U12 completes is knowable at generation time, so a
  dynamic resolver would have bought freshness and nothing else.
- **Every seam already existed.** `discoverScripts`, `loadParametersCached`,
  `Core.M3LConfigParameterDescriptor` (which already carries `operations`
  since U4/ADR-0055), `suggestNames` and `M3LCliError` covered the whole
  feature. No new introspection code was written.
- **`check:cli-docs` had already anticipated U12.** Its
  `CLI_CANONICAL_SECTIONS` declared `{ heading: "## Completion", required:
false, since: "U12" }` before this work started, and validated the section
  when present. Reading the gate's source first (rather than prose about it)
  meant the docs landed in the right shape on the first try.
- **Pure renderers made the output testable.** Exact-text assertions over a
  fixed model, with no I/O in the renderers, made "what exactly does this
  emit" a unit test rather than a manual read.

## What diverged

### The reserved-name set has seven sites, not four

The plan named four source literals. There are seven, and the three extra are
all test-side — each invisible to a _different_ gate, which is why they
surfaced one at a time rather than together:

| Site                                                                           | Surfaced by                                  |
| ------------------------------------------------------------------------------ | -------------------------------------------- |
| `main.ts`, `commands/dynamic.ts`, `commands/doctor.ts`, `scaffold/manifest.ts` | the plan                                     |
| `tests/scaffold-manifest.test.ts` — exact-array assertion                      | `pnpm verify` (typecheck and lint both pass) |
| `bin/tests/check-cli-docs.test.ts` — pinned at nine names                      | `pre-push` only                              |
| `tests/doctor.test.ts` — the drift guard                                       | `pnpm verify`                                |

The `bin/tests` one cost a full round trip. That directory is excluded from
the default Vitest project and runs only under `vitest.bin.config.ts`, which
`pnpm verify` does not invoke — so `verify` went green, and the push failed
afterwards on a file `verify` had never executed. **A green `pnpm verify` does
not imply a green `pre-push`.**

Two of the seven are now self-maintaining rather than hand-copied:

- `tests/doctor.test.ts`'s guard is **three-way** (doctor ↔ manifest ↔
  dynamic). `dynamic.ts` declared the same literal and was previously
  unguarded — exactly the drift this work would have introduced. It was
  mutation-tested: deleting `"completion"` from `dynamic.ts` alone fails the
  test, and it passes again on restore.
- `tests/scaffold-manifest.test.ts`'s per-name `test.each` now derives from
  `RESERVED_CLI_NAMES` instead of re-listing it (66 → 68 tests), so it covers
  `new` and `completion` and cannot fall behind again.

The exact-array assertion above it was **deliberately left hand-written**. It
is the one place pinning content _and order_; deriving both sides would make
the pair vacuous — a reconciliation whose two sides come from one source can
never fail. Keeping one side hand-pinned is what gives it teeth.

### The docs could not be split from the code

`bin/check-cli-docs.mjs` cross-checks `## Commands` against `main.ts`'s
`STATIC_COMMAND_NAMES` in **both** directions, so a command with no `####`
heading fails and a heading with no command fails. A docs-first or code-first
split is impossible; both must land in the same PR. This was confirmed by
watching the gate fail with exactly that message after wiring dispatch.

### An allowlist that is too tight makes prose unreadable

The comment scrub initially reused the token allowlist verbatim, which
rendered a config-load reason as `config?import?failed`. A space is harmless
inside a `#` comment in all three shells; a **newline** is the character that
actually matters, because it ends the comment and lets the rest of the text
start a statement. The scrub now permits a space and nothing else outside the
token set, and the newline case is asserted directly.

### Renderers hit the `max-lines-per-function` ceiling

Both the bash and zsh renderers exceeded ESLint's 60-line function limit,
because a shell script's body is mostly fixed text. Hoisting the
model-independent tail into a module-level `readonly string[]` constant
(`BASH_COMPLETE_BODY`, `ZSH_DISPATCH_BODY`) fixed it and made the split
meaningful: what is hoisted is exactly the part with nothing interpolated
into it, which is also the part that carries no injection risk.

## Verification beyond the unit tests

Three tiers, because exact-text assertions alone only prove the renderer is
self-consistent:

1. **Exact-text assertions** over a fixed model, per renderer.
2. **Real parsers.** `bash -n` and `zsh -n` run inside the test suite against
   the generated scripts, including the empty-`case` edge case when no scripts
   are discovered.
3. **Driving the completion function.** The generated bash function was
   sourced and invoked directly with `COMP_WORDS`/`COMP_CWORD` against the
   real 17-script workspace — `m3l sqs-etl --command <TAB>` →
   `dump send redrive delete purge transform list-queues`, `--command d<TAB>`
   → `dump delete`, `m3l inspect s<TAB>` → the three `s`-prefixed scripts.
   This is the tier that would have caught a logically-valid script that
   completes the wrong thing, and it needs no interactive terminal.

**fish was never syntax-checked.** It is not installed on this host and is not
assumed in CI, so its renderer is covered by exact-text assertions only. Both
PR bodies state that plainly rather than implying otherwise.

## Lessons

- **Enumerate a "reserved set" by grepping for a member, not by trusting a
  plan's census.** `grep -rn '"wizard"'` found all seven sites in one command;
  the plan's four came from an audit that had only looked at `src/`.
- **`pnpm verify` and `pre-push` are not the same set.** `bin/tests/**` runs in
  the second and not the first. When a change touches something `bin/` pins,
  run `pnpm vitest run --config vitest.bin.config.ts` explicitly before
  pushing. _(promoted → .claude/rules/tests.md)_
- **Read a gate's source before designing around it.** `check:cli-docs`
  already knew about U12; discovering the bidirectional `## Commands`
  cross-check by reading `bin/check-cli-docs.mjs` was cheaper than discovering
  it from a red CI run — and passing that finding to the concurrent U10
  session let them fix their slice plan before writing any code.
- **When a generated artifact is executable, the allowlist is the design.**
  Deciding which characters may be interpolated — and separately, which may
  appear in a comment — is the whole security surface. Both were made
  explicit, quoted regardless, and tested with hostile input.
- **`script-aws-provisioning-failure.test.ts` is the pre-push contention
  canary on this host, not a flaky test.** Three sessions independently hit it
  in the same window: two concurrent Claude sessions running `pre-push` under
  lefthook's `parallel: true` starve Vitest, and this test's 5 s timeout is the
  first to trip. It passes in ~1.2 s in isolation every time, and the serial
  `pnpm verify` is green. The fix is to serialize the sessions, never
  `--no-verify`, and never to raise the timeout — the timeout is doing its
  job. (ADR-0080 covers the host-capacity side; `pnpm check:host-resources`
  warns before you start.)
- **Cross-session coordination paid for itself.** The concurrent U10 session
  and this one both grow the reserved-name set. Exchanging the site list, the
  drift-guard change and the docs-coupling constraint mid-flight meant U10
  revised its slice boundaries before writing code, and this session got an
  independent reproduction of the contention flake instead of chasing it as a
  real failure.
