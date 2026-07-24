/**
 * `core/prompt/M3LDestructiveGate` — the shared confirm-before-destroy step
 * promoted from an identical `destructive-gate.ts` step duplicated across 5
 * consumer scripts.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

import type { M3LLogger } from "../logging/index.js";

import type { M3LPrompt } from "./M3LPrompt.js";

/**
 * Dependencies for {@link confirmDestructive}.
 */
export interface M3LConfirmDestructiveOptions {
  /** The prompt facade used to ask for confirmation. */
  readonly prompt: M3LPrompt;
  /** The logger used to record a bypass warning. */
  readonly logger: M3LLogger;
  /** Human-readable description of the destructive action, e.g. `"delete bucket my-bucket"`. */
  readonly description: string;
  /**
   * When `true`, skips the interactive confirmation entirely (a
   * caller-supplied `--yes`/`-y` flag) and logs a warning instead.
   */
  readonly yes: boolean;
  /**
   * The `M3LError` `code` to use if the caller declines confirmation.
   * Caller-supplied, not a value hardcoded by this function.
   */
  readonly code: string;
}

/**
 * Confirms a destructive action before proceeding, with a `yes`-flag bypass.
 *
 * Three behaviors:
 *
 * 1. `deps.yes` is `true` — the confirmation is bypassed. A single warning is
 *    logged (`destructive confirmation bypassed (yes=true): <description>`)
 *    and the function resolves; `deps.prompt.confirm` is never called.
 * 2. `deps.yes` is `false` and the prompt resolves `true` — the function
 *    resolves normally.
 * 3. `deps.yes` is `false` and the prompt resolves `false` — an
 *    {@link M3LError} is thrown (`aborted: <description>`) carrying
 *    `deps.code` verbatim as its `code`.
 *
 * A rejection from `deps.prompt.confirm` (e.g. the underlying adapter throws
 * on a cancelled prompt) propagates unchanged — it is never converted into
 * the `aborted` {@link M3LError}.
 *
 * @param deps - The prompt, logger, description, bypass flag, and error code
 *   described above.
 * @returns A promise that resolves once the action is confirmed (or bypassed).
 * @throws {@link M3LError} with `code: deps.code` when the caller declines
 *   confirmation (`deps.yes` is `false` and `deps.prompt.confirm` resolves
 *   `false`).
 * @example
 * ```ts
 * import {
 *   confirmDestructive,
 *   M3LLogger,
 *   M3LPrompt,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const prompt = new M3LPrompt();
 * const logger = new M3LLogger([]);
 *
 * await confirmDestructive({
 *   prompt,
 *   logger,
 *   description: "delete bucket my-bucket",
 *   yes: false,
 *   code: "ERR_LAMBDA_OPS_ABORTED",
 * });
 * ```
 */
export async function confirmDestructive(
  deps: M3LConfirmDestructiveOptions,
): Promise<void> {
  if (deps.yes) {
    deps.logger.warning(
      `destructive confirmation bypassed (yes=true): ${deps.description}`,
    );
    return;
  }

  const confirmed = await deps.prompt.confirm(`Confirm: ${deps.description}?`);

  if (!confirmed) {
    throw new M3LError(`aborted: ${deps.description}`, { code: deps.code });
  }
}
