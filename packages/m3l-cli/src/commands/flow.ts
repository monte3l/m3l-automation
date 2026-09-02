/**
 * `commands/flow` — `m3l flow list` and `m3l flow run <name>` (U11): the thin
 * wiring between the flow engine's modules and the shared command context.
 *
 * ```
 * m3l flow list                                       # the available flow names
 * m3l flow run <name> [--dry-run] [--json] [--resume] # execute a named flow
 * ```
 *
 * Deliberately thin. Every decision lives one module down — `flow/load`
 * validates, `flow/run` branches, `flow/record` hashes and persists,
 * `flow/envelope` and `flow/render` format — so this module only orders those
 * calls and maps their results onto the writer facade and an exit code.
 *
 * **`--resume` (U11).** `runFlow` accepts `resumeFromStepId` and
 * `stepExecutionCount`; this module reads the saved run record and forwards
 * those values when the flag is present. The three resume preconditions —
 * record existence, non-null `resumeStepId`, and definition hash match — are
 * enforced by `flow/record`'s `validateResumeRecord`, which throws
 * `ERR_CLI_FLOW_RESUME_REFUSED` with a distinguishable message for each.
 *
 * **Every extra argument is REJECTED, never dropped.** `--dry-run=false` and
 * `--json=false` do not disable the flag they name — a value-bearing form of
 * either boolean flag is a usage error — and a surplus positional
 * (`flow run a b`, `flow list extra`) is a usage error too. Silently ignoring
 * either would make a misunderstood invocation look like it worked.
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
import {
  buildFlowRunRecord,
  readFlowRunRecord,
  validateResumeRecord,
  writeFlowRunRecord,
} from "../flow/record.js";
import { formatFlowListLines, formatFlowRunLines } from "../flow/render.js";
import { runFlow } from "../flow/run.js";
import type { M3LCliFlowRunResult } from "../flow/run.js";
import type { M3LCliFlowDefinition } from "../flow/types.js";
import type { M3LCliFlowValidationParameter } from "../flow/validate.js";

/** Exit code for a usage error, mirroring `main.ts`'s own constant. */
const USAGE_EXIT_CODE = 2;

/** The flow-level dry-run flag every fleet script also accepts (ADR-0022). */
const DRY_RUN_FLAG = "--dry-run";

/** The resume flag activated in U11: resumes from the last saved step. */
const RESUME_FLAG = "--resume";

/** The two subcommands `m3l flow` dispatches. */
const SUBCOMMANDS: readonly string[] = ["list", "run"];

/** The directory, under the discovery cache's own directory, run records live in. */
const FLOW_RECORD_DIRECTORY = "flows";

/**
 * What {@link parseFlowArgs} resolved from the raw argument slice: the
 * positionals with every flag-shaped token removed, plus the three flags this
 * command recognizes.
 */
interface ParsedFlowArgs {
  /** Every non-flag token, in order: the subcommand, then the flow name. */
  readonly positionals: readonly string[];
  /** Whether `--dry-run` was given. */
  readonly dryRun: boolean;
  /** Whether `--json` was given. */
  readonly json: boolean;
  /** Whether `--resume` was given. */
  readonly resume: boolean;
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
 * `--dry-run`, `--json`, and `--resume` are boolean SWITCHES, not
 * value-bearing options: only the bare token enables one. `--dry-run=false`
 * is REFUSED rather than matched loosely and coerced to `true` — a caller who
 * wrote `=false` expecting a real run must see a usage error, not a silent dry
 * run.
 *
 * @param rawArgs - The raw post-command argument slice.
 * @returns The parsed positionals and flags, or the offending flag token when
 *   an unrecognized flag — or a value-bearing form of a boolean flag — was
 *   given.
 */
function parseFlowArgs(
  rawArgs: readonly string[],
): ParsedFlowArgs | { readonly unknownFlag: string } {
  const positionals: string[] = [];
  let dryRun = false;
  let json = false;
  let resume = false;

  for (const token of rawArgs) {
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === DRY_RUN_FLAG) {
      dryRun = true;
      continue;
    }
    if (token === JSON_FLAG) {
      json = true;
      continue;
    }
    if (token === RESUME_FLAG) {
      resume = true;
      continue;
    }
    const name = flagName(token);
    // A value-bearing form of a boolean flag (`--dry-run=false`,
    // `--resume=dump`) is reported with the FULL token, not the stripped name,
    // so the offending `=value` is visible in the error rather than swallowed.
    return {
      unknownFlag:
        name === DRY_RUN_FLAG || name === JSON_FLAG || name === RESUME_FLAG
          ? token
          : name,
    };
  }
  return { positionals, dryRun, json, resume };
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
 * Reports an unrecognized flag — or a value-bearing form of a boolean flag —
 * as a usage error.
 *
 * @param context - The command context, for the writer facade.
 * @param flag - The offending flag token, as returned by
 *   {@link parseFlowArgs} — stripped of any `=<value>` suffix, except when the
 *   value-bearing form itself is the defect, in which case it is passed whole.
 * @returns The usage exit code.
 */
function reportUnknownFlag(
  context: M3LCliCommandContext,
  flag: string,
): number {
  const baseName = flagName(flag);
  if (
    flag !== baseName &&
    (baseName === DRY_RUN_FLAG ||
      baseName === JSON_FLAG ||
      baseName === RESUME_FLAG)
  ) {
    context.output.error(
      `${baseName} does not take a value — write ${baseName} alone, not '${flag}'`,
    );
  } else {
    context.output.error(
      `unknown flag '${flag}' — m3l flow accepts ${JSON_FLAG} on any subcommand, and ${DRY_RUN_FLAG} and ${RESUME_FLAG} on 'run'`,
    );
  }
  return USAGE_EXIT_CODE;
}

/**
 * Returns the canonical path for the run record of a named flow.
 *
 * Extracted so both the write site and the resume read site resolve the SAME
 * path from the same inputs — if either computed it inline, the two could
 * silently drift apart and the resume reader would never find what the writer
 * persisted.
 *
 * @param context - The command context, for the cache file path anchor.
 * @param flowName - The flow whose record path is needed.
 * @returns The absolute path to the flow's JSON run record.
 */
function flowRecordPath(
  context: M3LCliCommandContext,
  flowName: string,
): string {
  return join(
    dirname(context.cacheFilePath),
    FLOW_RECORD_DIRECTORY,
    `${flowName}.json`,
  );
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
 * Dispatches the `list` subcommand, after enforcing its own argument
 * constraints — specifically that `--resume` does not apply to `list`.
 *
 * Extracted from {@link runFlowCommand} to keep that function's cyclomatic
 * complexity within the project's allowed maximum of 10.
 *
 * @param context - The command context.
 * @param rest - Tokens after the `list` subcommand (must be empty).
 * @param resume - Whether `--resume` was given.
 * @param json - Whether `--json` was given.
 * @returns `0` on success, `2` on a usage error.
 * @throws Whatever `listFlows` throws, unchanged.
 */
function dispatchFlowList(
  context: M3LCliCommandContext,
  rest: readonly string[],
  resume: boolean,
  json: boolean,
): number {
  if (resume) {
    context.output.error(
      `--resume applies to 'run', not 'list' — usage: m3l flow run <name> [${RESUME_FLAG}]`,
    );
    return USAGE_EXIT_CODE;
  }
  if (rest.length > 0) {
    context.output.error(
      `m3l flow list does not accept a positional argument — got '${rest.join(" ")}', usage: m3l flow list`,
    );
    return USAGE_EXIT_CODE;
  }
  return runFlowList(context, json);
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
 * context, `loadFlowDefinition` validates, (optionally) the resume record is
 * read, `runFlow` executes, `buildFlowRunRecord` assembles the ledger, the
 * result is EMITTED, and only then is the ledger written. Nothing here
 * recomputes the definition hash the record already carries.
 *
 * **Resume.** When `resume` is true, the saved run record is read and
 * forwarded to `flow/record`'s `validateResumeRecord`, which enforces the
 * three preconditions (record exists, `resumeStepId` non-null, definition
 * hash matches). Any violation throws `ERR_CLI_FLOW_RESUME_REFUSED`. A
 * corrupt record (`ERR_CLI_FLOW_RECORD_INVALID`) propagates UNCHANGED —
 * never caught here.
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
 * @param resume - Whether to resume from the last saved step.
 * @returns The flow's own exit code, verbatim.
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_FLOW` or
 *   `ERR_CLI_FLOW_INVALID` from validation, `ERR_CLI_FLOW_RESUME_REFUSED`
 *   when a resume precondition is not met, `ERR_CLI_FLOW_RECORD_INVALID`
 *   when the saved record is corrupt, `ERR_CLI_FLOW_RECORD_WRITE_FAILED`
 *   when the resume ledger cannot be written, and whatever a step execution
 *   throws — each unchanged.
 */
async function runNamedFlow(
  context: M3LCliCommandContext,
  name: string,
  dryRun: boolean,
  json: boolean,
  resume: boolean,
): Promise<number> {
  const candidates = discoverScripts(context.workspaceRoot);
  const definition = loadFlowDefinition(context.workspaceRoot, name, {
    parametersByScript: await buildParametersByScript(context, candidates),
  });

  const resumeOptions = resume
    ? validateResumeRecord(
        readFlowRunRecord(flowRecordPath(context, definition.name)),
        definition,
      )
    : undefined;

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
    { dryRun, ...resumeOptions },
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

  writeFlowRunRecord(flowRecordPath(context, definition.name), record);
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
 *   `ERR_CLI_FLOW_INVALID` from validation, `ERR_CLI_FLOW_RESUME_REFUSED`
 *   when a resume precondition is not met, `ERR_CLI_FLOW_RECORD_INVALID`
 *   when the saved record is corrupt, `ERR_CLI_FLOW_RECORD_WRITE_FAILED`
 *   when the resume ledger cannot be written, and whatever a step execution
 *   throws — each unchanged.
 *
 * @example
 * ```ts
 * const exitCode = await runFlowCommand(context, ["run", "dlq-reconcile", "--resume"]);
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

  const [subcommand, ...rest] = parsed.positionals;
  if (subcommand === undefined || !SUBCOMMANDS.includes(subcommand)) {
    context.output.error(
      subcommand === undefined
        ? `m3l flow requires a subcommand — usage: m3l flow ${SUBCOMMANDS.join("|")}`
        : `unknown m3l flow subcommand '${subcommand}' — expected ${SUBCOMMANDS.join(" or ")}`,
    );
    return USAGE_EXIT_CODE;
  }
  if (subcommand === "list") {
    return dispatchFlowList(context, rest, parsed.resume, json);
  }
  const [name, ...surplus] = rest;
  if (name === undefined) {
    context.output.error(
      `m3l flow run requires a <name> positional — usage: m3l flow run <name> [${DRY_RUN_FLAG}] [${JSON_FLAG}] [${RESUME_FLAG}]`,
    );
    return USAGE_EXIT_CODE;
  }
  if (surplus.length > 0) {
    context.output.error(
      `m3l flow run accepts only one <name> positional — got surplus '${surplus.join(" ")}', usage: m3l flow run <name> [${DRY_RUN_FLAG}] [${JSON_FLAG}] [${RESUME_FLAG}]`,
    );
    return USAGE_EXIT_CODE;
  }
  return runNamedFlow(context, name, parsed.dryRun, json, parsed.resume);
}
