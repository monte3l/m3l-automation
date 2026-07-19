import { Core } from "@m3l-automation/m3l-common";

const FORCE_DEFAULT = false;
const YES_DEFAULT = false;

/** The seven operations `eventbridge-schedules` supports. */
const EVENTBRIDGE_SCHEDULES_OPERATIONS = [
  "list",
  "describe",
  "create",
  "update",
  "delete",
  "enable",
  "disable",
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
 * `create`) are cross-parameter constraints a single parameter's validator
 * cannot express, so they are guard-checked at run start instead (see
 * `steps/run-eventbridge-schedules.ts`).
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
      EVENTBRIDGE_SCHEDULES_OPERATIONS,
    ),
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
];
