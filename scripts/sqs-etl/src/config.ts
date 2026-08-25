import { Core } from "@m3l-automation/m3l-common";

const BATCH_SIZE_MIN = 1;
const BATCH_SIZE_MAX = 10_000;
const BATCH_SIZE_DEFAULT = 100;
const VISIBILITY_TIMEOUT_MIN = 0;
const VISIBILITY_TIMEOUT_MAX = 43_200;

/** The `command` config parameter's finite set of operation modes. */
export const SQS_ETL_COMMANDS = [
  "dump",
  "send",
  "redrive",
  "delete",
  "purge",
  "transform",
] as const;

/**
 * The declared configuration schema for `sqs-etl` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); declare a parameter here instead so resolution, coercion, validation,
 * and redaction all flow through the library.
 *
 * Per-command requiredness (e.g. `queueUrl` for `dump` but not `transform`)
 * is not expressed here as a declarative `M3LConfigParameter({ required: true })`
 * — a single parameter's `validate:` callback cannot express a
 * cross-parameter constraint; every parameter besides `command` and
 * `aws.profile` remains declared optional. See {@link configValidators}
 * below, which enforces the per-command requirement at config-load time via
 * F1b's `Core.M3LConfigSchema` cross-parameter validation seam. See
 * `docs/reference/scripts/sqs-etl.md` for the full per-command requirement
 * table.
 *
 * Declare an AWS profile parameter with `Core.AWS_PROFILE_PARAM_NAME` when the
 * script touches AWS — that name is what enables the `script.aws`
 * dynamic-provisioning seam.
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: Core.AWS_PROFILE_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "command",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.oneOf<string>(SQS_ETL_COMMANDS),
  }),
  new Core.M3LConfigParameter({
    name: "queueUrl",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "dlqUrl",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "input",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "output",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "batchSize",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: BATCH_SIZE_DEFAULT,
    validate: Core.M3LConfigValidators.range(BATCH_SIZE_MIN, BATCH_SIZE_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "visibilityTimeoutSeconds",
    type: Core.M3LConfigParameterType.INT,
    validate: Core.M3LConfigValidators.range(
      VISIBILITY_TIMEOUT_MIN,
      VISIBILITY_TIMEOUT_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "deleteAfterDump",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: false,
  }),
  new Core.M3LConfigParameter({
    name: "yes",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: false,
  }),
  new Core.M3LConfigParameter({
    name: "yesSensitive",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: false,
  }),
  new Core.M3LConfigParameter({
    name: "fields",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    defaultValue: [],
  }),
  new Core.M3LConfigParameter({
    name: "filters",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    defaultValue: [],
  }),
];

/** The commands for which `queueUrl` is required — every command except `transform`, which never touches SQS. */
const QUEUE_URL_REQUIRING_COMMANDS = [
  "dump",
  "send",
  "redrive",
  "delete",
  "purge",
] as const;

/** The commands for which `dlqUrl` is required. */
const DLQ_URL_REQUIRING_COMMANDS = ["redrive"] as const;

/** The commands for which `input` is required. */
const INPUT_REQUIRING_COMMANDS = ["send", "delete", "transform"] as const;

/** The commands for which `output` is required. */
const OUTPUT_REQUIRING_COMMANDS = ["dump", "transform"] as const;

/** True when `value` is a string present in `commands` — narrows `unknown` without an `as` assertion. */
function isOneOf(value: unknown, commands: readonly string[]): boolean {
  return typeof value === "string" && commands.includes(value);
}

/**
 * Builds a schema-level validator asserting `paramName` is set whenever
 * `config`'s `command` is one of `requiringCommands`. The failure reason
 * names only the fixed command list (a constraint description), never the
 * received `command`/`paramName` value.
 */
function requiredForCommands(
  paramName: string,
  requiringCommands: readonly string[],
): Core.M3LConfigSchemaValidator {
  return (config: Core.M3LConfig): true | string => {
    const requires =
      isOneOf(config.get("command"), requiringCommands) &&
      config.get(paramName) === undefined;
    return requires
      ? `'${paramName}' is required for command(s): ${requiringCommands.join(", ")}`
      : true;
  };
}

/**
 * The `sqs-etl` schema-level cross-parameter validators (F1b) — the declared
 * config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN `command` and the
 * per-command "Required for" parameters, which no single
 * `M3LConfigParameter` can express on its own:
 *
 * - `queueUrl` is required for `dump`, `send`, `redrive`, `delete`, `purge`
 *   (NOT `transform`, which never touches SQS).
 * - `dlqUrl` is required for `redrive` only.
 * - `input` is required for `send`, `delete`, `transform`.
 * - `output` is required for `dump`, `transform`.
 *
 * Unlike `ecs-ops`/`eks-ops`/`lambda-ops`, `sqs-etl` has no central
 * dispatcher — each command's guard previously lived inside its own step
 * module (`steps/dump-queue.ts`, `steps/send-batch.ts`,
 * `steps/redrive-queue.ts`, `steps/delete-messages.ts`,
 * `steps/purge-queue.ts`, `steps/transform-records.ts`). Those
 * `accessor.requiredString(...)` calls SUPPLEMENT — not replace — this
 * schema-level layer: they also narrow `string | undefined` into `string`
 * for downstream typed use, which TypeScript needs regardless of when
 * presence is first enforced. Declaring the relationship here moves the
 * *failure* to config-load time (before any step module runs) and unifies
 * the error code under the library's `ERR_CONFIG_VALIDATION`. See
 * `docs/reference/core/config.md`'s "Cross-parameter validation" section for
 * the `M3LConfigSchemaValidator` contract these functions satisfy.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { configParameters, configValidators } from "./config.js";
 *
 * const schema = new Core.M3LConfigSchema(configParameters, configValidators);
 * ```
 */
export const configValidators: readonly Core.M3LConfigSchemaValidator[] = [
  requiredForCommands("queueUrl", QUEUE_URL_REQUIRING_COMMANDS),
  requiredForCommands("dlqUrl", DLQ_URL_REQUIRING_COMMANDS),
  requiredForCommands("input", INPUT_REQUIRING_COMMANDS),
  requiredForCommands("output", OUTPUT_REQUIRING_COMMANDS),
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
