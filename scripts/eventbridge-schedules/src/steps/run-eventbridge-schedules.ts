import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `run-eventbridge-schedules` — the thin composition step: reads the already
 * `oneOf`-validated `operation` config parameter, runs
 * `Core.confirmDestructive` for the five mutating operations, then
 * dispatches, unchanged, the full deps object to the matching step. This
 * module owns no business logic of its own beyond the gate + dispatch.
 */

/** The dependencies every dispatched step receives, unchanged. */
interface RunEventbridgeSchedulesDeps {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly eventBridgeOperations: AWS.M3LEventBridgeOperations;
  readonly prompt: Core.M3LPrompt;
}

/** The five operations that mutate state and therefore require confirmation. */
const MUTATING_OPERATIONS: ReadonlySet<string> = new Set([
  "create",
  "update",
  "delete",
  "enable",
  "disable",
]);

/**
 * Reads the `ruleName` config parameter for display in the
 * `Core.confirmDestructive` description, falling back to `"(unspecified)"`
 * when unset or empty.
 *
 * Deliberately distinct from `config-helpers.ts`'s `readRequiredRuleName`:
 * this reader is display-only and must never throw — the gate still needs a
 * description even for `create`, where `ruleName` may legitimately be unset
 * (rejected later by `putRuleStep`'s own guard, not here).
 */
function readRuleNameForDisplay(config: Core.M3LConfig): string {
  const raw = config.get("ruleName");
  return typeof raw === "string" && raw.length > 0 ? raw : "(unspecified)";
}

/**
 * Runs `eventbridge-schedules`: for the five mutating operations
 * (`create`/`update`/`delete`/`enable`/`disable`), confirms via
 * `Core.confirmDestructive` before dispatching (skipped entirely for `list`/
 * `describe`), then dispatches to the `steps/` module matching the resolved
 * `operation`.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, the
 *   provisioned `eventBridgeOperations` wrapper, and the interactive-prompt
 *   facade — forwarded unchanged to whichever step is selected.
 * @returns A promise that resolves once the dispatched step completes.
 * @throws {@link Core.M3LError} coded `"ERR_EVENTBRIDGE_SCHEDULES_ABORTED"`
 *   when the user declines the `Core.confirmDestructive` confirmation.
 * @throws {@link Core.M3LError} coded `"ERR_EVENTBRIDGE_SCHEDULES_CONFIG"`
 *   when `operation` is not one of the seven declared values —
 *   unreachable through the declared config schema's `oneOf` validator,
 *   guarded here defensively.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { runEventbridgeSchedules } from "./run-eventbridge-schedules.js";
 *
 * declare const eventBridgeOperations: AWS.M3LEventBridgeOperations;
 * await runEventbridgeSchedules({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "eventbridge-schedules", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   eventBridgeOperations,
 *   prompt: new Core.M3LPrompt(),
 * });
 * ```
 */
export async function runEventbridgeSchedules(
  deps: RunEventbridgeSchedulesDeps,
): Promise<void> {
  const operation = deps.config.get("operation");

  // Every step module dispatched below is imported dynamically, at dispatch
  // time rather than at this module's top level: `run-eventbridge-schedules
  // .test.ts` replaces each of these modules with a `vi.mock` factory that
  // closes over a `vi.fn()` spy declared later in the same test file, so a
  // top-level static import here would resolve the (mocked) module graph —
  // invoking the factory — before those spies are initialized, throwing a
  // TDZ `ReferenceError`. Dispatch-time dynamic import defers resolution
  // until this function actually runs — inside a test body, after the spies
  // exist. `Core.confirmDestructive` is a stable library function, not
  // locally mockable this way, so it is imported statically alongside `Core`.
  if (typeof operation === "string" && MUTATING_OPERATIONS.has(operation)) {
    await Core.confirmDestructive({
      prompt: deps.prompt,
      logger: deps.logger,
      description: `${operation} rule '${readRuleNameForDisplay(deps.config)}'`,
      yes: deps.config.get("yes") === true,
      code: "ERR_EVENTBRIDGE_SCHEDULES_ABORTED",
    });
  }

  switch (operation) {
    case "list": {
      const { listRules } = await import("./list-rules.js");
      return listRules(deps);
    }
    case "describe": {
      const { describeRule } = await import("./describe-rule.js");
      return describeRule(deps);
    }
    case "create": {
      const { createRule } = await import("./create-rule.js");
      return createRule(deps);
    }
    case "update": {
      const { updateRule } = await import("./update-rule.js");
      return updateRule(deps);
    }
    case "delete": {
      const { deleteRule } = await import("./delete-rule.js");
      return deleteRule(deps);
    }
    case "enable": {
      const { enableRule } = await import("./enable-rule.js");
      return enableRule(deps);
    }
    case "disable": {
      const { disableRule } = await import("./disable-rule.js");
      return disableRule(deps);
    }
    default:
      throw new Core.M3LError(
        `unrecognized 'operation' value: ${String(operation)}`,
        { code: "ERR_EVENTBRIDGE_SCHEDULES_CONFIG", context: { operation } },
      );
  }
}
