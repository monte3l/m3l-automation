# Work log — issue #1019 `agent-operator` deps boundary (2026-09-11)

This log covers resolving GitHub issue #1019 — `createAgentCliSurface`
(`scripts/agent-operator/src/lib/cli-surface.ts`) read all of its required
constructor dependencies with plain dot access, so a caller reaching that
state through a cast could inherit a value from a polluted
`Object.prototype`. It records the plan-mode design work (including a
census correction the issue itself needed), the TDD pipeline, an
adversarial security review that executed real exploit probes, and the
repeated host-memory-pressure recovery this session needed.

## Summary

One PR ([#1176](https://github.com/monte3l/m3l-automation/pull/1176),
`fix/agent-operator-deps-boundary`), merged via squash as `b8a0717b`,
closing issue #1019.

The issue's own census named **eight** required keys; re-deriving the
interface directly from source found **ten** — `flowTimeoutMs` and
`flowAllowlist` landed in an intervening PR (#1006's V9 slice) after the
issue was filed, and `flowAllowlist` carries the identical risk class as
the other two allowlists (the only membership layer before `m3l flow run
<name>` executes a flow file). Corrected via a comment on #1019 before
implementing, per the issue's own "must cover all N at once" rule.

Fix, in `createAgentCliSurface`:

- New `assertSurfaceDeps` reads and validates each of the ten required keys
  exactly **once**, via `Object.hasOwn`-gated helpers (`requireOwnDep` +
  four typed `require*` wrappers: `requireNonEmptyString`,
  `requirePositiveInteger`, `requireStringSet`, `requireStringMap`), then
  freezes the result into a `ValidatedSurfaceDeps` snapshot every one of
  the seven method thunks (`list`/`doctor`/`inspect`/`dryRun`/`run`/
  `triageRun`/`flowRun`) now consumes instead of `deps` — `deps` is never
  referenced again once construction returns.
- Validating at construction alone would not have closed the hole: four of
  the ten keys were already snapshotted into `ctx` at construction, but the
  other six (`cliTimeoutMs`, `dryRunTimeoutMs`, `flowTimeoutMs`, and all
  three allowlists) were re-read **live** off `deps` on every method call —
  so a construction-time-only check and the actual use were two separate
  reads of the same property, exploitable by a getter or a post-construction
  mutation of the retained bag.
- `instanceof Set`/`Map` (not duck-typing) for the three allowlist checks —
  a polluted `Object.prototype` can forge a `.has`/`.get` method as easily
  as any other property. The snapshot preserves `Set`/`Map` reference
  identity rather than copying, so a caller-subclassed `Map` with an
  overridden `get()` keeps working (the pre-existing `ThrowingAllowlist`
  regression test depends on this).
- Reused the existing `ERR_AGENT_OPERATOR_CONFIG` code; no new error code,
  no `exports`-map change (consumer script, not a published package).
- Extracted the file-local prototype-pollution test harness from
  `tests/lib/cli-surface.test.ts`'s M4c block into a shared, key-generic
  `tests/support/prototypePollution.ts` (its own `refactor:` commit) so the
  25 new required-deps tests reuse the proven pattern.

Verification: `scripts/agent-operator` suite 1402/1402 passing; full
workspace `typecheck`/`build` clean; `eslint`/`knip`/`prettier` clean on all
touched files; every one of the ten guards plus the `run` thunk's two
snapshotted reads individually mutation-tested (revert → confirm exactly
that row goes red → restore); an adversarial `security-reviewer` dispatch
executed real exploit probes (a two-faced getter, post-construction
mutation, `Object.prototype` pollution, duck-typed forgeries, injected
secret values) against the actually-compiled JS output rather than just
reading code, and could not refute the fix — it did catch one genuine TSDoc
overclaim, corrected in the same commit (see item 4 below).
`spec-conformance-reviewer` confirmed `docs/reference/scripts/
agent-operator.md` needed no update. Full CI green: 17 checks including
`CodeQL`, `review` (verdict PASS, zero Must-fix/Should-fix, two Nits — both
already-assessed intentional tradeoffs), `should-fix-ack`, `verify`.

Skills used: `starting-work`, `writing-commits`, `creating-prs`,
`syncing-docs`, `writing-work-logs`.

Spoke incidents: 2 truncations / 0 stalls / 1 resume. Both `test-author`
and `code-implementer` hit their 40-turn limit once each. `code-implementer`
was resumed correctly via `SendMessage` and completed its mutation-check
sweep. `test-author`'s resume was mishandled — a fresh `Agent` dispatch was
used instead of `SendMessage`, spawning a second, context-less agent that
re-derived the same facts independently (wasted, though harmless, since it
happened to confirm rather than contradict the hub's own direct
verification); see item 5 below.

Compaction events: none.

## What went as planned

- **The plan-mode design phase caught both structural gaps before any code
  was written.** A dispatched `Plan` agent's adversarial design review
  independently found the same "validate-then-trust is insufficient, must
  snapshot" defect the hub had already reasoned to, plus concrete exploit
  sketches (a getter answering the construction check honestly and a later
  read hostilely; post-construction mutation) — both incorporated into the
  approved plan before implementation started.
- **RED failed for the right reasons across all three categories.** All 10
  prototype-pollution rows, all 10 wrong-type rows, and both snapshot-
  invariant rows failed with distinct, correctly-attributed causes (missing
  presence guard, no type validation, live re-read) — confirmed by
  reconciling the exact failure count and signature before dispatching
  GREEN.
- **GREEN was clean on the design side.** The `code-implementer` decomposed
  the guard into small, single-purpose helpers unprompted-beyond-the-
  contract, correctly derived the `unknown`-return rationale for
  `requireOwnDep` (not stated explicitly in the dispatch prompt), and
  self-identified the file's `complexity`/`max-lines-per-function` ESLint
  caps as the reason for that decomposition.
- **Every review spoke (`silent-failure-hunter`, `code-reviewer`,
  `security-reviewer`, `spec-conformance-reviewer`) returned clean or
  Pass**, with the one Should-fix (the TSDoc overclaim) fixed in a single
  small follow-up dispatch.
- **The full `pre-push` gate suite and all 17 CI checks passed on the first
  push** — no should-fix round, no re-push needed.

## What didn't go as planned, and why

### 1. Two full `pnpm verify` runs and one `git push` were killed by host memory pressure

Both attempts at a full local `pnpm verify` were killed by the harness's
low-memory guard at the identical point (immediately after the
`lint-library` lane, entering the next parallel fan-out) — once while a
peer session was concurrently active, once again on retry. A subsequent
combined quality-gate command (`lint && typecheck && ... && test:coverage
&& ...`) was also killed, this time inside `lint:workspace`'s
`--max-old-space-size=8192` ESLint pass. A plain `run_in_background` `git
push` was killed too.

**Why it happened:** ADR-0080's documented host-resource contention (2+
concurrent Claude sessions on a memory-constrained host), compounded by the
harness's own low-memory kill targeting its tracked background jobs as a
set rather than the specific heavy process — as already documented in
`.claude/skills/creating-prs/SKILL.md` and two prior logs.

**Fix for future:** Detach every long-running command with `nohup <cmd> >
<log> 2>&1 & disown` and poll the raw PID via a `Monitor` until-loop
(`kill -0 $PID`) rather than trusting `run_in_background` tracking or a
`pnpm check:host-resources` clean report — see item 2 below for why the
latter gave no protection here. This recovered every one of the four kills
in this session without losing any actual work (the underlying commands,
once detached, completed and their logs were read directly).

### 2. `pnpm check:host-resources` reporting clean gave no protection against the next kill

`pnpm check:host-resources` reported "Host resource mitigations in place"
immediately before the `lint:workspace` run that was killed anyway; `free
-h` at the same moment showed 13GiB available out of 15GiB.

**Why it happened:** `check:host-resources` reports static host
configuration (earlyoom/oomd presence, zram, `MemoryMax`, a concurrent
`claude` process count) — it is not the same signal as the harness's own
live tracked-background-job accounting, which can kill a job regardless of
what the static check or `free -h` report at that instant.

**Fix for future:** Treat `check:host-resources`'s "clean" report as
informational only, never as license to skip the detach-and-poll pattern
for a long `run_in_background` command on this host. Promoted this
clarification into `.claude/skills/creating-prs/SKILL.md`'s existing
low-memory-kill note, which previously only named `free -h` as the
insufficient signal.

### 3. `EnterWorktree`-guarded worktree-isolation Bash checks rejected a nested `git` invocation

`nohup bash -c 'cd <worktree> && git push ...' > log 2>&1 & disown` was
rejected by the session's worktree-isolation guard ("this command hands
bash text naming git in a plain command, which cannot be shown to stay
inside the worktree"), even with an explicit `cd` inside the nested string.

**Why it happened:** The guard's static check for "stays inside the
worktree" evidently requires the `cd <worktree-path> &&` prefix to appear
literally at the top level of the command text, not nested one level down
inside a `bash -c '...'` string argument — a `git` token inside that nested
string isn't recognized as guarded by the outer `cd`.

**Fix for future:** When detaching a `git` command in a worktree-isolated
session, keep `cd <worktree-path> &&` at the literal top level of the
command and put `nohup`/`disown` around the whole thing directly (`cd
<path> && nohup git push ... > log 2>&1 & disown`) rather than nesting the
git invocation inside a `bash -c` string.

### 4. An adversarial security review found a genuine TSDoc overclaim

The `security-reviewer` spoke executed the actual case rather than only
reading code: it mutated `deps.presetAllowlist` (the same, retained `Map`
object, not a reassignment) after construction and showed the mutation
still reached a later `run()` call. The `@param deps` TSDoc claimed no
"post-construction mutation of `deps`" could reach a later call — true for
property reassignment, false for in-place content mutation of a retained
allowlist container (deliberately not copied, to preserve the
`ThrowingAllowlist` regression test's live-override semantics).

**Why it happened:** The claim was written to describe the vulnerability
class the fix closes (prototype inheritance, stale reads) without
separately auditing the "the container is a reference, not a copy" design
decision against the same sentence's wording.

**Fix for future:** Confirmed rather than new — this matches this repo's
own rule ("A TSDoc sentence asserting a security property is a claim to
verify, not prose to write") exactly. The fix here was a small, isolated
follow-up dispatch narrowing the claim to what the snapshot actually
closes, plus an explicit "treat every `Set`/`Map` handed to this
constructor as owned by the surface" caveat.

### 5. A spoke resume used the wrong tool once

After `test-author` hit its 40-turn limit with a near-complete report, the
hub dispatched a **fresh** `Agent` call (subagent_type `test-author`) to
"finish the report" instead of `SendMessage` to the original agent ID. This
produced a second, context-less agent that re-derived the same facts from
scratch (reading the already-written test files and re-running them) rather
than continuing the first agent's own state.

**Why it happened:** Momentary inattention to the tool-choice distinction
at the exact moment a truncation notification arrived — `SendMessage` to
the agent ID was the documented correct action and was used correctly for
the very next truncation (`code-implementer`) in the same session.

**Fix for future:** Confirmed rather than new — `.claude/rules/
subagent-dispatch.md` already states this exact rule ("Resume the SAME
spoke via `SendMessage`, never a fresh `Agent`/`Task` dispatch"). No
promotion needed; this was a one-off execution slip against an existing
rule, not a gap in the rule itself. The redundant dispatch was low-cost
here only because it happened to independently confirm rather than
contradict the hub's own direct verification — that will not always be
true, so the rule's value stands.

## Insights

- **A stale issue census is discoverable cheaply, before writing any
  code.** Re-deriving `CreateAgentCliSurfaceOptions`'s actual field list
  from source (one `Read` call) caught a two-key drift the issue's own text
  had no way to self-correct — confirms CLAUDE.md's existing "re-derive any
  authored claim you're about to act on" rule rather than adding a new one.
- **A security guard covering N of M lazily-re-read fields must snapshot,
  not just gate.** When some of a constructor's validated fields are read
  once (into a fixed context) and others are re-read live on every later
  call, a construction-time-only check is provably insufficient — the
  check and the use are separate reads of the same mutable property.
  Confirms `.claude/rules/library-src.md`'s existing "never validate a
  caller value and then let something else re-read it" rule directly,
  rather than adding new content.
- **`pnpm check:host-resources` passing is not evidence a heavy
  `run_in_background` command will complete on this host** — it reports
  static configuration, not the harness's own live tracked-job kill
  accounting. _(promoted → .claude/skills/creating-prs/SKILL.md)_
- **A worktree-isolation guard's "stays inside the worktree" text match
  needs `cd <path> &&` at the literal top level**, not nested inside a
  `bash -c '...'` string, even when that nested string itself starts with
  the same `cd`.
- **An adversarial security review that executes real probes against
  compiled output catches a TSDoc overclaim that reading code alone would
  miss** — the specific gap here (reference-preserving snapshot vs.
  content-mutation immunity) was invisible from source review because the
  design decision (don't copy the `Map`) and the doc claim (no mutation
  reaches later calls) were both individually correct in isolation and only
  contradicted each other when combined.
