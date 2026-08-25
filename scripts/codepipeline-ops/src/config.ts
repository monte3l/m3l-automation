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
 * `list-pipelines`, `input` for `create-pipeline`/`update-pipeline`) are not
 * expressible by a single parameter's `validate:` callback — see
 * `configValidators` below, which enforces them at config-load time.
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

/** `pipeline` is required for every operation except these three. */
const PIPELINE_NOT_REQUIRED_OPERATIONS = [
  "list-pipelines",
  "create-pipeline",
  "update-pipeline",
] as const;

/** `executionId` is required for these three operations. */
const EXECUTION_ID_REQUIRED_OPERATIONS = [
  "describe-execution",
  "stop-execution",
  "watch-execution",
] as const;

/** `stage`/`transitionType` are required for both stage-transition operations. */
const STAGE_TRANSITION_REQUIRED_OPERATIONS = [
  "enable-stage-transition",
  "disable-stage-transition",
] as const;

/** `reason` is required ONLY for `disable-stage-transition` — `stop-execution` forwards it but never requires it. */
const REASON_REQUIRED_OPERATIONS = ["disable-stage-transition"] as const;

/** `input` is required for both mutating-declaration operations. */
const INPUT_REQUIRED_OPERATIONS = [
  "create-pipeline",
  "update-pipeline",
] as const;

/**
 * Joins `operations` into a human-readable, individually-quoted,
 * Oxford-comma list: `'a'`, `'a' and 'b'`, or `'a', 'b', and 'c'`. Used only
 * to describe the fixed, closed set of operations a constraint applies to —
 * never a caller-supplied value.
 */
const OXFORD_COMMA_MIN_LENGTH = 3;

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
 * `operations` (used for `pipeline`, whose exclusion set is smaller than its
 * requirement set). Skips (returns `true`) when `operation` itself has not
 * resolved to a string — the `operation` parameter's own `required` +
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
  requiredWhenOperation("pipeline", PIPELINE_NOT_REQUIRED_OPERATIONS, "except"),
  requiredWhenOperation("executionId", EXECUTION_ID_REQUIRED_OPERATIONS),
  requiredWhenOperation("stage", STAGE_TRANSITION_REQUIRED_OPERATIONS),
  requiredWhenOperation("transitionType", STAGE_TRANSITION_REQUIRED_OPERATIONS),
  requiredWhenOperation("reason", REASON_REQUIRED_OPERATIONS),
  requiredWhenOperation("input", INPUT_REQUIRED_OPERATIONS),
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
