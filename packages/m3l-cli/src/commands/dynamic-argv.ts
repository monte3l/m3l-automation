/**
 * `commands/dynamic-argv` — the CLI-reserved-flag-stripped argv →
 * declared-parameter translation layer shared by the dynamic per-script
 * dispatch and the wizard — turns a script's declared `configParameters`
 * plus parsed `parseArgs` values into either canonical `--name[=value]`
 * child argv paired with the secret-only environment overlay
 * (`translateArgv`, spawn path, ADR-0085) or a typed `Record` for direct
 * in-process binding (`buildParameterValues`, ADR-0054/U7).
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../cli/errors.js";
import { suggestNames } from "../cli/suggest.js";
import type { M3LCliParameterDescriptor } from "../discovery/load-config.js";

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
export type M3LCliParsedValues = Record<
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
export function buildParseArgsOptions(
  descriptors: readonly M3LCliParameterDescriptor[],
): Record<string, M3LCliParseArgsOptionConfig> {
  // Object.create(null) rather than a `{}` literal: a declared parameter or
  // alias literally named "__proto__" must become a genuine own key here —
  // a plain-literal object would route `options["__proto__"] = config`
  // through the inherited setter instead, silently dropping the key and
  // making parseArgs reject `--__proto__` as unknown before it ever reaches
  // buildParameterValues's own same-shaped fix.
  const options: Record<string, M3LCliParseArgsOptionConfig> = Object.create(
    null,
  ) as Record<string, M3LCliParseArgsOptionConfig>;
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

/** The subset of a `node:util` `parseArgs` token this module reads back to reconstruct a dropped entry. */
interface M3LParseArgsTokenLike {
  readonly kind: string;
  readonly name?: string;
  readonly value?: string | undefined;
}

/**
 * Computes the value {@link restoreDroppedOptionTokens} backfills for one
 * dropped option token, mirroring `parseArgs`'s own per-type translation:
 * a bare boolean flag, a single string, or an accumulating array for a
 * `multiple` option.
 */
function translatedTokenValue(
  existing: M3LCliParsedValues[string],
  token: M3LParseArgsTokenLike,
  config: M3LCliParseArgsOptionConfig,
): string | boolean | Array<string | boolean> {
  if (config.type === "boolean") {
    return true;
  }
  if (config.multiple === true) {
    return [...(Array.isArray(existing) ? existing : []), token.value ?? ""];
  }
  return token.value ?? "";
}

/**
 * Backfills any "option" token `node:util`'s `parseArgs` silently declined to
 * record on its own returned `values` — specifically an option literally
 * named `__proto__`, which `parseArgs`'s implementation unconditionally
 * refuses to set on `values` regardless of how `options`/`values` are
 * constructed (verified empirically: even an `Object.create(null)`-backed
 * pair still drops it). Reads every "option" token back and, for any `name`
 * not already an own property of the ORIGINAL, pristine `values` parseArgs
 * returned, sets it via {@link translatedTokenValue} — so this module's own
 * `Object.create(null)` fix in {@link buildParseArgsOptions} /
 * {@link buildParameterValues} isn't quietly defeated one layer further down
 * the stack. The own-key guard is deliberately checked against `values`
 * rather than the fold's own mutating `accumulated` state: checking
 * `accumulated` would make the reducer's first write for a repeated name
 * (e.g. a `STRING_ARRAY` parameter passed `--name` three times) look like it
 * was "already recorded" by the second and third occurrences, silently
 * truncating a multi-valued option to its first value. Returns a new object
 * (via a computed-key object literal, never bracket-assignment on an
 * existing object) rather than mutating `values` in place, since a
 * `__proto__`-named backfill must go through `[[DefineOwnProperty]]`
 * (an object literal's computed key), not `[[Set]]` (bracket assignment),
 * to land as a genuine own key regardless of the target object's prototype.
 */
export function restoreDroppedOptionTokens(
  values: M3LCliParsedValues,
  tokens: readonly M3LParseArgsTokenLike[],
  options: Record<string, M3LCliParseArgsOptionConfig>,
): M3LCliParsedValues {
  return tokens.reduce<M3LCliParsedValues>((accumulated, token) => {
    if (token.kind !== "option" || token.name === undefined) {
      return accumulated;
    }
    if (Object.hasOwn(values, token.name)) {
      return accumulated;
    }
    const config = options[token.name];
    /* istanbul ignore next -- unreachable: `options` is built by
       buildParseArgsOptions from the same `descriptors` parseArgs was
       invoked with in `strict: true` mode, so an option name absent from
       `options` makes parseArgs itself throw before any token for it is
       ever returned — every "option"-kind token reaching here already has
       a matching `options` entry. */
    if (config === undefined) {
      return accumulated;
    }
    return {
      ...accumulated,
      [token.name]: translatedTokenValue(
        accumulated[token.name],
        token,
        config,
      ),
    };
  }, values);
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
export function toParameterError(
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
 * Rejects a declared parameter set in which two canonical names derive the
 * same environment-variable name and at least one of them is secret.
 *
 * `api.token` and `api-token` are two distinct, individually legal declared
 * parameters that both normalize to `API_TOKEN`. Injecting one of them as a
 * secret would then silently satisfy the *other* parameter whenever that
 * other one is absent from argv — a swapped secret, delivered quietly. No
 * script in the fleet declares such a pair today; this guard is what keeps
 * that true.
 *
 * Only pairs involving a secret are rejected. Two non-secret parameters
 * colliding is pre-existing, unchanged behaviour (neither is ever injected),
 * and failing on it here would break scripts this change has no business
 * breaking.
 *
 * @throws {@link M3LCliError} coded `ERR_CLI_CONFIG_IMPORT` — the same code
 *   {@link buildParseArgsOptions}'s name/alias collision guard raises, since
 *   this is likewise an invalid declared config rather than bad user input.
 */
function assertNoEnvVarNameCollision(
  descriptors: readonly M3LCliParameterDescriptor[],
): void {
  const ownerByEnvName = new Map<string, M3LCliParameterDescriptor>();
  for (const descriptor of descriptors) {
    const envName = Core.deriveEnvVarName(descriptor.name);
    const existing = ownerByEnvName.get(envName);
    if (existing === undefined) {
      ownerByEnvName.set(envName, descriptor);
      continue;
    }
    if (existing.secret === true || descriptor.secret === true) {
      throw new M3LCliError(
        "ERR_CLI_CONFIG_IMPORT",
        `parameters '${existing.name}' and '${descriptor.name}' both derive the environment variable '${envName}', and at least one is secret`,
      );
    }
  }
}

/**
 * Renders one present secret-flagged parameter's value for environment
 * delivery, mirroring {@link pushTranslatedArg}'s per-type translation onto
 * the string forms `Core.coerceConfigValue` accepts on the way back in:
 * `STRING_ARRAY` → the comma-joined items (the same `splitCsv` contract
 * {@link buildParameterValues} already honours), everything else →
 * `String(value)`.
 *
 * `BOOL` is deliberately absent: see {@link translateArgv}'s note on why a
 * secret boolean is routed to argv instead.
 */
function secretEnvValue(
  descriptor: M3LCliParameterDescriptor,
  value: M3LCliParsedValues[string],
): string {
  if (descriptor.type === "STRING_ARRAY") {
    /* istanbul ignore next -- unreachable: buildParseArgsOptions always
       configures a STRING_ARRAY descriptor's key with `multiple: true`, so
       parseArgs only ever yields an array for a present key of this type. */
    const items = Array.isArray(value) ? value : [];
    return items.map(String).join(",");
  }
  return String(value);
}

/**
 * The two halves of a spawn invocation {@link translateArgv} produces: the
 * public `--name[=value]` argv tokens, and the secret-only environment
 * overlay the CLI injects into the child instead of writing it into
 * `/proc/<pid>/cmdline` (ADR-0085).
 *
 * Returned as one object rather than split across two functions on purpose:
 * "a declared parameter's value is in exactly one of these" is the invariant
 * the whole hardening rests on, and it is only checkable in one place if
 * both halves are produced in one place.
 *
 * @example
 * ```ts
 * import type { M3LCliTranslatedInvocation } from "./dynamic-argv.js";
 *
 * const invocation: M3LCliTranslatedInvocation = {
 *   argv: ["--region=us-east-1"],
 *   secretEnv: { API_TOKEN: "hunter2" },
 * };
 * ```
 */
export interface M3LCliTranslatedInvocation {
  /** The translated `--name[=value]` tokens, in declaration order. */
  readonly argv: readonly string[];
  /**
   * One entry per present secret-flagged parameter, keyed by the
   * SCREAMING_SNAKE_CASE name `Core.deriveEnvVarName` derives from the
   * descriptor's canonical `name` — the exact key
   * `M3LEnvironmentConfigProvider` looks up at level 4 of the child's own
   * provider chain. Empty when the script declares no secrets, or none were
   * supplied.
   */
  readonly secretEnv: Readonly<Record<string, string>>;
}

/**
 * Translates parsed `values` into the spawn invocation's two halves: the
 * canonical `--name[=value]` child argv, in `descriptors`' declaration order
 * (see {@link pushTranslatedArg} for the per-type translation), and the
 * secret-only environment overlay. An alias hit maps back to its canonical
 * `descriptor.name` in both.
 *
 * A parameter declared `secret: true` is routed to `secretEnv` and its argv
 * token is **dropped**. Dropping it is required, not cosmetic: argv is level
 * 1 of `M3LScriptConfigLoader`'s provider chain and the environment is level
 * 4, so a value emitted both ways would still resolve from argv and the
 * hardening would be silently inert while every "the secret reaches the
 * environment" assertion still passed.
 *
 * A `secret: true` **`BOOL`** parameter is a contradiction — a boolean
 * carries no secret payload, only the fact that a flag was set, which its
 * mere presence in the argv already reveals. Rather than crash or invent a
 * `"true"`/`"false"` environment encoding whose absent case is ambiguous, it
 * is treated as non-secret for delivery purposes and keeps going to argv as
 * a bare `--name` flag.
 *
 * Exported (8g refactor) so `commands/wizard.ts` can reuse the exact same
 * translation instead of duplicating it — both modules build a
 * `{descriptor.name: value}`-shaped record and hand it to this one shared
 * routine.
 *
 * @param descriptors - The script's declared parameters, in declaration order.
 * @param values - The parsed/collected values, keyed by canonical name or
 *   alias.
 * @returns The translated argv tokens and the secret environment overlay.
 * @throws {@link M3LCliError} coded `ERR_CLI_CONFIG_IMPORT` when two declared
 *   parameters' canonical names derive the same environment-variable name
 *   (`api.token` and `api-token` both yield `API_TOKEN`) and at least one of
 *   them is secret — an invalid declared config, not a user error, and one
 *   that would otherwise feed a secret to the wrong parameter.
 *
 * @example
 * ```ts
 * const { argv, secretEnv } = translateArgv(descriptors, {
 *   region: "us-east-1",
 *   "api-token": "hunter2",
 * });
 * // argv === ["--region=us-east-1"]
 * // secretEnv === { API_TOKEN: "hunter2" }
 * ```
 */
export function translateArgv(
  descriptors: readonly M3LCliParameterDescriptor[],
  values: M3LCliParsedValues,
): M3LCliTranslatedInvocation {
  const argv: string[] = [];
  // Object.create(null) for the same reason buildParseArgsOptions uses it: a
  // declared parameter named "__proto__" must become a genuine own key rather
  // than reach the inherited setter.
  const secretEnv: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;

  assertNoEnvVarNameCollision(descriptors);

  for (const descriptor of descriptors) {
    const names = [descriptor.name, ...descriptor.aliases];
    const presentKey = names.find((name) => Object.hasOwn(values, name));
    if (presentKey === undefined) {
      continue;
    }
    const value = values[presentKey];
    if (descriptor.secret === true && descriptor.type !== "BOOL") {
      secretEnv[Core.deriveEnvVarName(descriptor.name)] = secretEnvValue(
        descriptor,
        value,
      );
      continue;
    }
    pushTranslatedArg(argv, descriptor, value);
  }

  return { argv, secretEnv };
}

/**
 * Builds the typed `parameterValues` bag {@link runInProcess} passes straight
 * into a hosted command's `execute` as its first argument — the in-process
 * counterpart to {@link translateArgv}'s argv-string translation, keyed by
 * canonical `descriptor.name` rather than child-process argv tokens.
 *
 * Mirrors {@link translateArgv}'s own present-key lookup over `descriptors`
 * exactly (an alias hit still resolves to its canonical name), but only a
 * `STRING_ARRAY` parameter's value needs translating: `parseArgs` already
 * yields a real JS array for it, which is comma-joined into one string per
 * `Core.coerceConfigValue`'s documented `STRING_ARRAY` contract (the same
 * contract `translateArgv` honours by emitting one repeated `--name=value`
 * per item). Every other declared type's raw `parseArgs` value — a real
 * `boolean` for `BOOL`, a raw `string` for everything else — already matches
 * what `coerceConfigValue` expects and passes through unchanged.
 *
 * @param descriptors - The script's declared parameters, in declaration order.
 * @param values - The parsed/collected values, keyed by canonical name or alias.
 * @returns One entry per parameter present in `values`, keyed by canonical name.
 */
export function buildParameterValues(
  descriptors: readonly M3LCliParameterDescriptor[],
  values: M3LCliParsedValues,
): Record<string, unknown> {
  // Object.create(null) rather than a `{}` literal: a declared parameter
  // literally named "__proto__" must become a genuine own key here — a
  // plain-literal object would route `result["__proto__"] = value` through
  // the inherited setter instead, silently dropping the value before it
  // ever reaches M3LInMemoryConfigProvider's own M3LUnsafeConfigKeyError
  // guard downstream (see buildParseArgsOptions's matching fix above).
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const descriptor of descriptors) {
    const names = [descriptor.name, ...descriptor.aliases];
    const presentKey = names.find((name) => Object.hasOwn(values, name));
    if (presentKey === undefined) {
      continue;
    }
    const value = values[presentKey];
    result[descriptor.name] = Array.isArray(value)
      ? value.map(String).join(",")
      : value;
  }
  return result;
}
