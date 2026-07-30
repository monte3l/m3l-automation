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
 * `validate:` callback. F1b's `Core.M3LConfigSchema` `configValidators` seam
 * (shipped) could express these presence checks as config-load-time checks
 * instead; they remain guard-checked at run start pending this script's
 * fleet retrofit — see `steps/run-cloudformation-stacks.ts`. The separate
 * `template`-vs-`input`-record `templateBody`/`templateUrl` conflict check
 * (also in that file) is a different class of guard — it compares a config
 * parameter against a *parsed input file's contents*, not another config
 * parameter, so `configValidators` cannot express it and it stays a
 * permanent run-start guard regardless of F1b (see `docs/plans/IMPLEMENTATION.md`'s F1b row).
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
];
