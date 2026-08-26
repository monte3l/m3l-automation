import { Core } from "@m3l-automation/m3l-common";

const PAGE_SIZE_MIN = 1;
const PAGE_SIZE_MAX = 1_000;

const YES_DEFAULT = false;
const YES_SENSITIVE_DEFAULT = false;

/**
 * The `operation` parameter's declared operation set (ADR-0055) — the seven
 * verbs `s3-objects` dispatches over `aws/s3`. Feeds {@link configParameters}'
 * `operation` declaration (which auto-composes the membership validator,
 * replacing the prior hand-written `oneOf`) and
 * {@link S3_OBJECTS_OPERATIONS}' name projection below.
 *
 * `requiredParameters` here is **declarative metadata only** — CLI
 * introspection surfaces it (ADR-0055), but it is deliberately **not**
 * enforced at config-load time: `Core.deriveOperationValidators` is NOT
 * spread into {@link configValidators}, so presence enforcement stays
 * exactly where it already was — the run-start guard `steps/run-s3-objects.ts`
 * applies via `Core.M3LOperationPipeline`'s `requiredFields` option
 * (`REQUIRED_FIELDS`). Wiring `deriveOperationValidators` in here would move
 * that failure earlier (to config-load time) and is out of scope for this
 * change — do not add it without deliberately deciding to change failure
 * timing.
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
export const S3_OBJECTS_OPERATION_DECLARATIONS = [
  {
    name: "list",
    description:
      "List objects in a bucket, optionally under a prefix, streaming summaries as JSONL.",
    requiredParameters: ["output"],
  },
  {
    name: "describe",
    description: "Describe one object's metadata.",
    requiredParameters: ["key", "output"],
  },
  {
    name: "get",
    description: "Get one object's body.",
    requiredParameters: ["key", "output"],
  },
  {
    name: "put",
    description: "Write one object's body.",
    requiredParameters: ["key", "input"],
  },
  {
    name: "copy",
    description: "Copy one object between buckets/keys.",
    requiredParameters: ["key", "sourceBucket", "sourceKey"],
  },
  {
    name: "delete",
    description: "Delete one object by key.",
    requiredParameters: ["key"],
  },
  {
    name: "delete-batch",
    description:
      "Delete many objects listed in the input file, chunked into 1000-key groups.",
    requiredParameters: ["input"],
  },
] as const;

/** The literal union of {@link S3_OBJECTS_OPERATION_DECLARATIONS}' operation names. */
type S3ObjectsOperationName =
  (typeof S3_OBJECTS_OPERATION_DECLARATIONS)[number]["name"];

/**
 * Name-only projection of {@link S3_OBJECTS_OPERATION_DECLARATIONS} — the
 * seven operations `s3-objects` supports. Kept under its original name and
 * element order: passed to `Core.M3LOperationPipeline`'s `operations` option
 * in `steps/run-s3-objects.ts`, whose constructor requires a
 * `readonly [TOp, ...(readonly TOp[])]`, and read elsewhere as the closed
 * `S3ObjectsOperation` literal union.
 */
export const S3_OBJECTS_OPERATIONS: readonly [
  S3ObjectsOperationName,
  ...(readonly S3ObjectsOperationName[]),
] = Core.deriveOperationNames(S3_OBJECTS_OPERATION_DECLARATIONS);

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
 * requirements (e.g. `key` for `describe`, `input` for `put`) are declared as
 * data on {@link S3_OBJECTS_OPERATION_DECLARATIONS}' `requiredParameters` for
 * CLI introspection, but are cross-parameter constraints a single
 * parameter's validator cannot express and are deliberately left enforced at
 * run start only (see `steps/run-s3-objects.ts`) — see that constant's
 * TSDoc for why `Core.deriveOperationValidators` is not wired in here.
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
    operations: S3_OBJECTS_OPERATION_DECLARATIONS,
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
