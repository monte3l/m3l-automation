/**
 * `runs/executor` — the two `M3LRunExecutor` ports the X4 run-registry drives
 * a script through: {@link createSpawnExecutor} spawns a script's
 * `dist/main.js` as a child process, and {@link createInProcessExecutor}
 * dynamically imports and invokes a script's opted-in `dist/command.js`
 * in-process (ADR-0054). Both report their observed result as
 * {@link M3LSpawnExitInfo}, exactly the vocabulary `runs/outcome` maps onto
 * `Core.M3LRunOutcome` — now including its optional explicit `outcome` arm:
 * the in-process executor sets it directly from the command's own
 * `M3LCommandOutcome.status`, since a plain exit code cannot express every
 * `Core.M3LRunOutcome` member (`"partial"`, or a self-reported
 * `"interrupted"` the caller never asked for); the spawn executor leaves it
 * absent because a child process has nothing more than an exit code and a
 * kill signal to report.
 *
 * X7d adds one more piece of per-run environment on the SPAWN path only:
 * `M3L_OUTPUT_DIR`, pinned to this run's own directory so the report it
 * writes is addressable by run id. See {@link M3LRunExecutorOptions.outputDir}
 * for why the in-process path cannot honour it.
 *
 * @packageDocumentation
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";

import type { M3LSpawnExitInfo } from "./outcome.js";

/** A sink a run executor calls once per line of a script's observable output. */
export type M3LLineSink = (line: string) => void;

/**
 * The options {@link M3LRunExecutor.execute} accepts for one run.
 *
 * Deliberately NOT exported today: knip flags an exported type that nothing
 * under `src/**` consumes, and `tests/**` is outside its `project` glob so a
 * test-only import would not count as usage anyway. A caller building one of
 * these at the call site does not need to name this type — `execute`'s own
 * signature infers the argument shape directly. Re-export it the moment X4
 * slice 6's run orchestrator builds one to call {@link M3LRunExecutor.execute},
 * giving `src/**` a consumer that satisfies the knip gate.
 *
 * @example
 * ```ts
 * const options: M3LRunExecutorOptions = {
 *   scriptDir: "/scripts/example",
 *   parameters: { region: "us-east-1" },
 *   dryRun: false,
 *   signal: new AbortController().signal,
 *   onLine: (line) => {
 *     console.log(line);
 *   },
 * };
 * ```
 */
interface M3LRunExecutorOptions {
  /** The absolute path to the script's build directory. */
  readonly scriptDir: string;
  /** The run's caller-supplied parameters. */
  readonly parameters: Readonly<Record<string, string>>;
  /** Whether this run must perform no real work. */
  readonly dryRun: boolean;
  /** The cooperative cancellation signal for this run. */
  readonly signal: AbortSignal;
  /**
   * The launching request's correlation id (ADR-0070), threaded explicitly
   * from the orchestrator rather than read from ambient context — a queued
   * run is started inside a different run's completion continuation, so
   * there is no correct ambient value to read.
   *
   * Required, not optional: every caller has one (the HTTP layer resolves it
   * per request), and an optional field would let a new call site silently
   * drop correlation for the runs it starts.
   */
  readonly correlationId: string;
  /**
   * The directory this run's own output tree lives under, handed to a
   * spawned child as `M3L_OUTPUT_DIR` (X7d, ADR-0070). The orchestrator
   * derives it per run as `<runsOutputRoot>/<runId>`, which is what makes a
   * run's `run-report.json` addressable by run id — see
   * `config/paths.ts`'s `resolveRunsOutputRoot`.
   *
   * Consumed by {@link createSpawnExecutor} ONLY.
   * {@link createInProcessExecutor} accepts and ignores it: a hosted command
   * runs inside the console's own process, `Core.M3LPaths` snapshots the
   * output dir at construction time from the ambient environment, and there
   * is no per-call seam to hand it through — mutating `process.env` for one
   * in-process run would leak into every other. The consequence is stated in
   * `docs/reference/console.md`: an in-process run's report is not served.
   *
   * Required, not optional, for the same reason `correlationId` is: every
   * caller has one, and an optional field would let a new call site silently
   * drop per-run isolation for the runs it starts.
   */
  readonly outputDir: string;
  /** Called once per non-empty line of the run's observable output. */
  readonly onLine: M3LLineSink;
}

/**
 * The port a run's driver depends on to execute a script: spawn it as a
 * child process, or invoke it in-process. Both {@link createSpawnExecutor}
 * and {@link createInProcessExecutor} build one.
 *
 * @example
 * ```ts
 * import { createSpawnExecutor } from "@m3l-automation/m3l-console-server/runs/executor.js";
 *
 * const executor = createSpawnExecutor({ killTimeoutMs: 5000 });
 * const info = await executor.execute({
 *   scriptDir: "/scripts/example",
 *   parameters: {},
 *   dryRun: true,
 *   signal: new AbortController().signal,
 *   onLine: (line) => {
 *     console.log(line);
 *   },
 * });
 * ```
 */
export interface M3LRunExecutor {
  /**
   * Executes one run and resolves once it has finished.
   *
   * @param options - See {@link M3LRunExecutorOptions}.
   * @returns The run's observed exit info.
   */
  execute(options: M3LRunExecutorOptions): Promise<M3LSpawnExitInfo>;
}

/**
 * Constructor options for {@link createSpawnExecutor}.
 *
 * @example
 * ```ts
 * const options: M3LSpawnExecutorOptions = { killTimeoutMs: 5000 };
 * ```
 */
export interface M3LSpawnExecutorOptions {
  /**
   * How long to wait, after sending `SIGTERM` on abort, before escalating to
   * `SIGKILL`.
   */
  readonly killTimeoutMs: number;
}

/** The subset of a spawned child process {@link createSpawnExecutor} depends on. */
interface M3LSpawnedProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly kill: (signal?: string) => boolean;
  once(
    event: "close",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

/** The options {@link createSpawnExecutor}'s spawn seam is called with. */
interface M3LSpawnCallOptions {
  readonly cwd: string;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The test-only injection seam for {@link createSpawnExecutor}: replaces the
 * real `child_process.spawn` and `setTimeout` so a test can drive both
 * without a real process or a real clock.
 */
interface M3LSpawnExecutorInternals {
  readonly spawnImpl?: (
    command: string,
    args: readonly string[],
    options: M3LSpawnCallOptions,
  ) => M3LSpawnedProcess;
  readonly timerImpl?: typeof setTimeout;
}

/**
 * Wraps `node:child_process`'s `spawn` down to {@link M3LSpawnedProcess}'s
 * narrower shape — the only surface {@link createSpawnExecutor} depends on.
 */
function defaultSpawn(
  command: string,
  args: readonly string[],
  options: M3LSpawnCallOptions,
): M3LSpawnedProcess {
  return spawn(command, [...args], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env,
  }) as unknown as M3LSpawnedProcess;
}

/**
 * Splits `stream` into lines and calls `onLine` for each non-empty one.
 * A no-op when `stream` is `null` (stdio disabled for that channel).
 */
function pipeLines(
  stream: NodeJS.ReadableStream | null,
  onLine: M3LLineSink,
): void {
  if (stream === null) return;
  createInterface({ input: stream }).on("line", (line: string): void => {
    if (line.length > 0) onLine(line);
  });
}

/**
 * Builds the terminal {@link M3LSpawnExitInfo} for a spawned child's
 * `"close"` event.
 *
 * Node's `killSignal` is `non-null` whenever the child died from a signal —
 * whether this executor requested it (via `abort()`) or not (kernel OOM
 * `SIGKILL`, an operator `kill`, a supervisor's own `SIGTERM`). Either way the
 * run did not complete normally, so `outcome` is set to `"interrupted"`
 * explicitly rather than left for `mapSpawnOutcome` to derive
 * `"success"`/`"failure"` from an exit code a signal death can leave
 * meaningless (`null`, collapsed to `0` here). This is deliberately
 * independent of `killRequested`: an externally-initiated signal must NOT
 * flip that flag — only an `abort()` this executor issued may do that — so an
 * unrequested signal death still reports `killRequested: false` alongside
 * `outcome: "interrupted"`.
 */
function buildCloseExitInfo(
  exitCode: number | null,
  killSignal: string | null,
  killRequested: boolean,
  dryRun: boolean,
): M3LSpawnExitInfo {
  return {
    exitCode: exitCode ?? 0,
    killRequested,
    dryRun,
    ...(killSignal !== null && { outcome: "interrupted" as const }),
  };
}

/**
 * Awaits a spawned {@link M3LSpawnedProcess} to a terminal
 * {@link M3LSpawnExitInfo}, wiring up abort-driven `SIGTERM`/`SIGKILL`
 * escalation and settle-once resolve/reject guards. Extracted out of
 * {@link createSpawnExecutor} to keep that factory function short.
 *
 * See {@link buildCloseExitInfo} for how the `"close"` event's `code`/`signal`
 * pair maps onto the resolved {@link M3LSpawnExitInfo}.
 */
function awaitSpawnedChild(
  child: M3LSpawnedProcess,
  run: Pick<M3LRunExecutorOptions, "scriptDir" | "dryRun" | "signal">,
  killTimeoutMs: number,
  timerImpl: typeof setTimeout,
): Promise<M3LSpawnExitInfo> {
  const { scriptDir, dryRun, signal } = run;

  return new Promise<M3LSpawnExitInfo>((resolve, reject) => {
    let settled = false;
    let killRequested = false;
    let killTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const settleResolve = (info: M3LSpawnExitInfo): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(info);
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new M3LConsoleError(
          "ERR_CONSOLE_INTERNAL",
          `failed to spawn script process in ${scriptDir}`,
          { cause: error },
        ),
      );
    };

    if (signal.aborted) {
      killRequested = true;
      child.kill("SIGTERM");
      killTimer = timerImpl((): void => {
        if (!settled) child.kill("SIGKILL");
      }, killTimeoutMs);
    }

    signal.addEventListener(
      "abort",
      (): void => {
        killRequested = true;
        child.kill("SIGTERM");
        killTimer = timerImpl((): void => {
          if (!settled) child.kill("SIGKILL");
        }, killTimeoutMs);
      },
      { once: true },
    );

    child.once("close", (code, killSignal): void => {
      settleResolve(
        buildCloseExitInfo(code, killSignal, killRequested, dryRun),
      );
    });
    child.once("error", (error): void => {
      settleReject(error);
    });
  });
}

/**
 * Creates an {@link M3LRunExecutor} that spawns a script's `dist/main.js` as
 * a child process, piping its stdout/stderr through `onLine` line by line.
 *
 * On abort, sends `SIGTERM`; if the process has not exited after
 * `killTimeoutMs`, escalates to `SIGKILL`. Either path reports
 * `killRequested: true` on the resolved {@link M3LSpawnExitInfo}, regardless
 * of the exit code the killed process happened to produce.
 *
 * @param options - See {@link M3LSpawnExecutorOptions}.
 * @param internals - Test-only injection seam; omit in production code.
 * @returns An executor over a spawned child process.
 *
 * @example
 * ```ts
 * import { createSpawnExecutor } from "@m3l-automation/m3l-console-server/runs/executor.js";
 *
 * const executor = createSpawnExecutor({ killTimeoutMs: 5000 });
 * ```
 */
export function createSpawnExecutor(
  options: M3LSpawnExecutorOptions,
  internals: M3LSpawnExecutorInternals = {},
): M3LRunExecutor {
  const spawnImpl = internals.spawnImpl ?? defaultSpawn;
  const timerImpl = internals.timerImpl ?? setTimeout;

  return {
    execute(executeOptions: M3LRunExecutorOptions): Promise<M3LSpawnExitInfo> {
      const {
        scriptDir,
        parameters,
        dryRun,
        signal,
        correlationId,
        outputDir,
        onLine,
      } = executeOptions;
      const args = dryRun ? ["dist/main.js", "--dry-run"] : ["dist/main.js"];
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        M3L_RUN_PARAMETERS: JSON.stringify(parameters),
        // MIRRORED LITERAL. `m3l-common`'s
        // `internal/script/correlationId.ts` READS this exact variable as
        // the tier below an explicit option, which is what makes a spawned
        // run join this request's trace. The two copies are deliberate —
        // neither package needs the other's compile-time surface for a
        // string — and each side has a test exercising the literal, so a
        // rename fails loudly rather than silently breaking correlation.
        M3L_CORRELATION_ID: correlationId,
        // MIRRORED LITERAL. `m3l-common`'s `core/utils/M3LPaths.ts` READS
        // this exact variable (`M3LPathEnvironmentVariables.OUTPUT_DIR`) as
        // the override for its computed output directory, snapshotted at
        // construction — which is what puts this run's `run-report.json` and
        // stage-9 archive under a directory the console can address by run
        // id. Same two-copies-on-purpose reasoning as `M3L_CORRELATION_ID`
        // above, and each side has a test pinning the literal: this file's
        // twin in `tests/runs-executor.test.ts`, and `m3l-common`'s in
        // `tests/utils.test.ts`.
        M3L_OUTPUT_DIR: outputDir,
      };
      const child = spawnImpl("node", args, {
        cwd: scriptDir,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });

      pipeLines(child.stdout, onLine);
      pipeLines(child.stderr, onLine);

      return awaitSpawnedChild(
        child,
        { scriptDir, dryRun, signal },
        options.killTimeoutMs,
        timerImpl,
      );
    },
  };
}

/**
 * The test-only injection seam for {@link createInProcessExecutor}: replaces
 * the real dynamic `import()` so a test can hand back a fake module without a
 * real `dist/command.js` on disk.
 */
interface M3LInProcessExecutorInternals {
  readonly importImpl?: (specifier: string) => Promise<unknown>;
  /**
   * Handlers to construct the run's logger with, defaulting to none.
   *
   * Production passes none: this executor forwards a command's output
   * through `onLine`, not through a log handler. The seam exists because
   * `Core.M3LLogger` exposes its correlation id ONLY on events it dispatches
   * to handlers — no getter, no attach-after-construction API — so with zero
   * handlers "the logger was seeded with this run's id" is unobservable, and
   * a regression that dropped the seeding would pass silently. Injecting a
   * handler lets a test read the id off a dispatched event while the
   * SEEDING itself stays in the production path.
   */
  readonly logHandlers?: readonly Core.M3LLoggerHandler[];
}

/**
 * Maps a hosted command's resolved {@link Core.M3LCommandOutcome} onto
 * {@link M3LSpawnExitInfo}, mirroring the exit codes `runs/outcome` and
 * `core/cli-contract` already assign to the same status vocabulary — and
 * additionally setting the explicit `outcome` field to the command's own
 * `status` for every arm, so `mapSpawnOutcome` reports the command's real
 * terminal status instead of re-deriving it from an exit code that cannot
 * distinguish `"partial"` from `"failure"`, or a self-reported
 * `"interrupted"` from one the caller's own signal actually requested.
 */
function mapCommandOutcome(
  outcome: Core.M3LCommandOutcome,
  dryRun: boolean,
  signal: AbortSignal,
): M3LSpawnExitInfo {
  switch (outcome.status) {
    case "success":
      return { exitCode: 0, killRequested: false, dryRun, outcome: "success" };
    case "dry-run":
      return {
        exitCode: 0,
        killRequested: false,
        dryRun: true,
        outcome: "dry-run",
      };
    case "interrupted":
      return {
        exitCode: 130,
        killRequested: signal.aborted,
        dryRun,
        outcome: "interrupted",
      };
    case "partial":
      return { exitCode: 2, killRequested: false, dryRun, outcome: "partial" };
    case "failure":
      return { exitCode: 1, killRequested: false, dryRun, outcome: "failure" };
    default: {
      const exhaustive: never = outcome;
      throw new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        `unhandled command outcome status: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Creates an {@link M3LRunExecutor} that dynamically imports a script's
 * opted-in `dist/command.js` and invokes its exported `commandModule`
 * in-process (ADR-0054), instead of spawning a child process.
 *
 * @param internals - Test-only injection seam; omit in production code.
 * @returns An executor over an in-process command module.
 *
 * @example
 * ```ts
 * import { createInProcessExecutor } from "@m3l-automation/m3l-console-server/runs/executor.js";
 *
 * const executor = createInProcessExecutor();
 * ```
 */
export function createInProcessExecutor(
  internals: M3LInProcessExecutorInternals = {},
): M3LRunExecutor {
  const importImpl =
    internals.importImpl ??
    ((specifier: string): Promise<unknown> => import(specifier));
  const logHandlers = internals.logHandlers ?? [];

  return {
    async execute(options: M3LRunExecutorOptions): Promise<M3LSpawnExitInfo> {
      const { scriptDir, parameters, dryRun, signal, correlationId, onLine } =
        options;
      const specifier = join(scriptDir, "dist/command.js");
      let imported: unknown;
      try {
        imported = await importImpl(specifier);
      } catch (cause: unknown) {
        throw new M3LConsoleError(
          "ERR_CONSOLE_INTERNAL",
          `failed to load command module from ${specifier}`,
          { cause },
        );
      }
      const candidate = (imported as Record<string, unknown>)["commandModule"];
      if (!Core.isM3LCommandModule(candidate)) {
        throw new M3LConsoleError(
          "ERR_CONSOLE_INTERNAL",
          `${specifier} does not export a valid command module`,
        );
      }

      const output: Core.M3LCommandOutput = {
        colorEnabled: false,
        info: onLine,
        error: onLine,
        heading: onLine,
      };
      // Two independent channels, both seeded from the same id: the logger
      // stamps every event it emits, and the context hands the id to the
      // command itself. The logger half needs no `m3l-common` surface at
      // all — `M3LLogger` has taken `correlationId` since it shipped.
      const logger = new Core.M3LLogger([...logHandlers], { correlationId });
      const outcome = await candidate.execute(parameters, {
        output,
        logger,
        signal,
        dryRun,
        correlationId,
      });
      return mapCommandOutcome(outcome, dryRun, signal);
    },
  };
}
