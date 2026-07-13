import type { Core } from "@m3l-automation/m3l-common";

import { deleteCheckpoint } from "./steps/checkpoint.js";

/**
 * Builds the lifecycle hooks for `logs-insights`, bound to `paths`. All
 * eight hooks are optional and run in the fixed order documented in
 * `docs/reference/core/script.md`.
 *
 * `paths` is threaded in from the composition root (`main.ts`) rather than
 * constructed fresh inside a hook: `M3LScriptHookContext` exposes only
 * `config`/`correlationId`, not `paths`, so a hook has no way to reach the
 * script's own `M3LPaths` instance directly. `scripts/json-etl/src/hooks.ts`
 * solves the sibling problem — a value only known once `run()` starts — by
 * capturing it into module state via an earlier hook and reading it back
 * later. `paths` is already known before `run()` is even called, so instead
 * of capturing, the caller threads the single, real `M3LPaths` instance
 * straight through this factory, avoiding a second, independent
 * `new Core.M3LPaths()` that would otherwise be constructed inside the hook
 * body.
 *
 * `onAfterRun` deletes the run's checkpoint file — it only fires once
 * `mainFn` has resolved successfully (stage 8, before `onCleanup`); a thrown
 * error skips straight to `onError`/`onCleanup` instead, so the checkpoint
 * (and its accumulated rows) is left intact for a subsequent `resume: true`
 * run, exactly as `docs/reference/scripts/logs-insights.md`'s "Inputs and
 * outputs" section specifies (`M3LScript` has no `onShutdown` hook).
 *
 * @param paths - The composition root's `Core.M3LPaths` instance.
 * @returns The lifecycle hooks object to pass to `Core.M3LScript`.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { buildHooks } from "./hooks.js";
 *
 * const paths = new Core.M3LPaths();
 * const script = new Core.M3LScript({
 *   metadata: { name: "logs-insights", version: "0.0.0" },
 *   config: { params: [] },
 *   hooks: buildHooks(paths),
 * });
 * ```
 */
export function buildHooks(paths: Core.M3LPaths): Core.M3LScriptLifecycleHooks {
  return {
    onAfterRun: async (ctx) => {
      const output = ctx.config.get("output");
      if (typeof output !== "string" || output.length === 0) return;
      await deleteCheckpoint({ paths, output });
    },
  };
}
