import { Core } from "@m3l-automation/m3l-common";

/**
 * The closed set of operations `cloudwatch-logs-analysis` dispatches on.
 * `analyze` is the incident-time path; the other three are offline
 * authoring/CI aids that never reach AWS (ADR-0076).
 */
export const ANALYSIS_OPERATIONS = [
  "analyze",
  "validate",
  "explain",
  "convert",
] as const;

/** One member of {@link ANALYSIS_OPERATIONS}. */
export type AnalysisOperation = (typeof ANALYSIS_OPERATIONS)[number];

/** The default preset directory, relative to `M3L_INPUT_DIR`. */
export const RUNBOOK_DIR_DEFAULT = "runbooks";
/** The default trace-chain ceiling. */
export const MAX_DEPTH_DEFAULT = 4;
const MAX_DEPTH_MIN = 1;
const MAX_DEPTH_MAX = 8;
const MINUTES_MIN = 0;
const MINUTES_MAX = 1440;

/**
 * The declared configuration schema — the script's only input seam. Mirrors
 * `docs/reference/scripts/cloudwatch-logs-analysis.md`'s "Configuration
 * schema" table exactly, in table order.
 *
 * Only `operation`, `runbookDir`, `maxDepth`, `interactive` and `format`
 * carry a default. Everything else is **bare-optional**: whether it is
 * required depends on the operation, which no per-parameter validator can
 * see — {@link configValidators} adjudicates that at config-load time,
 * before any step runs.
 *
 * `Core.AWS_PROFILE_PARAM_NAME` (`aws.profile`) is declared but not
 * `required: true` on purpose: declaring the parameter is what triggers
 * `M3LScript` to provision `script.aws`, and only `analyze` needs it —
 * `validate`, `explain` and `convert` must stay runnable with no AWS
 * credentials at all, which is what makes `validate` a CI gate.
 *
 * `leadMinutes`, `lagMinutes` and `severityLadder` are per-run **overrides**
 * of the preset's own values, not defaults: absent, the preset decides. A
 * default here would silently overwrite every preset's authored window.
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: "operation",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: "analyze",
    validate: Core.M3LConfigValidators.oneOf<string>(ANALYSIS_OPERATIONS),
  }),
  new Core.M3LConfigParameter({
    name: Core.AWS_PROFILE_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "alarm",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "triggeredAt",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "runbookDir",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: RUNBOOK_DIR_DEFAULT,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "source",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "leadMinutes",
    type: Core.M3LConfigParameterType.INT,
    validate: Core.M3LConfigValidators.range(MINUTES_MIN, MINUTES_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "lagMinutes",
    type: Core.M3LConfigParameterType.INT,
    validate: Core.M3LConfigValidators.range(MINUTES_MIN, MINUTES_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "severityLadder",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "maxDepth",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: MAX_DEPTH_DEFAULT,
    validate: Core.M3LConfigValidators.range(MAX_DEPTH_MIN, MAX_DEPTH_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "interactive",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: false,
  }),
  new Core.M3LConfigParameter({
    name: "output",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "format",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: "json",
    validate: Core.M3LConfigValidators.oneOf(["json", "text"]),
  }),
];

/**
 * Which bare-optional parameters each operation cannot run without. Keyed as
 * a `Record<AnalysisOperation, ...>` so adding an operation to
 * {@link ANALYSIS_OPERATIONS} without deciding its requirements is a compile
 * error, not a run-time gap.
 */
const REQUIRED_BY_OPERATION: Record<AnalysisOperation, readonly string[]> = {
  analyze: [Core.AWS_PROFILE_PARAM_NAME, "alarm", "triggeredAt"],
  validate: [],
  explain: ["alarm"],
  convert: ["source"],
};

/** Reads `operation`, falling back to the declared default. */
function readOperation(config: Core.M3LConfig): AnalysisOperation {
  const raw = config.get("operation");
  const match = ANALYSIS_OPERATIONS.find((candidate) => candidate === raw);
  return match ?? "analyze";
}

/**
 * The schema-level (cross-parameter) validators, wired into `main.ts` as
 * `config.validate`.
 *
 * Two constraints live here because no per-parameter validator can express
 * them: per-operation requiredness (a validator never sees a second
 * parameter's value), and `triggeredAt`'s ISO-8601 parseability, which is
 * checked here so a typo'd timestamp fails at config load rather than
 * halfway through the first Logs Insights query.
 */
export const configValidators: readonly Core.M3LConfigSchemaValidator[] = [
  (config: Core.M3LConfig): true | string => {
    const operation = readOperation(config);
    const missing = REQUIRED_BY_OPERATION[operation].filter((name) => {
      const value = config.get(name);
      return typeof value !== "string" || value.length === 0;
    });
    return missing.length === 0
      ? true
      : `operation '${operation}' requires: ${missing.join(", ")}`;
  },
  (config: Core.M3LConfig): true | string => {
    const triggeredAt = config.get("triggeredAt");
    if (typeof triggeredAt !== "string" || triggeredAt.length === 0)
      return true;
    return Number.isNaN(Date.parse(triggeredAt))
      ? "'triggeredAt' must be an ISO-8601 timestamp, e.g. 2026-08-23T14:32:00Z"
      : true;
  },
];
