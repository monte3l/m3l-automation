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
import { suggestNames } from "../cli/suggest.js";
import type { M3LCliCommandContext } from "./context.js";
import { discoverScripts } from "../discovery/discover.js";
import { loadParametersCached } from "../discovery/cached-load.js";
import type { M3LCliParameterDescriptor } from "../discovery/load-config.js";
import { spawnScript } from "../run/spawn.js";
import { runInspect } from "./inspect.js";
import { recordHistoryEntry } from "../history/store.js";

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
 * and `main.ts`'s own `STATIC_COMMAND_NAMES` is a narrower, intentionally
 * different list (it excludes `"new"`, which has no dispatched command and
 * would hit `dispatchStaticCommandByName`'s unreachable default), plus
 * `main.ts` lazy-imports every command module to keep `help`/`--version`
 * free of discovery — a static import of `doctor.ts` purely for this
 * constant would defeat that. This literal must stay set-equal to
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
  "help",
];

/** A single `node:util` `parseArgs` option entry this module ever builds. */
interface M3LCliParseArgsOptionConfig {
  readonly type: "string" | "boolean";
  readonly multiple?: true;
}

/**
 * The `parseArgs` `values` shape this module reads back after a strict
 * parse — matches `node:util`'s own fallback declaration for the generic
 * (non-literal) `options` shape {@link buildParseArgsOptions} builds: since
 * `options` is a dynamically-keyed `Record`, not a `parseArgs`-inferrable
 * literal, TypeScript can't narrow `values` to a per-key shape and instead
 * types every entry as this full union regardless of the declared type.
 */
type M3LCliParsedValues = Record<
  string,
  string | boolean | Array<string | boolean> | undefined
>;

/**
 * Builds a `parseArgs` options config keyed by every declared parameter name
 * and alias: `BOOL` → `boolean`, `STRING_ARRAY` → `multiple` string,
 * everything else → plain `string`.
 *
 * @throws {@link M3LCliError} coded `ERR_CLI_CONFIG_IMPORT` when two
 *   different declared parameters collide on the same option key (a
 *   parameter name reused as another parameter's alias, or two aliases
 *   sharing a name) — an invalid declared config, not a runtime user error.
 */
function buildParseArgsOptions(
  descriptors: readonly M3LCliParameterDescriptor[],
): Record<string, M3LCliParseArgsOptionConfig> {
  const options: Record<string, M3LCliParseArgsOptionConfig> = {};
  const ownerNameByKey = new Map<string, string>();

  for (const descriptor of descriptors) {
    const config: M3LCliParseArgsOptionConfig =
      descriptor.type === "BOOL"
        ? { type: "boolean" }
        : descriptor.type === "STRING_ARRAY"
          ? { type: "string", multiple: true }
          : { type: "string" };

    for (const key of [descriptor.name, ...descriptor.aliases]) {
      const existingOwnerName = ownerNameByKey.get(key);
      if (
        existingOwnerName !== undefined &&
        existingOwnerName !== descriptor.name
      ) {
        throw new M3LCliError(
          "ERR_CLI_CONFIG_IMPORT",
          `parameters '${existingOwnerName}' and '${descriptor.name}' both declare the option '${key}'`,
        );
      }
      ownerNameByKey.set(key, descriptor.name);
      options[key] = config;
    }
  }

  return options;
}

/** Matches `node:util` `parseArgs`'s unknown-option error message, e.g. `Unknown option '--regoin'`. */
const UNKNOWN_OPTION_MESSAGE_PATTERN = /Unknown option '(--?[^']+)'/;

/**
 * Matches the offending flag's name embedded in a `parseArgs`
 * invalid-option-value error message, e.g. `Option '--verbose' does not take an argument`
 * or `Option '--region <value>' argument missing`.
 */
const INVALID_OPTION_VALUE_MESSAGE_PATTERN = /Option '(--?[A-Za-z0-9][\w-]*)/;

/**
 * Extracts the offending flag's bare name (dashes stripped) from an `Error`
 * message via `pattern`; `undefined` when `error` isn't an `Error` or its
 * message doesn't match the expected shape.
 */
function extractOptionName(
  error: unknown,
  pattern: RegExp,
): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const token = pattern.exec(error.message)?.[1];
  return token === undefined ? undefined : token.replace(/^--?/, "");
}

/** The subset of a Node error shape this module reads: its `code` string. */
interface M3LNodeErrorLike {
  readonly code?: unknown;
}

/** True when `error` is a `parseArgs`-raised `Error` carrying Node's `code`. */
function hasParseArgsErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as M3LNodeErrorLike).code === code;
}

/**
 * Maps a `parseArgs` parse failure to the appropriate `M3LCliError`: Node's
 * `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` (e.g. `--verbose=true` given to a
 * `BOOL` flag, which never takes a value) becomes
 * `ERR_CLI_INVALID_PARAMETER_VALUE`, carrying `parseArgs`'s own message;
 * everything else — including a genuinely unknown option — becomes
 * `ERR_CLI_UNKNOWN_PARAMETER` with suggestions over the script's declared
 * parameter names.
 */
function toParameterError(
  error: unknown,
  scriptName: string,
  descriptors: readonly M3LCliParameterDescriptor[],
): M3LCliError {
  if (hasParseArgsErrorCode(error, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE")) {
    const parameterName =
      extractOptionName(error, INVALID_OPTION_VALUE_MESSAGE_PATTERN) ?? "";
    const detail = error instanceof Error ? error.message : String(error);
    return new M3LCliError(
      "ERR_CLI_INVALID_PARAMETER_VALUE",
      `invalid value for parameter '${parameterName}' for script '${scriptName}': ${detail}`,
    );
  }

  const unknownName =
    extractOptionName(error, UNKNOWN_OPTION_MESSAGE_PATTERN) ?? "";
  return new M3LCliError(
    "ERR_CLI_UNKNOWN_PARAMETER",
    `unknown parameter '${unknownName}' for script '${scriptName}'`,
    {
      suggestions: suggestNames(
        unknownName,
        descriptors.map((descriptor) => descriptor.name),
      ),
    },
  );
}

/**
 * Appends `descriptor`'s translated `--name[=value]` form(s) to `argv` for
 * one already-present parsed `value`: `BOOL` → a bare `--name` when `true`
 * (omitted otherwise), `STRING_ARRAY` → one repeated `--name=value` per
 * item, everything else → a single `--name=value`.
 */
function pushTranslatedArg(
  argv: string[],
  descriptor: M3LCliParameterDescriptor,
  value: M3LCliParsedValues[string],
): void {
  if (descriptor.type === "BOOL") {
    if (value === true) {
      argv.push(`--${descriptor.name}`);
    }
    return;
  }
  if (descriptor.type === "STRING_ARRAY") {
    /* istanbul ignore next -- unreachable: buildParseArgsOptions always
       configures a STRING_ARRAY descriptor's key with `multiple: true`, so
       parseArgs only ever yields an array for a present key of this type. */
    const items = Array.isArray(value) ? value : [];
    for (const item of items) {
      argv.push(`--${descriptor.name}=${String(item)}`);
    }
    return;
  }
  argv.push(`--${descriptor.name}=${String(value)}`);
}

/**
 * Translates parsed `values` back to canonical `--name[=value]` child argv,
 * in `descriptors`' declaration order (see {@link pushTranslatedArg} for the
 * per-type translation). An alias hit maps back to its canonical
 * `descriptor.name`.
 *
 * Exported (8g refactor) so `commands/wizard.ts` can reuse the exact same
 * translation instead of duplicating it — both modules build a
 * `{descriptor.name: value}`-shaped record and hand it to this one shared
 * routine to produce the spawned script's argv.
 *
 * @param descriptors - The script's declared parameters, in declaration order.
 * @param values - The parsed/collected values, keyed by canonical name or
 *   alias.
 * @returns The translated `--name[=value]` argv tokens, in declaration order.
 *
 * @example
 * ```ts
 * const argv = translateArgv(descriptors, { region: "us-east-1", verbose: true });
 * // ["--region=us-east-1", "--verbose"]
 * ```
 */
export function translateArgv(
  descriptors: readonly M3LCliParameterDescriptor[],
  values: M3LCliParsedValues,
): readonly string[] {
  const argv: string[] = [];

  for (const descriptor of descriptors) {
    const names = [descriptor.name, ...descriptor.aliases];
    const presentKey = names.find((name) => Object.hasOwn(values, name));
    if (presentKey === undefined) {
      continue;
    }
    pushTranslatedArg(argv, descriptor, values[presentKey]);
  }

  return argv;
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
 * Once the spawn resolves, best-effort records a run-history entry (8f)
 * naming the parsed canonical parameter names (unlike `run`, which never
 * parses and always records `[]`) — never recorded for the `--help`/`-h`
 * delegation (no spawn) or when an unknown script/parameter throws before
 * spawning.
 *
 * @param context - The command context to run against; must carry
 *   `historyFilePath`.
 * @param scriptName - The first positional token, resolved as a script name.
 * @param args - The tokens between the script name and the first bare `--`
 *   in the original `argv` (raw — not pre-parsed by `main.ts`).
 * @param passthroughArgs - Everything after the first bare `--`, forwarded
 *   verbatim to the spawned script.
 * @returns `runInspect`'s resolved code for `--help`/`-h`; otherwise
 *   {@link spawnScript}'s resolved exit code, propagated verbatim.
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
  const candidates = discoverScripts(context.workspaceRoot);
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

  if (args.includes("--help") || args.includes("-h")) {
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
      args: [...args],
      options,
      strict: true,
      allowPositionals: false,
    });
    // `options` is built dynamically (not a literal), so Node's own
    // `parseArgs` typings widen `parsed.values` to this generic
    // string|boolean|Array<string|boolean> union rather than a per-key
    // shape — `M3LCliParsedValues` mirrors that fallback declaration
    // exactly, so no cast is needed to assign it.
    values = parsed.values;
  } catch (error) {
    throw toParameterError(error, scriptName, descriptors);
  }

  const translatedArgs = translateArgv(descriptors, values);
  const exitCode = await spawnScript(candidate.directory, [
    ...translatedArgs,
    ...passthroughArgs,
  ]);
  recordDynamicHistory(
    context.historyFilePath,
    scriptName,
    presentParameterNames(descriptors, values),
    exitCode,
  );
  return exitCode;
}
