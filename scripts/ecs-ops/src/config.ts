import { Core } from "@m3l-automation/m3l-common";

/**
 * The eight verbs `ecs-ops` dispatches over `AWS.M3LECSOperations`.
 * Declared as a bare `as const` array (rather than inline in the
 * `M3LConfigParameter`'s `oneOf` call) so the closed set is independently
 * assertable in tests without exercising config resolution — the same
 * "bare `as const` + derived union" idiom `scripts/lambda-ops/src/config.ts`
 * uses for `LAMBDA_OPERATIONS`.
 */
export const ECS_OPERATIONS = [
  "list-services",
  "describe-service",
  "create-service",
  "update-service",
  "delete-service",
  "wait-services-stable",
  "list-clusters",
  "describe-cluster",
] as const;

/** The `force` parameter's declared default — the single source of truth `steps/run-ecs-ops.ts` reads at the config-read site too. */
export const FORCE_DEFAULT = false;

/** The `yes` parameter's declared default — the single source of truth `steps/run-ecs-ops.ts` reads at the config-read site too. */
export const YES_DEFAULT = false;

/** The `maxWaitTime` parameter's declared `range()` bounds, in seconds. */
const MAX_WAIT_TIME_MIN_SECONDS = 1;
const MAX_WAIT_TIME_MAX_SECONDS = 3600;

/**
 * The declared configuration schema for `ecs-ops` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); declare a parameter here instead so resolution, coercion, validation,
 * and redaction all flow through the library.
 *
 * Only `aws.profile` and `operation` are `required: true`: per-operation
 * cross-parameter requirements (e.g. `cluster`/`service` for
 * `describe-service`, `input` for `create-service`/`update-service`) are not
 * expressible by a single parameter's validator (F1b, deferred), so they are
 * guard-checked at run start instead — see `steps/run-ecs-ops.ts`.
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
    validate: Core.M3LConfigValidators.oneOf<string>(ECS_OPERATIONS),
  }),
  new Core.M3LConfigParameter({
    name: "cluster",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "service",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "services",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "input",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "nextToken",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "force",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: FORCE_DEFAULT,
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
