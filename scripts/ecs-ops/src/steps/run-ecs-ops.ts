import { Core } from "@m3l-automation/m3l-common";

/**
 * Starter step for `ecs-ops`: Manage AWS ECS services (list, describe, create, update, delete, wait-for-stable) and inspect clusters (read-only), over the typed M3LECSOperations wrapper
 *
 * Business logic lives here — never in `main.ts`. Every dependency (config
 * values, logger, paths, the `script.aws` provider) is injected as a single
 * options object so the step stays unit-testable without running the
 * lifecycle: a test constructs the object with mocks, no `M3LScript` needed.
 * This starter takes the logger and the resolved `config`; add whatever else
 * the real step needs (a `M3LPaths`-resolved dir, `script.aws`, …) to the same
 * object.
 */
export function runEcsOps(deps: {
  readonly logger: Core.M3LLogger;
  readonly config: Core.M3LConfig;
}): Promise<void> {
  // Implementation is handed off to the implementing-scripts pipeline.
  // (Sync body returning a resolved promise: `require-await` rejects an async
  // function with no await — flip to `async` once the real logic awaits.)
  // `config.get(name)` reads a declared parameter (typed `unknown` — narrow or
  // coerce it); this line shows the injected config in use.
  const awsProfile = deps.config.get(Core.AWS_PROFILE_PARAM_NAME);
  deps.logger.step(
    `ecs-ops starter step — implementation pending (aws.profile=${String(awsProfile)})`,
  );
  return Promise.resolve();
}
