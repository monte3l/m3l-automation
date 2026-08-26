/**
 * `internal/config/validateOperationDeclarations` — the ADR-0055 operations
 * declaration validation extracted out of `M3LConfigParameter`.
 *
 * `M3LConfigParameter.ts` sits under `pnpm check:file-budget`'s per-file
 * ceiling (ADR-0072); the operations-declaration validation layer (several
 * private methods plus their TSDoc) pushed that file to within bytes of the
 * limit. This module carries that validation as a free function instead, so
 * the class stays comfortably under the ceiling and the validation itself
 * stays independently readable/testable. Private to `core/config`; never
 * re-exported through a public barrel.
 */

import { M3LConfigParameterType } from "../../core/config/M3LConfigParameterType.js";
import { M3LConfigValidationError } from "../../core/config/M3LConfigValidationError.js";
import type {
  M3LOperationDeclaration,
  M3LOperationDeclarationList,
} from "../../core/config/M3LOperationDeclaration.js";

/**
 * Validates a declared `operations` option and returns a **fresh, deep-
 * frozen projection** of it — never the caller's original array or its
 * original entry objects (`M3LConfigParameter.getOperations` returns this
 * projection, not the constructor argument) — or `undefined` when none was
 * declared.
 *
 * Returning the projection rather than the original array/entries matters
 * beyond immutability: an entry can carry an accessor property (e.g. a
 * `get name()` getter) that returns a different value on each read. Reading
 * `name`/`description` exactly once per entry, in
 * {@link validateOperationEntryShape}, and building this function's return
 * value from those already-read locals — never by re-reading the caller's
 * object — is what keeps every downstream consumer
 * ({@link deriveOperationValidators}, `M3LConfigHelpFormatter`,
 * `M3LConfigParameter`'s derived membership validator) looking at the exact
 * values that were validated, instead of independently re-observing a
 * mutable object and risking disagreement with the validation that already
 * ran.
 *
 * Runtime guard for {@link M3LOperationDeclarationList}'s compile-time
 * constraints (non-empty, `STRING`-only, well-shaped entries): a plain
 * JavaScript caller, or a cast, has no `tsc` enforcing any of them, so
 * everything from the array downward is treated as `unknown` until proven
 * otherwise, entry by entry, in {@link validateOperationEntry}.
 *
 * @param parameterName - The declaring parameter's name, used only in thrown
 *   messages/context.
 * @param type - The declaring parameter's declared coercion target type.
 * @param operations - The constructor option to validate.
 * @returns A fresh, deep-frozen {@link M3LOperationDeclarationList}
 *   projecting every validated entry, or `undefined` when `operations` is
 *   `undefined`.
 * @throws {@link M3LConfigValidationError} When `operations` is declared on
 *   a non-`STRING` parameter, is not an array, is empty, or contains a
 *   malformed entry — see {@link validateOperationEntry}.
 */
export function validateOperationDeclarations(
  parameterName: string,
  type: M3LConfigParameterType,
  operations: unknown,
): M3LOperationDeclarationList | undefined {
  if (operations === undefined) return undefined;

  if (type !== M3LConfigParameterType.STRING) {
    throw new M3LConfigValidationError(
      `configuration parameter '${parameterName}' declares operations but has type '${type}'; operations require type STRING`,
      {
        context: {
          parameter: parameterName,
          reason: `type is '${type}', not STRING`,
        },
      },
    );
  }

  // Treated as `unknown` per this function's own TSDoc above.
  const candidate: unknown = operations;

  if (!Array.isArray(candidate)) {
    throw new M3LConfigValidationError(
      `configuration parameter '${parameterName}' declares operations that are not an array`,
      {
        context: {
          parameter: parameterName,
          reason: "operations is not an array",
        },
      },
    );
  }

  if (candidate.length === 0) {
    throw new M3LConfigValidationError(
      `configuration parameter '${parameterName}' declares an empty operation list`,
      {
        context: { parameter: parameterName, reason: "empty operation list" },
      },
    );
  }

  const seenNames = new Set<string>();
  const validated: M3LOperationDeclaration[] = [];
  for (const entry of candidate) {
    const operation = validateOperationEntry(parameterName, entry, seenNames);
    seenNames.add(operation.name);
    validated.push(operation);
  }

  return Object.freeze(validated) as unknown as M3LOperationDeclarationList;
}

/**
 * Validates one raw operation entry and returns it narrowed to
 * {@link M3LOperationDeclaration}. `entry` is typed `unknown` deliberately —
 * a plain JavaScript caller (or one bypassing the type system with a cast)
 * can hand this anything, so nothing here trusts its shape before proving
 * it. Splits the work across {@link validateOperationEntryShape} (structural
 * checks, which must run first so a later `.trim()` never touches a
 * non-string) and {@link validateOperationEntryContent} (blank/duplicate
 * checks).
 *
 * @param parameterName - The declaring parameter's name, used only in thrown
 *   messages/context.
 * @param entry - The raw operation entry to validate.
 * @param seenNames - Names already validated earlier in the same list.
 * @returns A fresh, frozen {@link M3LOperationDeclaration} built from the
 *   values read off `entry` — never `entry` itself, and never a second read
 *   of any of its properties.
 * @throws {@link M3LConfigValidationError} When `entry` is not a non-null
 *   object; `name` or `description` is not a string, is blank, or
 *   duplicates an earlier entry's `name`; or `requiredParameters` is present
 *   and is not an array of strings.
 */
function validateOperationEntry(
  parameterName: string,
  entry: unknown,
  seenNames: ReadonlySet<string>,
): M3LOperationDeclaration {
  const { name, description, requiredParameters } = validateOperationEntryShape(
    parameterName,
    entry,
  );
  validateOperationEntryContent(parameterName, name, description, seenNames);

  // `exactOptionalPropertyTypes` is on: `requiredParameters` must be
  // omitted entirely when absent, never assigned an explicit `undefined`
  // (that would fail the JSON round-trip contract too — JSON.stringify
  // drops an `undefined` value, but a caller inspecting the in-memory
  // object before serialising it should not see the key at all).
  return Object.freeze({
    name,
    description,
    ...(requiredParameters !== undefined && { requiredParameters }),
  });
}

/**
 * Validates the structural shape of a raw operation entry: a non-null
 * object with a string `name`, a string `description`, and (if present) a
 * `requiredParameters` that is an array of strings. Must run before
 * {@link validateOperationEntryContent}'s `.trim()` calls, so a non-string
 * `name`/`description` is caught here instead of surfacing as a bare
 * `TypeError`.
 *
 * @param parameterName - The declaring parameter's name, used only in thrown
 *   messages/context.
 * @param entry - The raw operation entry to validate.
 * @returns The validated `name`, `description`, and `requiredParameters`,
 *   unchecked for blankness or duplication.
 * @throws {@link M3LConfigValidationError} When `entry` is not a non-null
 *   object; `name` or `description` is not a string; or
 *   `requiredParameters` is present and is not an array of strings.
 */
function validateOperationEntryShape(
  parameterName: string,
  entry: unknown,
): {
  readonly name: string;
  readonly description: string;
  readonly requiredParameters: readonly string[] | undefined;
} {
  if (typeof entry !== "object" || entry === null) {
    throw new M3LConfigValidationError(
      `configuration parameter '${parameterName}' declares a non-object operation`,
      {
        context: {
          parameter: parameterName,
          reason: "non-object operation",
        },
      },
    );
  }

  const candidate = entry as Record<string, unknown>;

  // Each property is read into a local exactly once, before its `typeof`
  // check, and that same local is what gets returned — never a second
  // bracket access off `candidate`. `candidate["name"]`/`["description"]`
  // can be accessor properties (a `get name()` that computes a different
  // value on each read); reading twice would let a value that passed the
  // guard differ from the value this function hands back.
  const rawName: unknown = candidate["name"];
  if (typeof rawName !== "string") {
    throw new M3LConfigValidationError(
      `configuration parameter '${parameterName}' declares an operation with a non-string name`,
      {
        context: {
          parameter: parameterName,
          reason: "non-string operation name",
        },
      },
    );
  }
  const operationName = rawName;

  const rawDescription: unknown = candidate["description"];
  if (typeof rawDescription !== "string") {
    throw new M3LConfigValidationError(
      `configuration parameter '${parameterName}' declares an operation with a non-string description: '${operationName}'`,
      {
        context: {
          parameter: parameterName,
          reason: `non-string description for operation '${operationName}'`,
        },
      },
    );
  }
  const description = rawDescription;

  const requiredParameters = validateRequiredParametersShape(
    parameterName,
    candidate["requiredParameters"],
    operationName,
  );

  return { name: operationName, description, requiredParameters };
}

/**
 * Validates content constraints on an already shape-checked entry: `name`
 * and `description` must not be blank, and `name` must not duplicate an
 * earlier entry. Assumes {@link validateOperationEntryShape} already proved
 * both are strings.
 *
 * @param parameterName - The declaring parameter's name, used only in thrown
 *   messages/context.
 * @param name - The shape-validated operation name.
 * @param description - The shape-validated operation description.
 * @param seenNames - Names already validated earlier in the same list.
 * @throws {@link M3LConfigValidationError} When `name` or `description` is
 *   blank, or `name` duplicates an earlier entry's name.
 */
function validateOperationEntryContent(
  parameterName: string,
  name: string,
  description: string,
  seenNames: ReadonlySet<string>,
): void {
  if (name.trim() === "") {
    throw new M3LConfigValidationError(
      `configuration parameter '${parameterName}' declares an operation with a blank name`,
      {
        context: {
          parameter: parameterName,
          reason: "blank operation name",
        },
      },
    );
  }
  if (description.trim() === "") {
    throw new M3LConfigValidationError(
      `configuration parameter '${parameterName}' declares an operation with a blank description: '${name}'`,
      {
        context: {
          parameter: parameterName,
          reason: `blank description for operation '${name}'`,
        },
      },
    );
  }
  if (seenNames.has(name)) {
    throw new M3LConfigValidationError(
      `configuration parameter '${parameterName}' declares duplicate operation '${name}'`,
      {
        context: {
          parameter: parameterName,
          reason: `duplicate operation '${name}'`,
        },
      },
    );
  }
}

/**
 * Validates that an operation's `requiredParameters` field is absent or an
 * array of strings — the one place this shape is checked.
 * `deriveOperationValidators` walks `requiredParameters` trusting this
 * guard and does not re-check it: `requiredParameters: 42` would otherwise
 * throw a bare `TypeError` deep inside that free function, and
 * `requiredParameters: "cluster"` would silently iterate per character.
 *
 * @param parameterName - The declaring parameter's name, used only in thrown
 *   messages/context.
 * @param requiredParameters - The raw field value to validate.
 * @param operationName - The already-validated operation name, used only in
 *   the thrown message/context.
 * @returns A fresh, frozen copy of `requiredParameters` narrowed to
 *   `readonly string[]` — never the caller's original array — or
 *   `undefined` when absent.
 * @throws {@link M3LConfigValidationError} When `requiredParameters` is
 *   present and is not an array of strings.
 */
function validateRequiredParametersShape(
  parameterName: string,
  requiredParameters: unknown,
  operationName: string,
): readonly string[] | undefined {
  if (requiredParameters === undefined) return undefined;

  if (!Array.isArray(requiredParameters)) {
    throw new M3LConfigValidationError(
      `configuration parameter '${parameterName}' declares an operation with non-array requiredParameters: '${operationName}'`,
      {
        context: {
          parameter: parameterName,
          reason: `non-array requiredParameters for operation '${operationName}'`,
        },
      },
    );
  }

  const validated: string[] = [];
  for (const item of requiredParameters) {
    if (typeof item !== "string") {
      throw new M3LConfigValidationError(
        `configuration parameter '${parameterName}' declares an operation with a non-string required parameter: '${operationName}'`,
        {
          context: {
            parameter: parameterName,
            reason: `non-string required parameter for operation '${operationName}'`,
          },
        },
      );
    }
    validated.push(item);
  }

  return Object.freeze(validated);
}
