/**
 * `core/config/M3LConfigHelpFormatter` — renders a {@link M3LConfigSchema}
 * into human-readable CLI help text.
 *
 * @packageDocumentation
 */

import type { M3LConfigParameter } from "./M3LConfigParameter.js";
import type { M3LConfigSchema } from "./M3LConfigSchema.js";
import type {
  M3LOperationDeclaration,
  M3LOperationDeclarationList,
} from "./M3LOperationDeclaration.js";

/** Indentation applied to a description/default line beneath its header. */
const LINE_INDENT = "    ";

/** Mask rendered in place of a secret parameter's default value. */
const SECRET_MASK = "********";

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
 * Renders one operation line: the name column, the (possibly padded)
 * description column, and an optional `requires:` cell.
 *
 * `descriptionCell` is only padded when `requiresCell` is non-empty (so the
 * `requires:` column aligns); otherwise the description is rendered plain,
 * which is what keeps a `requires:`-less operation's line from ending in
 * trailing whitespace.
 */
function formatOperationLine(
  operation: M3LOperationDeclaration,
  nameWidth: number,
  descWidth: number,
): string {
  const requiresCell =
    operation.requiredParameters !== undefined &&
    operation.requiredParameters.length > 0
      ? `  requires: ${operation.requiredParameters.join(", ")}`
      : "";
  const descriptionCell =
    requiresCell === ""
      ? operation.description
      : operation.description.padEnd(descWidth);

  return `${LINE_INDENT}  ${operation.name.padEnd(nameWidth)}  ${descriptionCell}${requiresCell}`;
}

/**
 * Renders the `operations:` block for a parameter that declares
 * {@link M3LConfigParameter.getOperations}: a header line followed by one
 * line per operation, in declaration order, name- and description-aligned
 * across the whole list.
 *
 * Typed `M3LOperationDeclarationList` rather than a plain
 * `readonly M3LOperationDeclaration[]`, so the non-empty guarantee its
 * only caller ({@link formatParameter}, gated on
 * `getOperations() !== undefined`) already has stays visible here — the
 * `Math.max` spread below would silently return `-Infinity` on an empty
 * array.
 */
function formatOperationsBlock(
  operations: M3LOperationDeclarationList,
): string {
  const nameWidth = Math.max(...operations.map((op) => op.name.length));
  const descWidth = Math.max(...operations.map((op) => op.description.length));

  const lines = [`${LINE_INDENT}operations:`];
  for (const operation of operations) {
    lines.push(formatOperationLine(operation, nameWidth, descWidth));
  }
  return lines.join("\n");
}

/**
 * Renders the full block for a single `parameter`: its header line, an
 * optional description line, an optional default-value line, and — when
 * declared — its operations block.
 */
function formatParameter(parameter: M3LConfigParameter): string {
  const lines = [formatHeader(parameter)];

  const description = parameter.getDescription();
  if (description !== undefined) {
    lines.push(`${LINE_INDENT}${description}`);
  }

  const defaultValue = parameter.getDefaultValue();
  if (defaultValue !== undefined) {
    const rendered = parameter.isSecret()
      ? SECRET_MASK
      : formatDefaultValue(defaultValue);
    lines.push(`${LINE_INDENT}default: ${rendered}`);
  }

  const operations = parameter.getOperations();
  if (operations !== undefined) {
    lines.push(formatOperationsBlock(operations));
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
