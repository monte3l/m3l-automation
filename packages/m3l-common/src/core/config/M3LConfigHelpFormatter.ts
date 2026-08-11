/**
 * `core/config/M3LConfigHelpFormatter` — renders a {@link M3LConfigSchema}
 * into human-readable CLI help text.
 *
 * @packageDocumentation
 */

import type { M3LConfigParameter } from "./M3LConfigParameter.js";
import type { M3LConfigSchema } from "./M3LConfigSchema.js";

/** Indentation applied to a description/default line beneath its header. */
const LINE_INDENT = "    ";

/**
 * Renders a header line for `parameter`, e.g. `--name, --alias <STRING>`,
 * with a trailing `" (required)"` when the parameter is required.
 */
function formatHeader(parameter: M3LConfigParameter): string {
  const flags = [parameter.getName(), ...parameter.getAliases()]
    .map((name) => `--${name}`)
    .join(", ");
  const requiredSuffix = parameter.isRequired() ? " (required)" : "";
  return `${flags} <${parameter.getType()}>${requiredSuffix}`;
}

/**
 * Renders a default-value line's value half: an array default joins with
 * `", "`; every other value uses `String(value)`.
 */
function formatDefaultValue(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/**
 * Renders the full block for a single `parameter`: its header line, an
 * optional description line, and an optional default-value line.
 */
function formatParameter(parameter: M3LConfigParameter): string {
  const lines = [formatHeader(parameter)];

  const description = parameter.getDescription();
  if (description !== undefined) {
    lines.push(`${LINE_INDENT}${description}`);
  }

  const defaultValue = parameter.getDefaultValue();
  if (defaultValue !== undefined) {
    lines.push(`${LINE_INDENT}default: ${formatDefaultValue(defaultValue)}`);
  }

  return lines.join("\n");
}

/**
 * Renders a {@link M3LConfigSchema} into human-readable CLI help text — one
 * block per declared parameter, in schema order, separated by a blank line.
 * Formatting is purely local to this module: no dependency on
 * `core/logging`'s table formatter, since this output is a flat list of
 * blocks rather than tabular data.
 *
 * @example
 * ```ts
 * import {
 *   M3LConfigHelpFormatter,
 *   M3LConfigParameter,
 *   M3LConfigParameterType,
 *   M3LConfigSchema,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const schema = new M3LConfigSchema([
 *   new M3LConfigParameter({
 *     name: "region",
 *     type: M3LConfigParameterType.STRING,
 *     description: "The AWS region to target.",
 *     required: true,
 *   }),
 * ]);
 * const help = new M3LConfigHelpFormatter().format(schema);
 * // "--region <STRING> (required)\n    The AWS region to target."
 * ```
 */
export class M3LConfigHelpFormatter {
  /**
   * Renders `schema` into CLI help text.
   *
   * @param schema - The schema to render.
   * @returns The rendered help text, or `""` when `schema` declares no
   *   parameters.
   */
  // `this: void` — the method never reads instance state, so a caller can
  // safely take a bare reference to it (e.g. `expectTypeOf(formatter.format)`)
  // without triggering `@typescript-eslint/unbound-method`.
  format(this: void, schema: M3LConfigSchema): string {
    return schema.parameters
      .map((parameter) => formatParameter(parameter))
      .join("\n\n");
  }
}
