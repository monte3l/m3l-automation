/**
 * `commands/flow` — `m3l flow list` and `m3l flow run <name>` (U10): the thin
 * wiring between the flow engine's modules and the shared command context.
 *
 * ```
 * m3l flow list                             # the available flow names
 * m3l flow run <name> [--dry-run] [--json]  # execute a named flow
 * ```
 *
 * Deliberately thin. Every decision lives one module down — `flow/load`
 * validates, `flow/run` branches, `flow/record` hashes and persists,
 * `flow/envelope` and `flow/render` format — so this module only orders those
 * calls and maps their results onto the writer facade and an exit code.
 *
 * **No `--resume` in U10.** `runFlow` already accepts `resumeFromStepId`, but
 * nothing here may pass it, and `--resume` is REJECTED rather than silently
 * ignored: a user who typed it would otherwise get a full re-run from step one
 * while believing they had resumed.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import type { M3LCliCommandContext } from "./context.js";
import { JSON_FLAG } from "../cli/flags.js";
import { discoverScripts } from "../discovery/discover.js";
import type { M3LCliScriptCandidate } from "../discovery/discover.js";
import { loadParametersCached } from "../discovery/cached-load.js";
import { buildFlowEnvelope, formatFlowEnvelope } from "../flow/envelope.js";
import { listFlows, loadFlowDefinition } from "../flow/load.js";
import { buildFlowRunRecord, writeFlowRunRecord } from "../flow/record.js";
import { formatFlowListLines, formatFlowRunLines } from "../flow/render.js";
import { runFlow } from "../flow/run.js";
import type { M3LCliFlowRunResult } from "../flow/run.js";
import type { M3LCliFlowDefinition } from "../flow/types.js";
import type { M3LCliFlowValidationParameter } from "../flow/validate.js";

/** Exit code for a usage error, mirroring `main.ts`'s own constant. */
const USAGE_EXIT_CODE = 2;

/** The flow-level dry-run flag every fleet script also accepts (ADR-0022). */
const DRY_RUN_FLAG = "--dry-run";

/**
 * The flag U11 will own. Named here only so U10 can REFUSE it: `runFlow`'s
 * resume seam exists already, so a silently-ignored `--resume` would re-run a
 * flow from its first step while the operator believed it had resumed.
 */
const RESUME_FLAG = "--resume";

/** The two subcommands `m3l flow` dispatches. */
const SUBCOMMANDS: readonly string[] = ["list", "run"];

/** The directory, under the discovery cache's own directory, run records live in. */
const FLOW_RECORD_DIRECTORY = "flows";

/**
 * What {@link parseFlowArgs} resolved from the raw argument slice: the
 * positionals with every flag-shaped token removed, plus the two flags this
 * command recognizes.
 */
interface ParsedFlowArgs {
  /** Every non-flag token, in order: the subcommand, then the flow name. */
  readonly positionals: readonly string[];
  /** Whether `--dry-run` was given. */
  readonly dryRun: boolean;
  /** Whether `--json` was given. */
  readonly json: boolean;
}

/**
 * Reduces a token to the flag name it carries, so `--resume=dump` is
 * recognized as `--resume` rather than as an unknown flag of its own.
 *
 * @param token - One raw argument token starting with `-`.
 * @returns The flag name, without any `=<value>` suffix.
 */
function flagName(token: string): string {
  const separatorIndex = token.indexOf("=");
  return separatorIndex === -1 ? token : token.slice(0, separatorIndex);
}

/**
 * Splits the raw argument slice into positionals and recognized flags.
 *
 * Positionals are resolved by SKIPPING flag-shaped tokens rather than by
 * position, so `run x --dry-run --json`, `--json run --dry-run x` and
 * `run --json x --dry-run` all resolve the same subcommand and name. `--json`
 * reaches this command unstripped (`main.ts` bypasses
 * `parseStaticCommandArgs` for `flow`, exactly as it does for
 * `new`/`completion`), so it must be TOLERATED here, never treated as
 * unknown.
 *
 * @param rawArgs - The raw post-command argument slice.
 * @returns The parsed positionals and flags, or the offending flag name when
 *   an unrecognized flag was given.
 */
function parseFlowArgs(
  rawArgs: readonly string[],
): ParsedFlowArgs | { readonly unknownFlag: string } {
  const positionals: string[] = [];
  let dryRun = false;
  let json = false;

  for (const token of rawArgs) {
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const name = flagName(token);
    if (name === DRY_RUN_FLAG) {
      dryRun = true;
    } else if (name === JSON_FLAG) {
      json = true;
    } else {
      return { unknownFlag: name };
    }
  }
  return { positionals, dryRun, json };
}

/**
 * Narrows a parse result to its failure arm.
 *
 * @param parsed - What {@link parseFlowArgs} returned.
 * @returns Whether it is the unknown-flag arm.
 */
function isUnknownFlag(
  parsed: ParsedFlowArgs | { readonly unknownFlag: string },
): parsed is { readonly unknownFlag: string } {
  return "unknownFlag" in parsed;
}

/**
 * Reports an unrecognized flag as a usage error, naming `--resume`
 * specifically so a user who reached for it learns it is not yet a thing
 * rather than merely that it is unknown.
 *
 * @param context - The command context, for the writer facade.
 * @param flag - The offending flag name.
 * @returns The usage exit code.
 */
function reportUnknownFlag(
  context: M3LCliCommandContext,
  flag: string,
): number {
  context.output.error(
    flag === RESUME_FLAG
      ? `m3l flow does not accept ${RESUME_FLAG} yet — resuming a flow run is not part of this release`
      : `unknown flag '${flag}' — m3l flow run accepts ${DRY_RUN_FLAG} and ${JSON_FLAG}`,
  );
  return USAGE_EXIT_CODE;
}

/**
 * Builds the validation context `flow/load` needs: every discovered script
 * name mapped to the parameters it declares.
 *
 * The descriptors are handed through WHOLE, never projected down to names: the
 * validator's ADR-0085 secret screen can only fire on a parameter whose
 * `secret` flag survived the trip, and the projection that discarded it is
 * what let a secret-valued `parameters` key reach a child's argv.
 *
 * A script whose config will not load degrades to an EMPTY parameter list and
 * keeps its name in the map, with the reason reported on stderr — the same
 * tolerance `commands/completion.ts` and `commands/list.ts` give an unloadable
 * script. Dropping the name instead would make the flow fail validation for
 * naming a script that genuinely exists, so one broken unrelated script would
 * block every flow. The reason is recorded, never swallowed.
 *
 * @param context - The command context.
 * @param candidates - The discovered scripts.
 * @returns Declared parameters by script name.
 */
async function buildParametersByScript(
  context: M3LCliCommandContext,
  candidates: readonly M3LCliScriptCandidate[],
): Promise<ReadonlyMap<string, readonly M3LCliFlowValidationParameter[]>> {
  const parametersByScript = new Map<
    string,
    readonly M3LCliFlowValidationParameter[]
  >();
  for (const candidate of candidates) {
    try {
      const parameters = await loadParametersCached(
        candidate.name,
        candidate.directory,
        context.cacheFilePath,
      );
      parametersByScript.set(candidate.name, parameters);
    } catch (error) {
      context.output.error(
        `could not read script '${candidate.name}' parameters — treating it as declaring none: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      parametersByScript.set(candidate.name, []);
    }
  }
  return parametersByScript;
}

/**
 * Runs `m3l flow list`.
 *
 * Never loads a definition, only names them: one malformed flow file must not
 * make the rest of the set unlistable. A `listFlows` failure (an unreadable
 * flows directory, say) propagates instead — reporting an empty flow set for a
 * directory that could not be read would be a lie.
 *
 * @param context - The command context.
 * @param json - Whether to emit the machine-readable form.
 * @returns `0`.
 * @throws Whatever `listFlows` throws, unchanged.
 */
function runFlowList(context: M3LCliCommandContext, json: boolean): number {
  const flowNames = listFlows(context.workspaceRoot);
  if (json) {
    context.output.info(JSON.stringify(flowNames));
    return 0;
  }
  context.output.heading("Flows");
  for (const line of formatFlowListLines(flowNames)) {
    context.output.info(line);
  }
  return 0;
}

/**
 * Emits a finished run — the single `--json` envelope line, or the human
 * rendering under its heading.
 *
 * Called BEFORE the record is persisted, on purpose: a record-write failure
 * throws, and the operator should still have the full result on stdout when it
 * does.
 *
 * @param context - The command context.
 * @param runId - The run's own id, shared with its record.
 * @param definition - The definition that ran, for its guard value.
 * @param result - What `flow/run` reported.
 * @param definitionHash - The built record's hash, reused rather than
 *   recomputed so the envelope and the ledger can never name different
 *   definitions.
 * @param dryRun - Whether the run was a dry run.
 * @param json - Whether to emit the machine-readable form.
 */
function emitFlowRun(
  context: M3LCliCommandContext,
  runId: string,
  definition: M3LCliFlowDefinition,
  result: M3LCliFlowRunResult,
  definitionHash: string,
  dryRun: boolean,
  json: boolean,
): void {
  if (json) {
    context.output.info(
      formatFlowEnvelope(
        buildFlowEnvelope({ runId, definitionHash, dryRun, result }),
      ),
    );
    return;
  }
  context.output.heading("Flow run");
  for (const line of formatFlowRunLines({
    runId,
    dryRun,
    maxStepExecutions: definition.maxStepExecutions,
    result,
  })) {
    context.output.info(line);
  }
}

/**
 * Runs `m3l flow run <name>`.
 *
 * **Ordering.** Discovery and the cached parameter load build the validation
 * context, `loadFlowDefinition` validates, `runFlow` executes,
 * `buildFlowRunRecord` assembles the ledger, the result is EMITTED, and only
 * then is the ledger written. Nothing here recomputes the definition hash the
 * record already carries.
 *
 * The record write is not wrapped: `ERR_CLI_FLOW_RECORD_WRITE_FAILED`
 * propagates and DOES change the resolved exit code, the exact inverse of
 * `history/store.ts`'s best-effort entry. A run whose resume ledger failed to
 * write cannot be resumed, so reporting the flow's own exit code as if
 * everything had gone fine would leave the operator with a run they cannot
 * continue and no signal that anything went wrong.
 *
 * @param context - The command context.
 * @param name - The flow to run.
 * @param dryRun - Whether to run every step in dry-run mode.
 * @param json - Whether to emit the machine-readable form.
 * @returns The flow's own exit code, verbatim.
 * @throws Whatever `loadFlowDefinition`, `runFlow` or `writeFlowRunRecord`
 *   throws, unchanged — each is already a typed {@link M3LCliError}.
 */
async function runNamedFlow(
  context: M3LCliCommandContext,
  name: string,
  dryRun: boolean,
  json: boolean,
): Promise<number> {
  const candidates = discoverScripts(context.workspaceRoot);
  const definition = loadFlowDefinition(context.workspaceRoot, name, {
    parametersByScript: await buildParametersByScript(context, candidates),
  });

  const runId = randomUUID();
  const result = await runFlow(
    {
      output: context.output,
      outputDirPath: context.outputDirPath,
      scriptDirectories: new Map(
        candidates.map((candidate) => [candidate.name, candidate.directory]),
      ),
      // Forwarded verbatim (ADR-0085): a spawned step's child must inherit the
      // same environment, and load the same env file, a hand-typed
      // `m3l <script>` invocation would.
      env: context.env,
      envFile: context.envFile,
      // So a spawned step's child stdout is kept off the parent's when THIS
      // flow run is emitting a `--json` envelope of its own.
      jsonOutput: json,
    },
    definition,
    { dryRun },
  );

  const record = buildFlowRunRecord({ runId, definition, result });
  emitFlowRun(
    context,
    runId,
    definition,
    result,
    record.definitionHash,
    dryRun,
    json,
  );

  writeFlowRunRecord(
    join(
      dirname(context.cacheFilePath),
      FLOW_RECORD_DIRECTORY,
      `${definition.name}.json`,
    ),
    record,
  );
  return result.exitCode;
}

/**
 * Runs `m3l flow`.
 *
 * Named `runFlowCommand` rather than `runFlow` because `flow/run.ts` already
 * exports `runFlow` — the engine's step loop — and a consumer importing both
 * must be able to tell them apart.
 *
 * @param context - The command context to run against.
 * @param rawArgs - The raw post-command argument slice (`m3l flow`'s own
 *   arguments, `--json` included).
 * @returns The flow's own exit code, verbatim (`4` stays `4`, `137` stays
 *   `137`), `0` for `flow list`, or `2` for a usage error.
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_FLOW` or
 *   `ERR_CLI_FLOW_INVALID` from validation, `ERR_CLI_FLOW_RECORD_WRITE_FAILED`
 *   when the resume ledger cannot be written, and whatever a step execution
 *   throws — each unchanged.
 *
 * @example
 * ```ts
 * const exitCode = await runFlowCommand(context, ["run", "dlq-reconcile"]);
 * ```
 */
export async function runFlowCommand(
  context: M3LCliCommandContext,
  rawArgs: readonly string[],
): Promise<number> {
  const parsed = parseFlowArgs(rawArgs);
  if (isUnknownFlag(parsed)) {
    return reportUnknownFlag(context, parsed.unknownFlag);
  }
  const json = parsed.json || context.jsonOutput;

  const [subcommand, name] = parsed.positionals;
  if (subcommand === undefined || !SUBCOMMANDS.includes(subcommand)) {
    context.output.error(
      subcommand === undefined
        ? `m3l flow requires a subcommand — usage: m3l flow ${SUBCOMMANDS.join("|")}`
        : `unknown m3l flow subcommand '${subcommand}' — expected ${SUBCOMMANDS.join(" or ")}`,
    );
    return USAGE_EXIT_CODE;
  }
  if (subcommand === "list") {
    return runFlowList(context, json);
  }
  if (name === undefined) {
    context.output.error(
      `m3l flow run requires a <name> positional — usage: m3l flow run <name> [${DRY_RUN_FLAG}] [${JSON_FLAG}]`,
    );
    return USAGE_EXIT_CODE;
  }
  return runNamedFlow(context, name, parsed.dryRun, json);
}
