/**
 * `commands/dynamic` — runtime-registered per-script subcommands. Any first
 * positional that doesn't match a reserved command name dispatches here,
 * translating a script's declared config parameters into a real
 * `parseArgs`-driven flag surface and spawning it.
 *
 * @packageDocumentation
 */

import { parseArgs } from "node:util";

import { M3LCliError } from "../cli/errors.js";
import type { M3LCliEnvFileSetting } from "../cli/flags.js";
import { partitionInProcessFlag, partitionJsonFlag } from "../cli/flags.js";
import { suggestNames } from "../cli/suggest.js";
import type { M3LCliCommandContext } from "./context.js";
import { discoverScripts } from "../discovery/discover.js";
import type { M3LCliScriptCandidate } from "../discovery/discover.js";
import { loadParametersCached } from "../discovery/cached-load.js";
import type { M3LCliParameterDescriptor } from "../discovery/load-config.js";
import { createCancellationScope } from "../run/cancellation.js";
import { executeScript } from "../run/execute.js";
import { runInProcess } from "../run/in-process.js";
import { runInspect } from "./inspect.js";
import { recordHistoryEntry } from "../history/store.js";
import {
  buildParameterValues,
  buildParseArgsOptions,
  restoreDroppedOptionTokens,
  toParameterError,
  translateArgv,
} from "./dynamic-argv.js";
import type { M3LCliParsedValues } from "./dynamic-argv.js";

/**
 * `M3LCliCommandContext` plus the run-history file's absolute path (8f) —
 * `runDynamic`'s own parameter type, narrower than the shared base so the
 * best-effort history recording below can read `context.historyFilePath`
 * without a cast.
 */
interface M3LCliDynamicCommandContext extends M3LCliCommandContext {
  readonly historyFilePath: string;
}

/**
 * The full ADR-0042 reserved CLI command-name list — every name a discovered
 * script can never be registered under, folded into the unknown-script
 * suggestion pool alongside the discovered script names.
 *
 * Kept as its own literal here (rather than sharing an import) for two
 * independent reasons: `doctor.ts`'s own `RESERVED_COMMAND_NAMES` is pinned
 * by a `doctor.test.ts` drift guard that regex-extracts the literal array
 * straight out of `doctor.ts`'s source text, so that declaration can't move;
 * and `main.ts` lazy-imports every command module (including `new.ts`, which
 * it now also dispatches statically) to keep `help`/`--version` free of
 * discovery — a static import of `doctor.ts` purely for this constant would
 * defeat that. This literal must stay set-equal to
 * `doctor.ts`'s `RESERVED_COMMAND_NAMES` and `bin/lib/script-scaffold.mjs`'s
 * `RESERVED_CLI_NAMES` (the ADR-0042 source of truth) whenever any of the
 * three changes.
 */
const STATIC_COMMAND_NAMES: readonly string[] = [
  "list",
  "inspect",
  "run",
  "doctor",
  "presets",
  "history",
  "new",
  "wizard",
  "completion",
  "flow",
  "help",
];

/**
 * Rejects an in-process dispatch the moment it's asked for something that
 * path cannot honor: a `passthroughArgs` token other than the literal
 * `--dry-run` (there is no child process argv for it to reach — the spawn
 * path forwards `passthroughArgs` verbatim, but {@link runInProcess} only
 * ever consults the `--dry-run` token), or `context.jsonOutput` (only
 * {@link executeScript}'s spawn path emits the `--json` result envelope).
 * Either condition previously produced a silent no-op — the extra tokens
 * dropped, or `--json` simply never honored — rather than a loud failure.
 *
 * `--env-file`/`--no-env-file` is rejected for the same reason: there is no
 * child process for an env file to be loaded into, so honoring the flag is
 * impossible and ignoring it would silently change what configuration the
 * run resolved from.
 *
 * @throws {@link M3LCliError} coded `ERR_CLI_IN_PROCESS_UNSUPPORTED` when any
 *   unsupported combination is present.
 */
function assertInProcessSupported(
  passthroughArgs: readonly string[],
  jsonOutput: boolean,
  envFile: M3LCliEnvFileSetting,
): void {
  const unsupportedPassthrough = passthroughArgs.filter(
    (token) => token !== "--dry-run",
  );
  if (unsupportedPassthrough.length > 0) {
    throw new M3LCliError(
      "ERR_CLI_IN_PROCESS_UNSUPPORTED",
      "--in-process does not support passthrough arguments other than --dry-run — there is no child process argv for them to reach; drop --in-process to spawn instead",
    );
  }
  if (jsonOutput) {
    throw new M3LCliError(
      "ERR_CLI_IN_PROCESS_UNSUPPORTED",
      "--in-process does not yet support --json (no result envelope is emitted on this path) — drop one flag or the other",
    );
  }
  if (envFile.kind !== "auto") {
    throw new M3LCliError(
      "ERR_CLI_IN_PROCESS_UNSUPPORTED",
      "--in-process does not support --env-file/--no-env-file — there is no child process for a .env to be loaded into; drop --in-process to spawn instead",
    );
  }
}

/**
 * Dispatches a resolved, parsed dynamic run to its execution path: in-process
 * via {@link runInProcess} when `inProcess` is `true` (no envelope emission —
 * that integration is a deliberate follow-up, not part of this dispatch —
 * and rejected loudly via {@link assertInProcessSupported} rather than
 * silently dropping unsupported input), otherwise the spawn path via
 * {@link translateArgv} + {@link executeScript} (which also emits the
 * `--json` envelope when `context.jsonOutput` is `true`). Extracted so
 * {@link runDynamic} itself stays under the per-function line budget.
 *
 * @throws {@link M3LCliError} coded `ERR_CLI_IN_PROCESS_UNSUPPORTED` — see
 *   {@link assertInProcessSupported} — when `inProcess` is `true` and either
 *   `passthroughArgs` carries a token other than `--dry-run`, or
 *   `context.jsonOutput` is `true`.
 */
async function dispatchDynamicRun(
  context: M3LCliCommandContext,
  scriptName: string,
  scriptDirectory: string,
  descriptors: readonly M3LCliParameterDescriptor[],
  values: M3LCliParsedValues,
  passthroughArgs: readonly string[],
  inProcess: boolean,
): Promise<number> {
  if (inProcess) {
    assertInProcessSupported(
      passthroughArgs,
      context.jsonOutput,
      context.envFile,
    );
    // No child process, no argv, no serialization: a secret-flagged
    // parameter's value is bound straight into the hosted command's typed
    // `parameterValues` and never leaves this process's heap, so there is
    // nothing here for ADR-0085's environment injection to protect.
    //
    // Install a cancellation scope for the duration of the in-process run
    // so SIGINT aborts the command's signal rather than killing the parent
    // immediately — the command module can observe `context.signal` and
    // unwind cooperatively (U11, ADR-0049). dispose() in finally so a
    // thrown error still cleans up the SIGINT/SIGTERM listeners.
    const scope = createCancellationScope();
    try {
      return await runInProcess(scriptDirectory, {
        output: context.output,
        parameterValues: buildParameterValues(descriptors, values),
        dryRun: passthroughArgs.includes("--dry-run"),
        signal: scope.signal,
      });
    } finally {
      scope.dispose();
    }
  }
  const { argv, secretEnv } = translateArgv(descriptors, values);
  return executeScript(
    context,
    scriptName,
    scriptDirectory,
    [...argv, ...passthroughArgs],
    { secretEnv },
  );
}

/**
 * Resolves `scriptName` against `discoverScripts`' candidates, or throws
 * `ERR_CLI_UNKNOWN_SCRIPT` with suggestions spanning the static command names
 * and the discovered script names. Extracted so {@link runDynamic} itself
 * stays under the per-function line budget.
 */
function resolveDynamicCandidate(
  workspaceRoot: string,
  scriptName: string,
): M3LCliScriptCandidate {
  const candidates = discoverScripts(workspaceRoot);
  const candidate = candidates.find((entry) => entry.name === scriptName);
  if (candidate === undefined) {
    throw new M3LCliError(
      "ERR_CLI_UNKNOWN_SCRIPT",
      `unknown script '${scriptName}'`,
      {
        suggestions: suggestNames(scriptName, [
          ...STATIC_COMMAND_NAMES,
          ...candidates.map((entry) => entry.name),
        ]),
      },
    );
  }
  return candidate;
}

/**
 * Names every declared parameter whose canonical name or an alias is present
 * in the already-parsed `values` — the run-history entry's `parameterNames`
 * (8f), mapped to each descriptor's canonical `name` (never the alias key
 * the caller happened to type).
 */
function presentParameterNames(
  descriptors: readonly M3LCliParameterDescriptor[],
  values: M3LCliParsedValues,
): readonly string[] {
  return descriptors
    .filter((descriptor) =>
      [descriptor.name, ...descriptor.aliases].some((name) =>
        Object.hasOwn(values, name),
      ),
    )
    .map((descriptor) => descriptor.name);
}

/**
 * Best-effort records a run-history entry after a successful spawn — never
 * throws (any failure, including {@link recordHistoryEntry} itself throwing
 * rather than returning `false`, is swallowed) since history recording must
 * never affect the resolved exit code {@link runDynamic} already has in hand.
 */
function recordDynamicHistory(
  historyFilePath: string,
  scriptName: string,
  parameterNames: readonly string[],
  exitCode: number,
): void {
  try {
    recordHistoryEntry(historyFilePath, {
      timestamp: new Date().toISOString(),
      script: scriptName,
      parameterNames,
      exitCode,
    });
  } catch {
    /* best-effort: history recording must never affect the resolved exit code */
  }
}

/**
 * Resolves `scriptName` against the discovered `scripts/*` candidates and
 * either delegates to `runInspect` (for `--help`/`-h`) or parses `args`
 * against the script's declared parameters and spawns it, forwarding
 * `passthroughArgs` verbatim after the translated flags.
 *
 * Before any of that, the CLI-reserved `--json` flag (V2 slice 1, #539 /
 * ADR-0063) and the CLI-reserved `--in-process` flag (U7, ADR-0054) are
 * stripped out of `args` via {@link partitionJsonFlag} then
 * {@link partitionInProcessFlag} on its `rest` — the same treatment
 * `--help`/`-h` already gets — so neither ever reaches the script's own
 * strict `parseArgs` (which would otherwise reject it as an unknown
 * parameter) or leaks into the translated child argv, even when the script
 * happens to declare its own same-named `json`/`in-process` parameter.
 *
 * When `--in-process` was present, execution diverts entirely: instead of
 * {@link translateArgv} + {@link executeScript}, `runDynamic` builds a typed
 * `parameterValues` bag via {@link buildParameterValues} and calls
 * {@link runInProcess} with the script's directory, `context.output`, and a
 * `dryRun` flag derived from whether `passthroughArgs` contains the literal
 * `--dry-run` token (the same convention a spawned script's own `main.ts`
 * reads off its own argv). Absent, behavior is unchanged from the pre-U7
 * spawn path.
 *
 * The in-process path rejects loudly, rather than silently dropping the
 * request, when it's asked for something it cannot honor: a
 * `passthroughArgs` token other than the literal `--dry-run` (there is no
 * child process argv for it to reach), or `context.jsonOutput` (only the
 * spawn path's `executeScript` emits the `--json` result envelope) — see
 * `dispatchDynamicRun`'s `assertInProcessSupported` helper.
 *
 * Once the spawn/in-process run resolves, best-effort records a run-history
 * entry (8f) naming the parsed canonical parameter names (unlike `run`,
 * which never parses and always records `[]`) — never recorded for the
 * `--help`/`-h` delegation (no spawn) or when an unknown script/parameter
 * throws before spawning.
 *
 * @param context - The command context to run against; must carry
 *   `historyFilePath`.
 * @param scriptName - The first positional token, resolved as a script name.
 * @param args - The tokens between the script name and the first bare `--`
 *   in the original `argv` (raw — not pre-parsed by `main.ts`).
 * @param passthroughArgs - Everything after the first bare `--`, forwarded
 *   verbatim to the spawned script.
 * @returns `runInspect`'s resolved code for `--help`/`-h`; otherwise
 *   {@link executeScript}'s resolved exit code, propagated verbatim.
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_SCRIPT` — with
 *   suggestions spanning the static command names and the discovered script
 *   names — when `scriptName` matches neither.
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_PARAMETER` — with
 *   suggestions over the script's declared parameter names — when `args`
 *   contains a flag the script doesn't declare.
 *
 * @example
 * ```ts
 * const exitCode = await runDynamic(
 *   context,
 *   "json-etl",
 *   ["--region", "us-east-1"],
 *   ["--limit", "5"],
 * );
 * ```
 */
export async function runDynamic(
  context: M3LCliDynamicCommandContext,
  scriptName: string,
  args: readonly string[],
  passthroughArgs: readonly string[],
): Promise<number> {
  const candidate = resolveDynamicCandidate(context.workspaceRoot, scriptName);

  const { rest: argsWithoutJsonFlag } = partitionJsonFlag(args);
  const { inProcess, rest: argsWithoutReservedFlags } =
    partitionInProcessFlag(argsWithoutJsonFlag);

  if (
    argsWithoutReservedFlags.includes("--help") ||
    argsWithoutReservedFlags.includes("-h")
  ) {
    return runInspect(context, scriptName);
  }

  const descriptors = await loadParametersCached(
    scriptName,
    candidate.directory,
    context.cacheFilePath,
  );
  const options = buildParseArgsOptions(descriptors);

  let values: M3LCliParsedValues;
  try {
    const parsed = parseArgs({
      args: [...argsWithoutReservedFlags],
      options,
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
    // `options` is built dynamically (not a literal), so Node's own
    // `parseArgs` typings widen `parsed.values` to this generic
    // string|boolean|Array<string|boolean> union rather than a per-key
    // shape — `M3LCliParsedValues` mirrors that fallback declaration
    // exactly, so no cast is needed to assign it.
    values = parsed.values;
    // Node's own parseArgs implementation unconditionally refuses to record
    // an option literally named `__proto__` on its returned `values` — even
    // when both `options` and `values` are null-prototype objects, verified
    // empirically. `restoreDroppedOptionTokens` reconstructs any such
    // silently-dropped entry from the raw `tokens` Node still hands back, so
    // this CLI's own security fix (Object.create(null) in
    // buildParseArgsOptions/buildParameterValues) isn't quietly defeated one
    // layer further down the stack.
    values = restoreDroppedOptionTokens(values, parsed.tokens ?? [], options);
  } catch (error) {
    throw toParameterError(error, scriptName, descriptors);
  }

  const exitCode = await dispatchDynamicRun(
    context,
    scriptName,
    candidate.directory,
    descriptors,
    values,
    passthroughArgs,
    inProcess,
  );
  recordDynamicHistory(
    context.historyFilePath,
    scriptName,
    presentParameterNames(descriptors, values),
    exitCode,
  );
  return exitCode;
}
