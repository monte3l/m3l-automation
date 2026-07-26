import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/** The three mutating operations `writeStack` dispatches. */
type WriteOperation = "create-stack" | "update-stack" | "delete-stack";

/**
 * The dependencies `writeStack` needs, already resolved by
 * `run-cloudformation-stacks` — `input` arrives as the already-JSON-parsed
 * record for `create-stack`/`update-stack` (`undefined` for `delete-stack`,
 * which reads `stackName`/`retainResources`/`roleArn` from config instead).
 * `templateText` is the already-read template file contents (`undefined`
 * when no `template` was configured, or for `delete-stack`). This step takes
 * no raw `Core.M3LConfig` and never touches `destructive-gate`/`prompt`
 * itself (`run-cloudformation-stacks` gates before ever dispatching here).
 */
interface WriteStackDeps {
  readonly operations: AWS.M3LCloudFormationOperations;
  readonly operation: WriteOperation;
  readonly input: Record<string, unknown> | undefined;
  readonly templateText: string | undefined;
  readonly stackName: string | undefined;
  readonly retainResources: readonly string[] | undefined;
  readonly roleArn: string | undefined;
}

/** Guard-checks `input` present, for `create-stack`/`update-stack`. */
function requireInput(
  input: Record<string, unknown> | undefined,
  operation: WriteOperation,
): Record<string, unknown> {
  if (input === undefined) {
    throw new Core.M3LError(
      `writeStack: 'input' is required for '${operation}'`,
      { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
    );
  }
  return input;
}

/** Guard-checks `stackName` present, for `delete-stack`'s flat config value. */
function requireStackName(stackName: string | undefined): string {
  if (stackName === undefined) {
    throw new Core.M3LError(
      "writeStack: 'stackName' is required for 'delete-stack'",
      { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
    );
  }
  return stackName;
}

/**
 * Reads the required, non-empty `stackName` field off an already-parsed
 * `input` record — per the doc's sourcing split, `create-stack`/
 * `update-stack` source `stackName` from **inside the record**, never from
 * the deps object's own `stackName` field.
 */
function requireStackNameField(
  input: Record<string, unknown>,
  operation: "create-stack" | "update-stack",
): string {
  const value = input["stackName"];
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError(
      `writeStack: 'input.stackName' must be a non-empty string for '${operation}'`,
      { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
    );
  }
  return value;
}

/** Reads an optional string field off an already-parsed `input` object (`undefined` when absent/wrong type). */
function readOptionalStringField(
  input: Record<string, unknown>,
  fieldName: string,
): string | undefined {
  const value = input[fieldName];
  return typeof value === "string" ? value : undefined;
}

/** Reads an optional number field off an already-parsed `input` object (`undefined` when absent/wrong type). */
function readOptionalNumberField(
  input: Record<string, unknown>,
  fieldName: string,
): number | undefined {
  const value = input[fieldName];
  return typeof value === "number" ? value : undefined;
}

/** Reads an optional boolean field off an already-parsed `input` object (`undefined` when absent/wrong type). */
function readOptionalBooleanField(
  input: Record<string, unknown>,
  fieldName: string,
): boolean | undefined {
  const value = input[fieldName];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Reads an optional array-shaped field off an already-parsed `input` object,
 * trusting each entry's shape as-is (matching `M3LCloudFormationOperations`'s
 * own no-pre-flight-validation stance for `parameters`/`capabilities`/`tags`).
 */
function readOptionalArrayField<T>(
  input: Record<string, unknown>,
  fieldName: string,
): readonly T[] | undefined {
  const value = input[fieldName];
  return Array.isArray(value) ? (value as readonly T[]) : undefined;
}

/**
 * Resolves the `templateBody` to send: the record's own `templateBody` when
 * set; otherwise `undefined` when the record already sets `templateUrl`
 * (never inject over an explicit URL); otherwise `templateText` (which may
 * itself be `undefined` when no `template` was configured).
 */
function resolveTemplateBody(
  input: Record<string, unknown>,
  templateText: string | undefined,
): string | undefined {
  const recordTemplateBody = readOptionalStringField(input, "templateBody");
  if (recordTemplateBody !== undefined) return recordTemplateBody;
  if (readOptionalStringField(input, "templateUrl") !== undefined) {
    return undefined;
  }
  return templateText;
}

/**
 * Narrows an already-parsed `input` record into
 * `M3LCloudFormationCreateStackInput`, guard-checking `stackName` present
 * and non-empty (the only field this module validates; every other field is
 * trusted as-is) and injecting `templateBody` from `templateText` per
 * {@link resolveTemplateBody}.
 */
function buildCreateStackInput(
  input: Record<string, unknown>,
  templateText: string | undefined,
): AWS.M3LCloudFormationCreateStackInput {
  const stackName = requireStackNameField(input, "create-stack");
  const templateBody = resolveTemplateBody(input, templateText);
  const templateUrl = readOptionalStringField(input, "templateUrl");
  const parameters = readOptionalArrayField<AWS.M3LCloudFormationKeyValue>(
    input,
    "parameters",
  );
  const capabilities = readOptionalArrayField<AWS.M3LCloudFormationCapability>(
    input,
    "capabilities",
  );
  const roleArn = readOptionalStringField(input, "roleArn");
  const tags = readOptionalArrayField<AWS.M3LCloudFormationKeyValue>(
    input,
    "tags",
  );
  const timeoutInMinutes = readOptionalNumberField(input, "timeoutInMinutes");
  const disableRollback = readOptionalBooleanField(input, "disableRollback");
  const enableTerminationProtection = readOptionalBooleanField(
    input,
    "enableTerminationProtection",
  );

  return {
    stackName,
    ...(templateBody !== undefined && { templateBody }),
    ...(templateUrl !== undefined && { templateUrl }),
    ...(parameters !== undefined && { parameters }),
    ...(capabilities !== undefined && { capabilities }),
    ...(roleArn !== undefined && { roleArn }),
    ...(tags !== undefined && { tags }),
    ...(timeoutInMinutes !== undefined && { timeoutInMinutes }),
    ...(disableRollback !== undefined && { disableRollback }),
    ...(enableTerminationProtection !== undefined && {
      enableTerminationProtection,
    }),
  };
}

/**
 * Narrows an already-parsed `input` record into
 * `M3LCloudFormationUpdateStackInput`, guard-checking `stackName` present
 * and non-empty (the only field this module validates; every other field is
 * trusted as-is) and injecting `templateBody` from `templateText` per
 * {@link resolveTemplateBody}.
 */
function buildUpdateStackInput(
  input: Record<string, unknown>,
  templateText: string | undefined,
): AWS.M3LCloudFormationUpdateStackInput {
  const stackName = requireStackNameField(input, "update-stack");
  const templateBody = resolveTemplateBody(input, templateText);
  const templateUrl = readOptionalStringField(input, "templateUrl");
  const usePreviousTemplate = readOptionalBooleanField(
    input,
    "usePreviousTemplate",
  );
  const parameters = readOptionalArrayField<AWS.M3LCloudFormationKeyValue>(
    input,
    "parameters",
  );
  const capabilities = readOptionalArrayField<AWS.M3LCloudFormationCapability>(
    input,
    "capabilities",
  );
  const roleArn = readOptionalStringField(input, "roleArn");
  const tags = readOptionalArrayField<AWS.M3LCloudFormationKeyValue>(
    input,
    "tags",
  );

  return {
    stackName,
    ...(templateBody !== undefined && { templateBody }),
    ...(templateUrl !== undefined && { templateUrl }),
    ...(usePreviousTemplate !== undefined && { usePreviousTemplate }),
    ...(parameters !== undefined && { parameters }),
    ...(capabilities !== undefined && { capabilities }),
    ...(roleArn !== undefined && { roleArn }),
    ...(tags !== undefined && { tags }),
  };
}

/**
 * Runs `cloudformation-stacks`'s three mutating stack operations:
 * `create-stack` (`operations.createStack`), `update-stack`
 * (`operations.updateStack`), and `delete-stack` (`operations.deleteStack`).
 * `run-cloudformation-stacks` always routes through `destructive-gate` before
 * dispatching here — this step performs no confirmation of its own.
 *
 * @param deps - The injected `AWS.M3LCloudFormationOperations`, which
 *   mutating operation to run, the already-parsed `input` record and
 *   already-read `templateText` (for `create-stack`/`update-stack`), and the
 *   `stackName`/`retainResources`/`roleArn` config values (for
 *   `delete-stack`).
 * @returns The created/updated stack's result for `create-stack`/
 *   `update-stack` — `update-stack`'s result may legitimately be
 *   `{ changed: false }`, a no-op success rather than an error — or `void`
 *   for `delete-stack`.
 * @throws {@link Core.M3LError} coded `"ERR_CLOUDFORMATION_STACKS_CONFIG"`
 *   when `input` is missing for `create-stack`/`update-stack`, the parsed
 *   `input` record is missing `stackName`, or `stackName` is missing for
 *   `delete-stack`.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { writeStack } from "./write-stack.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LCloudFormationOperations(script.aws.clients.cloudFormation)`.
 * declare const operations: AWS.M3LCloudFormationOperations;
 *
 * await writeStack({
 *   operations,
 *   operation: "delete-stack",
 *   input: undefined,
 *   templateText: undefined,
 *   stackName: "my-stack",
 *   retainResources: undefined,
 *   roleArn: undefined,
 * });
 * ```
 */
export async function writeStack(
  deps: WriteStackDeps,
): Promise<
  | AWS.M3LCloudFormationCreateStackResult
  | AWS.M3LCloudFormationUpdateStackResult
  | void
> {
  switch (deps.operation) {
    case "create-stack": {
      const input = requireInput(deps.input, deps.operation);
      return deps.operations.createStack(
        buildCreateStackInput(input, deps.templateText),
      );
    }
    case "update-stack": {
      const input = requireInput(deps.input, deps.operation);
      return deps.operations.updateStack(
        buildUpdateStackInput(input, deps.templateText),
      );
    }
    case "delete-stack": {
      const stackName = requireStackName(deps.stackName);
      return deps.operations.deleteStack(stackName, {
        ...(deps.retainResources !== undefined && {
          retainResources: deps.retainResources,
        }),
        ...(deps.roleArn !== undefined && { roleArn: deps.roleArn }),
      });
    }
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_CLOUDFORMATION_STACKS_CONFIG",
      });
    }
  }
}
