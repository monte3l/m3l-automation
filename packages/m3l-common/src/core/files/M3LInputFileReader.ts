/**
 * `core/files/M3LInputFileReader` — reading an input file under
 * `M3LPaths.resolveInput`, as raw text or parsed/validated JSON.
 *
 * @packageDocumentation
 */

import * as fsp from "node:fs/promises";

import { M3LError } from "../errors/index.js";
import { isDangerousKey } from "../security/index.js";
import type { M3LPaths } from "../utils/index.js";

/** Narrows `value` to `string`. */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Narrows `value` to `number`. Does not reject `NaN` — `typeof NaN === "number"`. */
function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** Narrows `value` to `boolean`. A string `"true"`/`"false"` is deliberately not coerced. */
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Narrows `value` to a plain array (element type left as `unknown`). */
function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Constructor options for {@link M3LInputFileReader}.
 *
 * @example
 * ```ts
 * import type { M3LInputFileReaderOptions } from "@m3l-automation/m3l-common/core";
 * import { M3LPaths } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LInputFileReaderOptions = {
 *   paths: new M3LPaths(),
 *   code: "ERR_MY_SCRIPT_INPUT",
 * };
 * ```
 */
export interface M3LInputFileReaderOptions {
  /** The paths port used to resolve `name` under the input directory. */
  readonly paths: M3LPaths;
  /**
   * Machine-readable error code attached to every `M3LError` this reader
   * throws (not to a passed-through `M3LPathResolutionError`, which always
   * propagates unchanged).
   */
  readonly code: string;
}

/**
 * Reads an input file under `M3LPaths.resolveInput`, as raw text, parsed
 * JSON, or a validated JSON object record.
 *
 * A `name` that escapes the input directory (absolute, or a `..` segment)
 * throws {@link M3LPathResolutionError} unchanged — it is never wrapped into
 * this reader's own `M3LError`/`code`. A missing or unreadable file wraps the
 * raw filesystem error into a bare {@link M3LError} chaining it as `cause`.
 * Malformed JSON throws a bare {@link M3LError} with **no** chained cause and
 * without reading the underlying `SyntaxError`'s `message` — `JSON.parse`'s
 * own message can embed a snippet of the malformed content, which must never
 * leak into a persisted run report.
 *
 * @example
 * ```ts
 * import { M3LInputFileReader, M3LPaths } from "@m3l-automation/m3l-common/core";
 *
 * const reader = new M3LInputFileReader({
 *   paths: new M3LPaths(),
 *   code: "ERR_MY_SCRIPT_INPUT",
 * });
 * const record = await reader.readJSONRecord("payload.json");
 * ```
 */
export class M3LInputFileReader {
  readonly #paths: M3LPaths;
  readonly #code: string;

  /**
   * Creates a new `M3LInputFileReader`.
   *
   * @param options - See {@link M3LInputFileReaderOptions}.
   */
  constructor(options: M3LInputFileReaderOptions) {
    this.#paths = options.paths;
    this.#code = options.code;
  }

  /**
   * Shared skeleton behind every optional field reader: reads `field` off
   * `record`, returns `undefined` when absent, and throws a bare
   * {@link M3LError} when present but rejected by `isValid`. A present field
   * is never silently dropped for being the wrong type — that would mask a
   * caller/config mistake as "unset" (see `.claude/rules/library-src.md` §
   * "Fail loud on caller/config errors").
   */
  #readOptionalField<T>(
    record: Readonly<Record<string, unknown>>,
    field: string,
    isValid: (value: unknown) => value is T,
    typeName: string,
  ): T | undefined {
    const value = record[field];
    if (value === undefined) return undefined;
    if (!isValid(value)) {
      throw new M3LError(`'${field}' must be a ${typeName}`, {
        code: this.#code,
      });
    }
    return value;
  }

  /**
   * Reads the file at `paths.resolveInput(name)` as UTF-8 text.
   *
   * @param name - The input file name, relative to the input directory.
   * @returns The file's UTF-8 text content.
   * @throws {@link M3LPathResolutionError} When `name` escapes the input
   *   directory (absolute path or a `..` segment) — propagated unchanged.
   * @throws {@link M3LError} When the file cannot be read (e.g. it does not
   *   exist), chaining the raw filesystem error as `cause`.
   *
   * @example
   * ```ts
   * const text = await reader.readText("greeting.txt");
   * ```
   */
  async readText(name: string): Promise<string> {
    try {
      const resolved = this.#paths.resolveInput(name);
      return (await fsp.readFile(resolved)).toString("utf8");
    } catch (cause) {
      if (cause instanceof M3LError) throw cause;
      throw new M3LError(`failed reading input file '${name}'`, {
        code: this.#code,
        cause,
      });
    }
  }

  /**
   * Reads and JSON-parses the file at `paths.resolveInput(name)`.
   *
   * Deliberately does not chain the raw `SyntaxError` as `cause` and never
   * reads its `.message` — `JSON.parse`'s own `SyntaxError.message` embeds a
   * snippet (up to ~10 characters) of the malformed content, which would
   * otherwise leak into a persisted run report. Only the failing error's
   * `name` is folded into the thrown message.
   *
   * @param name - The input file name, relative to the input directory.
   * @returns The parsed JSON value.
   * @throws {@link M3LPathResolutionError} When `name` escapes the input
   *   directory — propagated unchanged.
   * @throws {@link M3LError} When the file cannot be read, or when its
   *   content is not valid JSON.
   *
   * @example
   * ```ts
   * const value = await reader.readJSON("payload.json");
   * ```
   */
  async readJSON(name: string): Promise<unknown> {
    const raw = await this.readText(name);
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "SyntaxError";
      throw new M3LError(`'${name}' must be valid JSON (${errorName})`, {
        code: this.#code,
      });
    }
  }

  /**
   * Reads and JSON-parses the file at `paths.resolveInput(name)`, requiring
   * the decoded value to be a plain JSON object.
   *
   * @param name - The input file name, relative to the input directory.
   * @returns The parsed JSON object, as a record.
   * @throws {@link M3LPathResolutionError} When `name` escapes the input
   *   directory — propagated unchanged.
   * @throws {@link M3LError} When the file cannot be read, its content is
   *   not valid JSON, or the decoded value is not a plain object (e.g. an
   *   array, `null`, or a primitive).
   *
   * @example
   * ```ts
   * const record = await reader.readJSONRecord("payload.json");
   * ```
   */
  async readJSONRecord(
    name: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.asRecord(await this.readJSON(name), name);
  }

  /**
   * Narrows an already-parsed JSON value to a plain object.
   *
   * Screens every **top-level** key with `isDangerousKey`, throwing when one
   * is a prototype-pollution vector (`__proto__`, `constructor`, or
   * `prototype`) — the same guard used by `buildSafeValueMap` for config
   * providers. Only the first level of keys is screened; a dangerous key
   * nested inside a safe top-level value is not detected.
   *
   * @param value - The candidate value, typically from {@link readJSON}.
   * @param name - The value's name, for the thrown message.
   * @returns `value`, narrowed to a record.
   * @throws {@link M3LError} When `value` is not a plain object (an array,
   *   `null`, or a primitive), or when it contains a top-level
   *   prototype-pollution vector key.
   *
   * @example
   * ```ts
   * const record = reader.asRecord(JSON.parse(text), "payload");
   * ```
   */
  asRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new M3LError(`'${name}' must decode to a JSON object`, {
        code: this.#code,
      });
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (isDangerousKey(key)) {
        throw new M3LError(`'${name}' contains an unsafe key`, {
          code: this.#code,
        });
      }
    }
    return record;
  }

  /**
   * Returns `record`, throwing when it is `undefined`. Promotes the
   * `requireInput`/`requireDeclarationRecord`-style guard duplicated across
   * consumer scripts' write steps (e.g. `scripts/ecs-ops/src/steps/write-service.ts`),
   * each gating an already-JSON-parsed `input` record before reading its
   * fields.
   *
   * @param record - The candidate record, typically an already-parsed
   *   `input` from {@link readJSONRecord} threaded through as an optional
   *   config value.
   * @param name - The record's name, for the thrown message.
   * @param operation - The operation requiring `record`, for the thrown
   *   message.
   * @returns `record`, narrowed to exclude `undefined`.
   * @throws {@link M3LError} When `record` is `undefined`.
   *
   * @example
   * ```ts
   * const input = reader.requireRecord(maybeInput, "input", "create-service");
   * ```
   */
  requireRecord(
    record: Readonly<Record<string, unknown>> | undefined,
    name: string,
    operation: string,
  ): Readonly<Record<string, unknown>> {
    if (record === undefined) {
      throw new M3LError(`'${name}' is required for '${operation}'`, {
        code: this.#code,
      });
    }
    return record;
  }

  /**
   * Reads a required, non-empty string field off an already-parsed record.
   *
   * @param record - The already-parsed record (typically from
   *   {@link readJSONRecord} / {@link requireRecord}).
   * @param field - The field name to read.
   * @param operation - The operation requiring `field`, for the thrown
   *   message.
   * @returns The field's string value.
   * @throws {@link M3LError} When `field` is absent, not a string, or an
   *   empty string.
   *
   * @example
   * ```ts
   * const taskDefinition =
   *   reader.requiredStringField(input, "taskDefinition", "create-service");
   * ```
   */
  requiredStringField(
    record: Readonly<Record<string, unknown>>,
    field: string,
    operation: string,
  ): string {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new M3LError(
        `'${field}' must be a non-empty string for '${operation}'`,
        { code: this.#code },
      );
    }
    return value;
  }

  /**
   * Reads a required, non-empty array field off an already-parsed record.
   *
   * @param record - The already-parsed record (typically from
   *   {@link readJSONRecord} / {@link requireRecord}).
   * @param field - The field name to read.
   * @param operation - The operation requiring `field`, for the thrown
   *   message.
   * @returns The field's array value (element type left as `unknown` — cast
   *   at the call site, where the concrete shape is known).
   * @throws {@link M3LError} When `field` is absent, not an array, or an
   *   empty array.
   *
   * @example
   * ```ts
   * const stages = reader.requiredArrayField(input, "stages", "create-pipeline");
   * ```
   */
  requiredArrayField(
    record: Readonly<Record<string, unknown>>,
    field: string,
    operation: string,
  ): readonly unknown[] {
    const value = record[field];
    if (!Array.isArray(value) || value.length === 0) {
      throw new M3LError(
        `'${field}' must be a non-empty array for '${operation}'`,
        { code: this.#code },
      );
    }
    return value;
  }

  /**
   * Reads an optional string field off an already-parsed record, defensively
   * re-checking its type.
   *
   * @param record - The already-parsed record.
   * @param field - The field name to read.
   * @returns The field's string value, or `undefined` when absent.
   * @throws {@link M3LError} When `field` is present but not a string.
   *
   * @example
   * ```ts
   * const launchType = reader.optionalStringField(input, "launchType");
   * ```
   */
  optionalStringField(
    record: Readonly<Record<string, unknown>>,
    field: string,
  ): string | undefined {
    return this.#readOptionalField(record, field, isString, "string");
  }

  /**
   * Reads an optional number field off an already-parsed record, defensively
   * re-checking its type. `NaN` passes through unrejected, since
   * `typeof NaN === "number"`.
   *
   * @param record - The already-parsed record.
   * @param field - The field name to read.
   * @returns The field's number value, or `undefined` when absent.
   * @throws {@link M3LError} When `field` is present but not a number.
   *
   * @example
   * ```ts
   * const desiredCount = reader.optionalNumberField(input, "desiredCount");
   * ```
   */
  optionalNumberField(
    record: Readonly<Record<string, unknown>>,
    field: string,
  ): number | undefined {
    return this.#readOptionalField(record, field, isNumber, "number");
  }

  /**
   * Reads an optional boolean field off an already-parsed record, defensively
   * re-checking its type. A string `"true"`/`"false"` is deliberately not
   * coerced — it throws.
   *
   * @param record - The already-parsed record.
   * @param field - The field name to read.
   * @returns The field's boolean value, or `undefined` when absent.
   * @throws {@link M3LError} When `field` is present but not a boolean.
   *
   * @example
   * ```ts
   * const forceNewDeployment =
   *   reader.optionalBooleanField(input, "forceNewDeployment");
   * ```
   */
  optionalBooleanField(
    record: Readonly<Record<string, unknown>>,
    field: string,
  ): boolean | undefined {
    return this.#readOptionalField(record, field, isBoolean, "boolean");
  }

  /**
   * Reads an optional array field off an already-parsed record, defensively
   * re-checking its type.
   *
   * @param record - The already-parsed record.
   * @param field - The field name to read.
   * @returns The field's array value (element type left as `unknown` — cast
   *   at the call site), or `undefined` when absent.
   * @throws {@link M3LError} When `field` is present but not an array.
   *
   * @example
   * ```ts
   * const loadBalancers = reader.optionalArrayField(input, "loadBalancers");
   * ```
   */
  optionalArrayField(
    record: Readonly<Record<string, unknown>>,
    field: string,
  ): readonly unknown[] | undefined {
    return this.#readOptionalField(record, field, isArray, "array");
  }

  /**
   * Reads an optional plain-object field off an already-parsed record. Reuses
   * {@link asRecord} once `field` is known to be present, so a present field
   * gets the same object-shape check and top-level prototype-pollution key
   * screen as any other decoded JSON object.
   *
   * @param record - The already-parsed record.
   * @param field - The field name to read.
   * @returns The field's record value, or `undefined` when absent.
   * @throws {@link M3LError} When `field` is present but not a plain object,
   *   or contains a top-level prototype-pollution vector key.
   *
   * @example
   * ```ts
   * const networkConfiguration =
   *   reader.optionalRecordField(input, "networkConfiguration");
   * ```
   */
  optionalRecordField(
    record: Readonly<Record<string, unknown>>,
    field: string,
  ): Readonly<Record<string, unknown>> | undefined {
    const value = record[field];
    if (value === undefined) return undefined;
    return this.asRecord(value, field);
  }
}
