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
  readonly reader: Core.M3LInputFileReader;
  readonly operation: WriteOperation;
  readonly input: Record<string, unknown> | undefined;
  readonly templateText: string | undefined;
  readonly stackName: string | undefined;
  readonly retainResources: readonly string[] | undefined;
  readonly roleArn: string | undefined;
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
 * Resolves the `templateBody` to send: the record's own `templateBody` when
 * set; otherwise `undefined` when the record already sets `templateUrl`
 * (never inject over an explicit URL); otherwise `templateText` (which may
 * itself be `undefined` when no `template` was configured).
 */
function resolveTemplateBody(
  reader: Core.M3LInputFileReader,
  input: Record<string, unknown>,
  templateText: string | undefined,
): string | undefined {
  const recordTemplateBody = reader.optionalStringField(input, "templateBody");
  if (recordTemplateBody !== undefined) return recordTemplateBody;
  if (reader.optionalStringField(input, "templateUrl") !== undefined) {
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
  reader: Core.M3LInputFileReader,
  input: Record<string, unknown>,
  templateText: string | undefined,
): AWS.M3LCloudFormationCreateStackInput {
  const stackName = reader.requiredStringField(
    input,
    "stackName",
    "create-stack",
  );
  const templateBody = resolveTemplateBody(reader, input, templateText);
  const templateUrl = reader.optionalStringField(input, "templateUrl");
  const parameters = reader.optionalArrayField(input, "parameters") as
    readonly AWS.M3LCloudFormationKeyValue[] | undefined;
  const capabilities = reader.optionalArrayField(input, "capabilities") as
    readonly AWS.M3LCloudFormationCapability[] | undefined;
  const roleArn = reader.optionalStringField(input, "roleArn");
  const tags = reader.optionalArrayField(input, "tags") as
    readonly AWS.M3LCloudFormationKeyValue[] | undefined;
  const timeoutInMinutes = reader.optionalNumberField(
    input,
    "timeoutInMinutes",
  );
  const disableRollback = reader.optionalBooleanField(input, "disableRollback");
  const enableTerminationProtection = reader.optionalBooleanField(
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
  reader: Core.M3LInputFileReader,
  input: Record<string, unknown>,
  templateText: string | undefined,
): AWS.M3LCloudFormationUpdateStackInput {
  const stackName = reader.requiredStringField(
    input,
    "stackName",
    "update-stack",
  );
  const templateBody = resolveTemplateBody(reader, input, templateText);
  const templateUrl = reader.optionalStringField(input, "templateUrl");
  const usePreviousTemplate = reader.optionalBooleanField(
    input,
    "usePreviousTemplate",
  );
  const parameters = reader.optionalArrayField(input, "parameters") as
    readonly AWS.M3LCloudFormationKeyValue[] | undefined;
  const capabilities = reader.optionalArrayField(input, "capabilities") as
    readonly AWS.M3LCloudFormationCapability[] | undefined;
  const roleArn = reader.optionalStringField(input, "roleArn");
  const tags = reader.optionalArrayField(input, "tags") as
    readonly AWS.M3LCloudFormationKeyValue[] | undefined;

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
 * @param deps - The injected `AWS.M3LCloudFormationOperations`, the shared
 *   `Core.M3LInputFileReader`, which mutating operation to run, the
 *   already-parsed `input` record and already-read `templateText` (for
 *   `create-stack`/`update-stack`), and the
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
 * import { Core } from "@m3l-automation/m3l-common";
 * import { writeStack } from "./write-stack.js";
 *
 * // `operations`/`reader` are injected by the caller, e.g.
 * // `new AWS.M3LCloudFormationOperations(script.aws.clients.cloudFormation)`.
 * declare const operations: AWS.M3LCloudFormationOperations;
 * declare const reader: Core.M3LInputFileReader;
 *
 * await writeStack({
 *   operations,
 *   reader,
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
      const input = deps.reader.requireRecord(
        deps.input,
        "input",
        deps.operation,
      );
      return deps.operations.createStack(
        buildCreateStackInput(deps.reader, input, deps.templateText),
      );
    }
    case "update-stack": {
      const input = deps.reader.requireRecord(
        deps.input,
        "input",
        deps.operation,
      );
      return deps.operations.updateStack(
        buildUpdateStackInput(deps.reader, input, deps.templateText),
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
