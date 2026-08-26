import { Core } from "@m3l-automation/m3l-common";

/**
 * The thirteen operations `codepipeline-ops` dispatches over
 * `AWS.M3LCodePipelineOperations`, declared as data (ADR-0055). Feeds
 * {@link configParameters}' `operation` declaration (which auto-composes the
 * membership validator) and {@link Core.deriveOperationValidators}'s
 * per-operation `requiredParameters` derivation below.
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
export const CODEPIPELINE_OPS_OPERATION_DECLARATIONS = [
  {
    name: "list-pipelines",
    description: "List pipelines in the account, one page per call.",
    requiredParameters: [],
  },
  {
    name: "describe-pipeline",
    description:
      "Describe one pipeline's declaration, optionally at a specific version.",
    requiredParameters: ["pipeline"],
  },
  {
    name: "get-pipeline-state",
    description: "Get a pipeline's current stage states.",
    requiredParameters: ["pipeline"],
  },
  {
    name: "list-executions",
    description: "List a pipeline's executions, one page per call.",
    requiredParameters: ["pipeline"],
  },
  {
    name: "describe-execution",
    description: "Describe one pipeline execution.",
    requiredParameters: ["pipeline", "executionId"],
  },
  {
    name: "create-pipeline",
    description: "Create a pipeline from a JSON declaration document.",
    requiredParameters: ["input"],
  },
  {
    name: "update-pipeline",
    description:
      "Update an existing pipeline from a JSON declaration document.",
    requiredParameters: ["input"],
  },
  {
    name: "delete-pipeline",
    description: "Delete a pipeline.",
    requiredParameters: ["pipeline"],
  },
  {
    name: "start-execution",
    description: "Start a new execution of a pipeline.",
    requiredParameters: ["pipeline"],
  },
  {
    name: "stop-execution",
    description: "Stop an in-progress pipeline execution.",
    requiredParameters: ["pipeline", "executionId"],
  },
  {
    name: "enable-stage-transition",
    description: "Enable a stage's inbound or outbound transition.",
    requiredParameters: ["pipeline", "stage", "transitionType"],
  },
  {
    name: "disable-stage-transition",
    description:
      "Disable a stage's inbound or outbound transition, recording a reason.",
    requiredParameters: ["pipeline", "stage", "transitionType", "reason"],
  },
  {
    name: "watch-execution",
    description: "Poll an execution until it reaches a terminal status.",
    requiredParameters: ["pipeline", "executionId"],
  },
] as const;

/**
 * The literal union of {@link CODEPIPELINE_OPS_OPERATION_DECLARATIONS}'
 * operation names.
 */
type CodepipelineOpsOperationName =
  (typeof CODEPIPELINE_OPS_OPERATION_DECLARATIONS)[number]["name"];

/**
 * Name-only projection of {@link CODEPIPELINE_OPS_OPERATION_DECLARATIONS} —
 * keeps the closed set independently assertable in tests without exercising
 * config resolution.
 */
export const CODEPIPELINE_OPS_OPERATIONS: readonly [
  CodepipelineOpsOperationName,
  ...(readonly CodepipelineOpsOperationName[]),
] = Core.deriveOperationNames(CODEPIPELINE_OPS_OPERATION_DECLARATIONS);

/** The two values `M3LCodePipelineStageTransitionType` accepts — the wrapper's closed write-only union. */
export const STAGE_TRANSITION_TYPES = ["Inbound", "Outbound"] as const;

/** The `yes` parameter's declared default — the single source of truth `steps/run-codepipeline-ops.ts` reads at the config-read site too. */
export const YES_DEFAULT = false;

/** The `yesSensitive` parameter's declared default — the single source of truth `steps/run-codepipeline-ops.ts` reads at the config-read site too. */
export const YES_SENSITIVE_DEFAULT = false;

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
 * `list-pipelines`/`create-pipeline`/`update-pipeline`, `input` for
 * `create-pipeline`/`update-pipeline`) are declared on
 * {@link CODEPIPELINE_OPS_OPERATION_DECLARATIONS} rather than expressed by a
 * single parameter's `validate:` callback — see {@link configValidators}
 * below, which derives and enforces them at config-load time.
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
    operations: CODEPIPELINE_OPS_OPERATION_DECLARATIONS,
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
    name: "yesSensitive",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: YES_SENSITIVE_DEFAULT,
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

/**
 * The `codepipeline-ops` schema-level cross-parameter validators (F1b) — the
 * declared config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN `operation` and the
 * parameter(s) it conditionally requires, which no single
 * `M3LConfigParameter` can express on its own — the "Required for" column of
 * `docs/reference/scripts/codepipeline-ops.md`'s configuration table.
 *
 * The per-operation requiredness validators are DERIVED from
 * {@link CODEPIPELINE_OPS_OPERATION_DECLARATIONS} by
 * {@link Core.deriveOperationValidators} (ADR-0055):
 *
 * - `pipeline` is required for every operation but `list-pipelines`,
 *   `create-pipeline`, `update-pipeline`.
 * - `executionId` is required for `describe-execution`, `stop-execution`,
 *   `watch-execution`.
 * - `stage`/`transitionType` are required for `enable-stage-transition`,
 *   `disable-stage-transition`.
 * - `reason` is required ONLY for `disable-stage-transition` —
 *   `stop-execution` forwards it but never requires it.
 * - `input` is required for `create-pipeline`, `update-pipeline`.
 *
 * `transitionType`'s own `oneOf(Inbound, Outbound)` membership check (see
 * `configParameters` above) is a plain enum validator, not an operation
 * selector — it is unaffected by this derivation.
 *
 * This SUPPLEMENTS, rather than replaces, the existing run-start
 * `accessor.requiredFor(...)` guards in `steps/run-codepipeline-ops.ts`:
 * those calls also narrow `string | undefined` into `string` for typed
 * downstream use, which TypeScript still needs even though presence is now
 * guaranteed earlier by these validators. See
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
  ...Core.deriveOperationValidators(configParameters),
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
