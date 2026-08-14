/**
 * `presets/store` — preset-file discovery, schema derivation from a script's
 * declared parameters, preset-record reading (through
 * `Core.M3LScriptPresetLoader`), and secret-refusing preset writes.
 *
 * @packageDocumentation
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../cli/errors.js";
import type { M3LCliParameterDescriptor } from "../discovery/load-config.js";

/** Indentation width for a pretty-printed preset file. */
const PRESET_JSON_INDENT = 2;

/** A preset name may only contain lowercase letters, digits, and hyphens. */
const PRESET_NAME_PATTERN = /^[a-z0-9-]+$/;

/** Maps a recognized preset file extension to its format label. */
const PRESET_EXTENSION_FORMATS: Readonly<Record<string, "json" | "yaml">> = {
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};

/**
 * A discovered preset file: its name (basename sans extension), absolute
 * path, and format.
 *
 * @example
 * ```ts
 * const file: M3LCliPresetFile = {
 *   name: "prod",
 *   filePath: "/repo/data/config/presets/prod.json",
 *   format: "json",
 * };
 * ```
 */
export interface M3LCliPresetFile {
  /** The preset's name — its filename with the extension stripped. */
  readonly name: string;
  /** The preset file's absolute path. */
  readonly filePath: string;
  /** The preset file's format, inferred from its extension. */
  readonly format: "json" | "yaml";
}

/**
 * Resolves the workspace's presets directory: `<workspaceRoot>/data/config/presets`.
 *
 * @param workspaceRoot - The resolved workspace root.
 * @returns The presets directory's absolute path.
 */
function presetsDirectory(workspaceRoot: string): string {
  return join(workspaceRoot, "data", "config", "presets");
}

/**
 * Lists every `.json`/`.yaml`/`.yml` file in the workspace's presets
 * directory, sorted by name. Any other extension is skipped.
 *
 * @param workspaceRoot - The resolved workspace root.
 * @returns The discovered preset files, sorted by name; `[]` when the
 *   presets directory does not exist.
 *
 * @example
 * ```ts
 * const files = listPresetFiles("/repo");
 * // [{ name: "dev", filePath: "/repo/data/config/presets/dev.yaml", format: "yaml" }, ...]
 * ```
 */
export function listPresetFiles(
  workspaceRoot: string,
): readonly M3LCliPresetFile[] {
  const directory = presetsDirectory(workspaceRoot);
  if (!existsSync(directory)) {
    return [];
  }

  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch (cause) {
    throw new M3LCliError(
      "ERR_CLI_PRESET_INVALID",
      `failed to list preset files in '${directory}'`,
      { cause },
    );
  }

  const files: M3LCliPresetFile[] = [];
  for (const entry of entries) {
    const extension = extname(entry).toLowerCase();
    const format = PRESET_EXTENSION_FORMATS[extension];
    if (format === undefined) {
      continue;
    }
    files.push({
      name: entry.slice(0, entry.length - extension.length),
      filePath: join(directory, entry),
      format,
    });
  }

  return files.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Maps a descriptor's declared `type` string back to a
 * {@link Core.M3LConfigParameterType} member, falling back to `STRING` for
 * an unrecognized value.
 */
function resolveParameterType(type: string): Core.M3LConfigParameterType {
  const values: readonly string[] = Object.values(Core.M3LConfigParameterType);
  return values.includes(type)
    ? (type as Core.M3LConfigParameterType)
    : Core.M3LConfigParameterType.STRING;
}

/**
 * Builds a throwaway {@link Core.M3LConfigSchema} from a script's described
 * parameters, purely so {@link Core.M3LScriptPresetLoader} can validate a
 * preset's top-level keys against the script's declared names/aliases.
 * Every declared parameter is mapped `required: false` — a preset is
 * partial by nature, so a preset schema must never enforce a script's own
 * `required` declarations.
 *
 * @param descriptors - The script's described parameters.
 * @returns A schema declaring the same names/aliases/types, never `required`.
 *
 * @example
 * ```ts
 * const schema = buildSchemaFromDescriptors(descriptors);
 * schema.has("region"); // true when a "region" parameter was declared
 * ```
 */
export function buildSchemaFromDescriptors(
  descriptors: readonly M3LCliParameterDescriptor[],
): Core.M3LConfigSchema {
  return new Core.M3LConfigSchema(
    descriptors.map(
      (descriptor) =>
        new Core.M3LConfigParameter({
          name: descriptor.name,
          type: resolveParameterType(descriptor.type),
          aliases: descriptor.aliases,
          description: descriptor.description,
        }),
    ),
  );
}

/** Node `errno` codes classified as "permission denied" by {@link classifyPresetLoadFailure}. */
const PERMISSION_ERRNO_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EPERM",
]);

/**
 * Checks whether `error` is a Node `ErrnoException` whose `code` is in
 * `codes`.
 *
 * @param error - The candidate value to check.
 * @param codes - The `errno` codes to match against.
 * @returns Whether `error` is an `ErrnoException` with a matching `code`.
 */
function hasErrnoCode(error: unknown, codes: ReadonlySet<string>): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    codes.has((error as NodeJS.ErrnoException).code ?? "")
  );
}

/**
 * Classifies a `loader.load(...)` failure into a content-free category
 * string — never the raw `cause.message`, since `M3LScriptPresetLoader`'s
 * own error messages can embed snippets of the preset file's content (e.g. an
 * offending key's literal name from a malformed structure), which would leak
 * through an otherwise-generic "invalid preset" surface if printed verbatim.
 * Only key *names* (from {@link Core.M3LPresetUnknownKeysError.unknownKeys})
 * are safe to include, since those are already validated against the
 * script's own declared schema, not attacker-controlled file content.
 *
 * @param cause - The value {@link Core.M3LScriptPresetLoader.load} threw.
 * @returns A content-free category string describing the failure.
 */
function classifyPresetLoadFailure(cause: unknown): string {
  if (hasErrnoCode(cause, PERMISSION_ERRNO_CODES)) {
    return "permission denied";
  }
  if (cause instanceof Core.M3LPresetUnknownKeysError) {
    return `unknown keys: ${cause.unknownKeys.join(", ")}`;
  }
  if (cause instanceof Core.M3LError) {
    if (cause.code === "ERR_PRESET_LOAD") {
      return hasErrnoCode(cause.cause, PERMISSION_ERRNO_CODES)
        ? "permission denied"
        : "invalid or unparseable";
    }
    if (cause.code === "ERR_PRESET_TOO_DEEP") {
      return "nesting too deep";
    }
  }
  return "invalid preset";
}

/**
 * Reads and validates a preset file's top-level record against `descriptors`,
 * through {@link Core.M3LScriptPresetLoader}.
 *
 * @param filePath - The preset file's absolute path.
 * @param descriptors - The script's described parameters, used to derive the
 *   validating schema (see {@link buildSchemaFromDescriptors}).
 * @returns The preset's validated top-level record.
 * @throws {@link M3LCliError} coded `ERR_CLI_PRESET_INVALID` when the file
 *   cannot be read/parsed, or declares an unrecognized key. The message
 *   carries only a content-free category (see
 *   {@link classifyPresetLoadFailure}) — never the loader's raw message,
 *   which can embed snippets of the preset file's own content; the loader's
 *   own error is still chained as `cause` for a caller that wants to
 *   `instanceof`-narrow it directly.
 *
 * @example
 * ```ts
 * const record = readPresetRecord(
 *   "/repo/data/config/presets/prod.json",
 *   descriptors,
 * );
 * ```
 */
export function readPresetRecord(
  filePath: string,
  descriptors: readonly M3LCliParameterDescriptor[],
): Record<string, unknown> {
  try {
    const loader = new Core.M3LScriptPresetLoader({
      schema: buildSchemaFromDescriptors(descriptors),
    });
    return loader.load(filePath);
  } catch (cause) {
    throw new M3LCliError(
      "ERR_CLI_PRESET_INVALID",
      `failed to load preset file '${filePath}': ${classifyPresetLoadFailure(cause)}`,
      { cause },
    );
  }
}

/** The result of a {@link writePreset} call. */
export interface M3LCliPresetWriteResult {
  /** The written preset file's absolute path. */
  readonly filePath: string;
  /** The parameter names actually persisted. */
  readonly written: readonly string[];
  /** The secret-flagged parameter names refused, never persisted. */
  readonly skippedSecrets: readonly string[];
}

/**
 * Writes `values` as a named preset under
 * `<workspaceRoot>/data/config/presets/<presetName>.json`, refusing to
 * persist any key whose descriptor is not explicitly `secret: false`
 * (collected into {@link M3LCliPresetWriteResult.skippedSecrets} for the
 * caller to report — their raw values are never written). This is
 * fail-closed by design: a key whose descriptor carries no `secret` field at
 * all, or explicitly `secret: true`, is skipped exactly like a proven-secret
 * key — only an explicit `secret: false` proves it safe to persist. (In
 * practice {@link Core}'s `describeParameters` always assigns an explicit
 * `true`/`false`, never leaves it `undefined`; the fail-closed check exists
 * for a stale/hand-built descriptor that predates that guarantee.)
 *
 * Writes atomically: the record is written to a same-directory temp file,
 * then renamed over `filePath`, so a reader never observes a partially
 * written file and a symlink at `filePath` is never followed for the write
 * itself (only the atomic `rename` targets it).
 *
 * @param workspaceRoot - The resolved workspace root.
 * @param presetName - The preset's name; must match `[a-z0-9-]+`.
 * @param values - The parameter values to persist, keyed by declared name.
 * @param descriptors - The script's described parameters.
 * @returns The written file's path, the persisted key names, and the
 *   secret-flagged (or unproven-safe) key names refused.
 * @throws {@link M3LCliError} coded `ERR_CLI_PRESET_INVALID` when
 *   `presetName` is invalid, `values` names a key with no matching
 *   descriptor, or the write itself fails (a Node error chained as `cause`)
 *   — write failures are loud, not best-effort, since this is an explicit
 *   user request.
 *
 * @example
 * ```ts
 * const result = writePreset(
 *   "/repo",
 *   "prod",
 *   { region: "us-east-1" },
 *   descriptors,
 * );
 * // { filePath: "/repo/data/config/presets/prod.json", written: ["region"], skippedSecrets: [] }
 * ```
 */
export function writePreset(
  workspaceRoot: string,
  presetName: string,
  values: Readonly<Record<string, string | boolean | readonly string[]>>,
  descriptors: readonly M3LCliParameterDescriptor[],
): M3LCliPresetWriteResult {
  if (!PRESET_NAME_PATTERN.test(presetName)) {
    throw new M3LCliError(
      "ERR_CLI_PRESET_INVALID",
      `invalid preset name '${presetName}' — must match /^[a-z0-9-]+$/`,
    );
  }

  const descriptorByName = new Map(
    descriptors.map((descriptor) => [descriptor.name, descriptor] as const),
  );
  const unknownKeys = Object.keys(values).filter(
    (key) => !descriptorByName.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new M3LCliError(
      "ERR_CLI_PRESET_INVALID",
      `preset '${presetName}' declares unknown parameter key(s): ${unknownKeys.join(", ")}`,
    );
  }

  const written: string[] = [];
  const skippedSecrets: string[] = [];
  const record: Record<string, string | boolean | readonly string[]> = {};

  for (const [key, value] of Object.entries(values)) {
    const descriptor = descriptorByName.get(key);
    // Fail-closed: only an explicit `secret: false` proves a key safe to
    // persist. Absent, `undefined`, or `secret: true` all skip — never write
    // a value this CLI cannot positively prove is non-secret.
    if (descriptor?.secret === false) {
      record[key] = value;
      written.push(key);
    } else {
      skippedSecrets.push(key);
    }
  }

  const directory = presetsDirectory(workspaceRoot);
  const filePath = join(directory, `${presetName}.json`);
  const tempFilePath = join(directory, `.${presetName}.${randomUUID()}.tmp`);

  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      tempFilePath,
      JSON.stringify(record, undefined, PRESET_JSON_INDENT),
      "utf8",
    );
    renameSync(tempFilePath, filePath);
  } catch (cause) {
    // Best-effort cleanup of the temp file — its own failure (e.g. the temp
    // file was never created because mkdirSync/writeFileSync failed first)
    // must never shadow the real write failure being thrown below.
    try {
      unlinkSync(tempFilePath);
    } catch {
      /* ignore — the write failure above is what matters */
    }
    throw new M3LCliError(
      "ERR_CLI_PRESET_INVALID",
      `failed to write preset file '${filePath}'`,
      { cause },
    );
  }

  return { filePath, written, skippedSecrets };
}
