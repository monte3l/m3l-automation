# Work log — V13 flow-run process-group teardown (2026-09-11)

The teardown half of `flowTimeoutMs`. V9 shipped the observability half — a
`"timed-out"` disposition records the run INDETERMINATE, escalates, and refuses
a second invocation within a run — but expiry still could not _stop_ the
mutation it interrupted: `lib/cli-process.ts` signalled only its direct child,
`m3l` traps SIGTERM in a survival scope and keeps executing, and the escalated
SIGKILL reached only `m3l` because a SIGKILL to one pid does not propagate to
the grandchild flow step. The tracker's gate was explicit: resolve before an
operator allowlists a flow on a profile that matters.

Tracker row: [`docs/plans/IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md) V13
(issue #1120). Decision record: ADR-0049's 2026-09-11 Update.

## Summary

- `scripts/agent-operator/src/lib/cli-process.ts` gains an exported
  `CliTeardownScope` (`"child" | "group"`), a `ProcessKillLike` injection
  seam, and a `CliExitEmitter`. `"group"` adds `detached: true` via a
  **conditional spread**, so `"child"` mode's spawn options object carries no
  `detached` key at all; both the SIGTERM and the escalated SIGKILL go through
  one `signalTarget` call shape addressed at `-pid`.
- The pid guard (`isGroupTargetablePid`) refuses anything that is not a
  positive integer and falls back to `child.kill`. This is the load-bearing
  line: `process.kill(-0, sig)` _is_ `process.kill(0, sig)` — "every process
  in the caller's own group".
- Errno handling splits `ESRCH` (a benign, expected race — the group can drain
  between settle and SIGTERM, or between SIGTERM and the escalation) from
  everything else, which gets a one-line stderr diagnostic carrying **only**
  the errno code and signal name. No pid, no path, no raw message — this
  process's stderr is read by a model, and `readFailureCode`'s allow-list
  posture is the local precedent.
- `trackDetachedGroup` registers each live detached group pid in a
  `WeakMap<CliExitEmitter, Set<number>>` and group-SIGKILLs the remainder from
  a `process.on("exit")` listener, covering the double-Ctrl-C orphan (the
  second signal in `registerShutdownSignals` is a JS `process.exit()`, which
  still runs `"exit"` listeners). A SIGKILL of agent-operator itself is _not_
  covered; that is stated in the TSDoc rather than implied away.
- `lib/cli-surface.ts`'s `CliInvocationSpec` gains `teardown` as a
  **required** field. Seven construction sites, six `"child"`, and `runFlowRun`
  the only `"group"` — so the asymmetry is provable by reading seven literals.
- Five stale self-references corrected in the same commit (`config.ts`'s
  `FLOW_TIMEOUT_MS_DEFAULT` "This is UNSOLVED" narrative, `cli-surface.ts`'s
  `flowTimeoutMs`, `run-queue-reconcile.ts`'s "NOT fixed here", plus
  `SIGKILL_GRACE_MS` and `runCliProcess`'s own ADR-0049 paragraph).
- Tests: 25 new cases in `tests/lib/cli-process.test.ts` and a new
  `tests/lib/cli-surface-teardown.test.ts` (9 cases). Zero
  `packages/m3l-cli` changes.

## What went as planned

- **The injectable-killer precedent transferred cleanly.**
  `packages/m3l-cli/src/run/cancellation.ts`'s `escalateBySignal` `target` and
  `M3LCancellationScopeOptions.killer` exist for exactly this reason — a test
  that reaches a real `process.kill(-pid, …)` signals the Vitest worker's own
  process group. Copying that shape (rather than inventing a module-private
  test hook) meant the seam needed no argument.
- **The conditional spread paid for itself immediately.** Because `"child"`
  mode emits no `detached` key, the absence test is a real assertion
  (`Object.hasOwn(options, "detached") === false`) rather than the weaker
  `detached === false`, which would pass against a spawn that explicitly opts
  out — a different fact.
- **`check:file-budget` excludes `scripts/*/src`**, so the ~250 lines of new
  TSDoc and helpers cost nothing at the byte budget, exactly as scoped.
- **The mutation test had teeth.** Replacing
  `pid !== undefined && Number.isInteger(pid) && pid > 0` with
  `pid !== undefined` failed **8** tests across both call sites (the settle
  path _and_ the reaper's registration) — `0`, negative, fractional and `NaN`
  rows in each. Restored and re-verified green from a byte copy, not from
  memory.

## What didn't go as planned, and why

- **`pid` could not be a required field, and the plan's stated motive for
  making it one was unreachable.** The plan specified
  `readonly pid: number | undefined` on `CliChildProcess`, deliberately as a
  compile break that would force every existing test fake to declare a pid.
  `@types/node`'s `child_process.d.ts` declares that property as optional,
  and under `exactOptionalPropertyTypes: true` an **optional**
  property is not assignable to a **required** one — so the required form
  breaks `defaultSpawn`'s documented no-cast return of a real `ChildProcess`.
  Shipped as `pid?: number | undefined`. The pid-guard tests were written
  anyway, from the plan's own test list, so nothing was lost but the forcing
  function.
- **The plan's "delete the pid on settle" would have opened the window the
  reaper exists to close.** Removal is keyed on the child's `"close"` only.
  De-registering at settle blinds the reaper during exactly the five-second
  grace window in which the `unref`'d escalation timer can be lost to a
  process exit — and `"close"` is the only event that makes the pid safely
  reusable by the OS, which is the same reasoning `KILL_ON_SETTLE`'s remarks
  already carry for the direct-child case.
- **A `WeakSet` of wired emitters wasn't the right idempotency key.** The plan
  called for a module-level `Set<number>` of pids plus a `WeakSet<EventEmitter>`
  of wired emitters. A single `WeakMap<CliExitEmitter, Set<number>>` subsumes
  both: its key presence already makes registration idempotent per emitter, and
  keying the pid set by emitter means a test's injected fake emitter can never
  reap (or be blamed for) another test's pids. No `vi.resetModules`, no
  test-only reset export.
- **ESLint's per-function line limit fired, as it does on every change of this
  shape.** `runCliProcess` reached 64 effective lines against
  `max-lines-per-function`'s 60 (`skipComments: true`, so the TSDoc was free
  and the wiring was not). Paid with two extractions that read as concepts
  rather than as line-count relief: `abortedBeforeSpawn()` (the
  already-aborted result) and `planTeardown()` (the plan and its reaper
  registration, resolved in one place so a caller cannot set the scope without
  arming the backstop).
- **A design pass delivered mid-implementation argued for probe-gated
  cancellation, and was not adopted.** Its finding: under `"group"`, cancelling
  the escalation on the direct child's `"close"` is unsound, because `m3l`
  closing does not prove the group is empty. Real, but narrow — `m3l` awaits
  its step spawn, so a clean `m3l` exit means the step already exited, and the
  target failure mode (`m3l` surviving the first SIGTERM by design) never fires
  `"close"` inside the grace window at all. The residual case is `m3l` crashing
  while its step runs, which orphans the step today regardless. Adding a
  `kill(-pid, 0)` liveness probe was outside the approved scope; recorded here
  rather than actioned.
- **A fixture path was wrong in a way only the real validator caught.** The new
  surface test's `presetAllowlist` entry used `presets/agent-operator/…`;
  `isDeclarablePresetPath` requires containment under
  `data/config/presets/`, and the failure surfaced as "the preset name did not
  pass this tool's allowed-name check" — a message about the _name_ for a fault
  in the _path_.

## Insights

- **A type-system fact can invalidate a plan's forcing function without
  invalidating its test list.** The plan wanted a required `pid` _specifically_
  to make existing fakes fail to compile, so the pid-guard tests could not be
  skipped. `exactOptionalPropertyTypes` plus `@types/node`'s own optional
  declaration made that impossible. The right response was to keep the tests
  and drop the mechanism — not to bend the interface until the mechanism
  worked. Check a planned compile break against the upstream `.d.ts` before
  relying on it to enforce discipline.
- **A "delete on settle" cleanup and a "delete when the OS can reuse it"
  cleanup are different rules, and only one of them is safe for a reaper.**
  Settle is when _this_ code stops caring; `"close"` is when the _kernel_
  stops guaranteeing the id. Any registry that exists to act after the normal
  path has been abandoned must key its removal on the kernel's event, or it
  goes blind exactly when it is needed.
- **`WeakMap<emitter, state>` beats `Set<state>` + `WeakSet<emitter>` whenever
  the state is per-emitter.** The two-collection form makes registration
  idempotent but leaves the state global, so injected test emitters share it.
  One weak map keyed by the thing you register on gives idempotency _and_
  isolation, with no reset export and no `vi.resetModules` cost.
- **Signal-scope changes invert the intuitive risk, so state the direction
  explicitly.** "Detached breaks Ctrl-C" is the reading a reviewer arrives
  with. Here it is backwards: sharing the tty foreground group is what made
  exit 5 _racy_ (the `"aborted"` settle vs the child's own `"close"` from the
  same SIGINT), and detaching makes the abort listener win unconditionally. The
  honest cost is elsewhere and smaller — a SIGKILL of the operator now orphans
  a group. Write both directions down or the reviewer assumes only the bad one.
- **`process.kill(-0, sig)` is `process.kill(0, sig)`.** A negative-pid group
  signal needs a positive-**integer** guard, not a truthiness check: `0` and
  `-0` both target the caller's own group, and `-NaN` is undefined behaviour.
  `Number.isInteger(pid) && pid > 0` is the whole guard, and it must be
  mutation-tested at **every** call site that negates a pid — here the settle
  path and the exit reaper were two, and a guard on only one still leaks a
  `kill(-0, "SIGKILL")` at process exit.
- **A path validator's rejection message can name the wrong input.** A preset
  _path_ outside the required prefix reported "the preset **name** did not pass
  this tool's allowed-name check". When a fixture fails a containment check,
  read the validator, not the message.
