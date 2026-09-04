import { Core } from "@m3l-automation/m3l-common";

import { isAllowedScriptName } from "./lib/cli-names.js";

const MAX_ITERATIONS_MIN = 1;
const MAX_ITERATIONS_MAX = 64;
/**
 * Declared default for `maxIterations`. Exported so
 * `steps/resolve-runtime.ts` can reuse the same literal for its
 * standalone-unit-test fallback rather than hand-copying it — see that
 * module's `resolveAgentOperatorRuntime` doc for why the fallback exists at
 * all despite being unreachable through the real `M3LScript` pipeline.
 */
export const MAX_ITERATIONS_DEFAULT = 8;
const MAX_TOOLS_PER_TURN_MIN = 1;
const MAX_TOOLS_PER_TURN_MAX = 16;
/** Declared default for `maxToolsPerTurn` — see {@link MAX_ITERATIONS_DEFAULT}. */
export const MAX_TOOLS_PER_TURN_DEFAULT = 4;
const MAX_OUTPUT_TOKENS_MIN = 1;
const MAX_OUTPUT_TOKENS_MAX = 8192;
/** Declared default for `maxOutputTokens` — see {@link MAX_ITERATIONS_DEFAULT}. */
export const MAX_OUTPUT_TOKENS_DEFAULT = 2048;
const CLI_TIMEOUT_MS_MIN = 1000;
const CLI_TIMEOUT_MS_MAX = 600_000;
/** Declared default for `cliTimeoutMs` — see {@link MAX_ITERATIONS_DEFAULT}. */
export const CLI_TIMEOUT_MS_DEFAULT = 30_000;
const DRY_RUN_TIMEOUT_MS_MIN = 1000;
const DRY_RUN_TIMEOUT_MS_MAX = 900_000;
/** Declared default for `dryRunTimeoutMs` — see {@link MAX_ITERATIONS_DEFAULT}. */
export const DRY_RUN_TIMEOUT_MS_DEFAULT = 120_000;
const MAX_OUTPUT_BYTES_MIN = 1024;
const MAX_OUTPUT_BYTES_MAX = 16_777_216;
/** Declared default for `maxOutputBytes` — see {@link MAX_ITERATIONS_DEFAULT}. */
export const MAX_OUTPUT_BYTES_DEFAULT = 1_048_576;
/** Declared default for `policyFile` — see {@link MAX_ITERATIONS_DEFAULT}. */
export const POLICY_FILE_DEFAULT = "agent-policy.json";
/** Declared default for `agentName` — see {@link MAX_ITERATIONS_DEFAULT}. */
export const AGENT_NAME_DEFAULT = "agent-operator";
const INCLUDE_DRY_RUN_PROBES_DEFAULT = false;

/**
 * Builds a {@link Core.M3LConfigValidator} for a `STRING_ARRAY` parameter
 * that rejects the array unless every element is an allowed script name
 * (`src/lib/cli-names.ts`'s `isAllowedScriptName`) — the same allowlist
 * `src/lib/cli-surface.ts` enforces per-call before any spawn. Attaching it
 * here makes the published reference table ("each an allowed script name")
 * true at config-load time too, not only at first use.
 *
 * @param parameterName - The declaring parameter's canonical name, named in
 *   the failure reason. The offending element itself is never echoed — a
 *   rejected script name can be an operator typo or model-supplied text,
 *   and neither is safe to surface verbatim.
 * @returns A validator whose failure reason names only `parameterName`.
 */
function eachAllowedScriptName(
  parameterName: string,
): Core.M3LConfigValidator<readonly string[]> {
  return (values) =>
    values.every((value) => isAllowedScriptName(value))
      ? true
      : `every '${parameterName}' entry must be an allowed script name`;
}

/**
 * Builds a {@link Core.M3LConfigValidator} for a `STRING_ARRAY` parameter
 * that rejects the array unless every element is a non-blank model id
 * ("each `nonEmpty`" in the published reference table).
 *
 * @param parameterName - The declaring parameter's canonical name, named in
 *   the failure reason. The offending element is never echoed.
 * @returns A validator whose failure reason names only `parameterName`.
 */
function eachNonEmptyModelId(
  parameterName: string,
): Core.M3LConfigValidator<readonly string[]> {
  return (values) =>
    values.every((value) => value.trim().length > 0)
      ? true
      : `every '${parameterName}' entry must be a non-empty model id`;
}

/**
 * The `command` parameter's declared operation set (ADR-0055) — the two
 * verbs `agent-operator` dispatches over in PR 1 (offline-only: no Bedrock
 * client, no agent loop, no network). Feeds {@link configParameters}'
 * `command` declaration (which auto-composes the membership validator) and
 * {@link AGENT_OPERATOR_COMMANDS} below.
 *
 * Deliberately **only two** operations, and deliberately no generic
 * `ask`/`prompt` operation: a free-form operation would let model output
 * (rather than a reviewed, versioned declaration) choose which workload
 * runs, defeating the whole point of declaring the operation set as data.
 *
 * Declared with a bare `as const` — NOT
 * `as const satisfies Core.M3LOperationDeclarationList` — because a
 * `satisfies` clause on this literal fails `tsc --isolatedDeclarations`
 * (the mode `tsconfig.build.json` builds under). The shape is still fully
 * compile-time-checked at both use sites without it: passing this value to
 * `Core.deriveOperationNames` below and to `operations:` in
 * `configParameters` each independently check it against
 * `Core.M3LOperationDeclarationList` — do not re-add `satisfies` here.
 */
export const AGENT_OPERATOR_COMMAND_DECLARATIONS = [
  {
    name: "health-check",
    description:
      "Run m3l doctor/list/inspect across the discovered script fleet and report blocking failures — deterministic, no Bedrock call.",
    requiredParameters: [],
  },
  {
    name: "explain-policy",
    description:
      "Load the agent policy file and render its grants, operations, budgets, and flags — deterministic, no Bedrock call.",
    requiredParameters: [],
  },
] as const;

/** The literal union of {@link AGENT_OPERATOR_COMMAND_DECLARATIONS}' command names. */
type AgentOperatorCommandName =
  (typeof AGENT_OPERATOR_COMMAND_DECLARATIONS)[number]["name"];

/** The `command` config parameter's finite set of operation modes. */
export const AGENT_OPERATOR_COMMANDS: readonly [
  AgentOperatorCommandName,
  ...(readonly AgentOperatorCommandName[]),
] = Core.deriveOperationNames(AGENT_OPERATOR_COMMAND_DECLARATIONS);

/**
 * The declared configuration schema for `agent-operator` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); declare a parameter here instead so resolution, coercion, validation,
 * and redaction all flow through the library.
 *
 * Only `aws.profile`, `command`, and `modelId` are `required: true` — every
 * other parameter is either defaulted or genuinely operation-optional (an
 * absence handled downstream, e.g. `output`/`decisionLogDir`/`cliEntrypoint`
 * falling back to a derived location in `steps/resolve-runtime.ts`).
 *
 * `scripts` and `dryRunAllowlist` attach {@link eachAllowedScriptName}
 * (built on `src/lib/cli-names.ts`'s `isAllowedScriptName`, the same
 * allowlist `src/lib/cli-surface.ts`'s `assertAllowedScriptName` enforces
 * per-call before any spawn) so a malformed name fails closed at
 * config-load time — fail early, not just at first use. `fallbackModelIds`
 * attaches {@link eachNonEmptyModelId}. `modelRates` carries no `validate`
 * here on purpose: its `"<id>=<in>,<out>"` grammar, plus rejecting
 * non-finite/negative rates, is parsed and validated in
 * `steps/resolve-runtime.ts` — see that module's own tests — and duplicating
 * that grammar here would risk drifting from its single source of truth.
 * `presetAllowlist` carries no `validate` for the same reason: its
 * `"<name>=<path>"` grammar — the allowed preset name, the non-blank
 * workspace-relative path, and the containment rule keeping that path inside
 * the workspace presets directory — is parsed and validated in
 * `steps/resolve-runtime.ts` (`parsePresetAllowlist`), which is the single
 * source of truth. A validator here would be a second copy of that grammar,
 * free to drift from the one that actually gates a spawn, and the copy an
 * operator's failure message came from would stop being predictable.
 *
 * Deliberately absent, each for a reason:
 * - No `budget*` parameter. Budgets are policy-file fields (see
 *   `data/input/agent-policy.json`); exposing them on argv would let an
 *   operator widen a declared ceiling without a reviewable diff, defeating
 *   ADR-0060's premise that the policy file is the auditable ceiling.
 * - No `dryRun` parameter. It is ADR-0054's context flag, read once in
 *   `main.ts` — not a declared config value.
 * - No `yes`/`yesSensitive`. Neither confirm-gate flag applies, because this
 *   workload never calls `confirmDestructive` — not because it has no
 *   mutating path. It does have one: the `run` operation spawns `m3l run`
 *   against an allowlisted preset, which executes a real script. That path is
 *   gated by the V6 agent-policy layer instead (the action's `mutating`
 *   classification evaluated against the reviewable policy file, plus this
 *   module's `presetAllowlist`), so the gate lives in a diffable artifact
 *   rather than in an argv flag a caller could simply pass.
 *
 * Declare an AWS profile parameter with `Core.AWS_PROFILE_PARAM_NAME` when the
 * script touches AWS — that name is what enables the `script.aws`
 * dynamic-provisioning seam.
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: Core.AWS_PROFILE_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "command",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    operations: AGENT_OPERATOR_COMMAND_DECLARATIONS,
  }),
  new Core.M3LConfigParameter({
    name: "modelId",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "fallbackModelIds",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    defaultValue: [],
    validate: eachNonEmptyModelId("fallbackModelIds"),
  }),
  new Core.M3LConfigParameter({
    name: "modelRates",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    defaultValue: [],
  }),
  new Core.M3LConfigParameter({
    name: "policyFile",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: POLICY_FILE_DEFAULT,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "agentName",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: AGENT_NAME_DEFAULT,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "maxIterations",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: MAX_ITERATIONS_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      MAX_ITERATIONS_MIN,
      MAX_ITERATIONS_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "maxToolsPerTurn",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: MAX_TOOLS_PER_TURN_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      MAX_TOOLS_PER_TURN_MIN,
      MAX_TOOLS_PER_TURN_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "maxOutputTokens",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: MAX_OUTPUT_TOKENS_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      MAX_OUTPUT_TOKENS_MIN,
      MAX_OUTPUT_TOKENS_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "scripts",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    defaultValue: [],
    validate: eachAllowedScriptName("scripts"),
  }),
  new Core.M3LConfigParameter({
    name: "includeDryRunProbes",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: INCLUDE_DRY_RUN_PROBES_DEFAULT,
  }),
  new Core.M3LConfigParameter({
    name: "dryRunAllowlist",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    defaultValue: [],
    validate: eachAllowedScriptName("dryRunAllowlist"),
  }),
  new Core.M3LConfigParameter({
    name: "presetAllowlist",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    defaultValue: [],
  }),
  new Core.M3LConfigParameter({
    name: "output",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "decisionLogDir",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "cliEntrypoint",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "cliTimeoutMs",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: CLI_TIMEOUT_MS_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      CLI_TIMEOUT_MS_MIN,
      CLI_TIMEOUT_MS_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "dryRunTimeoutMs",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: DRY_RUN_TIMEOUT_MS_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      DRY_RUN_TIMEOUT_MS_MIN,
      DRY_RUN_TIMEOUT_MS_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "maxOutputBytes",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: MAX_OUTPUT_BYTES_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      MAX_OUTPUT_BYTES_MIN,
      MAX_OUTPUT_BYTES_MAX,
    ),
  }),
];

/**
 * The `agent-operator` schema-level cross-parameter validators (F1b) — the
 * declared config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved.
 *
 * PR 1 declares no `requiredParameters` on either operation in
 * {@link AGENT_OPERATOR_COMMAND_DECLARATIONS} (`health-check` and
 * `explain-policy` both need only the globally-required `modelId`/
 * `aws.profile`), so {@link Core.deriveOperationValidators} currently derives
 * an empty array — it is still spread in unconditionally so a later
 * operation-specific `requiredParameters` entry is enforced without anyone
 * having to remember to wire it up.
 *
 * The `maxIterations` must-not-exceed `policy.budgets.loopIterations` cross-check
 * (ADR-0060: a policy-declared ceiling must not be widenable from argv) is
 * NOT expressed here — it depends on the loaded policy file, which this
 * static schema has no access to. It is enforced in
 * `steps/resolve-runtime.ts` instead, after `steps/load-policy.ts` has
 * resolved the policy.
 *
 * The `includeDryRunProbes` ⇒ `dryRunAllowlist` validator stays hand-written
 * (not derived): it is not per-operation requiredness, but a genuinely
 * cross-parameter constraint between an independently-defaulted `BOOL` and a
 * `STRING_ARRAY` — enabling the dry-run tool while leaving its allowlist
 * empty would ship a tool that can probe nothing, which is a config mistake
 * to reject at load time rather than a silent no-op discovered mid-run.
 * `Core.M3LConfigSchemaValidators.requires` cannot express this: both
 * operands carry a declared default, so neither ever resolves to
 * `undefined` — compare resolved values directly instead.
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
  (config: Core.M3LConfig): true | string => {
    const dryRunAllowlist = config.get("dryRunAllowlist");
    return config.get("includeDryRunProbes") !== true ||
      (Array.isArray(dryRunAllowlist) && dryRunAllowlist.length > 0)
      ? true
      : "'includeDryRunProbes' requires a non-empty 'dryRunAllowlist'";
  },
];
