import { Core } from "@m3l-automation/m3l-common";

const FORCE_DEFAULT = false;
const YES_DEFAULT = false;
const YES_SENSITIVE_DEFAULT = false;

/**
 * The `operation` parameter's declared operation set (ADR-0055) — the seven
 * verbs `eventbridge-schedules` dispatches over `AWS.M3LEventBridgeOperations`.
 * Feeds {@link configParameters}' `operation` declaration, which
 * auto-composes the membership validator, replacing the prior hand-written
 * `oneOf`.
 *
 * `requiredParameters` here is **declarative metadata only** — CLI
 * introspection surfaces it (ADR-0055), but it is deliberately **not**
 * enforced at config-load time: `Core.deriveOperationValidators` is NOT
 * spread into {@link configValidators}, so presence enforcement stays
 * exactly where it already was — the run-start guard in
 * `steps/run-eventbridge-schedules.ts`. Wiring `deriveOperationValidators`
 * in here would move that failure earlier (to config-load time) and is out
 * of scope for this change — do not add it without deliberately deciding to
 * change failure timing.
 *
 * `create`/`update` additionally require exactly one of
 * `eventPattern`/`scheduleExpression` — an exclusive-or `requiredParameters`
 * cannot express, so it is deliberately omitted here and stays enforced in
 * `steps/put-rule.ts`'s `readRuleDiscriminant`.
 *
 * Deliberately declared with a bare `as const` — NOT
 * `as const satisfies Core.M3LOperationDeclarationList` — because a
 * `satisfies` clause on this literal fails `tsc --isolatedDeclarations`
 * (the mode each script's `tsconfig.build.json` builds under). The shape is
 * still fully compile-time-checked at its use site without it: passing this
 * value to `operations:` in `configParameters` checks it against
 * `Core.M3LOperationDeclarationList` — do not re-add `satisfies` here.
 */
const EVENTBRIDGE_SCHEDULES_OPERATION_DECLARATIONS = [
  {
    name: "list",
    description:
      "List EventBridge rules, optionally filtered by name prefix or event bus.",
    requiredParameters: [],
  },
  {
    name: "describe",
    description: "Describe one EventBridge rule by name.",
    requiredParameters: ["ruleName"],
  },
  {
    name: "create",
    description: "Create an EventBridge rule, optionally attaching targets.",
    requiredParameters: ["ruleName"],
  },
  {
    name: "update",
    description: "Update an EventBridge rule, optionally attaching targets.",
    requiredParameters: ["ruleName"],
  },
  {
    name: "delete",
    description: "Delete an EventBridge rule by name.",
    requiredParameters: ["ruleName"],
  },
  {
    name: "enable",
    description: "Enable an EventBridge rule by name.",
    requiredParameters: ["ruleName"],
  },
  {
    name: "disable",
    description: "Disable an EventBridge rule by name.",
    requiredParameters: ["ruleName"],
  },
] as const;

/** The three EventBridge rule states. */
const EVENTBRIDGE_SCHEDULES_STATES = [
  "ENABLED",
  "DISABLED",
  "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS",
] as const;

/**
 * The declared configuration schema for `eventbridge-schedules` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); declare a parameter here instead so resolution, coercion, validation,
 * and redaction all flow through the library.
 *
 * Declare an AWS profile parameter with `Core.AWS_PROFILE_PARAM_NAME` when the
 * script touches AWS — that name is what enables the `script.aws`
 * dynamic-provisioning seam.
 *
 * `aws.profile` and `operation` are `required: true`: presence is enforced at
 * config-load time by the library. The remaining per-operation requirements
 * (e.g. `ruleName` for `describe`/`delete`, `scheduleExpression` for
 * `create`) are declared as data on
 * {@link EVENTBRIDGE_SCHEDULES_OPERATION_DECLARATIONS}' `requiredParameters`
 * for CLI introspection (ADR-0055), but are cross-parameter constraints a
 * single parameter's validator cannot express and are deliberately left
 * enforced at run start only (see `steps/run-eventbridge-schedules.ts`) —
 * see that constant's TSDoc for why `Core.deriveOperationValidators` is not
 * wired into {@link configValidators} here.
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
    operations: EVENTBRIDGE_SCHEDULES_OPERATION_DECLARATIONS,
  }),
  new Core.M3LConfigParameter({
    name: "ruleName",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "namePrefix",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "eventBusName",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "eventPattern",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "scheduleExpression",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "state",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.oneOf<string>(
      EVENTBRIDGE_SCHEDULES_STATES,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "description",
    type: Core.M3LConfigParameterType.STRING,
  }),
  new Core.M3LConfigParameter({
    name: "roleArn",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "targets",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "force",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: FORCE_DEFAULT,
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

/**
 * Cross-parameter constraints that a single {@link Core.M3LConfigParameter}'s
 * own `validate` cannot express (ADR-0048, Issue #483, A2b): `yesSensitive`
 * only means anything alongside `yes` (see
 * `steps/run-eventbridge-schedules.ts`'s `Core.confirmDestructive` call), so
 * setting it without `yes` is rejected at config-load time rather than
 * silently ignored at run time.
 */
export const configValidators: readonly Core.M3LConfigSchemaValidator[] = [
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
