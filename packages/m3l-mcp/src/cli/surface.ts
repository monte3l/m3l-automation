/**
 * `cli/surface` — the argv table plus invocation this package's tools call
 * (V10c2b, contract file 4). This is the one module V10c3's `tools/health.ts`
 * calls; it hides the CLI-invocation and envelope-parsing plumbing
 * (`cli/process.ts`, `cli/envelopes.ts`) behind one typed method per `m3l`
 * subcommand.
 *
 * Every refusal reaches a model verbatim once V10c3 wires a tool handler
 * around this surface, so every thrown message here is a fixed module-level
 * constant — never the entrypoint path, the child's stdout/stderr, or a
 * caught error's message. Diagnostic detail (the exit code, the
 * disposition, the parse-failure reason) goes in `M3LMcpError`'s `context`
 * instead, which stays log-only.
 *
 * @packageDocumentation
 */
import type { M3LMcpSettings } from "../config/settings.js";
import { M3LMcpError } from "../errors/mcp-error.js";

import {
  parseDoctorChecks,
  parseJsonText,
  type M3LMcpDoctorCheck,
} from "./envelopes.js";
import {
  runCliProcess,
  type CliRunResult,
  type RunCliProcessOptions,
} from "./process.js";

/**
 * A refusal raised when the `m3l` CLI exited outside the invoked method's
 * accepted exit-code set. Fixed text — see the module doc for why.
 */
const EXIT_POLICY_VIOLATION =
  "the m3l CLI exited with a status outside the invoked method's accepted set";

/**
 * A refusal raised when the CLI invocation did not settle by a clean exit —
 * a spawn failure, a timeout, a mid-run abort, a signalled exit, a
 * stdout/stderr stream failure, or an output-cap breach. Fixed text — see
 * the module doc for why.
 */
const RUN_DID_NOT_COMPLETE = "the m3l CLI invocation did not complete normally";

/**
 * A refusal raised when {@link buildArgv} is asked to build argv for a
 * `CliMethodRequest` variant it does not recognize — an internal bug (a new
 * union member added without a corresponding case), never a user-facing
 * exit-code problem. Fixed text — see the module doc for why.
 */
const UNSUPPORTED_CLI_METHOD = "the CLI surface does not support this method";

/**
 * A refusal raised when a CLI invocation that did exit within its accepted
 * set produced output this surface could not parse into the expected
 * envelope shape. Fixed text — see the module doc for why.
 */
const OUTPUT_NOT_PARSEABLE = "the m3l CLI's output could not be parsed";

/**
 * A refusal raised when `runProcess` itself rejects rather than resolving
 * with a {@link CliRunResult} — a caller-substituted implementation
 * breaking its documented contract (the real `runCliProcess` resolves on
 * every path and never rejects). Fixed text — see the module doc for why;
 * the rejected value is chained as `cause`, never interpolated here.
 */
const RUN_PROCESS_REJECTED = "the m3l CLI invocation seam rejected";

/**
 * One request this surface knows how to build argv for, discriminated by
 * `method`. Deliberately a closed union with an exhaustive `switch` in
 * {@link buildArgv} rather than a string parameter or a lookup object that
 * would tolerate an unknown method silently — slices V10f/V10g adding
 * `list`/`inspect`/`run` get a compile error here, not a runtime gap.
 */
type CliMethodRequest = { readonly method: "doctor" };

/**
 * Builds the `m3l` CLI's argv for one {@link CliMethodRequest}. Module-private
 * — every caller goes through {@link createM3LMcpCliSurface}'s typed
 * methods instead.
 */
function buildArgv(request: CliMethodRequest): readonly string[] {
  switch (request.method) {
    case "doctor":
      return ["doctor", "--json"];
    /* istanbul ignore next -- unreachable: CliMethodRequest has exactly one
     * member today; this only fires if a future V10f/V10g method is added
     * to the union without adding its case here, which is exactly the
     * compile-time gap this exhaustive switch exists to catch. */
    default: {
      const exhaustive: never = request.method;
      throw new M3LMcpError("ERR_MCP_CLI", UNSUPPORTED_CLI_METHOD, {
        context: { method: String(exhaustive) },
      });
    }
  }
}

/**
 * Raises {@link M3LMcpError} (`ERR_MCP_CLI`) unless `result` settled by a
 * clean exit (`disposition === "exited"`). Exhaustive over every other
 * {@link CliRunDisposition} member so a new disposition added to
 * `cli/process.ts` fails to compile here rather than silently falling
 * through.
 */
function assertExited(result: CliRunResult): void {
  switch (result.disposition) {
    case "exited":
      return;
    case "spawn-failed":
    case "timed-out":
    case "aborted":
    case "signalled":
    case "output-truncated":
    case "stream-failed":
      throw new M3LMcpError("ERR_MCP_CLI", RUN_DID_NOT_COMPLETE, {
        context: {
          disposition: result.disposition,
          failureCode: result.failureCode,
        },
      });
    /* istanbul ignore next -- unreachable: every CliRunDisposition member is
     * listed above; this only fires if `cli/process.ts` adds a new member
     * without updating this switch, which is exactly the compile-time gap
     * this exhaustive switch exists to catch. */
    default: {
      const exhaustive: never = result.disposition;
      throw new M3LMcpError("ERR_MCP_CLI", RUN_DID_NOT_COMPLETE, {
        context: { disposition: String(exhaustive) },
      });
    }
  }
}

/**
 * Raises {@link M3LMcpError} (`ERR_MCP_CLI`) unless `exitCode` is one of
 * `doctor`'s accepted exit codes. `0` and `1` are BOTH success for
 * `doctor`: re-derived from `packages/m3l-cli/src/commands/doctor.ts`'s
 * `runDoctor`, which returns `1` precisely when a health check resolved
 * `"fail"` — a failing check is the tool's *answer*, not a tool-level
 * failure, so exit `1` must parse and return like exit `0`. Any other code
 * means the CLI itself broke (a crash, a usage error), which is a genuine
 * `ERR_MCP_CLI`.
 */
function assertDoctorExitCode(exitCode: number | null): void {
  if (exitCode === 0 || exitCode === 1) return;
  throw new M3LMcpError("ERR_MCP_CLI", EXIT_POLICY_VIOLATION, {
    context: { exitCode },
  });
}

/**
 * Parses `stdout` as `m3l doctor --json`'s envelope, raising
 * {@link M3LMcpError} (`ERR_MCP_CLI`) on any parse failure. The failure
 * `reason` token (never any part of `stdout` itself — see
 * `cli/envelopes.ts`) goes in `context` for logs.
 */
function parseDoctorOutput(stdout: string): readonly M3LMcpDoctorCheck[] {
  const jsonResult = parseJsonText(stdout);
  if (!jsonResult.ok) {
    throw new M3LMcpError("ERR_MCP_CLI", OUTPUT_NOT_PARSEABLE, {
      context: { reason: jsonResult.reason },
    });
  }

  const checksResult = parseDoctorChecks(jsonResult.value);
  if (!checksResult.ok) {
    throw new M3LMcpError("ERR_MCP_CLI", OUTPUT_NOT_PARSEABLE, {
      context: { reason: checksResult.reason },
    });
  }

  return checksResult.value;
}

/**
 * Runs `m3l doctor --json` through `runProcess` and returns its parsed
 * checks. Module-private — {@link createM3LMcpCliSurface} is the public
 * entry point.
 */
async function invokeDoctor(
  settings: M3LMcpSettings,
  runProcess: (options: RunCliProcessOptions) => Promise<CliRunResult>,
): Promise<readonly M3LMcpDoctorCheck[]> {
  let result: CliRunResult;
  try {
    result = await runProcess({
      nodeExecPath: settings.nodeExecPath,
      entrypoint: settings.cliEntrypoint,
      args: buildArgv({ method: "doctor" }),
      cwd: settings.cwd,
      timeoutMs: settings.cliTimeoutMs,
      maxOutputBytes: settings.maxOutputBytes,
    });
  } catch (cause) {
    throw new M3LMcpError("ERR_MCP_CLI", RUN_PROCESS_REJECTED, { cause });
  }

  assertExited(result);
  assertDoctorExitCode(result.exitCode);
  return parseDoctorOutput(result.stdout);
}

/**
 * The typed `m3l` CLI methods this package's tools call through. One method
 * per subcommand this slice supports; V10f/V10g grow this interface
 * alongside {@link CliMethodRequest}.
 *
 * @example
 * ```ts
 * import type { M3LMcpCliSurface } from "./surface.js";
 *
 * async function summarize(surface: M3LMcpCliSurface): Promise<number> {
 *   const checks = await surface.doctor();
 *   return checks.filter((check) => check.status === "fail").length;
 * }
 * ```
 */
export interface M3LMcpCliSurface {
  /**
   * Runs `m3l doctor --json` and returns its parsed checks. Resolves for
   * both exit `0` and exit `1` — a failing health check is a normal
   * result, not a rejection. Rejects with {@link M3LMcpError}
   * (`ERR_MCP_CLI`) for any other exit code, a non-`"exited"` disposition,
   * unparseable output, or a `runProcess` seam that itself rejects (the
   * rejected value is contained and chained as `cause`, never surfaced in
   * the fixed `message`).
   */
  doctor(): Promise<readonly M3LMcpDoctorCheck[]>;
}

/**
 * Dependencies for {@link createM3LMcpCliSurface}.
 */
export interface CreateM3LMcpCliSurfaceDeps {
  /** This package's resolved boot configuration. */
  readonly settings: M3LMcpSettings;
  /**
   * The CLI-invocation seam. Defaults to the real `runCliProcess`, which
   * spawns an actual `m3l` child process — every test supplies a fake here
   * instead. Optional, matching this package's own `cli/process.ts` `spawn?`
   * seam and the house pattern elsewhere in the fleet. A rejecting
   * implementation is contained, not propagated: `invokeDoctor` catches it
   * and raises {@link M3LMcpError} (`ERR_MCP_CLI`) with the rejected value
   * chained as `cause`.
   */
  readonly runProcess?: (
    options: RunCliProcessOptions,
  ) => Promise<CliRunResult>;
}

/**
 * Builds an {@link M3LMcpCliSurface} bound to `deps.settings`, invoking the
 * `m3l` CLI through `deps.runProcess` (default: the real `runCliProcess`).
 *
 * @param deps - See {@link CreateM3LMcpCliSurfaceDeps}.
 * @returns A surface exposing one typed method per supported `m3l`
 *   subcommand.
 *
 * @example
 * ```ts
 * import { createM3LMcpCliSurface } from "./surface.js";
 * import { loadM3LMcpSettings } from "../config/settings.js";
 *
 * const surface = createM3LMcpCliSurface({ settings: loadM3LMcpSettings() });
 * const checks = await surface.doctor();
 * ```
 */
export function createM3LMcpCliSurface(
  deps: CreateM3LMcpCliSurfaceDeps,
): M3LMcpCliSurface {
  const runProcess = deps.runProcess ?? runCliProcess;
  return {
    doctor: () => invokeDoctor(deps.settings, runProcess),
  };
}
