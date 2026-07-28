import * as fsp from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";

/**
 * `steps/config-helpers` — shared config-reading and input-file helpers used
 * only by `run-eks-ops.ts`'s dispatch functions (the `codepipeline-ops`/
 * `ecs-ops` precedent), extracted to keep the dispatcher under the
 * `scripts/*\/src/**` ESLint per-function line/complexity caps.
 *
 * @packageDocumentation
 */

/** Narrows `value` to `string` — the {@link readOptionalString}/{@link readOptionalStringArray} predicate. */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Narrows `value` to `number` — the {@link readOptionalNumber}/{@link readNumberWithDefault} predicate. */
function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** Narrows `value` to `boolean` — the {@link readBoolWithDefault} predicate. */
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Shared skeleton behind every scalar config reader below: reads `name`,
 * returns `undefined` when unset, and throws `ERR_EKS_OPS_CONFIG` when set to
 * a value `isValid` rejects. Extracted because {@link readOptionalString},
 * {@link readOptionalNumber}, {@link readBoolWithDefault}, and
 * {@link readNumberWithDefault} previously duplicated this exact shape with
 * only the type check and label varying.
 */
function readTypedConfigValue<T>(
  config: Core.M3LConfig,
  name: string,
  isValid: (value: unknown) => value is T,
  typeName: string,
): T | undefined {
  const value: unknown = config.get(name);
  if (value === undefined) return undefined;
  if (!isValid(value)) {
    throw new Core.M3LError(`'${name}' must be a ${typeName}`, {
      code: "ERR_EKS_OPS_CONFIG",
    });
  }
  return value;
}

/** Reads an optional string parameter, defensively re-checking its type (`undefined` when unset). */
export function readOptionalString(
  config: Core.M3LConfig,
  name: string,
): string | undefined {
  return readTypedConfigValue(config, name, isString, "string");
}

/** Reads an optional number parameter, defensively re-checking its type (`undefined` when unset). */
export function readOptionalNumber(
  config: Core.M3LConfig,
  name: string,
): number | undefined {
  return readTypedConfigValue(config, name, isNumber, "number");
}

/**
 * Reads a boolean parameter, falling back to `defaultValue` when unset. A
 * `Core.M3LConfig` built directly (as tests do) never applies a declared
 * parameter's `defaultValue` — only `M3LScript.getConfiguration()` does — so
 * this reproduces that default at the read site.
 */
export function readBoolWithDefault(
  config: Core.M3LConfig,
  name: string,
  defaultValue: boolean,
): boolean {
  return (
    readTypedConfigValue(config, name, isBoolean, "boolean") ?? defaultValue
  );
}

/**
 * Reads a number parameter, falling back to `defaultValue` when unset — the
 * numeric counterpart to {@link readBoolWithDefault}.
 */
export function readNumberWithDefault(
  config: Core.M3LConfig,
  name: string,
  defaultValue: number,
): number {
  return readTypedConfigValue(config, name, isNumber, "number") ?? defaultValue;
}

/**
 * Reads an optional string-array parameter (`include`), defensively
 * re-checking its type (`undefined` when unset). Tolerates both an
 * already-coerced `readonly string[]` (the shape `config.get()` returns in
 * production, once `M3LScript.getConfiguration()` has run the declared
 * `STRING_ARRAY` parameter's coercion) and a raw comma-separated `string`
 * (the shape a `Core.M3LConfig` built directly — as tests do — stores
 * verbatim, bypassing that coercion).
 */
export function readOptionalStringArray(
  config: Core.M3LConfig,
  name: string,
): readonly string[] | undefined {
  const value: unknown = config.get(name);
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new Core.M3LError(`'${name}' must be a string array`, {
    code: "ERR_EKS_OPS_CONFIG",
  });
}

/** Returns `value`, throwing `ERR_EKS_OPS_CONFIG` when it is `undefined` — the per-operation cross-parameter guard. */
export function requireString(
  value: string | undefined,
  name: string,
  operation: string,
): string {
  if (value === undefined) {
    throw new Core.M3LError(
      `'${name}' is required for operation '${operation}'`,
      { code: "ERR_EKS_OPS_CONFIG" },
    );
  }
  return value;
}

/** Reads the file at `paths.resolveInput(name)` as raw text — the one place `input` is ever read. */
async function readInputFileText(
  paths: Core.M3LPaths,
  name: string,
): Promise<string> {
  const resolved = paths.resolveInput(name);
  try {
    return (await fsp.readFile(resolved)).toString("utf8");
  } catch (cause) {
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(`failed reading input file '${name}'`, {
      code: "ERR_EKS_OPS_CONFIG",
      cause,
    });
  }
}

/**
 * Parses `raw` as JSON. Deliberately does **not** chain the raw `SyntaxError`
 * as `cause` and never reads its `.message` — a deliberate deviation from the
 * rest of the fleet (tracked as deferred fleet-wide friction item F10):
 * `JSON.parse`'s own `SyntaxError.message` embeds a snippet (up to ~10
 * characters) of the malformed content, which would otherwise leak into a
 * persisted run report via the error's `cause` chain. Only the failing
 * error's `name` is folded into the thrown message.
 */
function parseJSON(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "SyntaxError";
    throw new Core.M3LError(`'${name}' must be valid JSON (${errorName})`, {
      code: "ERR_EKS_OPS_CONFIG",
    });
  }
}

/**
 * Reads and JSON-parses `input` under `M3L_INPUT_DIR`, for `create-cluster`/
 * `update-cluster-config`/`create-nodegroup`/`update-nodegroup-config`. The
 * read and the parse are two genuinely distinct fallible operations (a
 * missing file vs. malformed JSON), so each is handled by its own helper —
 * see {@link parseJSON}'s TSDoc for why the parse failure is never chained.
 */
export async function readJSONFile(
  paths: Core.M3LPaths,
  name: string,
): Promise<unknown> {
  const raw = await readInputFileText(paths, name);
  return parseJSON(raw, name);
}

/** Narrows an already-parsed JSON value to a plain object, for the four `input`-bearing operations. */
export function asInputRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Core.M3LError(`'${name}' must decode to a JSON object`, {
      code: "ERR_EKS_OPS_CONFIG",
    });
  }
  return value as Record<string, unknown>;
}
