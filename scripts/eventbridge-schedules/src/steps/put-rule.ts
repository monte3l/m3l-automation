import type { AWS } from "@m3l-automation/m3l-common";
import { Core } from "@m3l-automation/m3l-common";

import {
  CONFIG_ERROR_CODE,
  readOptionalString,
  readRequiredRuleName,
} from "./config-helpers.js";

/** The two `putRuleStep` operations, echoed into every guard's error message. */
type PutRuleOperation = "create" | "update";

/** The `'targets'` malformed-shape error message, shared by every failing branch. */
const TARGETS_SHAPE_ERROR =
  "'targets' must be a JSON array of { id, arn, roleArn?, input?, inputPath? }";

/** The exactly-one-of-`eventPattern`/`scheduleExpression` selection this operation was configured with. */
type RuleDiscriminant =
  { readonly eventPattern: string } | { readonly scheduleExpression: string };

/**
 * Reads `eventPattern`/`scheduleExpression`, enforcing that exactly one is
 * configured (empty string treated as unset).
 *
 * @throws {@link Core.M3LError} coded `ERR_EVENTBRIDGE_SCHEDULES_CONFIG` when
 *   both or neither is set.
 */
function readRuleDiscriminant(
  config: Core.M3LConfig,
  operation: PutRuleOperation,
): RuleDiscriminant {
  const eventPattern = readOptionalString(config, "eventPattern");
  const scheduleExpression = readOptionalString(config, "scheduleExpression");

  if ((eventPattern === undefined) === (scheduleExpression === undefined)) {
    throw new Core.M3LError(
      `exactly one of 'eventPattern' or 'scheduleExpression' is required for '${operation}'`,
      { code: CONFIG_ERROR_CODE },
    );
  }

  return eventPattern !== undefined
    ? { eventPattern }
    : { scheduleExpression: scheduleExpression as string };
}

/** The optional `putRule` fields read straight off config, shared by both discriminant branches. */
interface RuleOptionalFields {
  readonly state: AWS.M3LEventBridgeRuleState | undefined;
  readonly description: string | undefined;
  readonly roleArn: string | undefined;
  readonly eventBusName: string | undefined;
}

/** Reads the optional `state`/`description`/`roleArn`/`eventBusName` fields shared by both `putRule` discriminant branches. */
function readOptionalRuleFields(config: Core.M3LConfig): RuleOptionalFields {
  const state = readOptionalString(config, "state");
  return {
    state: state as AWS.M3LEventBridgeRuleState | undefined,
    description: readOptionalString(config, "description"),
    roleArn: readOptionalString(config, "roleArn"),
    eventBusName: readOptionalString(config, "eventBusName"),
  };
}

/**
 * Builds the `putRule` input, branching on which of `eventPattern`/
 * `scheduleExpression` was configured so each branch produces exactly one
 * discriminated-union member.
 */
function buildPutRuleInput(
  ruleName: string,
  discriminant: RuleDiscriminant,
  optional: RuleOptionalFields,
): AWS.M3LEventBridgePutRuleInput {
  const base = {
    name: ruleName,
    ...(optional.eventBusName !== undefined && {
      eventBusName: optional.eventBusName,
    }),
    ...(optional.state !== undefined && { state: optional.state }),
    ...(optional.description !== undefined && {
      description: optional.description,
    }),
    ...(optional.roleArn !== undefined && { roleArn: optional.roleArn }),
  };

  return "eventPattern" in discriminant
    ? { ...base, eventPattern: discriminant.eventPattern }
    : { ...base, scheduleExpression: discriminant.scheduleExpression };
}

/** Type guard: is `value` a well-shaped `AWS.M3LEventBridgeTarget`? */
function isValidTarget(value: unknown): value is AWS.M3LEventBridgeTarget {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || typeof record["arn"] !== "string") {
    return false;
  }
  const optionalStringFields = ["roleArn", "input", "inputPath"] as const;
  return optionalStringFields.every((field) => {
    const fieldValue = record[field];
    return fieldValue === undefined || typeof fieldValue === "string";
  });
}

/**
 * Parses and validates the `targets` config string into an array of
 * {@link AWS.M3LEventBridgeTarget}.
 *
 * The three failure modes — unparseable JSON, a non-array value, and an
 * invalid array entry — each attach distinguishing diagnostic `context` (the
 * message text is identical across all three, so `context` is what lets a
 * caller tell them apart without string-matching).
 *
 * @throws {@link Core.M3LError} coded `ERR_EVENTBRIDGE_SCHEDULES_CONFIG` when
 *   `raw` is not valid JSON (chaining the `SyntaxError` as `cause`), is not a
 *   JSON array (`context: { receivedType }`), or contains an entry missing a
 *   string `id`/`arn` or carrying a non-string optional field
 *   (`context: { invalidIndex, entry }`).
 */
function parseTargets(raw: string): readonly AWS.M3LEventBridgeTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Core.M3LError(TARGETS_SHAPE_ERROR, {
      code: CONFIG_ERROR_CODE,
      cause,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new Core.M3LError(TARGETS_SHAPE_ERROR, {
      code: CONFIG_ERROR_CODE,
      context: { receivedType: typeof parsed },
    });
  }

  const invalidIndex = parsed.findIndex((entry) => !isValidTarget(entry));
  if (invalidIndex !== -1) {
    throw new Core.M3LError(TARGETS_SHAPE_ERROR, {
      code: CONFIG_ERROR_CODE,
      context: { invalidIndex, entry: parsed[invalidIndex] },
    });
  }

  // `invalidIndex === -1` above guarantees every entry satisfies
  // `isValidTarget`, but `findIndex` (unlike `Array.prototype.every` with a
  // type-guard callback) doesn't narrow `parsed`'s element type for us.
  return parsed as readonly AWS.M3LEventBridgeTarget[];
}

/**
 * Attaches `targets` (when configured) to the just-`putRule`'d rule via
 * `putTargets`, logging a warning per failed entry rather than throwing —
 * `putTargets` itself never throws on a per-entry failure, so this mirrors
 * that contract; a rejection from `putTargets` propagates unmodified.
 */
async function attachTargetsIfConfigured(
  deps: {
    readonly config: Core.M3LConfig;
    readonly logger: Core.M3LLogger;
    readonly eventBridgeOperations: AWS.M3LEventBridgeOperations;
  },
  ruleName: string,
  eventBusName: string | undefined,
): Promise<void> {
  const rawTargets = readOptionalString(deps.config, "targets");
  if (rawTargets === undefined) return;

  const targets = parseTargets(rawTargets);
  const result = await deps.eventBridgeOperations.putTargets(
    ruleName,
    targets,
    { ...(eventBusName !== undefined && { eventBusName }) },
  );

  for (const failure of result.failed) {
    deps.logger.warning(
      `eventbridge-schedules failed to attach target '${failure.target.id}' to rule '${ruleName}'`,
      {
        code: failure.code,
        ...(failure.message !== undefined && { message: failure.message }),
      },
    );
  }
}

/**
 * `eventbridge-schedules`'s shared `create`/`update` implementation:
 * guard-checks `ruleName` and the exactly-one `eventPattern`/
 * `scheduleExpression` discriminant, calls `eventBridgeOperations.putRule()`,
 * then optionally attaches `targets` via `putTargets()`.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, per-run correlation
 *   id, and the provisioned `eventBridgeOperations` wrapper.
 * @param operation - `"create"` or `"update"`, echoed into guard error
 *   messages (both operations share this one implementation).
 * @throws {@link Core.M3LError} coded `ERR_EVENTBRIDGE_SCHEDULES_CONFIG` when
 *   `ruleName` is missing, the `eventPattern`/`scheduleExpression`
 *   discriminant is not exactly one, or `targets` is malformed.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { putRuleStep } from "./put-rule.js";
 *
 * declare const eventBridgeOperations: AWS.M3LEventBridgeOperations;
 * await putRuleStep(
 *   {
 *     config: new Core.M3LConfig(),
 *     paths: new Core.M3LPaths(),
 *     logger: new Core.M3LLogger([]),
 *     correlationId: "run-1",
 *     eventBridgeOperations,
 *   },
 *   "create",
 * );
 * ```
 */
export async function putRuleStep(
  deps: {
    readonly config: Core.M3LConfig;
    readonly paths: Core.M3LPaths;
    readonly logger: Core.M3LLogger;
    readonly correlationId: string;
    readonly eventBridgeOperations: AWS.M3LEventBridgeOperations;
  },
  operation: PutRuleOperation,
): Promise<void> {
  const ruleName = readRequiredRuleName(deps.config, operation);
  const discriminant = readRuleDiscriminant(deps.config, operation);
  const optional = readOptionalRuleFields(deps.config);

  const input = buildPutRuleInput(ruleName, discriminant, optional);
  const { ruleArn } = await deps.eventBridgeOperations.putRule(input);

  await attachTargetsIfConfigured(deps, ruleName, optional.eventBusName);

  deps.logger.step(
    `eventbridge-schedules run ${deps.correlationId} '${operation}'d rule '${ruleName}'`,
    { ruleArn },
  );
}
