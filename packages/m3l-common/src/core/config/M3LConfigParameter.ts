/**
 * `core/config/M3LConfigParameter` — a declared configuration parameter and
 * its 8-level resolution chain.
 *
 * @packageDocumentation
 */

import { coerceConfigValue } from "./coerceConfigValue.js";
import type {
  M3LCoercedValue,
  M3LConfigParameterType,
} from "./M3LConfigParameterType.js";
import type { M3LConfigReader } from "./M3LConfigReader.js";

/**
 * Constructor options for {@link M3LConfigParameter}.
 */
interface M3LConfigParameterOptions<TType extends M3LConfigParameterType> {
  /** The canonical parameter name (its primary lookup key). */
  readonly name: string;
  /** The declared coercion target type. */
  readonly type: TType;
  /** Alternate lookup keys tried alongside `name`. */
  readonly aliases?: readonly string[];
  /**
   * Fallback value used when no provider supplies a value. Returned as-is —
   * it is never passed through {@link coerceConfigValue}.
   */
  readonly defaultValue?: M3LCoercedValue<TType>;
  /**
   * Async fallback invoked when no provider value and no `defaultValue` are
   * available. Its result is returned as-is — it is never coerced.
   */
  readonly asyncFallback?: () => Promise<M3LCoercedValue<TType>>;
}

/**
 * A declared configuration parameter: a name, its coercion target type,
 * optional aliases, and an optional default/fallback chain.
 *
 * Resolution order (`getValueAsync`), short-circuiting strictly at the first
 * satisfied level:
 * 1. A provider-supplied raw value (via the reader, tried under `name` then
 *    each alias) — coerced via {@link coerceConfigValue}.
 * 2. `defaultValue`, if defined — returned unmodified.
 * 3. `asyncFallback()`, if defined — its resolved value returned unmodified.
 * 4. `undefined`.
 *
 * @typeParam TType - The declared coercion target type. The resolved value
 *   type ({@link M3LCoercedValue}`<TType>`) is DERIVED from `type` — there is
 *   no independent caller generic, so `defaultValue`/`asyncFallback` are
 *   type-checked against the declared `type` (e.g. an `INT` parameter's
 *   `defaultValue` must be a `number`, not a string).
 *
 * @example
 * ```ts
 * import {
 *   M3LConfigParameter,
 *   M3LConfigParameterType,
 *   M3LConfigReader,
 *   M3LEnvironmentConfigProvider,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const reader = new M3LConfigReader([new M3LEnvironmentConfigProvider()]);
 * const port = new M3LConfigParameter({
 *   name: "PORT",
 *   type: M3LConfigParameterType.INT,
 *   defaultValue: 3000,
 * });
 * const value = await port.getValueAsync(reader); // number | undefined
 * ```
 */
export class M3LConfigParameter<
  TType extends M3LConfigParameterType = M3LConfigParameterType,
> {
  private readonly name: string;
  private readonly type: TType;
  private readonly aliases: readonly string[];
  private readonly defaultValue: M3LCoercedValue<TType> | undefined;
  private readonly asyncFallback:
    (() => Promise<M3LCoercedValue<TType>>) | undefined;

  /**
   * Creates a new `M3LConfigParameter`.
   *
   * @param options - The parameter declaration.
   */
  constructor(options: M3LConfigParameterOptions<TType>) {
    this.name = options.name;
    this.type = options.type;
    this.aliases = options.aliases ?? [];
    this.defaultValue = options.defaultValue;
    this.asyncFallback = options.asyncFallback;
  }

  /** The parameter's canonical name. */
  getName(): string {
    return this.name;
  }

  /** The parameter's declared aliases. */
  getAliases(): readonly string[] {
    return this.aliases;
  }

  /**
   * Resolves this parameter's value against `reader` through the 8-level
   * chain described in the class documentation.
   *
   * @param reader - The composed config reader to consult first.
   * @returns The resolved value, or `undefined` if no level supplies one.
   * @throws {@link M3LConfigCoercionError} When a provider-supplied raw value
   *   cannot be coerced to the declared `type`.
   */
  async getValueAsync(
    reader: M3LConfigReader,
  ): Promise<M3LCoercedValue<TType> | undefined> {
    const raw = reader.getRawValueForKeys([this.name, ...this.aliases]);
    if (raw !== undefined) {
      return coerceConfigValue(raw, this.type);
    }

    if (this.defaultValue !== undefined) {
      return this.defaultValue;
    }

    if (this.asyncFallback !== undefined) {
      return await this.asyncFallback();
    }

    return undefined;
  }
}
