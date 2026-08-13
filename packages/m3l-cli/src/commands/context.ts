/**
 * `commands/context` — the per-invocation context `main.ts` builds and every
 * command entry point (`runList`, `runInspect`, …) renders through.
 *
 * Kept as its own module so `list.ts` and `inspect.ts` can share the same
 * type without either importing from the other (which would otherwise form
 * an import cycle through `main.ts`).
 *
 * @packageDocumentation
 */

import type { M3LCliOutput } from "../cli/output.js";

/**
 * The context a command's `run*` entry point receives: the resolved
 * workspace root, the writer facade to render through, whether to emit
 * machine-readable JSON, and the discovery cache file's absolute path.
 *
 * @example
 * ```ts
 * // createOutput builds the `output` field; see cli/output.ts
 * const context: M3LCliCommandContext = {
 *   workspaceRoot: "/repo",
 *   output: createOutput({ stdout: process.stdout, stderr: process.stderr }),
 *   jsonOutput: false,
 *   cacheFilePath: "/repo/data/cache/m3l-cli/discovery.json",
 * };
 * ```
 */
export interface M3LCliCommandContext {
  /** The resolved workspace root (see `resolveWorkspaceRoot`). */
  readonly workspaceRoot: string;
  /** The writer facade the command renders through. */
  readonly output: M3LCliOutput;
  /** Whether the command should render machine-readable JSON instead of text. */
  readonly jsonOutput: boolean;
  /** The absolute path to the discovery cache file. */
  readonly cacheFilePath: string;
}
