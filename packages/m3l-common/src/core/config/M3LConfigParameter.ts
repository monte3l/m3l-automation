/**
 * `core/config/M3LConfigParameter` — a declared configuration parameter and
 * its 4-branch resolution chain.
 *
 * @packageDocumentation
 */

import { coerceConfigValue } from "./coerceConfigValue.js";
import { M3LConfigMissingError } from "./M3LConfigMissingError.js";
import { M3LConfigValidationError } from "./M3LConfigValidationError.js";
import type {
  M3LCoercedValue,
  M3LConfigParameterType,
} from "./M3LConfigParameterType.js";
import type {
  M3LConfigReader,
  M3LConfigResolution,
} from "./M3LConfigReader.js";
import type { M3LConfigValidator } from "./M3LConfigValidator.js";

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
  /**
   * Optional schema-time validator applied to the coerced value at every
   * resolution point (a declared `defaultValue` eagerly at construction, a
   * provider value after coercion, and an `asyncFallback` result after it
   * resolves). A failing validation throws {@link M3LConfigValidationError}.
   */
  readonly validate?: M3LConfigValidator<M3LCoercedValue<TType>>;
  /**
   * When `true`, {@link M3LConfigParameter.getValueAsync} throws
   * {@link M3LConfigMissingError} instead of resolving to `undefined` at the
   * true fall-through — i.e. only after a provider value, `defaultValue`,
   * and `asyncFallback` have all been tried and none supplied a value.
   * Defaults to `false`.
   */
  readonly required?: boolean;
  /**
   * A human-readable description of the parameter, purely presentational —
   * never consulted by resolution. Consumed by {@link M3LConfigHelpFormatter}.
   */
  readonly description?: string;
  /**
   * Marks the parameter as carrying a secret value. Like `description`, this
   * is a **purely declarative marker — never consulted by resolution,
   * coercion, or validation**; resolution behaves identically whether or not
   * it is set. It exists for consumers that handle a parameter's resolved
   * _value_ outside the resolution path (a preset/history writer, a display
   * layer): such a consumer must never persist a secret parameter's value,
   * and must mask it rather than render it unmasked. The parameter's name,
   * type, and description are not secret and still render normally —
   * `{@link M3LConfigHelpFormatter}` output is unchanged by this flag.
   * Defaults to `false`.
   */
  readonly secret?: boolean;
}

/**
 * A declared configuration parameter: a name, its coercion target type,
 * optional aliases, and an optional default/fallback chain.
 *
 * Resolution order (`getValueAsync`), short-circuiting strictly at the first
 * satisfied branch:
 * 1. A provider-supplied raw value (via the reader, tried under `name` then
 *    each alias) — coerced via {@link coerceConfigValue}.
 * 2. `defaultValue`, if defined — returned unmodified.
 * 3. `asyncFallback()`, if defined — its resolved value returned unmodified.
 * 4. The true fall-through: `undefined`, unless `required` is `true`, in
 *    which case {@link M3LConfigMissingError} is thrown instead.
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
  private readonly validate:
    M3LConfigValidator<M3LCoercedValue<TType>> | undefined;
  private readonly required: boolean;
  private readonly description: string | undefined;
  private readonly secret: boolean;

  /**
   * Creates a new `M3LConfigParameter`.
   *
   * @param options - The parameter declaration.
   * @throws {@link M3LConfigValidationError} When `options.validate` is
   *   declared and `options.defaultValue` is present but fails it — a bad
   *   static default is a programming error and fails fast at declaration.
   */
  constructor(options: M3LConfigParameterOptions<TType>) {
    this.name = options.name;
    this.type = options.type;
    this.aliases = options.aliases ?? [];
    this.defaultValue = options.defaultValue;
    this.asyncFallback = options.asyncFallback;
    this.validate = options.validate;
    this.required = options.required ?? false;
    this.description = options.description;
    this.secret = options.secret ?? false;

    if (this.defaultValue !== undefined) {
      this.runValidation(this.defaultValue);
    }
  }

  /**
   * Runs the declared `validate` function (if any) against a resolved
   * coerced value, throwing {@link M3LConfigValidationError} on failure.
   *
   * @param value - The coerced value to validate.
   * @throws {@link M3LConfigValidationError} When `validate` is declared and
   *   returns a failure reason for `value`.
   */
  private runValidation(value: M3LCoercedValue<TType>): void {
    if (this.validate === undefined) return;

    const result = this.validate(value);
    if (result === true) return;

    throw new M3LConfigValidationError(
      `configuration parameter '${this.name}' failed validation: ${result}`,
      {
        context: {
          parameter: this.name,
          reason: result,
          valueType: typeof value,
        },
      },
    );
  }

  /** The parameter's canonical name. */
  getName(): string {
    return this.name;
  }

  /** The parameter's declared aliases. */
  getAliases(): readonly string[] {
    return this.aliases;
  }

  /** The parameter's declared coercion target type. */
  getType(): TType {
    return this.type;
  }

  /** Whether resolution throws {@link M3LConfigMissingError} instead of resolving `undefined` at the true fall-through. */
  isRequired(): boolean {
    return this.required;
  }

  /**
   * Whether the parameter is declared secret. Purely declarative — never
   * consulted by resolution, coercion, or validation; a secret parameter
   * resolves identically to its non-secret twin. Consumers that handle the
   * resolved value outside the resolution path (a preset/history writer, a
   * display layer) must consult this flag to skip persisting and to mask
   * rendering.
   */
  isSecret(): boolean {
    return this.secret;
  }

  /** The parameter's declared default value, or `undefined` when none was declared. */
  getDefaultValue(): M3LCoercedValue<TType> | undefined {
    return this.defaultValue;
  }

  /** The parameter's declared human-readable description, or `undefined` when none was declared. */
  getDescription(): string | undefined {
    return this.description;
  }

  /**
   * Resolves this parameter's value AND its source label against `reader`
   * through the same 4-branch chain described in the class documentation.
   * {@link M3LConfigParameter.getValueAsync} delegates to this method,
   * discarding the `source` half of the result — this is the single copy of
   * the resolution chain.
   *
   * Each branch tags its own `source`: a provider hit reports the winning
   * provider's {@link M3LConfigProvider.getSourceLabel}, `defaultValue`
   * reports `"default"`, and a resolved `asyncFallback` reports
   * `"async-fallback"`.
   *
   * @param reader - The composed config reader to consult first.
   * @returns The resolved value/source pair, or `undefined` if no branch
   *   supplies one and `required` is not `true`.
   * @throws {@link M3LConfigCoercionError} When a provider-supplied raw value
   *   cannot be coerced to the declared `type`.
   * @throws {@link M3LConfigValidationError} When a declared `validate`
   *   rejects the coerced provider value or the resolved `asyncFallback`
   *   value.
   * @throws {@link M3LConfigMissingError} When `required` is `true` and the
   *   true fall-through is reached — no provider value, `defaultValue`, or
   *   `asyncFallback` supplied one.
   */
  async resolveAsync(
    reader: M3LConfigReader,
  ): Promise<M3LConfigResolution<M3LCoercedValue<TType>> | undefined> {
    const resolution = reader.resolveForKeys([this.name, ...this.aliases]);
    if (resolution !== undefined) {
      const coerced = coerceConfigValue(resolution.value, this.type);
      this.runValidation(coerced);
      return { value: coerced, source: resolution.source };
    }

    if (this.defaultValue !== undefined) {
      return { value: this.defaultValue, source: "default" };
    }

    if (this.asyncFallback !== undefined) {
      const resolved = await this.asyncFallback();
      this.runValidation(resolved);
      return { value: resolved, source: "async-fallback" };
    }

    if (this.required) {
      throw new M3LConfigMissingError(
        `configuration parameter '${this.name}' is required but no value was supplied`,
        { parameter: this.name },
      );
    }

    return undefined;
  }

  /**
   * Resolves this parameter's value against `reader` through the 4-branch
   * chain described in the class documentation. Delegates to
   * {@link M3LConfigParameter.resolveAsync}, discarding the `source` half of
   * its result.
   *
   * @param reader - The composed config reader to consult first.
   * @returns The resolved value, or `undefined` if no branch supplies one
   *   and `required` is not `true`.
   * @throws {@link M3LConfigCoercionError} When a provider-supplied raw value
   *   cannot be coerced to the declared `type`.
   * @throws {@link M3LConfigValidationError} When a declared `validate`
   *   rejects the coerced provider value or the resolved `asyncFallback`
   *   value.
   * @throws {@link M3LConfigMissingError} When `required` is `true` and the
   *   true fall-through is reached — no provider value, `defaultValue`, or
   *   `asyncFallback` supplied one.
   */
  async getValueAsync(
    reader: M3LConfigReader,
  ): Promise<M3LCoercedValue<TType> | undefined> {
    return (await this.resolveAsync(reader))?.value;
  }
}
