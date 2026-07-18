import { Core } from "@m3l-automation/m3l-common";

/**
 * The seven verbs `lambda-ops` dispatches over `AWS.M3LLambdaOperations`.
 * Declared as a bare `as const` array (rather than inline in the
 * `M3LConfigParameter`'s `oneOf` call) so the closed set is independently
 * assertable in tests without exercising config resolution — the same
 * "bare `as const` + derived union" idiom `scripts/dynamodb-crud/src/config.ts`
 * uses for `DYNAMO_OPERATIONS`.
 */
export const LAMBDA_OPERATIONS = [
  "list",
  "describe",
  "invoke",
  "create",
  "update-code",
  "update-configuration",
  "delete",
] as const;

/** The `yes` parameter's declared default — the single source of truth `steps/run-lambda-ops.ts` reads at the config-read site too. */
export const YES_DEFAULT = false;

/**
 * The declared configuration schema for `lambda-ops` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); declare a parameter here instead so resolution, coercion, validation,
 * and redaction all flow through the library.
 *
 * Only `aws.profile` and `operation` are `required: true`: per-operation
 * cross-parameter requirements (e.g. `functionName` for everything but
 * `list`, `zipFilePath` for `create`/`update-code`) are not expressible by a
 * single parameter's validator (F1b, deferred), so they are guard-checked at
 * run start instead — see `steps/run-lambda-ops.ts`.
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
    validate: Core.M3LConfigValidators.oneOf<string>(LAMBDA_OPERATIONS),
  }),
  new Core.M3LConfigParameter({
    name: "functionName",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "marker",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "zipFilePath",
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
];
