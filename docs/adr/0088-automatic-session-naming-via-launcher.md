# 0088. Automatic session naming via a launcher wrapper

- **Status:** Accepted; amends ADR-0087
- **Date:** 2026-09-03
- **Deciders:** repo maintainer

## Context and problem statement

[ADR-0087](./0087-claude-code-session-naming-convention.md) settled the
`<kind>-<slug>` vocabulary but, constrained by the fact that no hook can read
or set a session name, applied it through a single lever: `starting-work`
recommends a name and the user runs `/rename <name>` or `claude -n <name>` by
hand. That mechanism shipped across PRs #902–#906.

Feedback after those PRs merged rejected that mechanism outright: session
naming must be automatic, applied by the harness, never a step the user has to
remember to do. ADR-0087's two hard constraints still hold —

- No hook can read or set a session name, and command hooks cannot invoke
  slash commands.
- Transcript reads remain confined to `bin/session-telemetry.mjs`
  (ADR-0084).

— but ADR-0087 only considered application mechanisms _inside_ the hook
system. It did not consider the one place the name is actually consumed by
Claude Code before any hook could run: the `claude -n <name>` launch flag
itself. Computing that flag's value is ordinary scripting, not a hook, and
scripting can run the name through the same validation the statusline already
applies before the session ever starts — closing exactly the gap `starting-
work`'s free-text recommendation left open.

## Decision drivers

- **Eliminate the free-text `/rename` step** for the case `starting-work`
  already targets: starting new work, before the session opens.
- **Reuse ADR-0087's vocabulary and validation** rather than inventing a
  second naming scheme — the wrapper computes the same `<kind>-<slug>` shape
  the statusline already validates.
- **Small blast radius on shipped, tested code** — `bin/worktree-new.mjs`
  and the statusline/telemetry surfaces from PRs #904/#906 are unchanged;
  the naming _format_ did not change, only how a name is applied.
- **Fail loudly, not silently**, when the kind can't be inferred (a
  `main`-resident session has no branch to derive it from) rather than
  falling back to an unnamed session.

## Considered options

1. **Keep ADR-0087 as-is** (manual `/rename`/`claude -n`) — rejected per the
   new instruction that naming must never be a manual step.
2. **A launcher wrapper** (`bin/claude-launch.mjs`, run as
   `pnpm session:launch`) that derives `<kind>-<slug>` and execs
   `claude -n <name>` itself, replacing the wrapper process. Zero-touch for
   the dominant case — a branch-derivable `<kind>/<slug>` branch (`BRANCH_KINDS`:
   `feat`, `fix`, `docs`, `chore`, `refactor`, `ci`), already decided
   by `starting-work` before the session opens — since the branch alone
   determines the full name. `main`-resident-only kinds (`audit`, `research`,
   `review`, `merge`) have no branch to derive from, so the
   wrapper requires an explicit `--kind <kind>` flag plus a slug in that one
   case — still never a free-text `<kind>-<slug>` string typed and hoped to
   match the pattern, since the wrapper composes and validates both parts.
3. **Extend `bin/worktree-new.mjs` only**, auto-launching a named session
   after provisioning. Rejected as the _sole_ mechanism: it only covers
   worktree creation, not the more common "new branch in the shared
   checkout" path (`git switch -c feat/<slug>`, `starting-work`'s default
   location per ADR-0013), and it risks the existing, tested script by
   changing its default behavior to spawn an interactive child process.
4. **Document a shell-alias convention only**, no committed script —
   rejected: unversioned, invisible to `check:*`, drifts silently across
   machines, and can't be tested.

## Decision

We chose **option 2**. `bin/claude-launch.mjs` (invoked as
`pnpm session:launch`) computes the name and execs `claude -n <name>
[-- <passthrough args>]`:

```bash
pnpm session:launch                          # on a branch-derivable
                                              # <kind>/<slug> (BRANCH_KINDS):
                                              # derives kind+slug from the
                                              # branch, no other input
pnpm session:launch --kind audit some-slug   # main-resident-only kinds:
                                              # explicit kind + slug, still
                                              # validated and composed by
                                              # the script
pnpm session:launch -- --resume              # passthrough after `--` reaches
                                              # the underlying `claude` call
```

Naming logic (kind enum, `SLUG_PATTERN`, the ≤40-char bound, branch-derivation
for `feat`/`fix`) lives in a new shared module, `bin/lib/session-name.mjs`, so
`bin/claude-launch.mjs` cannot drift from the pattern `.claude/hooks/
statusline-context-pressure.mjs` validates against — both read the same
vocabulary, they just don't share one file across the hook/`bin` boundary.

`starting-work`'s sixth decision (Step 3, ADR-0087) changes what it
recommends running: instead of the literal `/rename <name>` or
`claude -n <name>` command, it recommends the literal `pnpm session:launch`
invocation (with `--kind` when the decided work has no branch to mirror).
The recommendation is otherwise unchanged — same decision, same point in the
flow, different command.

`bin/worktree-new.mjs`, the statusline widget, and `bin/session-telemetry.mjs`
are **not modified by this ADR**. The convention's shape is identical to
ADR-0087; only the application mechanism moved from a user-run command to a
harness-run one.

### Residual manual gap

A session **already open** before this ADR's launcher exists cannot be
renamed by the wrapper — there is no way to inject a launch-time flag into a
process that already started. Renaming an in-flight session (this ADR's own
implementation session included) still requires `/rename` by hand. This is
unavoidable under the same hard constraint ADR-0087 already established (no
hook can act on a running session), and it is out of this ADR's scope: the
target is starting new work, which `starting-work` already gates, not
retrofitting a name onto a conversation already underway.

### Reaffirmed (2026-09-03)

A follow-up audit, per the user's explicit request, re-ran
`/refreshing-anthropic-guidance` scoped to session naming/renaming to check
whether this mechanism is still correct or should instead be wired into a
Claude Code hook. Direct fetches of `code.claude.com/docs/en/cli-reference`
and `.../sessions`, plus a CHANGELOG delta (only `2.1.258`/`2.1.259` released
since the pinned `2.1.257`, neither touching naming), found **zero drift**:
`--name`/`-n` at launch and `/rename` mid-session remain the only documented
naming mechanisms, and Anthropic documents no hook field, `settings.json`
key, environment variable, or shell-integration pattern for automating it.
The launcher wrapper is confirmed as the correct, and only possible,
application of the one lever Anthropic provides — not a workaround.

That audit also added an opt-in shell-integration recipe and installer
(`pnpm session:install-shell-hook`, `docs/contributing/contributing.md` §
Session naming) that shadows the bare `claude` command with the launcher
inside a shell function, narrowing (not closing) the adoption gap below —
a contributor who opts in no longer needs to remember to type
`pnpm session:launch` instead of `claude`.

## Consequences

- **Positive:** the dominant case (`feat`/`fix` branch work) is named with
  zero manual input at the point the user already runs a command to start
  work; the `main`-resident case drops free-text naming for two small,
  validated inputs; the statusline and telemetry surfaces need no changes
  since the name shape is unchanged.
- **Negative / trade-offs:** a session already open before this launcher
  exists (or one the user starts by typing `claude` directly instead of
  `pnpm session:launch`, or without opting into the shell-integration hook
  above) still requires manual `/rename`; `main`-resident kinds still require
  the user to state a kind, since no signal exists to infer one from git
  state alone.
- **Semver impact:** none — internal harness/tooling convention, no public
  API surface.

## Links

- Supersedes / superseded by: amends
  [ADR-0087](./0087-claude-code-session-naming-convention.md)
- Related: [ADR-0013](./0013-git-worktrees-for-task-isolation.md) (worktree
  creation `starting-work` decides between), `docs/contributing/contributing.md`
  § Session naming (operational rules)
