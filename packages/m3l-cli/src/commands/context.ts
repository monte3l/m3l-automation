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

import type { M3LCliEnvFileSetting } from "../cli/flags.js";
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
 *   historyFilePath: "/repo/data/cache/m3l-cli/history.json",
 *   outputDirPath: "/repo/data/output",
 *   env: process.env,
 *   envFile: { kind: "auto" },
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
  /**
   * The absolute path to the run-history file (8f) — `main.ts`'s
   * `buildCommandContext` populates this for every command context, even
   * ones (`list`/`inspect`/`presets`) that don't read it.
   */
  readonly historyFilePath: string;
  /**
   * The absolute path to the managed output directory (V2 slice 2, #539 /
   * ADR-0063) — `main.ts`'s `buildCommandContext` populates this
   * unconditionally for every command context, mirroring `historyFilePath`,
   * even for commands (`list`/`inspect`/`presets`) that don't read it.
   */
  readonly outputDirPath: string;
  /**
   * The environment the CLI itself was invoked with (`runCli`'s
   * `options.env ?? process.env`) — `main.ts`'s `buildCommandContext` already
   * consumed this map to resolve the three paths above, and now carries it so
   * the spawn path can hand it to the child as its base environment instead
   * of reaching for the `process.env` global (ADR-0085).
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The resolved `--env-file`/`--no-env-file` decision (ADR-0085), populated
   * unconditionally for every command context like {@link outputDirPath},
   * even for commands that never spawn. Defaults to `{ kind: "auto" }`.
   */
  readonly envFile: M3LCliEnvFileSetting;
}
