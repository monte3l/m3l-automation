import { Core } from "@m3l-automation/m3l-common";

/**
 * The thirteen operations `codepipeline-ops` dispatches over
 * `AWS.M3LCodePipelineOperations`. Declared as a bare `as const` array
 * (rather than inline in the `M3LConfigParameter`'s `oneOf` call) so the
 * closed set is independently assertable in tests without exercising config
 * resolution — the same "bare `as const` + derived union" idiom
 * `ECS_OPERATIONS`/`CLOUDFORMATION_STACKS_OPERATIONS` use.
 */
export const CODEPIPELINE_OPS_OPERATIONS = [
  "list-pipelines",
  "describe-pipeline",
  "get-pipeline-state",
  "list-executions",
  "describe-execution",
  "create-pipeline",
  "update-pipeline",
  "delete-pipeline",
  "start-execution",
  "stop-execution",
  "enable-stage-transition",
  "disable-stage-transition",
  "watch-execution",
] as const;

/** The two values `M3LCodePipelineStageTransitionType` accepts — the wrapper's closed write-only union. */
export const STAGE_TRANSITION_TYPES = ["Inbound", "Outbound"] as const;

/** The `yes` parameter's declared default — the single source of truth `steps/run-codepipeline-ops.ts` reads at the config-read site too. */
export const YES_DEFAULT = false;

/** The `abandon` parameter's declared default (`stop-execution` only). */
export const ABANDON_DEFAULT = false;

/** The `waitMaxAttempts` parameter's declared default — passed to `Core.M3LPoller` as `maxAttempts`. */
export const WAIT_MAX_ATTEMPTS_DEFAULT = 60;

/** The `waitIntervalSeconds` parameter's declared default — the constant backoff delay `watch-execution` polls at. */
export const WAIT_INTERVAL_SECONDS_DEFAULT = 15;

const WAIT_MAX_ATTEMPTS_MIN = 1;
const WAIT_MAX_ATTEMPTS_MAX = 1000;
const WAIT_INTERVAL_SECONDS_MIN = 1;
const WAIT_INTERVAL_SECONDS_MAX = 300;
const VERSION_MIN = 1;
const VERSION_MAX = 1_000_000;
const MAX_RESULTS_MIN = 1;
const MAX_RESULTS_MAX = 1000;

/**
 * The declared configuration schema for `codepipeline-ops` — the script's
 * only input seam. Never read `process.env` directly (the scripts ESLint
 * zone bans it); declare a parameter here instead so resolution, coercion,
 * validation, and redaction all flow through the library.
 *
 * Only `aws.profile` and `operation` are `required: true`: per-operation
 * presence requirements (e.g. `pipeline` for every operation but
 * `list-pipelines`, `input` for `create-pipeline`/`update-pipeline`) are not
 * expressible by a single parameter's `validate:` callback. F1b's
 * `Core.M3LConfigSchema` `configValidators` seam (shipped) could express
 * these as config-load-time checks instead; they remain guard-checked at
 * run start pending this script's fleet retrofit — see
 * `steps/run-codepipeline-ops.ts`.
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
      CODEPIPELINE_OPS_OPERATIONS,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "pipeline",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "executionId",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "stage",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "transitionType",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.oneOf<string>(STAGE_TRANSITION_TYPES),
  }),
  new Core.M3LConfigParameter({
    name: "reason",
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
    name: "version",
    type: Core.M3LConfigParameterType.INT,
    validate: Core.M3LConfigValidators.range(VERSION_MIN, VERSION_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "maxResults",
    type: Core.M3LConfigParameterType.INT,
    validate: Core.M3LConfigValidators.range(MAX_RESULTS_MIN, MAX_RESULTS_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "clientRequestToken",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "abandon",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: ABANDON_DEFAULT,
  }),
  new Core.M3LConfigParameter({
    name: "yes",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: YES_DEFAULT,
  }),
  new Core.M3LConfigParameter({
    name: "waitMaxAttempts",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: WAIT_MAX_ATTEMPTS_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      WAIT_MAX_ATTEMPTS_MIN,
      WAIT_MAX_ATTEMPTS_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "waitIntervalSeconds",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: WAIT_INTERVAL_SECONDS_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      WAIT_INTERVAL_SECONDS_MIN,
      WAIT_INTERVAL_SECONDS_MAX,
    ),
  }),
];
