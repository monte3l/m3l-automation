import { Core } from "@m3l-automation/m3l-common";

const BATCH_SIZE_MIN = 1;
const BATCH_SIZE_MAX = 10_000;
const BATCH_SIZE_DEFAULT = 100;
const VISIBILITY_TIMEOUT_MIN = 0;
const VISIBILITY_TIMEOUT_MAX = 43_200;

/**
 * The `command` parameter's declared operation set (ADR-0055) — the seven
 * verbs `sqs-etl` dispatches over. Feeds {@link configParameters}'
 * `command` declaration (which auto-composes the membership validator) and
 * {@link Core.deriveOperationValidators}'s per-command `requiredParameters`
 * derivation below.
 *
 * Deliberately declared with a bare `as const` — NOT
 * `as const satisfies Core.M3LOperationDeclarationList` — because a
 * `satisfies` clause on this literal fails `tsc --isolatedDeclarations`
 * (the mode each script's `tsconfig.build.json` builds under). The shape is
 * still fully compile-time-checked at both use sites without it: passing
 * this value to `Core.deriveOperationNames` below and to `operations:` in
 * `configParameters` each independently check it against
 * `Core.M3LOperationDeclarationList` — do not re-add `satisfies` here.
 */
export const SQS_ETL_COMMAND_DECLARATIONS = [
  {
    name: "dump",
    description: "Drain the queue to a streamed JSONL file.",
    requiredParameters: ["queueUrl", "output"],
  },
  {
    name: "send",
    description: "Batch-publish JSONL records from a file to the queue.",
    requiredParameters: ["queueUrl", "input"],
  },
  {
    name: "redrive",
    description:
      "Move messages from a dead-letter queue back to its source queue.",
    requiredParameters: ["queueUrl", "dlqUrl"],
  },
  {
    name: "delete",
    description: "Remove specific messages from the queue by receipt handle.",
    requiredParameters: ["queueUrl", "input"],
  },
  {
    name: "purge",
    description: "Clear a queue of all messages.",
    requiredParameters: ["queueUrl"],
  },
  {
    name: "transform",
    description:
      "Map/filter records between two JSONL files without touching AWS.",
    requiredParameters: ["input", "output"],
  },
  {
    name: "list-queues",
    description: "List the account's SQS queue URLs, one page per call.",
    requiredParameters: [],
  },
] as const;

/** The literal union of {@link SQS_ETL_COMMAND_DECLARATIONS}' command names. */
type SqsEtlCommandName = (typeof SQS_ETL_COMMAND_DECLARATIONS)[number]["name"];

/** The `command` config parameter's finite set of operation modes. */
export const SQS_ETL_COMMANDS: readonly [
  SqsEtlCommandName,
  ...(readonly SqsEtlCommandName[]),
] = Core.deriveOperationNames(SQS_ETL_COMMAND_DECLARATIONS);

/**
 * The declared configuration schema for `sqs-etl` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); declare a parameter here instead so resolution, coercion, validation,
 * and redaction all flow through the library.
 *
 * Only `aws.profile` and `command` are `required: true`: per-command
 * presence requirements (e.g. `queueUrl` for `dump`/`send`/`redrive`/
 * `delete`/`purge`, `input` for `send`/`delete`/`transform`, `output` for
 * `dump`/`transform`; `list-queues` requires none) are declared on
 * {@link SQS_ETL_COMMAND_DECLARATIONS}
 * rather than expressed by a single parameter's `validate:` callback — see
 * {@link configValidators} below, which derives and enforces them at
 * config-load time via F1b's `Core.M3LConfigSchema` cross-parameter
 * validation seam. See `docs/reference/scripts/sqs-etl.md` for the full
 * per-command requirement table.
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
    operations: SQS_ETL_COMMAND_DECLARATIONS,
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
    name: "queueNamePrefix",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "nextToken",
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

/**
 * The `sqs-etl` schema-level cross-parameter validators (F1b) — the declared
 * config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN `command` and the
 * per-command "Required for" parameters, which no single
 * `M3LConfigParameter` can express on its own.
 *
 * The per-command requiredness validators are DERIVED from
 * {@link SQS_ETL_COMMAND_DECLARATIONS} by
 * {@link Core.deriveOperationValidators} (ADR-0055) rather than
 * hand-written:
 *
 * - `queueUrl` is required for `dump`, `send`, `redrive`, `delete`, `purge`
 *   (NOT `transform`, which never touches SQS).
 * - `dlqUrl` is required for `redrive` only.
 * - `input` is required for `send`, `delete`, `transform`.
 * - `output` is required for `dump`, `transform`.
 *
 * The derived reason strings say "operation(s)" where the prior hand-written
 * validators said "command(s)" — the library's wording is fixed, and this is
 * the one unavoidable string change; everything else about the messages is
 * identical.
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
 * The `yesSensitive`⇒`yes` validator stays hand-written: it is not
 * per-command requiredness, but a genuinely cross-parameter constraint
 * between two independently-defaulted BOOL parameters (ADR-0048).
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
  ...Core.deriveOperationValidators(configParameters),
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
