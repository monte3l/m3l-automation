/**
 * `lib/cli-process` — the process-plumbing layer for the agent-operator's
 * CLI seam.
 *
 * This is the **only** file in `@m3l-automation/agent-operator` that may
 * import `node:child_process`. Every other module reaches the `m3l` CLI
 * through `lib/cli-surface.ts`, which is the sole consumer of
 * {@link runCliProcess}.
 *
 * ## Teardown scope
 *
 * A spawn is torn down either at the direct child ({@link CliTeardownScope}
 * `"child"`, the default) or across the child's whole process group
 * (`"group"`). Group teardown exists because the `m3l` CLI is a middle link:
 * it spawns each flow step as its own grandchild and deliberately survives
 * the first `SIGTERM` to finish teardown, so signalling only the direct
 * child leaves a step process mutating AWS to completion after the caller
 * has already been told the run timed out. `"group"` is **POSIX-only** and
 * is opted into per surface method — today only `flowRun`.
 *
 * @packageDocumentation
 */

import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * The subset of a real `ChildProcess` (and stdio stream) that
 * {@link runCliProcess} depends on. Kept narrow and structural so a test can
 * satisfy it with a plain `EventEmitter`-based fake instead of spawning a
 * real process. Module-private: it exists only to constrain {@link SpawnLike}.
 */
interface CliChildProcess {
  /**
   * The child's OS process id, or `undefined` when it never got one.
   *
   * Declared OPTIONAL (`pid?`), not required-but-possibly-`undefined`, and
   * that is forced rather than chosen: `@types/node` declares
   * `ChildProcess.pid` as `readonly pid?: number | undefined`, and under
   * `exactOptionalPropertyTypes` an optional property is not assignable to a
   * required one — a required declaration here would break
   * {@link defaultSpawn}'s no-cast return of a real `ChildProcess`.
   */
  readonly pid?: number | undefined;
  readonly stdout: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    removeAllListeners(event: "data"): unknown;
  };
  readonly stderr: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    removeAllListeners(event: "data"): unknown;
  };
  readonly kill: (signal?: NodeJS.Signals) => boolean;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

/**
 * Injection seam for the underlying `spawn` call. Production code defaults to
 * a thin wrapper over `node:child_process`'s `spawn`; tests inject a fake that
 * never touches a real process.
 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => CliChildProcess;

/**
 * How far a teardown signal reaches.
 *
 * - `"child"` — the direct child only, via `ChildProcess#kill`. The default,
 *   and the behaviour every surface method except `flowRun` keeps.
 * - `"group"` — the child's whole process group, via a negative-pid
 *   `process.kill`. The child is spawned `detached` so it becomes its own
 *   group leader, which is what makes the group's other members (the flow
 *   step processes `m3l` spawns) reachable. **POSIX-only.**
 *
 * A string union rather than a boolean: it reads at the call site without a
 * comment, it matches this module's exhaustive-`Record` house style (see
 * {@link KILL_ON_SETTLE}), and a future third mode becomes a compile error
 * rather than a silently flipped flag.
 */
export type CliTeardownScope = "child" | "group";

/**
 * Injection seam for the process-level `kill` used by `"group"` teardown.
 *
 * This seam is mandatory, not stylistic: a test that reached a real
 * `process.kill(-pid, …)` would signal the Vitest worker's own process
 * group. Same reason and same shape as `packages/m3l-cli`'s
 * `escalateBySignal` `target` / `M3LCancellationScopeOptions.killer`.
 */
export type ProcessKillLike = (pid: number, signal: NodeJS.Signals) => void;

/**
 * The one event this module needs from `process` to register its exit
 * reaper. Kept narrow and structural — like {@link CliChildProcess} — so a
 * test satisfies it with a plain `EventEmitter` instead of the global
 * `process`. Module-private for the same reason {@link CliChildProcess} is:
 * it exists to constrain {@link RunCliProcessOptions.exitEmitter}, not to
 * ask a caller to name it.
 */
interface CliExitEmitter {
  on(event: "exit", listener: () => void): unknown;
}

/**
 * Every terminal state {@link runCliProcess} can resolve with. Spawn failure
 * is a **value** in this union, not a throw — the caller (`lib/cli-surface.ts`)
 * writes one exhaustive `switch` over this type and TypeScript proves every
 * case is handled.
 */
export type CliRunDisposition =
  | "exited"
  | "spawn-failed"
  | "timed-out"
  | "aborted"
  | "signalled"
  | "output-truncated";

/**
 * The outcome of one `runCliProcess` invocation.
 *
 * @example
 * ```ts
 * import type { CliRunResult } from "@m3l-automation/agent-operator/lib/cli-process";
 *
 * function isClean(result: CliRunResult): boolean {
 *   return result.disposition === "exited" && result.exitCode === 0;
 * }
 * ```
 */
export interface CliRunResult {
  /** Which terminal state the child process run reached. */
  readonly disposition: CliRunDisposition;
  /** The child's exit code, or `null` when it never cleanly exited. */
  readonly exitCode: number | null;
  /** Accumulated, UTF-8-decoded stdout up to the point of settlement. */
  readonly stdout: string;
  /** Accumulated, UTF-8-decoded stderr up to the point of settlement. */
  readonly stderr: string;
  /**
   * Only ever a spawn `error.code` matching `/^[A-Z][A-Z0-9_]{0,31}$/`
   * (e.g. `"ENOENT"`) — never a message. A raw Node spawn-error message
   * embeds the resolved absolute path, which must never reach a caller or a
   * model.
   */
  readonly failureCode: string | undefined;
}

/** Options accepted by {@link runCliProcess}. */
export interface RunCliProcessOptions {
  /** Absolute path to the Node executable to spawn (never a shell). */
  readonly nodeExecPath: string;
  /** Absolute path to the CLI entrypoint script (argv[0] after the node path). */
  readonly entrypoint: string;
  /** Arguments forwarded to the entrypoint, in fixed positions. */
  readonly args: readonly string[];
  /** Working directory for the spawned process. */
  readonly cwd: string;
  /** Own-timer timeout in milliseconds (never `spawn`'s `timeout` option). */
  readonly timeoutMs: number;
  /** Per-stream byte cap; breaching it kills the child and truncates output. */
  readonly maxOutputBytes: number;
  /** Optional cooperative-cancellation signal. */
  readonly signal?: AbortSignal;
  /** Test injection seam; defaults to a thin wrapper over the real `spawn`. */
  readonly spawn?: SpawnLike;
  /**
   * How far a teardown signal reaches. Defaults to `"child"` — today's
   * behaviour byte-for-byte, including a spawn options object that carries
   * no `detached` key at all.
   */
  readonly teardown?: CliTeardownScope;
  /**
   * Test injection seam for the process-level kill `"group"` teardown uses;
   * defaults to a thin wrapper over `process.kill`. A sibling of
   * {@link RunCliProcessOptions.spawn}, and mandatory for any test that
   * opts into `"group"` — see {@link ProcessKillLike}.
   */
  readonly kill?: ProcessKillLike;
  /**
   * Test injection seam for the emitter the exit reaper registers on;
   * defaults to `process`. Used only by `"group"` teardown.
   */
  readonly exitEmitter?: CliExitEmitter;
}

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * Extracts a spawn error's `code` only when it is a short, uppercase,
 * identifier-shaped string (e.g. `"ENOENT"`, `"EACCES"`). Deliberately never
 * reads `error.message` — a real Node spawn `ENOENT` message embeds the
 * resolved absolute entrypoint path.
 */
function readFailureCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code: unknown = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && ERROR_CODE_PATTERN.test(code)
    ? code
    : undefined;
}

/**
 * Wraps `node:child_process`'s `spawn` as the default {@link SpawnLike}.
 * Node's `ChildProcess` already satisfies {@link CliChildProcess}
 * structurally, so no cast is needed — the narrow local interface exists to
 * keep the injected test seam honest, not to widen Node's type.
 */
function defaultSpawn(
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
): CliChildProcess {
  return nodeSpawn(command, args, options);
}

/** Wraps `process.kill` as the default {@link ProcessKillLike}. */
function defaultKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

/**
 * Accumulates one stream's chunks through a dedicated `StringDecoder`, and
 * tracks raw byte count against a cap independently of decoded character
 * count (a multi-byte UTF-8 payload can breach a byte cap while its JS
 * string length stays under it).
 */
interface StreamCollector {
  /** Feeds one chunk; returns `true` once the byte cap is breached. */
  readonly feed: (chunk: Buffer) => boolean;
  /** Flushes the decoder and returns the accumulated text. */
  readonly finish: () => string;
}

function createStreamCollector(maxOutputBytes: number): StreamCollector {
  const decoder = new StringDecoder("utf8");
  let text = "";
  let bytes = 0;
  return {
    feed(chunk) {
      bytes += chunk.length;
      text += decoder.write(chunk);
      return bytes > maxOutputBytes;
    },
    finish() {
      text += decoder.end();
      return text;
    },
  };
}

/** A settled-once outcome, before stdout/stderr are attached. */
interface PendingOutcome {
  readonly disposition: CliRunDisposition;
  readonly exitCode: number | null;
  readonly failureCode: string | undefined;
}

/**
 * Whether a given disposition can leave the child alive and therefore needs
 * a kill on settle. `"exited"`/`"signalled"` mean the child already
 * terminated on its own, and `"spawn-failed"` means it never started — a
 * kill in any of those three cases would be a no-op at best and, if the OS
 * has already reused the pid, dangerous at worst. Typed as a `Record` over
 * every {@link CliRunDisposition} so adding a new disposition without an
 * entry here is a compile error, not a silent gap.
 */
const KILL_ON_SETTLE: Record<CliRunDisposition, boolean> = {
  exited: false,
  "spawn-failed": false,
  "timed-out": true,
  aborted: true,
  signalled: false,
  "output-truncated": true,
};

/** How a settled run's teardown signals are addressed. */
interface TeardownPlan {
  readonly scope: CliTeardownScope;
  readonly kill: ProcessKillLike;
}

/**
 * Whether a pid can safely be negated into a process-group target.
 *
 * This guard is load-bearing, not hygiene. `process.kill(-0, sig)` is
 * `process.kill(0, sig)`, which POSIX defines as "every process in the
 * **caller's own** group" — agent-operator would signal itself, and a test
 * would signal the Vitest worker and its siblings. `-NaN` and a fractional
 * pid are a coin flip. Only a positive integer is addressable.
 */
function isGroupTargetablePid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 0;
}

/**
 * Reports a non-benign teardown-signal failure to stderr, best-effort.
 *
 * `process.kill` fails two ways and only one of them is expected:
 *
 * - `ESRCH` — the group is already gone. A benign race: the child can drain
 *   between the settle decision and the `SIGTERM`, or between the `SIGTERM`
 *   and the escalated `SIGKILL`. Ignored deliberately.
 * - anything else (`EPERM`, `EINVAL`, and on Windows the negative-pid
 *   rejection) — a real fault, but one that surfaces AFTER
 *   {@link runCliProcess} has already resolved (the escalation fires 5 s
 *   later on an `unref`'d timer), so there is nowhere to return it and
 *   {@link runCliProcess}'s documented "never a throw" contract forbids
 *   rethrowing. Follows `packages/m3l-common`'s
 *   `internal/script/signalHandlers.ts` precedent for exactly this shape: a
 *   failure that is not actionable from here must still not vanish silently.
 *
 * The message carries **only** the errno code and the signal name — never a
 * pid, a path, or the raw error message. A Node error message embeds the
 * resolved absolute entrypoint path, and this process's stderr is collected
 * and read by a model, so this mirrors {@link readFailureCode}'s allow-list
 * posture rather than relaxing it.
 */
function reportTeardownFailure(cause: unknown, signal: NodeJS.Signals): void {
  const code = readFailureCode(cause);
  if (code === "ESRCH") return;
  process.stderr.write(
    `agent-operator: process-group ${signal} failed (${code ?? "UNKNOWN"})\n`,
  );
}

/**
 * Sends one teardown signal at the plan's scope.
 *
 * `"group"` falls back to the direct `child.kill` when the pid is not
 * group-targetable (see {@link isGroupTargetablePid}). That fallback is the
 * correct answer rather than a degradation: a child that never got a pid
 * never became a group leader, so there is no group to address, and
 * `child.kill` on such a child is itself a no-op.
 */
function signalTarget(
  child: CliChildProcess,
  plan: TeardownPlan,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (plan.scope === "child" || !isGroupTargetablePid(pid)) {
    child.kill(signal);
    return;
  }
  try {
    plan.kill(-pid, signal);
  } catch (cause) {
    reportTeardownFailure(cause, signal);
  }
}

/**
 * The live detached group pids each exit emitter is responsible for reaping.
 *
 * A `WeakMap` keyed by the emitter, rather than one module-level `Set` plus
 * a `WeakSet` of wired emitters, for two reasons: the map's own key presence
 * already makes listener registration idempotent per emitter, and keying the
 * pid set by emitter keeps a test's injected fake emitter from ever reaping
 * (or being blamed for) another test's pids — no `vi.resetModules`, whose
 * first-test cost this repo has measured, and no test-only reset export.
 * Weak so an emitter that goes out of scope is not retained.
 */
const groupPidsByEmitter = new WeakMap<CliExitEmitter, Set<number>>();

/**
 * Registers a detached group pid with the best-effort exit reaper, and wires
 * its removal on the child's `"close"`.
 *
 * The reaper covers the paths where the escalation timer never gets to fire
 * because the operator itself is going away: a double-Ctrl-C (the second
 * signal in `packages/m3l-common`'s `registerShutdownSignals` is a JS
 * `process.exit()`, which still runs `"exit"` listeners), an uncaught throw,
 * and a normal exit with a straggler. It deliberately does **not** cover a
 * `SIGKILL` of agent-operator itself — nothing can, and a detached group
 * then survives until a human runs `kill -- -<pgid>`.
 *
 * Removal is keyed on `"close"` and NOT on settle: `"close"` is the only
 * event that makes the pid safely reusable by the OS, and de-registering at
 * settle would blind the reaper during exactly the five-second window in
 * which the `unref`'d escalation timer can be lost to a process exit.
 *
 * `"exit"` listeners must be fully synchronous; `process.kill` is.
 */
function trackDetachedGroup(
  child: CliChildProcess,
  plan: TeardownPlan,
  emitter: CliExitEmitter,
): void {
  const pid = child.pid;
  if (!isGroupTargetablePid(pid)) return;
  const existing = groupPidsByEmitter.get(emitter);
  const pids = existing ?? new Set<number>();
  if (existing === undefined) {
    groupPidsByEmitter.set(emitter, pids);
    emitter.on("exit", () => {
      for (const live of pids) {
        try {
          plan.kill(-live, "SIGKILL");
        } catch (cause) {
          reportTeardownFailure(cause, "SIGKILL");
        }
      }
    });
  }
  pids.add(pid);
  child.on("close", () => {
    pids.delete(pid);
  });
}

/**
 * Grace period between the initial `SIGTERM` and an escalation to `SIGKILL`
 * for a child that ignores it. Five seconds mirrors the common
 * graceful-shutdown convention (e.g. Docker's default stop timeout): long
 * enough for an `m3l` CLI child to unwind cleanly, short enough that an
 * orphan from a long `dryRunTimeoutMs` (up to 900s) doesn't linger.
 *
 * Under `"group"` teardown this window bounds a whole process tree rather
 * than one process: the `SIGTERM` is broadcast to the group — where `m3l`'s
 * survival scope and each step's own shutdown handler treat it as a
 * cooperative first signal — and the `SIGKILL` is the guarantee that the
 * tree stops even if none of them cooperate.
 */
const SIGKILL_GRACE_MS = 5_000;

/**
 * Sends `SIGTERM`, then escalates to `SIGKILL` after {@link SIGKILL_GRACE_MS}
 * if the child has not closed by then. The escalation timer is `unref()`'d
 * (it can never keep the process alive) and is cancelled the moment the
 * child's own `"close"` fires, so a child that dies from the `SIGTERM`
 * within the grace period is never sent a second signal against a pid — or,
 * under `"group"`, a pgid — the OS may have already reused.
 *
 * Both signals go through the one {@link signalTarget} call shape, so the
 * `SIGTERM` and the `SIGKILL` can never disagree about scope or pid.
 */
function killWithEscalation(child: CliChildProcess, plan: TeardownPlan): void {
  signalTarget(child, plan, "SIGTERM");
  const graceTimer = setTimeout(() => {
    signalTarget(child, plan, "SIGKILL");
  }, SIGKILL_GRACE_MS);
  graceTimer.unref();
  child.on("close", () => {
    clearTimeout(graceTimer);
  });
}

/**
 * Builds the `resolve`-once machinery shared by every settle path: a
 * `settled` guard (an `error` and a `close` event can both fire, in either
 * order), the owned timeout timer, the abort-listener cleanup, unconditional
 * `"data"`-listener detachment (a byte cap otherwise bounds only what is
 * *returned*, not what a slow-draining child keeps feeding in), and a kill —
 * routed through this single guarded path so two breaches arriving in the
 * same tick (one per stream) can never each trigger their own kill.
 */
function createSettler(
  child: CliChildProcess,
  resolve: (result: CliRunResult) => void,
  stdout: StreamCollector,
  stderr: StreamCollector,
  timer: NodeJS.Timeout,
  detachAbort: () => void,
  plan: TeardownPlan,
): (outcome: PendingOutcome) => void {
  let settled = false;
  return (outcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    detachAbort();
    child.stdout.removeAllListeners("data");
    child.stderr.removeAllListeners("data");
    if (KILL_ON_SETTLE[outcome.disposition]) {
      killWithEscalation(child, plan);
    }
    resolve({
      ...outcome,
      stdout: stdout.finish(),
      stderr: stderr.finish(),
    });
  };
}

/** Wires the two stdio streams to their collectors, settling on byte-cap breach. */
function attachStdio(
  child: CliChildProcess,
  stdoutCollector: StreamCollector,
  stderrCollector: StreamCollector,
  settle: (outcome: PendingOutcome) => void,
): void {
  const onBreach = (): void => {
    settle({
      disposition: "output-truncated",
      exitCode: null,
      failureCode: undefined,
    });
  };
  child.stdout.on("data", (chunk) => {
    if (stdoutCollector.feed(chunk)) onBreach();
  });
  child.stderr.on("data", (chunk) => {
    if (stderrCollector.feed(chunk)) onBreach();
  });
}

/** Wires the child's `error`/`close` events (never `exit` — see module docs). */
function attachLifecycle(
  child: CliChildProcess,
  settle: (outcome: PendingOutcome) => void,
): void {
  child.on("error", (error) => {
    settle({
      disposition: "spawn-failed",
      exitCode: null,
      failureCode: readFailureCode(error),
    });
  });
  // Listen on "close", not "exit": "exit" can fire before the stdio streams
  // have flushed their final chunks.
  child.on("close", (code, signal) => {
    settle({
      disposition: signal !== null ? "signalled" : "exited",
      exitCode: code,
      failureCode: undefined,
    });
  });
}

/**
 * Registers the abort handler and returns the detach function the settler
 * calls on every settle path — a leaked listener on a long-lived agent-loop
 * signal would otherwise accumulate once per tool call. Killing the child is
 * the settler's job (via {@link KILL_ON_SETTLE}), not this function's — it
 * only supplies the `"aborted"` disposition.
 */
function attachAbort(
  signal: AbortSignal | undefined,
  settle: (outcome: PendingOutcome) => void,
): () => void {
  if (signal === undefined) return () => undefined;
  const onAbort = (): void => {
    settle({ disposition: "aborted", exitCode: null, failureCode: undefined });
  };
  signal.addEventListener("abort", onAbort);
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

/**
 * The outcome of one {@link spawnOrClassify} attempt: either a live child, or
 * the settled {@link CliRunResult} the caller must hand straight back.
 */
type SpawnAttempt =
  | { readonly spawned: true; readonly child: CliChildProcess }
  | { readonly spawned: false; readonly result: CliRunResult };

/** The arguments {@link spawnOrClassify} needs to place one spawn call. */
interface SpawnAttemptOptions {
  readonly spawn: SpawnLike;
  readonly nodeExecPath: string;
  readonly entrypoint: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly teardown: CliTeardownScope;
}

/**
 * Places the one `spawn` call, turning a SYNCHRONOUS failure into a
 * `"spawn-failed"` value rather than letting it escape.
 *
 * This helper exists because `spawn` fails two ways and only one of them is
 * an `error` event: an invalid argument — a NUL byte in `entrypoint`/`cwd`,
 * which reaches here unvalidated from operator config — throws
 * `ERR_INVALID_ARG_VALUE` inline, before any child exists and before any
 * listener could observe it. Without this `try`, that throw would escape
 * {@link runCliProcess} as a rejection and break its documented "a spawn
 * failure is a value, never a throw" contract on exactly one of its two
 * arms.
 *
 * Only the thrown value's `code` is read, through the same
 * {@link readFailureCode} allow-list the asynchronous arm uses — so a
 * non-`Error` throw yields `undefined`. Its `message` is deliberately
 * dropped: Node embeds the offending resolved absolute path in it, and this
 * result is read by a model.
 */
function spawnOrClassify(options: SpawnAttemptOptions): SpawnAttempt {
  const { spawn, nodeExecPath, entrypoint, args, cwd, teardown } = options;
  try {
    const child = spawn(nodeExecPath, [entrypoint, ...args], {
      cwd,
      shell: false, // primary argument-injection defence: no shell, no command line to inject into
      stdio: ["ignore", "pipe", "pipe"], // stdin ignored — a child M3LPrompt can never hang the agent
      // A CONDITIONAL SPREAD, not `detached: teardown === "group"`: under
      // `"child"` the options object carries no `detached` key at all, so
      // the six non-opted-in surface methods spawn byte-for-byte as before
      // — and a test can prove the absence with `Object.hasOwn` rather than
      // settling for the weaker `detached === false`.
      ...(teardown === "group" ? { detached: true } : {}),
    });
    return { spawned: true, child };
  } catch (cause) {
    return {
      spawned: false,
      result: {
        disposition: "spawn-failed",
        exitCode: null,
        stdout: "",
        stderr: "",
        failureCode: readFailureCode(cause),
      },
    };
  }
}

/**
 * The `"aborted"` result for a call whose signal had already fired before
 * any child existed: no process ran, so both streams are empty and there is
 * no exit code or failure code to report.
 */
function abortedBeforeSpawn(): CliRunResult {
  return {
    disposition: "aborted",
    exitCode: null,
    stdout: "",
    stderr: "",
    failureCode: undefined,
  };
}

/**
 * Builds the run's {@link TeardownPlan} and, under `"group"`, registers the
 * new group with the exit reaper — the two facts that must agree, resolved
 * in one place so a future caller cannot set the scope without arming the
 * reaper that backstops it.
 */
function planTeardown(
  child: CliChildProcess,
  teardown: CliTeardownScope,
  kill: ProcessKillLike,
  exitEmitter: CliExitEmitter,
): TeardownPlan {
  const plan: TeardownPlan = { scope: teardown, kill };
  if (teardown === "group") {
    trackDetachedGroup(child, plan, exitEmitter);
  }
  return plan;
}

/**
 * Spawns the `m3l` CLI entrypoint and resolves with its outcome as a value —
 * a spawn failure, a timeout, an abort, and a byte-cap breach are each a
 * {@link CliRunDisposition}, never a throw. The single exception the caller
 * (`lib/cli-surface.ts`) makes of this is `"aborted"`, which it re-raises as
 * `Core.M3LOperationAbortedError` so `deriveCommandOutcome` classifies a
 * Ctrl-C the same way in-process and via the spawn path (ADR-0049).
 *
 * Argument-injection defence lives here at the call site: `shell: false` is
 * written explicitly (even though it is the default) because it is the
 * primary defence — with no shell, there is no command line to inject into.
 * `stdin` is `"ignore"` so a child `M3LPrompt` can never hang the agent.
 *
 * `teardown: "group"` changes the Ctrl-C semantics ADR-0049 maps, and in the
 * direction opposite to what "detached breaks Ctrl-C" suggests. Today the
 * operator and the `m3l` child share the terminal's foreground process
 * group, so one Ctrl-C races two settle paths: this function's `"aborted"`
 * (exit 5) against the child's own `"close"` from that same `SIGINT`
 * (`"signalled"`, a spawn error). Spawned `detached`, the child's tree is in
 * its own group and receives nothing from the tty, so the abort listener
 * wins deterministically and exit 5 becomes MORE reliable on that path, not
 * less — while the settle-path group kill actually tears the tree down.
 *
 * The honest cost: a hard `SIGKILL` of agent-operator now leaves a detached
 * group nobody reaps, where the shared group previously meant a Ctrl-C
 * reached the whole tree. {@link trackDetachedGroup}'s exit reaper closes
 * every softer exit path (including a double-Ctrl-C); a `SIGKILL` of the
 * operator is a real, narrow regression it cannot cover, recoverable only
 * with `kill -- -<pgid>`.
 *
 * @example
 * ```ts
 * import { runCliProcess } from "@m3l-automation/agent-operator/lib/cli-process";
 *
 * const result = await runCliProcess({
 *   nodeExecPath: process.execPath,
 *   entrypoint: "/repo/packages/m3l-cli/bin/m3l.mjs",
 *   args: ["list", "--json"],
 *   cwd: "/repo",
 *   timeoutMs: 30_000,
 *   maxOutputBytes: 1_048_576,
 * });
 * if (result.disposition === "exited" && result.exitCode === 0) {
 *   console.log(result.stdout);
 * }
 * ```
 */
export async function runCliProcess(
  options: RunCliProcessOptions,
): Promise<CliRunResult> {
  const {
    nodeExecPath,
    entrypoint,
    args,
    cwd,
    timeoutMs,
    maxOutputBytes,
    signal,
    spawn = defaultSpawn,
    teardown = "child",
    kill = defaultKill,
    exitEmitter = process,
  } = options;

  // Checked before the `spawn` call, not inside the `attachAbort` listener:
  // `AbortSignal#addEventListener` never fires retroactively for a signal
  // that is already aborted at registration time, so relying on the
  // listener alone let an already-aborted `signal` spawn a fresh child and
  // ride out the full `timeoutMs` before settling. Returning here instead of
  // spawning-then-killing avoids process creation entirely — no
  // AWS-profile/env inheritance into a doomed child, no kill-signal race —
  // which matters once a single `AbortSignal` outlives many calls (a
  // Bedrock tool loop), where spawn-then-kill would otherwise repeat once
  // per remaining iteration.
  if (signal?.aborted === true) return abortedBeforeSpawn();

  const attempt = spawnOrClassify({
    spawn,
    nodeExecPath,
    entrypoint,
    args,
    cwd,
    teardown,
  });
  if (!attempt.spawned) return attempt.result;
  const child = attempt.child;

  const plan = planTeardown(child, teardown, kill, exitEmitter);

  const stdoutCollector = createStreamCollector(maxOutputBytes);
  const stderrCollector = createStreamCollector(maxOutputBytes);

  return new Promise<CliRunResult>((resolve) => {
    // Own timeout timer via setTimeout — not spawn's `timeout` option, which
    // surfaces indistinguishably from a spawn failure. `unref()` so a pending
    // timer never keeps the process alive. Uses the global `setTimeout`
    // (rather than `node:timers`' named export) so `vi.useFakeTimers()` can
    // control it: Node's ESM interop snapshots `node:timers`' named exports
    // at import time, so a fake-timer library that patches the global (or the
    // CJS `timers` module object) after that import is never observed by an
    // already-bound `import { setTimeout } from "node:timers"` reference.
    const timer = setTimeout(() => {
      settle({
        disposition: "timed-out",
        exitCode: null,
        failureCode: undefined,
      });
    }, timeoutMs);
    timer.unref();

    const settle = createSettler(
      child,
      resolve,
      stdoutCollector,
      stderrCollector,
      timer,
      () => detachAbort(),
      plan,
    );
    const detachAbort = attachAbort(signal, settle);

    attachStdio(child, stdoutCollector, stderrCollector, settle);
    attachLifecycle(child, settle);
  });
}
