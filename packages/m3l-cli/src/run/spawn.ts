/**
 * `run/spawn` — spawns a script's compiled `dist/main.js` as a child process,
 * resolving to its exit code (or the signal-derived `128 + signal number`
 * when the child died from a signal).
 *
 * @packageDocumentation
 */

import { existsSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { join } from "node:path";

import { M3LCliError } from "../cli/errors.js";

/**
 * The subset of a spawned child process's interface `spawnScript` relies on
 * — the `close`/`error` events every real `ChildProcess` emits (and that a
 * test's fake `EventEmitter` double can emit too, without satisfying
 * `ChildProcess`'s full `stdin`/`stdout`/`stderr` surface). `off` is included
 * so the settle-once guard in `spawnScript` can remove the sibling listener
 * once either event fires — every real `ChildProcess` and `EventEmitter`
 * already implements it.
 */
interface M3LCliSpawnedProcess {
  once(
    event: "close",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  off(
    event: "close",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  /**
   * The child's stdout stream, present only when `stdio`'s second element is
   * `"pipe"` — `null` for a real `ChildProcess` spawned with inherited stdio,
   * and possibly absent entirely from a minimal test double.
   */
  readonly stdout?: {
    pipe(destination: { write(chunk: unknown): unknown }): unknown;
  } | null;
}

/**
 * The `stdio` shape `spawnScript` ever passes to `spawnImpl`: either fully
 * inherited (the default), or the three-element form that pipes only the
 * child's stdout (fd 1) back to the parent while leaving stdin/stderr
 * inherited — used when {@link M3LCliSpawnOptions.redirectStdoutToStderr} is
 * set, so a script's own stdout never contends with a `--json` envelope
 * written to the parent's stdout.
 *
 * @example
 * ```ts
 * import type { M3LCliSpawnStdio } from "@m3l-automation/m3l-cli/run/spawn";
 *
 * const stdio: M3LCliSpawnStdio = ["inherit", "pipe", "inherit"];
 * ```
 */
export type M3LCliSpawnStdio =
  "inherit" | readonly ["inherit", "pipe", "inherit"];

/** Injectable overrides `spawnScript` accepts in place of the real process globals. */
export interface M3LCliSpawnOptions {
  /**
   * The `spawn` implementation to invoke; defaults to `node:child_process`'s
   * `spawn`, narrowed to the `close`/`error`-emitting subset of its return
   * type that `spawnScript` actually consumes (so an injected test double
   * only needs to satisfy that subset, not the full `ChildProcess` shape).
   */
  readonly spawnImpl?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly stdio: M3LCliSpawnStdio },
  ) => M3LCliSpawnedProcess;
  /**
   * When `true`, spawns with `stdio: ["inherit", "pipe", "inherit"]` and
   * pipes the child's stdout into {@link stderrStream} (or `process.stderr`)
   * instead of letting it inherit the parent's stdout — so a `--json`
   * caller's own envelope line is never interleaved with the script's own
   * stdout output. Defaults to `false` (fully inherited stdio).
   */
  readonly redirectStdoutToStderr?: boolean;
  /**
   * The stream the child's stdout is piped into when
   * {@link redirectStdoutToStderr} is `true`; defaults to `process.stderr`.
   * Ignored when `redirectStdoutToStderr` is not `true`.
   */
  readonly stderrStream?: { write(chunk: unknown): unknown };
}

/**
 * Adapts `node:child_process`'s real `spawn` to {@link M3LCliSpawnOptions}'s
 * narrower shape. `stdio`'s three-element form is copied into a fresh
 * mutable array — `node:child_process`'s own `SpawnOptions.stdio` accepts a
 * mutable array, never the `readonly` tuple {@link M3LCliSpawnStdio} declares.
 */
const defaultSpawnImpl: NonNullable<M3LCliSpawnOptions["spawnImpl"]> = (
  command,
  args,
  spawnOptions,
) =>
  nodeSpawn(command, args, {
    cwd: spawnOptions.cwd,
    stdio:
      spawnOptions.stdio === "inherit" ? "inherit" : [...spawnOptions.stdio],
  });

/** Exit-code offset applied to a signal's numeric value (POSIX shell convention). */
const SIGNAL_EXIT_CODE_OFFSET = 128;

/** Fallback exit code for a signal name `node:os`'s `constants.signals` doesn't recognize. */
const UNKNOWN_SIGNAL_EXIT_CODE = 1;

/**
 * Resolves the exit code for a child process that exited normally with
 * `code`, or (when `code` is `null`) died from `signal`.
 */
function resolveExitCode(code: number | null, signal: string | null): number {
  if (code !== null) {
    return code;
  }
  if (signal !== null) {
    const signals: Readonly<Record<string, number | undefined>> =
      osConstants.signals;
    const signalNumber = Object.hasOwn(signals, signal)
      ? signals[signal]
      : undefined;
    return signalNumber === undefined
      ? UNKNOWN_SIGNAL_EXIT_CODE
      : SIGNAL_EXIT_CODE_OFFSET + signalNumber;
  }
  return UNKNOWN_SIGNAL_EXIT_CODE;
}

/**
 * Spawns `<scriptDirectory>/dist/main.js` via `process.execPath`, passing
 * `passthroughArgs` through unchanged, and resolves the child's exit code.
 *
 * @param scriptDirectory - The script's directory (must contain a built
 *   `dist/main.js`).
 * @param passthroughArgs - Arguments forwarded verbatim after `dist/main.js`.
 * @param options - Optional `spawnImpl` override for testing.
 * @returns The child's numeric exit code; when the child died from a signal,
 *   `128 + <signal number>` (or `1` when the signal name is unrecognized).
 * @throws {@link M3LCliError} coded `ERR_CLI_SCRIPT_NOT_BUILT` when
 *   `dist/main.js` does not exist — before invoking `spawnImpl` at all.
 * @throws {@link M3LCliError} coded `ERR_CLI_SPAWN_FAILED` when the spawned
 *   process emits an `error` event (e.g. `ENOENT`), with the original error
 *   chained as `cause`.
 *
 * @example
 * ```ts
 * const exitCode = await spawnScript("/repo/scripts/json-etl", ["--limit", "5"]);
 * ```
 */
export async function spawnScript(
  scriptDirectory: string,
  passthroughArgs: readonly string[],
  options: M3LCliSpawnOptions = {},
): Promise<number> {
  const entryPoint = join(scriptDirectory, "dist", "main.js");
  if (!existsSync(entryPoint)) {
    throw new M3LCliError(
      "ERR_CLI_SCRIPT_NOT_BUILT",
      `script at '${scriptDirectory}' has not been built — run 'pnpm build' first`,
    );
  }

  const spawnImpl = options.spawnImpl ?? defaultSpawnImpl;
  const stdio: M3LCliSpawnStdio =
    options.redirectStdoutToStderr === true
      ? ["inherit", "pipe", "inherit"]
      : "inherit";

  return new Promise<number>((resolve, reject) => {
    let child: M3LCliSpawnedProcess;
    try {
      child = spawnImpl(
        process.execPath,
        ["--env-file-if-exists=.env", "dist/main.js", ...passthroughArgs],
        { cwd: scriptDirectory, stdio },
      );
    } catch (cause) {
      reject(
        new M3LCliError(
          "ERR_CLI_SPAWN_FAILED",
          `failed to spawn script at '${scriptDirectory}'`,
          { cause },
        ),
      );
      return;
    }

    // Piping is a no-op unless `stdio`'s second element is `"pipe"` (real
    // child) or the double happens to expose a `stdout.pipe` spy (test
    // double) — `?.` guards a real child whose `stdout` is `null` (inherited
    // stdio) and a double that omits `stdout` entirely.
    child.stdout?.pipe(options.stderrStream ?? process.stderr);

    // Settle-once guard: whichever of close/error fires first `.off()`s the
    // sibling listener before settling, so a spawn implementation that (in
    // violation of Node's own contract, but not something to trust blindly)
    // emitted both could never double-settle the promise.
    const onClose = (code: number | null, signal: string | null): void => {
      child.off("error", onError);
      resolve(resolveExitCode(code, signal));
    };
    const onError = (error: Error): void => {
      child.off("close", onClose);
      reject(
        new M3LCliError(
          "ERR_CLI_SPAWN_FAILED",
          `failed to spawn script at '${scriptDirectory}'`,
          { cause: error },
        ),
      );
    };
    child.once("close", onClose);
    child.once("error", onError);
  });
}
