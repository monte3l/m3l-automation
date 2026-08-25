import { Core } from "@m3l-automation/m3l-common";

const PAGE_SIZE_MIN = 1;
const PAGE_SIZE_MAX = 1_000;

const YES_DEFAULT = false;
const YES_SENSITIVE_DEFAULT = false;

/** The seven operations `s3-objects` supports. */
export const S3_OBJECTS_OPERATIONS = [
  "list",
  "describe",
  "get",
  "put",
  "copy",
  "delete",
  "delete-batch",
] as const;

/**
 * The declared configuration schema for `s3-objects` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); declare a parameter here instead so resolution, coercion, validation,
 * and redaction all flow through the library.
 *
 * Declare an AWS profile parameter with `Core.AWS_PROFILE_PARAM_NAME` when the
 * script touches AWS — that name is what enables the `script.aws`
 * dynamic-provisioning seam.
 *
 * `operation`, `bucket`, and `aws.profile` are `required: true`: presence is
 * enforced at config-load time by the library. The remaining per-operation
 * requirements (e.g. `key` for `describe`, `input` for `put`) are
 * cross-parameter constraints a single parameter's validator cannot express,
 * so they are guard-checked at run start instead (see
 * `steps/run-s3-objects.ts`).
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: Core.AWS_PROFILE_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "operation",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.oneOf<string>(S3_OBJECTS_OPERATIONS),
  }),
  new Core.M3LConfigParameter({
    name: "bucket",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "key",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "prefix",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "pageSize",
    type: Core.M3LConfigParameterType.INT,
    validate: Core.M3LConfigValidators.range(PAGE_SIZE_MIN, PAGE_SIZE_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "sourceBucket",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "sourceKey",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "contentType",
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
    name: "yes",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: YES_DEFAULT,
  }),
  new Core.M3LConfigParameter({
    name: "yesSensitive",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: YES_SENSITIVE_DEFAULT,
  }),
];

/**
 * Cross-parameter schema constraints for `s3-objects` (ADR-0048 fleet
 * retrofit, issue #483). `yesSensitive` is only a meaningful bypass companion
 * to `yes` (see `Core.confirmDestructive`'s state 3: both must be `true`
 * together to bypass a sensitive target's escalated confirmation) — setting
 * it without also setting `yes` is config drift the schema rejects outright.
 */
export const configValidators: readonly Core.M3LConfigSchemaValidator[] = [
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
