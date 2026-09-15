/**
 * `cli/process` — the bounded-subprocess port this package spawns the `m3l`
 * CLI through (V10c2, contract file 2). Deliberately **narrower** than
 * `scripts/agent-operator/src/lib/cli-process.ts`: no process-group
 * teardown, no `SIGKILL` escalation ladder, no exit reaper. Slice V10e
 * promotes that richer behavior into a `Core` leaf and replaces this
 * module's body with a delegation to it — do not "complete" this file with
 * any of those three; that work belongs there, not here.
 *
 * Every kill path (timeout, output-cap breach, mid-run abort, a broken
 * output stream) sends `SIGTERM`, never `SIGKILL` — this module has no
 * escalation ladder, and `SIGTERM` is the signal that lets a well-behaved
 * child flush and exit cleanly. Once a kill is issued this module resolves
 * immediately; it never waits for the child's `close` event to confirm the
 * kill took effect, so a child that ignores `SIGTERM` cannot hang the
 * caller — this runs inside a long-lived stdio MCP server that must keep
 * processing other requests.
 *
 * @packageDocumentation
 */
import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * The one pattern a spawn error's `.code` must match to be surfaced. Node's
 * own error `.message` embeds the resolved absolute command path (a leak
 * this package cannot afford — see the module doc), so only a short,
 * enum-shaped `.code` such as `"ENOENT"` is ever propagated, never the
 * message itself.
 */
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * The minimal event source `runCliProcess` reads a data stream through, and
 * detaches from once the run settles so a child that keeps writing after
 * settle cannot grow this module's memory or re-trigger a kill.
 * Module-private and structural — a test satisfies it with a plain
 * `EventEmitter`.
 */
interface CliChildProcessStream {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "data", listener: (chunk: Buffer) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * The minimal shape `runCliProcess` needs from a spawned child: the two
 * output streams, `kill`, and the two lifecycle events it reacts to (plus
 * the matching removal calls issued on settle). Module-private and
 * structural (not exported) — a real Node `ChildProcess` satisfies it, and
 * so does a plain `EventEmitter`-based fake built for a test.
 */
interface CliChildProcess {
  readonly stdout: CliChildProcessStream;
  readonly stderr: CliChildProcessStream;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  off(
    event: "error",
    listener: (error: NodeJS.ErrnoException) => void,
  ): unknown;
  off(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

/**
 * The exact `child_process.spawn` options this module ever passes. Fixed to
 * a precise shape rather than `Record<string, unknown>` so `shell: false` is
 * a compile-time fact and `stdio`/`timeout` are inexpressible — this module
 * owns its own timeout timer (see {@link RunCliProcessOptions.timeoutMs})
 * and never configures a different `stdio`.
 */
export interface CliSpawnOptions {
  readonly cwd: string;
  readonly shell: false;
}

/**
 * The spawn seam `runCliProcess` calls through. Its real implementation is
 * `node:child_process`'s `spawn`; every test substitutes a fake so no test
 * here ever starts a real process.
 *
 * **Must never emit `"error"` / `"close"` / a stream's `"data"` / `"error"`
 * synchronously from within the call itself.** `runCliProcess` attaches its
 * listeners only after `spawnFn` returns; Node's real `spawn` guarantees
 * asynchronous emission, so this holds in production, but a fake that emits
 * before returning would have the event silently dropped (`.emit(...)` with
 * no listeners attached yet returns `false`) and the run would hang to its
 * own timeout instead of reporting the true disposition. A `spawnFn` that
 * fails synchronously must `throw` instead — `runCliProcess` catches that
 * and resolves `"spawn-failed"`.
 *
 * @example
 * ```ts
 * import type { SpawnLike } from "./process.js";
 *
 * const recordingSpawn: SpawnLike = (command, args, options) => {
 *   // return a fake CliChildProcess-shaped EventEmitter for a test
 *   throw new Error("not implemented in this example");
 * };
 * ```
 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: CliSpawnOptions,
) => CliChildProcess;

/**
 * Every terminal outcome `runCliProcess` can settle with. `"spawn-failed"`
 * and `"stream-failed"` are values in this union rather than thrown errors —
 * the caller writes one exhaustive `switch`, never a `try`/`catch` around a
 * spawn primitive. `"stream-failed"` is distinct from `"spawn-failed"`
 * because the child genuinely started; only one of its output streams
 * emitted `"error"` (e.g. a broken pipe).
 */
export type CliRunDisposition =
  | "exited"
  | "spawn-failed"
  | "timed-out"
  | "aborted"
  | "signalled"
  | "output-truncated"
  | "stream-failed";

/**
 * What `runCliProcess` resolves with, always — this module never throws.
 * `failureCode` is a required key (typed `string | undefined`, not an
 * optional `?:` one) so a consumer destructuring the object never needs an
 * `in` check to read it.
 */
export interface CliRunResult {
  readonly disposition: CliRunDisposition;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failureCode: string | undefined;
}

/**
 * Inputs to {@link runCliProcess}. `spawn` defaults to `node:child_process`'s
 * real `spawn`; every other field is mandatory because this module has no
 * opinion about defaults for a CLI invocation — that belongs to the caller
 * that knows the settings (`cli/surface.ts`).
 */
export interface RunCliProcessOptions {
  readonly nodeExecPath: string;
  readonly entrypoint: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly spawn?: SpawnLike;
}

/**
 * Accumulates one stream's bytes under a cap, decoding with `StringDecoder`
 * so a multi-byte character split across chunks is never corrupted. For a
 * positive, finite `maxOutputBytes`, the retained byte count never exceeds
 * it — a breaching chunk is sliced to the remaining room *before* it is
 * decoded, not after, so the cap bounds the breaching chunk itself and not
 * just growth past it. When the slice cuts mid-character it strands a
 * partial UTF-8 sequence in the decoder's internal buffer; `finalize()`'s
 * `decoder.end()` flushes that stranded sequence as a single U+FFFD
 * replacement character, per `StringDecoder`'s own documented contract.
 *
 * This module never re-checks `maxOutputBytes` itself: `config/settings.ts`
 * already rejects a non-positive value with an `M3LMcpError` at the
 * configuration boundary, and a non-finite value cannot originate there
 * either. A non-positive or non-finite value passed directly to
 * `createStreamAccumulator` would disable or invert the cap — `room` would
 * go negative or `NaN` — but that state is unreachable through the
 * documented `config/settings.ts` entry point. The structural fix is
 * branding `maxOutputBytes` so an invalid value is unrepresentable at the
 * type level rather than merely rejected at one call site; that is already
 * recorded as a hard precondition of slice V10e's `core/process` promotion
 * in `docs/plans/2026-09-14-v10-runtime-mcp-surface.md`.
 */
interface StreamAccumulator {
  readonly breached: boolean;
  ingest(chunk: Buffer): void;
  finalize(): string;
}

function createStreamAccumulator(maxBytes: number): StreamAccumulator {
  const decoder = new StringDecoder("utf8");
  let text = "";
  let bytes = 0;
  let breached = false;
  return {
    get breached() {
      return breached;
    },
    ingest(chunk) {
      // This guard is UNREACHABLE in practice: `wireChildAndStreams`'s
      // `detach()` removes the "data" listener synchronously with breach
      // detection — same call stack, no microtask boundary — so no later
      // chunk can ever re-enter `ingest` once `breached` is true. Slicing
      // the chunk below to the remaining room does not change that. Kept
      // as defence-in-depth; do not read it as the real protection and
      // "simplify" `wireChildAndStreams` on that assumption.
      if (breached) {
        return;
      }
      // Slice BEFORE decoding, not after: this is what makes the cap an
      // actual bound on the breaching chunk itself, rather than a flag
      // that only limits growth on chunks that arrive after it.
      const room = maxBytes - bytes;
      const toDecode = chunk.length > room ? chunk.subarray(0, room) : chunk;
      bytes += toDecode.length;
      text += decoder.write(toDecode);
      if (toDecode.length < chunk.length) {
        breached = true;
      }
    },
    finalize() {
      return text + decoder.end();
    },
  };
}

/** True when `error` carries an OWN `code` property, without assuming it is an `Error` instance. Uses `Object.hasOwn` rather than `in` so a prototype-chain `code` (e.g. inherited from a poisoned `Object.prototype`) is never treated as the error's own code — hardening only, since these values come from Node's own `"error"` events or a synchronous `spawn` throw. */
function hasErrorCode(error: unknown): error is { readonly code: unknown } {
  return (
    typeof error === "object" && error !== null && Object.hasOwn(error, "code")
  );
}

/** Reads `error`'s `code` only when it matches {@link FAILURE_CODE_PATTERN} — the message itself never reaches the result (it embeds an absolute path). Accepts `unknown` so it can read a synchronous `spawn` throw as well as an async `"error"` event. */
function resolveFailureCode(error: unknown): string | undefined {
  const code = hasErrorCode(error) ? error.code : undefined;
  return typeof code === "string" && FAILURE_CODE_PATTERN.test(code)
    ? code
    : undefined;
}

/** The result a synchronous `spawnFn` throw settles with — see Fix 1 in the V10c2 review: Node's real `spawn` throws synchronously for a NUL-bearing/empty argv entry, and that throw must never escape this module's never-throws contract. */
function buildSpawnFailedResult(error: unknown): CliRunResult {
  return {
    disposition: "spawn-failed",
    exitCode: null,
    stdout: "",
    stderr: "",
    failureCode: resolveFailureCode(error),
  };
}

/** The settle/kill seam every listener attached to the child shares, so each listener body stays a one-liner. */
interface RunContext {
  readonly settle: (
    disposition: CliRunDisposition,
    exitCode: number | null,
    failureCode?: string,
  ) => void;
  readonly killChild: () => void;
}

/**
 * Wires the own timeout timer and the abort listener, and builds the
 * `settled` guard both share with the child's own event listeners. A
 * `Promise`'s `resolve` is already idempotent — a second call is a no-op
 * regardless of this flag — so `settled` is not what stops the resolved
 * disposition from being overwritten. What it actually buys is not
 * re-running `cleanup`/`finalize` (stream finalization, listener detachment,
 * timer clearing) a second time on a second terminal event. `detachAll` is
 * invoked once, on the first settle, so the caller can detach every other
 * listener it attached (child lifecycle, stream capture) without this
 * function needing to know about them. Kept separate from
 * {@link runCliProcess} purely to stay under this package's
 * `max-lines-per-function` budget.
 */
function createRunContext(
  child: CliChildProcess,
  streams: {
    readonly stdout: StreamAccumulator;
    readonly stderr: StreamAccumulator;
  },
  resolve: (result: CliRunResult) => void,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  detachAll: () => void,
): RunContext {
  let settled = false;
  let timerHandle: NodeJS.Timeout | undefined;

  const killChild = (): void => {
    child.kill("SIGTERM");
  };

  const cleanup = (): void => {
    if (timerHandle !== undefined) {
      clearTimeout(timerHandle);
      timerHandle = undefined;
    }
    signal?.removeEventListener("abort", onAbort);
    detachAll();
  };

  const settle = (
    disposition: CliRunDisposition,
    exitCode: number | null,
    failureCode?: string,
  ): void => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    resolve({
      disposition,
      exitCode,
      stdout: streams.stdout.finalize(),
      stderr: streams.stderr.finalize(),
      failureCode,
    });
  };

  const onAbort = (): void => {
    killChild();
    settle("aborted", null);
  };

  timerHandle = setTimeout(() => {
    killChild();
    settle("timed-out", null);
  }, timeoutMs);
  signal?.addEventListener("abort", onAbort);

  return { settle, killChild };
}

/**
 * Wires the child's own `"error"`/`"close"` listeners — the spawn-failure
 * and exit/signal paths. Returns a detach function that removes only
 * `"close"` on settle; `"error"` is deliberately left attached forever.
 *
 * `settle` already no-ops after the first call, so a late `"error"` is
 * harmless — but `EventEmitter` throws synchronously for an `"error"` event
 * with zero listeners. Detaching it on settle would trade the accumulation
 * bug this fix closes for the exact uncaught-exception hazard Fix 3 exists
 * to prevent (a delayed OS-level error arriving after this module has
 * already moved on). Leaving one idempotent listener attached costs nothing
 * and keeps the child's `EventEmitter` permanently safe to emit on.
 */
function attachChildLifecycle(
  child: CliChildProcess,
  settle: RunContext["settle"],
): () => void {
  const onError = (error: NodeJS.ErrnoException): void => {
    settle("spawn-failed", null, resolveFailureCode(error));
  };
  const onClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    settle(code === null && signal !== null ? "signalled" : "exited", code);
  };
  child.on("error", onError);
  child.on("close", onClose);
  return () => {
    child.off("close", onClose);
  };
}

/**
 * One output stream's wiring: the byte-cap breach path and the `"error"`
 * path, plus the matching detach. Attach/detach are split from construction
 * so `runCliProcess` can build both stream captures before wiring either.
 *
 * `detach()` removes only the `"data"` listener — that is the one that
 * accumulates bytes and re-triggers `killChild()` on every post-breach
 * chunk, which is what Fix 2 closes. `"error"` is left attached forever for
 * the same reason as {@link attachChildLifecycle}: `EventEmitter` throws
 * synchronously on an `"error"` event with no listener, so removing it would
 * reopen the exact uncaught-exception hazard Fix 3 exists to close.
 */
interface StreamCapture {
  attach(): void;
  detach(): void;
}

function createStreamCapture(
  stream: CliChildProcessStream,
  accumulator: StreamAccumulator,
  killChild: () => void,
  onBreach: () => void,
  onStreamError: (error: Error) => void,
): StreamCapture {
  const onData = (chunk: Buffer): void => {
    accumulator.ingest(chunk);
    if (accumulator.breached) {
      killChild();
      onBreach();
    }
  };
  return {
    attach() {
      stream.on("data", onData);
      stream.on("error", onStreamError);
    },
    detach() {
      stream.off("data", onData);
    },
  };
}

/**
 * Wires the child's lifecycle listeners and both stream captures, and
 * returns the single detach function {@link createRunContext} calls on
 * settle. An `"error"` on either output stream (e.g. a broken pipe) kills
 * the child and settles `"stream-failed"` — left unhandled, that event has
 * no listener and crashes this long-lived stdio server outright.
 */
function wireChildAndStreams(
  child: CliChildProcess,
  streams: {
    readonly stdout: StreamAccumulator;
    readonly stderr: StreamAccumulator;
  },
  context: RunContext,
): () => void {
  const { settle, killChild } = context;
  const detachChild = attachChildLifecycle(child, settle);

  const onBreach = (): void => {
    settle("output-truncated", null);
  };
  const onStreamError = (error: Error): void => {
    killChild();
    settle("stream-failed", null, resolveFailureCode(error));
  };

  const stdoutCapture = createStreamCapture(
    child.stdout,
    streams.stdout,
    killChild,
    onBreach,
    onStreamError,
  );
  const stderrCapture = createStreamCapture(
    child.stderr,
    streams.stderr,
    killChild,
    onBreach,
    onStreamError,
  );
  stdoutCapture.attach();
  stderrCapture.attach();

  return () => {
    detachChild();
    stdoutCapture.detach();
    stderrCapture.detach();
  };
}

/** The result an already-aborted `signal` resolves with — no spawn call is ever made for it. */
function buildAbortedResult(): CliRunResult {
  return {
    disposition: "aborted",
    exitCode: null,
    stdout: "",
    stderr: "",
    failureCode: undefined,
  };
}

/**
 * `node:child_process`'s real `spawn`, adapted to the narrower
 * {@link SpawnLike} seam. {@link CliSpawnOptions} carries no `stdio` field,
 * so `spawn` resolves the overload that guarantees non-null
 * `stdout`/`stderr` without needing a type assertion.
 */
const defaultSpawn: SpawnLike = (command, args, options) =>
  nodeSpawn(command, args, options);

/**
 * Spawns `nodeExecPath` with `[entrypoint, ...args]` (`shell: false`,
 * always — an argv array, never a command string) and resolves once the
 * run settles, by exactly one of: a clean exit, a signalled exit, a spawn
 * failure (thrown synchronously or emitted asynchronously), a broken output
 * stream, a timeout, an output-cap breach, or an abort. Never throws — a
 * spawn failure is a value in {@link CliRunDisposition}, so the caller
 * writes one exhaustive `switch` instead of a `try`/`catch`.
 *
 * @param options - See {@link RunCliProcessOptions}.
 * @returns The settled {@link CliRunResult}.
 *
 * @example
 * ```ts
 * import { runCliProcess } from "./process.js";
 *
 * const result = await runCliProcess({
 *   nodeExecPath: process.execPath,
 *   entrypoint: "/repo/packages/m3l-cli/bin/m3l.mjs",
 *   args: ["doctor", "--json"],
 *   cwd: "/repo/packages/m3l-cli/bin",
 *   timeoutMs: 30_000,
 *   maxOutputBytes: 1_048_576,
 * });
 * ```
 */
export async function runCliProcess(
  options: RunCliProcessOptions,
): Promise<CliRunResult> {
  if (options.signal?.aborted === true) {
    return buildAbortedResult();
  }

  return new Promise<CliRunResult>((resolve) => {
    const spawnFn = options.spawn ?? defaultSpawn;
    let child: CliChildProcess;
    try {
      child = spawnFn(
        options.nodeExecPath,
        [options.entrypoint, ...options.args],
        { cwd: options.cwd, shell: false },
      );
    } catch (error) {
      // Node's real spawn throws SYNCHRONOUSLY for a NUL-bearing/empty argv
      // entry — this catch is what keeps that throw from escaping this
      // module's never-throws contract (surface.ts has no try/catch here).
      resolve(buildSpawnFailedResult(error));
      return;
    }

    const streams = {
      stdout: createStreamAccumulator(options.maxOutputBytes),
      stderr: createStreamAccumulator(options.maxOutputBytes),
    };
    // wireChildAndStreams needs `context.settle`/`context.killChild`, and
    // createRunContext needs a detach callback for cleanup — this box lets
    // both sides exist before the other, with the real detach function
    // installed before control ever returns to the event loop.
    const detachBox: { detach: () => void } = { detach: () => undefined };
    const context = createRunContext(
      child,
      streams,
      resolve,
      options.timeoutMs,
      options.signal,
      () => {
        detachBox.detach();
      },
    );
    detachBox.detach = wireChildAndStreams(child, streams, context);
  });
}
