/**
 * `lib/cli-process` — the process-plumbing layer for the agent-operator's
 * CLI seam.
 *
 * This is the **only** file in `@m3l-automation/agent-operator` that may
 * import `node:child_process`. Every other module reaches the `m3l` CLI
 * through `lib/cli-surface.ts`, which is the sole consumer of
 * {@link runCliProcess}.
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

/**
 * Grace period between the initial `SIGTERM` and an escalation to `SIGKILL`
 * for a child that ignores it. Five seconds mirrors the common
 * graceful-shutdown convention (e.g. Docker's default stop timeout): long
 * enough for an `m3l` CLI child to unwind cleanly, short enough that an
 * orphan from a long `dryRunTimeoutMs` (up to 900s) doesn't linger.
 */
const SIGKILL_GRACE_MS = 5_000;

/**
 * Sends `SIGTERM`, then escalates to `SIGKILL` after {@link SIGKILL_GRACE_MS}
 * if the child has not closed by then. The escalation timer is `unref()`'d
 * (it can never keep the process alive) and is cancelled the moment the
 * child's own `"close"` fires, so a child that dies from the `SIGTERM`
 * within the grace period is never sent a second signal against a pid the OS
 * may have already reused.
 */
function killWithEscalation(child: CliChildProcess): void {
  child.kill("SIGTERM");
  const graceTimer = setTimeout(() => {
    child.kill("SIGKILL");
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
      killWithEscalation(child);
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
  const { spawn, nodeExecPath, entrypoint, args, cwd } = options;
  try {
    const child = spawn(nodeExecPath, [entrypoint, ...args], {
      cwd,
      shell: false, // primary argument-injection defence: no shell, no command line to inject into
      stdio: ["ignore", "pipe", "pipe"], // stdin ignored — a child M3LPrompt can never hang the agent
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
  if (signal?.aborted === true) {
    return {
      disposition: "aborted",
      exitCode: null,
      stdout: "",
      stderr: "",
      failureCode: undefined,
    };
  }

  const attempt = spawnOrClassify({
    spawn,
    nodeExecPath,
    entrypoint,
    args,
    cwd,
  });
  if (!attempt.spawned) return attempt.result;
  const child = attempt.child;

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
    );
    const detachAbort = attachAbort(signal, settle);

    attachStdio(child, stdoutCollector, stderrCollector, settle);
    attachLifecycle(child, settle);
  });
}
