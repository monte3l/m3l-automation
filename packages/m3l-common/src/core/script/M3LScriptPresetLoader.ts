/**
 * `core/script/M3LScriptPresetLoader` — loads a named parameter preset from a
 * YAML or JSON file, enforcing a bounded nesting depth and validating every
 * top-level key against a declared config schema.
 *
 * @packageDocumentation
 */

import * as fs from "fs";
import * as path from "path";

import { parse as parseYaml } from "yaml";

import { findClosestMatch } from "../../internal/script/damerauLevenshtein.js";
import { isWithinMaxDepth } from "../../internal/script/presetDepth.js";
import type { M3LConfigSchema } from "../config/index.js";
import { M3LUnsafeConfigKeyError } from "../config/index.js";
import { M3LError } from "../errors/index.js";
import { isDangerousKey } from "../security/index.js";

import { M3LPresetCycleError } from "./M3LPresetCycleError.js";
import { M3LPresetUnknownKeysError } from "./M3LPresetUnknownKeysError.js";
import type { M3LPresetUnknownKeySuggestion } from "./M3LPresetUnknownKeysError.js";

/**
 * Maximum allowed nesting depth for a parsed preset structure. A preset
 * whose deepest branch exceeds this value is rejected before any key
 * validation runs.
 *
 * Not exported — an implementation constant, not part of the public
 * contract (callers only observe the resulting throw).
 */
const MAX_PRESET_STRUCTURE_DEPTH = 64;

/**
 * Maximum allowed length of an `extends` inheritance chain. A chain longer
 * than this is treated as a cycle for safety (a runaway or pathological
 * chain is indistinguishable in effect from an actual cycle).
 *
 * Not exported — an implementation constant, not part of the public
 * contract (callers only observe the resulting throw).
 */
const MAX_PRESET_EXTENDS_DEPTH = 16;

/** File extensions recognized as YAML by {@link M3LScriptPresetLoader.load}. */
const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);

/** Machine-readable code for a preset load/parse failure. */
const PRESET_LOAD_ERROR_CODE = "ERR_PRESET_LOAD";

/** Machine-readable code for a preset exceeding the max nesting depth. */
const PRESET_TOO_DEEP_CODE = "ERR_PRESET_TOO_DEEP";

/**
 * Thrown when a preset file cannot be read or parsed, or when its parsed
 * structure is not a plain object.
 *
 * Not exported from the `script` barrel: callers observe this failure only
 * as an {@link M3LError} (optionally narrowed by `code === "ERR_PRESET_LOAD"`),
 * matching this file's convention of keeping preset-internal errors (see also
 * `M3LPresetTooDeepError` below) unexported.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   // loader.load(...)
 * } catch (e) {
 *   if (e instanceof M3LError && e.code === "ERR_PRESET_LOAD") {
 *     // malformed preset file
 *   }
 * }
 * ```
 */
class M3LPresetLoadError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_PRESET_LOAD"`. */
  override readonly code: typeof PRESET_LOAD_ERROR_CODE =
    PRESET_LOAD_ERROR_CODE;

  /**
   * Creates a new `M3LPresetLoadError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional `cause` carrying the underlying error.
   */
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { code: PRESET_LOAD_ERROR_CODE, cause: options.cause });
  }
}

/**
 * Thrown when a preset's parsed structure nests deeper than
 * {@link MAX_PRESET_STRUCTURE_DEPTH}.
 *
 * Not exported from the `script` barrel — see {@link M3LPresetLoadError}'s
 * doc for the shared rationale.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   // loader.load(...)
 * } catch (e) {
 *   if (e instanceof M3LError && e.code === "ERR_PRESET_TOO_DEEP") {
 *     // pathologically nested preset file
 *   }
 * }
 * ```
 */
class M3LPresetTooDeepError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_PRESET_TOO_DEEP"`. */
  override readonly code: typeof PRESET_TOO_DEEP_CODE = PRESET_TOO_DEEP_CODE;

  /**
   * Creates a new `M3LPresetTooDeepError`.
   *
   * @param message - Human-readable description of the failure.
   */
  constructor(message: string) {
    super(message, { code: PRESET_TOO_DEEP_CODE });
  }
}

/**
 * Constructor options for {@link M3LScriptPresetLoader}.
 *
 * Not exported from the `script` barrel — it is only ever supplied inline at
 * the `new M3LScriptPresetLoader(...)` call site, so callers never need to
 * name this shape directly.
 */
interface M3LScriptPresetLoaderOptions {
  /**
   * The declared config schema every preset key is validated against.
   * Omitted (or a schema with no declared names) means every top-level
   * preset key is treated as unknown.
   */
  readonly schema?: M3LConfigSchema;
}

/**
 * Reads and parses `filePath` as YAML or JSON, selected by file extension
 * (`.yaml`/`.yml` parse as YAML; anything else, including `.json`, parses as
 * JSON).
 *
 * Both the read and the parse are covered by the same catch: a missing or
 * unreadable file (`ENOENT`/`EACCES`/any other OS error) surfaces as
 * {@link M3LPresetLoadError} exactly like a parse failure does, chaining the
 * underlying error as `cause` — never a raw, untyped Node `Error`.
 */
function parsePresetFile(filePath: string): unknown {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const extension = path.extname(filePath).toLowerCase();
    return YAML_EXTENSIONS.has(extension)
      ? parseYaml(content)
      : (JSON.parse(content) as unknown);
  } catch (cause) {
    throw new M3LPresetLoadError(
      `Failed to read or parse preset file: ${filePath}`,
      { cause },
    );
  }
}

/** Builds the "did you mean" suggestion list for every unknown key. */
function buildSuggestions(
  unknownKeys: readonly string[],
  declaredNames: readonly string[],
): readonly M3LPresetUnknownKeySuggestion[] {
  return unknownKeys.map((key) => ({
    key,
    suggestion: findClosestMatch(key, declaredNames),
  }));
}

/** Builds the human-readable message for {@link M3LPresetUnknownKeysError}. */
function buildUnknownKeysMessage(
  suggestions: readonly M3LPresetUnknownKeySuggestion[],
): string {
  const parts = suggestions.map(({ key, suggestion }) =>
    suggestion === undefined
      ? `"${key}" (no similar declared parameter found)`
      : `"${key}" (did you mean "${suggestion}"?)`,
  );
  return `Preset declares unrecognized key(s): ${parts.join(", ")}`;
}

/**
 * Loads named parameter presets from a YAML or JSON file.
 *
 * Enforces a maximum nesting depth of {@link MAX_PRESET_STRUCTURE_DEPTH} and
 * validates every top-level key against the constructor-supplied config
 * schema, throwing {@link M3LPresetUnknownKeysError} (with
 * Damerau-Levenshtein "did you mean" suggestions) for any key the schema
 * does not declare.
 *
 * A preset may also declare a top-level `extends: <path>` to inherit from a
 * base preset, resolved relative to the extending file's directory (see
 * docs/reference/core/script.md, "Preset inheritance"). The base and derived
 * presets are combined with a **shallow** merge: each derived top-level key
 * wholly replaces the base's key of the same name (arrays/objects are
 * replaced as a unit, never deep-merged). A chain is resolved deepest base
 * first, so folding proceeds from the root base outward and the nearest
 * (most derived) override always wins. The `extends` key itself is stripped
 * before validation, and the nesting-depth and unknown-key checks run once,
 * against the fully merged result. A cycle in the `extends` graph, or a
 * chain deeper than {@link MAX_PRESET_EXTENDS_DEPTH}, throws
 * {@link M3LPresetCycleError}.
 *
 * @example
 * ```ts
 * import { M3LScriptPresetLoader } from "@m3l-automation/m3l-common/core";
 *
 * const loader = new M3LScriptPresetLoader();
 * const preset = loader.load("./data/config/presets/prod.yaml");
 * ```
 */
export class M3LScriptPresetLoader {
  private readonly declaredNames: readonly string[];

  /**
   * Creates a new `M3LScriptPresetLoader`.
   *
   * @param options - Optional config schema to validate preset keys
   *   against. Omitted (or a schema declaring no names) means every
   *   top-level preset key is treated as unknown.
   */
  constructor(options: M3LScriptPresetLoaderOptions = {}) {
    this.declaredNames = options.schema?.declaredNames() ?? [];
  }

  /**
   * Reads and parses the preset file at `absPath`, resolving and merging any
   * `extends` base first (deepest base wins the fold order — see
   * {@link M3LScriptPresetLoader}'s class-level TSDoc for the full shallow-merge
   * contract). Only the "must be a plain mapping" structural guard runs here,
   * per file in the chain; the nesting-depth, dangerous-key, and unknown-key
   * guards run exactly once, in {@link load}, against the fully merged
   * result.
   *
   * @param absPath - Absolute path to the preset file to resolve.
   * @param seen - The absolute paths already visited in this chain, in visit
   *   order; used to detect a cycle and to cap the chain length.
   * @returns The parsed (and, if applicable, merged) preset record, with any
   *   `extends` key stripped.
   * @throws {@link M3LPresetLoadError} When the file cannot be read or
   *   parsed, its top-level structure is not a plain object, or its
   *   `extends` value is present but not a string.
   * @throws {@link M3LPresetCycleError} When `absPath` revisits a path
   *   already in `seen`, or the chain exceeds
   *   {@link MAX_PRESET_EXTENDS_DEPTH}.
   */
  #resolveWithExtends(
    absPath: string,
    seen: Set<string>,
  ): Record<string, unknown> {
    if (seen.has(absPath)) {
      throw new M3LPresetCycleError(
        `Cycle detected in preset "extends" chain at: ${absPath}`,
        [...seen, absPath],
      );
    }
    if (seen.size >= MAX_PRESET_EXTENDS_DEPTH) {
      throw new M3LPresetCycleError(
        `Preset "extends" chain exceeds the maximum depth of ${String(MAX_PRESET_EXTENDS_DEPTH)} at: ${absPath}`,
        [...seen, absPath],
      );
    }
    seen.add(absPath);

    const parsed = parsePresetFile(absPath);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new M3LPresetLoadError(
        `Expected a mapping at the top level of preset file: ${absPath}`,
      );
    }

    const derived = parsed as Record<string, unknown>;
    const extendsValue = derived["extends"];

    if (extendsValue === undefined) {
      return derived;
    }
    if (typeof extendsValue !== "string") {
      throw new M3LPresetLoadError(
        `Expected "extends" to be a string path in preset file: ${absPath}`,
      );
    }

    const basePath = path.resolve(path.dirname(absPath), extendsValue);
    const base = this.#resolveWithExtends(basePath, seen);

    const { extends: _drop, ...rest } = derived;
    return { ...base, ...rest };
  }

  /**
   * Reads, parses, resolves any `extends` inheritance, and validates the
   * preset file at `filePath`.
   *
   * @param filePath - Path to the YAML or JSON preset file.
   * @returns The parsed (and merged, if the file or any of its bases declare
   *   `extends`) preset as a plain record, with `extends` stripped at every
   *   level.
   * @throws {@link M3LPresetLoadError} When the file (or a base it extends)
   *   cannot be read (e.g. `ENOENT`, `EACCES`) or parsed, its top-level
   *   structure is not a plain object, or its `extends` value is present but
   *   not a string.
   * @throws {@link M3LPresetCycleError} When the `extends` graph cycles back
   *   to a file already in the chain, or the chain exceeds
   *   {@link MAX_PRESET_EXTENDS_DEPTH}.
   * @throws {@link M3LPresetTooDeepError} When the merged structure nests
   *   deeper than {@link MAX_PRESET_STRUCTURE_DEPTH}.
   * @throws {@link M3LUnsafeConfigKeyError} When a top-level key of the
   *   merged result is a prototype-pollution vector (`__proto__`,
   *   `constructor`, `prototype`).
   * @throws {@link M3LPresetUnknownKeysError} When a top-level key of the
   *   merged result is not declared in the constructor-supplied schema.
   */
  load(filePath: string): Record<string, unknown> {
    const merged = this.#resolveWithExtends(path.resolve(filePath), new Set());

    if (!isWithinMaxDepth(merged, MAX_PRESET_STRUCTURE_DEPTH)) {
      throw new M3LPresetTooDeepError(
        `Preset file exceeds the maximum nesting depth of ${String(MAX_PRESET_STRUCTURE_DEPTH)}: ${filePath}`,
      );
    }

    for (const key of Object.keys(merged)) {
      if (isDangerousKey(key)) {
        throw new M3LUnsafeConfigKeyError(
          `Refusing to read unsafe preset key: "${key}"`,
          { context: { key, filePath } },
        );
      }
    }

    const declared = new Set(this.declaredNames);
    // Only scalar-valued top-level keys are checked against the declared
    // schema. A top-level key whose value is itself an object/array is a
    // structural nesting wrapper (e.g. a grouped section of related
    // parameters), not a parameter name in its own right, so it is exempt
    // from "unknown key" validation — only its own nested keys would be
    // (this loader validates one level deep, matching
    // M3LUnknownParameterDetector's flat-key contract elsewhere in the
    // config module).
    const unknownKeys = Object.keys(merged).filter((key) => {
      const value = merged[key];
      const isNestedContainer = typeof value === "object" && value !== null;
      return !isNestedContainer && !declared.has(key);
    });

    if (unknownKeys.length > 0) {
      const suggestions = buildSuggestions(unknownKeys, this.declaredNames);
      throw new M3LPresetUnknownKeysError(
        buildUnknownKeysMessage(suggestions),
        unknownKeys,
        suggestions,
      );
    }

    return merged;
  }
}
