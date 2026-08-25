import { Core } from "@m3l-automation/m3l-common";

/**
 * The nine operations `cloudformation-stacks` dispatches over
 * `AWS.M3LCloudFormationOperations`. Declared as a bare `as const` array
 * (rather than inline in the `M3LConfigParameter`'s `oneOf` call) so the
 * closed set is independently assertable in tests without exercising config
 * resolution — the same "bare `as const` + derived union" idiom
 * `ECS_OPERATIONS`/`LAMBDA_OPERATIONS`/`DYNAMO_OPERATIONS` use.
 */
export const CLOUDFORMATION_STACKS_OPERATIONS = [
  "list-stacks",
  "describe-stack",
  "describe-stack-events",
  "create-stack",
  "update-stack",
  "delete-stack",
  "wait-stack-create-complete",
  "wait-stack-update-complete",
  "wait-stack-delete-complete",
] as const;

/** The `yes` parameter's declared default — the single source of truth `steps/run-cloudformation-stacks.ts` reads at the config-read site too. */
export const YES_DEFAULT = false;

/** The `yesSensitive` parameter's declared default — the single source of truth `steps/run-cloudformation-stacks.ts` reads at the config-read site too. */
export const YES_SENSITIVE_DEFAULT = false;

/** The `maxWaitTime` parameter's declared `range()` bounds, in seconds. */
const MAX_WAIT_TIME_MIN_SECONDS = 1;
const MAX_WAIT_TIME_MAX_SECONDS = 3600;

/**
 * The declared configuration schema for `cloudformation-stacks` — the
 * script's only input seam. Never read `process.env` directly (the scripts
 * ESLint zone bans it); declare a parameter here instead so resolution,
 * coercion, validation, and redaction all flow through the library.
 *
 * Only `aws.profile` and `operation` are `required: true`: per-operation
 * presence requirements (e.g. `stackName` for `describe-stack`, `input` for
 * `create-stack`/`update-stack`) are not expressible by a single parameter's
 * `validate:` callback — see `configValidators` below, which enforces these
 * presence checks at config-load time. The separate `template`-vs-`input`-
 * record `templateBody`/`templateUrl` conflict check
 * (`steps/run-cloudformation-stacks.ts`'s `resolveTemplateText`) is a
 * different class of guard — it compares a config parameter against a
 * *parsed input file's contents*, not another config parameter, so
 * `configValidators` (a config-only seam with no filesystem access)
 * structurally cannot express it and it stays a permanent run-start guard.
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
    validate: Core.M3LConfigValidators.oneOf<string>(
      CLOUDFORMATION_STACKS_OPERATIONS,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "stackName",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "input",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "template",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "stackStatusFilter",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "retainResources",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "roleArn",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "nextToken",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "maxWaitTime",
    type: Core.M3LConfigParameterType.INT,
    validate: Core.M3LConfigValidators.range(
      MAX_WAIT_TIME_MIN_SECONDS,
      MAX_WAIT_TIME_MAX_SECONDS,
    ),
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

/** `stackName` is required for every operation except these three. */
const STACK_NAME_NOT_REQUIRED_OPERATIONS = [
  "list-stacks",
  "create-stack",
  "update-stack",
] as const;

/** `input` is required for both mutating-declaration operations. */
const INPUT_REQUIRED_OPERATIONS = ["create-stack", "update-stack"] as const;

const OXFORD_COMMA_MIN_LENGTH = 3;

/**
 * Joins `operations` into a human-readable, individually-quoted,
 * Oxford-comma list: `'a'`, `'a' and 'b'`, or `'a', 'b', and 'c'`. Used only
 * to describe the fixed, closed set of operations a constraint applies to —
 * never a caller-supplied value.
 */
function quotedList(operations: readonly string[]): string {
  const quoted = operations.map((operation) => `'${operation}'`);
  return quoted.reduce((joined, item, index) => {
    if (index === 0) return item;
    if (index === quoted.length - 1) {
      return quoted.length >= OXFORD_COMMA_MIN_LENGTH
        ? `${joined}, and ${item}`
        : `${joined} and ${item}`;
    }
    return `${joined}, ${item}`;
  }, "");
}

/**
 * Builds an F1b cross-parameter validator enforcing that `paramName` is set
 * whenever `operation` resolves to a member of `operations` — or, when
 * `mode` is `"except"`, whenever it resolves to anything OUTSIDE
 * `operations` (used for `stackName`, whose exclusion set is smaller than
 * its requirement set). Skips (returns `true`) when `operation` itself has
 * not resolved to a string — the `operation` parameter's own `required` +
 * `oneOf` validation already guards that shape before schema-level
 * validators ever run, so this is defensive, not load-bearing.
 */
function requiredWhenOperation(
  paramName: string,
  operations: readonly string[],
  mode: "for" | "except" = "for",
): Core.M3LConfigSchemaValidator {
  return (config: Core.M3LConfig): true | string => {
    const operation = config.get("operation");
    if (typeof operation !== "string") return true;

    const listed = operations.includes(operation);
    const applies = mode === "for" ? listed : !listed;
    if (!applies || config.get(paramName) !== undefined) return true;

    return mode === "for"
      ? `'${paramName}' is required for ${quotedList(operations)}`
      : `'${paramName}' is required for every operation except ${quotedList(operations)}`;
  };
}

/**
 * The `cloudformation-stacks` schema-level cross-parameter validators
 * (F1b) — the declared config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN `operation` and the
 * parameter(s) it conditionally requires, which no single
 * `M3LConfigParameter` can express on its own — the "Required for" column of
 * `docs/reference/scripts/cloudformation-stacks.md`'s configuration table.
 *
 * This SUPPLEMENTS, rather than replaces, the existing run-start
 * `accessor.requiredFor(...)` guards in `steps/run-cloudformation-stacks.ts`:
 * those calls also narrow `string | undefined` into `string` for typed
 * downstream use, which TypeScript still needs even though presence is now
 * guaranteed earlier by these validators. The separate `template`-vs-
 * `input`-record `templateBody`/`templateUrl` conflict check
 * (`resolveTemplateText`) is deliberately **not** covered here — see the
 * `configParameters` TSDoc above for why. See
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
  requiredWhenOperation(
    "stackName",
    STACK_NAME_NOT_REQUIRED_OPERATIONS,
    "except",
  ),
  requiredWhenOperation("input", INPUT_REQUIRED_OPERATIONS),
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
