/**
 * `lib/cli-surface` — the typed adapter over `lib/cli-process.ts`. This is
 * the **only** consumer of `runCliProcess`; it owns the argv table, the
 * per-method exit-code acceptance policy, and all error minting for the four
 * agent-facing CLI operations (`list`, `doctor`, `inspect`, `dryRun`).
 *
 * Argument-injection defence, layered in the order each layer is applied:
 *
 * 1. `shell: false` plus an argv array (`lib/cli-process.ts`) — with no
 *    shell, there is no command line for a value to inject into.
 * 2. `lib/cli-names.ts`'s anchored, ReDoS-safe
 *    `AGENT_OPERATOR_SCRIPT_NAME_RE` — a name cannot begin with `-` and
 *    admits no shell metacharacter.
 * 3. Membership in the fleet's `m3l list` set (enforced by the real CLI
 *    rejecting an unknown script) / the caller-supplied `dryRunAllowlist`
 *    (enforced here, before `dryRun` ever spawns).
 * 4. The V6 policy gate (a later slice — not yet implemented).
 * 5. Fixed argv positions built here from a closed `switch` over a
 *    discriminated `CliOperation` union — never string concatenation.
 *
 * Net effect: the model supplies exactly one value across the whole tool
 * surface — a script name.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import {
  parseDoctorChecks,
  parseJsonText,
  parseListRows,
  parseParamDescriptors,
  parseRunEnvelope,
  type AgentOperatorDoctorCheck,
  type AgentOperatorListRow,
  type AgentOperatorParamDescriptor,
  type AgentOperatorRunEnvelope,
  type ParseResult,
} from "./cli-envelopes.js";
import {
  assertAllowedScriptName,
  type AgentOperatorScriptName,
} from "./cli-names.js";
import {
  runCliProcess,
  type CliRunDisposition,
  type CliRunResult,
} from "./cli-process.js";
import { M3LAgentOperatorCliError } from "./errors.js";
import {
  projectDoctorReport,
  projectListRow,
  projectParamDescriptor,
  projectRunEnvelope,
  type AgentOperatorProjectedDoctorReport,
  type AgentOperatorProjectedListRow,
  type AgentOperatorProjectedParamDescriptor,
  type AgentOperatorProjectedRunEnvelope,
  type AgentOperatorProjectionOptions,
} from "./model-safety.js";

// ---------------------------------------------------------------------------
// Fixed, non-interpolated model-facing rejection messages. Every reachable
// rejection this module raises uses exactly one of these three — never a
// script name, raw stdout, a filesystem path, or a spawn `error.message`.
// ---------------------------------------------------------------------------

const SCRIPT_NAME_REJECTION_MESSAGE =
  "the script name did not pass this tool's allowed-name check";
const CLI_SPAWN_REJECTION_MESSAGE =
  "the CLI process could not be run to completion";
const CLI_OUTPUT_REJECTION_MESSAGE =
  "the CLI exited with an unacceptable status or produced output that could not be parsed";

/**
 * The typed, model-safe adapter over the `m3l` CLI. Every method spawns the
 * CLI at most once, applies this method's exit-code acceptance policy, and
 * returns the parsed output already passed through `lib/model-safety.ts`'s
 * projections — never the raw parsed value.
 */
export interface AgentCliSurface {
  /** Runs `m3l list --json`. Only exit `0` is acceptable. */
  list(): Promise<readonly AgentOperatorProjectedListRow[]>;
  /**
   * Runs `m3l doctor --json`. Exit `{0, 1}` are both acceptable — a failing
   * health check is the answer, not an error, so `doctor --json` exiting `1`
   * must not reject this promise.
   */
  doctor(): Promise<AgentOperatorProjectedDoctorReport>;
  /**
   * Runs `m3l inspect <name> --json`. `name` is validated against the
   * allowlist before anything is spawned. Only exit `0` is acceptable.
   */
  inspect(
    scriptName: string,
  ): Promise<readonly AgentOperatorProjectedParamDescriptor[]>;
  /**
   * Runs `m3l run <name> --json -- --dry-run`. `name` must pass the
   * allowlist AND be a member of the caller-supplied `dryRunAllowlist`
   * before anything is spawned. Any exit code is acceptable — the envelope
   * carries its own `exitCode`/`outcome`.
   */
  dryRun(scriptName: string): Promise<AgentOperatorProjectedRunEnvelope>;
}

/** Constructor options for {@link createAgentCliSurface}. */
export interface CreateAgentCliSurfaceOptions {
  /** Absolute path to the `m3l` CLI entrypoint (`packages/m3l-cli/bin/m3l.mjs`). */
  readonly entrypoint: string;
  /** Working directory for the spawned CLI process. */
  readonly cwd: string;
  /** Absolute path to the Node executable to spawn. */
  readonly nodeExecPath: string;
  /** Timeout applied to `list`/`doctor`/`inspect`. */
  readonly cliTimeoutMs: number;
  /** Timeout applied to `dryRun` (a real script's config load can be slower). */
  readonly dryRunTimeoutMs: number;
  /** Per-stream byte cap forwarded to `runCliProcess`. */
  readonly maxOutputBytes: number;
  /**
   * The closed set of script names `dryRun` may target. `--dry-run` is a
   * per-script convention (each script opts in via
   * `process.argv.includes("--dry-run")`), not a CLI contract, so this
   * allowlist — not the name regex alone — is what keeps the tool honestly
   * read-only.
   */
  readonly dryRunAllowlist: ReadonlySet<string>;
  /**
   * The absolute host workspace-root path, forwarded into every `project*`
   * call as `AgentOperatorProjectionOptions.workspaceRoot` so
   * `model-safety.ts`'s scrub actually runs against production CLI output
   * (`doctor`'s `workspace-root` check, `inspect`'s `description`/
   * `defaultValue`, `dryRun`'s echoed `script`) — otherwise the absolute host
   * path reaches the model unmasked. Optional: omitting it disables the
   * scrub without failing any method.
   */
  readonly workspaceRoot?: string;
  /** Optional cooperative-cancellation signal, forwarded to every spawn. */
  readonly signal?: AbortSignal;
  /** Test injection seam; defaults to the real `runCliProcess`. */
  readonly runProcess?: typeof runCliProcess;
}

/** The resolved, method-independent context every CLI invocation shares. */
interface SurfaceRunContext {
  readonly entrypoint: string;
  readonly cwd: string;
  readonly nodeExecPath: string;
  readonly maxOutputBytes: number;
  readonly workspaceRoot: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly runProcess: typeof runCliProcess;
}

/**
 * Builds the {@link AgentOperatorProjectionOptions} forwarded to every
 * `project*` call: `workspaceRoot` when the surface was constructed with
 * one, and `secrets` when the caller (currently only `runInspect`) supplies
 * declared secret parameter names. Built via conditional spread — never an
 * explicit `undefined` — so `exactOptionalPropertyTypes` sees a genuinely
 * absent property rather than a present-but-`undefined` one.
 */
function buildProjectionOptions(
  workspaceRoot: string | undefined,
  secrets?: readonly string[],
): AgentOperatorProjectionOptions {
  return {
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(secrets === undefined ? {} : { secrets }),
  };
}

/** One method's fixed argv, timeout, exit-code policy, and output parser. */
interface CliInvocationSpec<T> {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly isAcceptableExitCode: (exitCode: number | null) => boolean;
  readonly parse: (raw: unknown) => ParseResult<T>;
}

/**
 * The argv table — a closed, discriminated union over the four operations.
 * `scriptName` is typed as the branded {@link AgentOperatorScriptName}
 * (never bare `string`), so `buildArgv` structurally cannot be called with a
 * name that has not already passed {@link assertAllowedScriptName} — the
 * brand protects this internal path from the boundary inward; it does not
 * push validation onto the surface's public callers, which still pass raw
 * `string`.
 */
type CliOperation =
  | { readonly method: "list" }
  | { readonly method: "doctor" }
  | { readonly method: "inspect"; readonly scriptName: AgentOperatorScriptName }
  | { readonly method: "dryRun"; readonly scriptName: AgentOperatorScriptName };

/**
 * Builds one operation's fixed argv from a closed `switch`, at fixed
 * positions — never by string concatenation or templating a caller value
 * into a larger string.
 */
function buildArgv(operation: CliOperation): readonly string[] {
  switch (operation.method) {
    case "list":
      return ["list", "--json"];
    case "doctor":
      return ["doctor", "--json"];
    case "inspect":
      return ["inspect", operation.scriptName, "--json"];
    case "dryRun":
      // `splitAtFirstDoubleDash` (packages/m3l-cli/src/main.ts) runs before
      // `partitionJsonFlag`, so `--json` must precede the bare `--` to be
      // stripped by the CLI's own flag partitioning, and `--dry-run` must
      // follow the `--` to be forwarded verbatim to the child script.
      return ["run", operation.scriptName, "--json", "--", "--dry-run"];
    default: {
      const exhaustive: never = operation;
      throw new M3LAgentOperatorCliError(
        CLI_SPAWN_REJECTION_MESSAGE,
        "ERR_AGENT_OPERATOR_CLI_SPAWN",
        { context: { unexpectedOperation: exhaustive } },
      );
    }
  }
}

/**
 * Validates a caller-supplied script name against the allowlist, remapping
 * any rejection to the fixed {@link SCRIPT_NAME_REJECTION_MESSAGE} — the
 * original allowlist message is preserved as `cause` for diagnostics, but
 * never surfaced to the model, which is this boundary's whole purpose.
 */
function assertUsableScriptName(scriptName: string): AgentOperatorScriptName {
  try {
    return assertAllowedScriptName(scriptName);
  } catch (cause) {
    throw new M3LAgentOperatorCliError(
      SCRIPT_NAME_REJECTION_MESSAGE,
      "ERR_AGENT_OPERATOR_SCRIPT_NAME",
      { cause },
    );
  }
}

/**
 * Validates a caller-supplied script name for `dryRun`: it must pass the
 * allowlist AND be a member of `dryRunAllowlist`. Both failure modes surface
 * the same fixed message and code — the model cannot distinguish "not a
 * valid name" from "a valid name this tool won't dry-run".
 */
function assertDryRunEligible(
  scriptName: string,
  dryRunAllowlist: ReadonlySet<string>,
): AgentOperatorScriptName {
  const name = assertUsableScriptName(scriptName);
  if (!dryRunAllowlist.has(name)) {
    throw new M3LAgentOperatorCliError(
      SCRIPT_NAME_REJECTION_MESSAGE,
      "ERR_AGENT_OPERATOR_SCRIPT_NAME",
    );
  }
  return name;
}

/** Parses raw stdout text through `parseJsonText` then the method's own parser. */
function parseCliOutput<T>(
  stdout: string,
  parse: (raw: unknown) => ParseResult<T>,
): ParseResult<T> {
  const json = parseJsonText(stdout);
  if (!json.ok) return json;
  return parse(json.value);
}

/**
 * Mints an `ERR_AGENT_OPERATOR_CLI_OUTPUT` error. `context` carries only
 * structured, non-sensitive fields (a parse-failure reason, an exit code) —
 * never raw stdout/stderr, which could otherwise leak a rejected script's
 * arbitrary output text into an error a model reads.
 */
function buildOutputError(
  context: Record<string, unknown>,
): M3LAgentOperatorCliError {
  return new M3LAgentOperatorCliError(
    CLI_OUTPUT_REJECTION_MESSAGE,
    "ERR_AGENT_OPERATOR_CLI_OUTPUT",
    { context },
  );
}

/**
 * Mints an `ERR_AGENT_OPERATOR_CLI_SPAWN` error. `failureCode` is included in
 * `context` only when present — never a spawn `error.message`, which can
 * embed a resolved absolute path.
 */
function buildSpawnError(
  failureCode: string | undefined,
): M3LAgentOperatorCliError {
  const context: Record<string, unknown> =
    failureCode === undefined ? {} : { failureCode };
  return new M3LAgentOperatorCliError(
    CLI_SPAWN_REJECTION_MESSAGE,
    "ERR_AGENT_OPERATOR_CLI_SPAWN",
    { context },
  );
}

/** Resolves an `"exited"` disposition: exit-code policy, then output parsing. */
function resolveExited<T>(
  exitCode: number | null,
  stdout: string,
  spec: CliInvocationSpec<T>,
): T {
  if (!spec.isAcceptableExitCode(exitCode)) {
    throw buildOutputError({ reason: "unacceptable-exit-code", exitCode });
  }
  const parsed = parseCliOutput(stdout, spec.parse);
  if (!parsed.ok) {
    throw buildOutputError({ reason: parsed.reason });
  }
  return parsed.value;
}

/**
 * Classifies a settled `CliRunResult` via an exhaustive `switch` over its
 * disposition. `"aborted"` throws `Core.M3LOperationAbortedError` — never a
 * script-local code — so ADR-0049's `deriveCommandOutcome` maps it to exit 5
 * the same way whether the abort happened in-process or on this spawn path.
 */
function resolveCliRunResult<T>(
  result: CliRunResult,
  spec: CliInvocationSpec<T>,
): T {
  const disposition: CliRunDisposition = result.disposition;
  switch (disposition) {
    case "exited":
      return resolveExited(result.exitCode, result.stdout, spec);
    case "aborted":
      throw new Core.M3LOperationAbortedError();
    case "spawn-failed":
    case "timed-out":
    case "signalled":
    case "output-truncated":
      throw buildSpawnError(result.failureCode);
    default: {
      const exhaustive: never = disposition;
      throw new M3LAgentOperatorCliError(
        CLI_SPAWN_REJECTION_MESSAGE,
        "ERR_AGENT_OPERATOR_CLI_SPAWN",
        { context: { unexpectedDisposition: exhaustive } },
      );
    }
  }
}

/** Runs one CLI invocation end to end: spawn, then classify the result. */
async function runCliInvocation<T>(
  ctx: SurfaceRunContext,
  spec: CliInvocationSpec<T>,
): Promise<T> {
  const result = await ctx.runProcess({
    nodeExecPath: ctx.nodeExecPath,
    entrypoint: ctx.entrypoint,
    args: spec.args,
    cwd: ctx.cwd,
    timeoutMs: spec.timeoutMs,
    maxOutputBytes: ctx.maxOutputBytes,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  return resolveCliRunResult(result, spec);
}

/** `list()` — the `{0}`-only exit policy. */
async function runList(
  ctx: SurfaceRunContext,
  timeoutMs: number,
): Promise<readonly AgentOperatorProjectedListRow[]> {
  const rows = await runCliInvocation<readonly AgentOperatorListRow[]>(ctx, {
    args: buildArgv({ method: "list" }),
    timeoutMs,
    isAcceptableExitCode: (exitCode) => exitCode === 0,
    parse: parseListRows,
  });
  const opts = buildProjectionOptions(ctx.workspaceRoot);
  return rows.map((row) => projectListRow(row, opts));
}

/**
 * `doctor()` — the `{0, 1}` exit policy. This asymmetry with `list`/`inspect`
 * is deliberate: a failing health check is the answer this tool exists to
 * report, not a failure of the tool itself, so `doctor --json` exiting `1`
 * (its documented behaviour when any check fails) must resolve, not reject.
 */
async function runDoctor(
  ctx: SurfaceRunContext,
  timeoutMs: number,
): Promise<AgentOperatorProjectedDoctorReport> {
  const checks = await runCliInvocation<readonly AgentOperatorDoctorCheck[]>(
    ctx,
    {
      args: buildArgv({ method: "doctor" }),
      timeoutMs,
      isAcceptableExitCode: (exitCode) => exitCode === 0 || exitCode === 1,
      parse: parseDoctorChecks,
    },
  );
  return projectDoctorReport(checks, buildProjectionOptions(ctx.workspaceRoot));
}

/** `inspect(scriptName)` — allowlist first, then the `{0}`-only exit policy. */
async function runInspect(
  ctx: SurfaceRunContext,
  timeoutMs: number,
  scriptName: string,
): Promise<readonly AgentOperatorProjectedParamDescriptor[]> {
  const name = assertUsableScriptName(scriptName);
  const descriptors = await runCliInvocation<
    readonly AgentOperatorParamDescriptor[]
  >(ctx, {
    args: buildArgv({ method: "inspect", scriptName: name }),
    timeoutMs,
    isAcceptableExitCode: (exitCode) => exitCode === 0,
    parse: parseParamDescriptors,
  });
  // `inspect` already knows which parameter names this script declares
  // `secret: true` — thread them into the redactor's `secrets` widening
  // (S2) so a secret-flagged parameter's description/default is redacted
  // even when it embeds a value the library's default denylist can't see.
  const secretNames = descriptors
    .filter((descriptor) => descriptor.secret)
    .map((descriptor) => descriptor.name);
  const opts = buildProjectionOptions(ctx.workspaceRoot, secretNames);
  return descriptors.map((descriptor) =>
    projectParamDescriptor(descriptor, opts),
  );
}

/**
 * `dryRun(scriptName)` — allowlist AND `dryRunAllowlist` membership first,
 * then any exit code is acceptable (the envelope carries its own outcome).
 */
async function runDryRun(
  ctx: SurfaceRunContext,
  timeoutMs: number,
  scriptName: string,
  dryRunAllowlist: ReadonlySet<string>,
): Promise<AgentOperatorProjectedRunEnvelope> {
  const name = assertDryRunEligible(scriptName, dryRunAllowlist);
  const envelope = await runCliInvocation<AgentOperatorRunEnvelope>(ctx, {
    args: buildArgv({ method: "dryRun", scriptName: name }),
    timeoutMs,
    isAcceptableExitCode: () => true,
    parse: parseRunEnvelope,
  });
  return projectRunEnvelope(
    envelope,
    buildProjectionOptions(ctx.workspaceRoot),
  );
}

/**
 * Creates the typed, model-safe {@link AgentCliSurface} adapter over the
 * `m3l` CLI. Every method validates its script-name argument (and, for
 * `dryRun`, the `dryRunAllowlist`) BEFORE building argv or spawning anything
 * — a rejected call never reaches `runCliProcess`.
 *
 * @param deps - Spawn configuration, timeouts, the `dryRunAllowlist`, and an
 *   optional `runProcess` test seam.
 * @returns The four-method {@link AgentCliSurface}.
 * @example
 * ```ts
 * import { createAgentCliSurface } from "./cli-surface.js";
 *
 * const surface = createAgentCliSurface({
 *   entrypoint: "/repo/packages/m3l-cli/bin/m3l.mjs",
 *   cwd: "/repo",
 *   nodeExecPath: process.execPath,
 *   cliTimeoutMs: 30_000,
 *   dryRunTimeoutMs: 120_000,
 *   maxOutputBytes: 1_048_576,
 *   dryRunAllowlist: new Set(["json-etl"]),
 * });
 *
 * const rows = await surface.list();
 * ```
 */
export function createAgentCliSurface(
  deps: CreateAgentCliSurfaceOptions,
): AgentCliSurface {
  const ctx: SurfaceRunContext = {
    entrypoint: deps.entrypoint,
    cwd: deps.cwd,
    nodeExecPath: deps.nodeExecPath,
    maxOutputBytes: deps.maxOutputBytes,
    workspaceRoot: deps.workspaceRoot,
    signal: deps.signal,
    runProcess: deps.runProcess ?? runCliProcess,
  };

  return {
    list: () => runList(ctx, deps.cliTimeoutMs),
    doctor: () => runDoctor(ctx, deps.cliTimeoutMs),
    inspect: (scriptName) => runInspect(ctx, deps.cliTimeoutMs, scriptName),
    dryRun: (scriptName) =>
      runDryRun(ctx, deps.dryRunTimeoutMs, scriptName, deps.dryRunAllowlist),
  };
}
