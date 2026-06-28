/**
 * Reference automation.
 *
 * Demonstrates how a script in the `scripts/` workspace consumes the library
 * through the `workspace:*` dependency. Because this monorepo ships a
 * `pnpm-workspace.yaml` at its root, the library's `M3LExecutionEnvironment`
 * detects MONOREPO mode and `M3LPaths` anchors `data/{config,input,output}`
 * at the workspace root automatically.
 *
 * Once `Core.M3LScript` is implemented (see `docs/guides/writing-a-script.md`),
 * the body below becomes the real entry point. The documented shape is:
 *
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const script = new Core.M3LScript({
 *   name: "example-automation",
 *   version: "0.0.0",
 *   hooks: {
 *     onAfterConfigLoad: async (ctx) => {
 *       ctx.logger.info("config loaded");
 *     },
 *   },
 * });
 *
 * await script.run(async (ctx) => {
 *   ctx.logger.step("doing the work");
 *   // ...automation logic here...
 * });
 * ```
 *
 * Until then, `main()` only touches the (currently empty) namespaces so the
 * scaffold type-checks and builds without any business logic.
 */

import { Core, AWS } from "@m3l-automation/m3l-common";

/**
 * Placeholder entry point. Touches the (currently empty) namespaces so the
 * import is load-bearing, then yields once. Replace the body with a real
 * `Core.M3LScript(...).run(...)` call once `M3LScript` is implemented.
 */
async function main(): Promise<void> {
  const namespaces = { core: Core, aws: AWS };
  await Promise.resolve();
  console.log("example-automation ready", Object.keys(namespaces));
}

await main();
