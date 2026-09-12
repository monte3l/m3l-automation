import { Core } from "@m3l-automation/m3l-common";

/**
 * The `operation` parameter's declared operation set (ADR-0055) — the four
 * verbs `cloudwatch-logs-analysis` dispatches over. `analyze` is the
 * incident-time path; the other three are offline authoring/CI aids that
 * never reach AWS (ADR-0076). Feeds {@link configParameters}' `operation`
 * declaration (which auto-composes the membership validator) and
 * {@link Core.deriveOperationValidators}'s per-operation `requiredParameters`
 * derivation below.
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
export const ANALYSIS_OPERATION_DECLARATIONS = [
  {
    name: "analyze",
    description:
      "Load a preset, compile it, run it against CloudWatch Logs Insights, and persist the report.",
    // The literal is inlined rather than referencing
    // `Core.AWS_PROFILE_PARAM_NAME` because a cross-module reference inside
    // this `as const` literal cannot be resolved per-file under
    // `isolatedDeclarations` (TS9013). The symbolic tie survives where it
    // matters — the parameter itself is still declared
    // `name: Core.AWS_PROFILE_PARAM_NAME` in `configParameters` below, so the
    // two cannot drift without that declaration failing to compile.
    requiredParameters: ["aws.profile", "alarm", "triggeredAt"],
  },
  {
    name: "validate",
    description:
      "Build every preset in the runbook directory offline and report every problem at once.",
    requiredParameters: [],
  },
  {
    name: "explain",
    description: "Print one preset's compiled step graph, cases and digest.",
    requiredParameters: ["alarm"],
  },
  {
    name: "convert",
    description: "Turn one runbook markdown file into a preset skeleton.",
    requiredParameters: ["source"],
  },
] as const;

/** The literal union of {@link ANALYSIS_OPERATION_DECLARATIONS}' operation names. */
type AnalysisOperationName =
  (typeof ANALYSIS_OPERATION_DECLARATIONS)[number]["name"];

/**
 * The closed set of operations `cloudwatch-logs-analysis` dispatches on.
 * `analyze` is the incident-time path; the other three are offline
 * authoring/CI aids that never reach AWS (ADR-0076).
 */
export const ANALYSIS_OPERATIONS: readonly [
  AnalysisOperationName,
  ...(readonly AnalysisOperationName[]),
] = Core.deriveOperationNames(ANALYSIS_OPERATION_DECLARATIONS);

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
 * required depends on the operation, which is declared on
 * {@link ANALYSIS_OPERATION_DECLARATIONS} rather than expressed by a single
 * parameter's `validate:` callback — {@link configValidators} derives and
 * enforces those requirements at config-load time, before any step runs.
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
    operations: ANALYSIS_OPERATION_DECLARATIONS,
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
 * The schema-level (cross-parameter) validators, wired into `main.ts` as
 * `config.validate`.
 *
 * The per-operation requiredness validator is DERIVED from
 * {@link ANALYSIS_OPERATION_DECLARATIONS} by
 * {@link Core.deriveOperationValidators} (ADR-0055) — `aws.profile`,
 * `alarm` and `triggeredAt` are required for `analyze`; `alarm` for
 * `explain`; `source` for `convert`; `validate` requires nothing extra.
 * Unlike the prior hand-written check, each derived validator reports one
 * missing parameter at a time (fail-fast) and never names the resolved
 * `operation` value, matching the library's secret-safety discipline — see
 * `docs/reference/scripts/cloudwatch-logs-analysis.md` for the exact wording
 * change this produces.
 *
 * `triggeredAt`'s ISO-8601 parseability stays hand-written: it is not
 * per-operation requiredness, but a genuinely cross-parameter-independent
 * format constraint, checked here so a typo'd timestamp fails at config
 * load rather than halfway through the first Logs Insights query.
 */
export const configValidators: readonly Core.M3LConfigSchemaValidator[] = [
  ...Core.deriveOperationValidators(configParameters),
  (config: Core.M3LConfig): true | string => {
    const triggeredAt = config.get("triggeredAt");
    if (typeof triggeredAt !== "string" || triggeredAt.length === 0)
      return true;
    return Number.isNaN(Date.parse(triggeredAt))
      ? "'triggeredAt' must be an ISO-8601 timestamp, e.g. 2026-08-23T14:32:00Z"
      : true;
  },
];
