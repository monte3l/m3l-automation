/**
 * `run/execute` — the single shared execution tail both `m3l run <script>`
 * and the dynamic `m3l <script>` dispatch through (ADR-0063, #539, "V2 slice
 * 2"): spawn the script, and — only when `--json` was requested — locate its
 * run report and emit exactly one JSON envelope on stdout.
 *
 * Deliberately structural rather than importing `M3LCliCommandContext` from
 * `commands/context.js`: `run/` must not depend on `commands/` (the reverse
 * dependency direction this package's layering documents), so
 * {@link M3LCliExecuteContext} only names the three fields this module
 * actually reads.
 *
 * @packageDocumentation
 */

import type { M3LCliEnvFileSetting } from "../cli/flags.js";
import type { M3LCliOutput } from "../cli/output.js";
import { spawnScript } from "./spawn.js";
import type { M3LCliSpawnOptions } from "./spawn.js";
import { locateRunReport } from "./report-lookup.js";
import { buildRunEnvelope, formatRunEnvelope } from "./envelope.js";

/**
 * The subset of a command context {@link executeScript} reads: the writer
 * facade, whether `--json` was requested, the managed output directory to
 * scan for a run report, and the base environment plus env-file decision it
 * forwards to {@link spawnScript}.
 *
 * Always populated by `main.ts`'s real `buildCommandContext` — this module
 * treats an absent value as a caller contract violation, not a case to
 * silently degrade.
 *
 * @example
 * ```ts
 * import type { M3LCliExecuteContext } from "@m3l-automation/m3l-cli/run/execute";
 *
 * const context: M3LCliExecuteContext = {
 *   output: { colorEnabled: false, info() {}, error() {}, heading() {} },
 *   jsonOutput: true,
 *   outputDirPath: "/repo/data/output",
 *   env: process.env,
 *   envFile: { kind: "auto" },
 * };
 * ```
 */
export interface M3LCliExecuteContext {
  /** The writer facade `--json` mode's envelope line renders through. */
  readonly output: M3LCliOutput;
  /** Whether the caller requested machine-readable JSON output. */
  readonly jsonOutput: boolean;
  /** The managed output directory to scan for a matching run report. */
  readonly outputDirPath: string;
  /** The base environment the spawned child inherits (ADR-0085). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The resolved `--env-file`/`--no-env-file` decision (ADR-0085). */
  readonly envFile: M3LCliEnvFileSetting;
}

/**
 * Injectable overrides {@link executeScript} threads through to
 * {@link spawnScript}, plus a `now` seam for deterministic timing in tests.
 *
 * @example
 * ```ts
 * import type { M3LCliExecuteOptions } from "@m3l-automation/m3l-cli/run/execute";
 *
 * const options: M3LCliExecuteOptions = { now: () => new Date(0) };
 * ```
 */
export interface M3LCliExecuteOptions {
  /** Forwarded verbatim to {@link spawnScript}'s own `spawnImpl` override. */
  readonly spawnImpl?: M3LCliSpawnOptions["spawnImpl"];
  /** Forwarded verbatim to {@link spawnScript}'s own `stderrStream` override. */
  readonly stderrStream?: M3LCliSpawnOptions["stderrStream"];
  /** Overrides the wall-clock read for `startedAt`/`finishedAt`; defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * The secret-flagged parameter values to inject into the spawned child's
   * environment (ADR-0085) — `translateArgv`'s `secretEnv` half, forwarded
   * verbatim to {@link spawnScript}. Omitted when the script declares no
   * secrets.
   */
  readonly secretEnv?: Readonly<Record<string, string>>;
  /**
   * Overrides {@link spawnScript}'s own `redirectStdoutToStderr`; defaults to
   * `context.jsonOutput` when omitted, preserving `m3l run --json`'s existing
   * behaviour.
   *
   * Deliberately independent of `context.jsonOutput`: that flag decides
   * whether THIS call emits its own `m3l.run.result` envelope line, while this
   * option decides whether the spawned child's stdout is kept off the
   * parent's. A caller that must suppress this call's own envelope —
   * `flow/step` always does, so a spawned step cannot emit a second,
   * corrupting envelope line — but is itself composing a `--json` envelope of
   * its own (a running flow) still needs the child's stdout redirected, and
   * sets this explicitly rather than relying on `context.jsonOutput`.
   */
  readonly redirectStdoutToStderr?: boolean;
}

/**
 * Composes the options {@link executeScript} forwards to {@link spawnScript}.
 *
 * Extracted so {@link executeScript} stays a flat sequence (spawn, then —
 * only in `--json` mode — locate and emit the envelope) rather than also
 * carrying the option-assembly branching inline.
 *
 * @param context - The writer facade, `--json` flag, and the environment plus
 *   env-file decision to forward.
 * @param options - The caller's optional overrides.
 * @returns The options object to hand to {@link spawnScript}.
 */
function buildSpawnOptions(
  context: M3LCliExecuteContext,
  options: M3LCliExecuteOptions,
): M3LCliSpawnOptions {
  return {
    ...(options.spawnImpl !== undefined
      ? { spawnImpl: options.spawnImpl }
      : {}),
    ...(options.stderrStream !== undefined
      ? { stderrStream: options.stderrStream }
      : {}),
    ...(options.secretEnv !== undefined
      ? { secretEnv: options.secretEnv }
      : {}),
    env: context.env,
    envFile: context.envFile,
    redirectStdoutToStderr:
      options.redirectStdoutToStderr ?? context.jsonOutput,
  };
}

/**
 * Spawns `scriptName` at `scriptDirectory`, forwarding `argv` verbatim, and
 * — only when `context.jsonOutput` is `true` — locates the run's report and
 * writes exactly one {@link formatRunEnvelope}-formatted line via
 * `context.output.info`.
 *
 * In `--json` mode, the child's stdout is redirected to the parent's stderr
 * (`spawnScript`'s `redirectStdoutToStderr`), so a script's own stdout output
 * never interleaves with the single JSON envelope line this function writes.
 * `options.redirectStdoutToStderr` can override that default independently of
 * `context.jsonOutput`, for a caller that suppresses this call's own envelope
 * but is composing a `--json` envelope of its own (see
 * {@link M3LCliExecuteOptions.redirectStdoutToStderr}).
 *
 * Envelope emission is best-effort: a failure locating or rendering the
 * report (including `context.output.info` itself throwing) never changes
 * the resolved exit code — only {@link spawnScript}'s own rejection
 * propagates. Such a failure is not silently discarded: it is surfaced via
 * `context.output.error` (itself best-effort, so a throwing implementation
 * still cannot alter the resolved exit code).
 *
 * @param context - The writer facade, `--json` flag, and output directory to
 *   scan.
 * @param scriptName - The invoked script's name (used for the report match
 *   and the envelope's `script` field).
 * @param scriptDirectory - The script's directory (must contain a built
 *   `dist/main.js`).
 * @param argv - Arguments forwarded verbatim to the spawned script.
 * @param options - The optional `secretEnv` overlay plus
 *   `spawnImpl`/`stderrStream`/`redirectStdoutToStderr` overrides and a `now`
 *   seam for deterministic timing.
 * @returns The spawned child's resolved exit code, unaffected by the
 *   envelope pipeline.
 *
 * @example
 * ```ts
 * const exitCode = await executeScript(
 *   {
 *     output,
 *     jsonOutput: true,
 *     outputDirPath: "/repo/data/output",
 *     env: process.env,
 *     envFile: { kind: "auto" },
 *   },
 *   "export-users",
 *   "/repo/scripts/export-users",
 *   ["--limit", "5"],
 * );
 * ```
 */
export async function executeScript(
  context: M3LCliExecuteContext,
  scriptName: string,
  scriptDirectory: string,
  argv: readonly string[],
  options: M3LCliExecuteOptions = {},
): Promise<number> {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();

  // Parent survival is now guaranteed by the single scope in runCli (main.ts),
  // which wraps the entire dispatch — including all teardown — so a SIGINT
  // never kills the parent before history recording or envelope emission
  // completes (SF-2, U11 ADR-0049). No scope is needed here.
  const exitCode = await spawnScript(
    scriptDirectory,
    argv,
    buildSpawnOptions(context, options),
  );

  if (!context.jsonOutput) {
    return exitCode;
  }

  const finishedAt = now();
  try {
    const lookup = locateRunReport({
      outputDirPath: context.outputDirPath,
      scriptName,
      startedAt,
      finishedAt,
    });
    const envelope = buildRunEnvelope({
      scriptName,
      startedAt,
      finishedAt,
      exitCode,
      lookup,
    });
    context.output.info(formatRunEnvelope(envelope));
  } catch (cause) {
    try {
      context.output.error(
        `failed to emit the --json run-result envelope${cause instanceof Error ? `: ${cause.message}` : ""}`,
      );
    } catch {
      /* the diagnostic write itself is best-effort too — it must never alter the resolved exit code */
    }
  }

  return exitCode;
}
