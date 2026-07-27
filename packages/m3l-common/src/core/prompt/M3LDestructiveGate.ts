/**
 * `core/prompt/M3LDestructiveGate` — the shared confirm-before-destroy step
 * promoted from an identical `destructive-gate.ts` step duplicated across 5
 * consumer scripts.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";
import { escapeTerminalControls } from "../../internal/prompt/sanitize.js";

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
 * @remarks
 * `deps.description` is passed through the internal display-escape helper in
 * **two** of the three channels above — the bypass warning log and the
 * `Confirm: ...?` message sent to `deps.prompt.confirm` — but **deliberately
 * not** in the thrown `aborted: ...` {@link M3LError}'s message. That message
 * is a data value, not a render target: it flows downstream into
 * `core/logging`'s name-based secret redaction (`redactSensitiveLogText`),
 * applied here by `core/diagnostics`'s error-chain serialization, which
 * locates `key=value`-shaped secrets by matching on surrounding word
 * boundaries. Escaping the description first would introduce alphanumeric
 * escape text (`\x09`, `\u{202e}`) that merges into those boundaries and can
 * suppress a secret's redaction in a persisted run report — a worse outcome
 * than the display issue this escape exists to close. The thrown message
 * therefore carries `deps.description` unchanged, exactly as before this
 * escape was introduced, so downstream redaction keeps operating on
 * unmodified text. This is a display-integrity fix for the two escaped
 * channels (it keeps a hostile description from manipulating the terminal or
 * the log line) — it is not an authorization control and does not otherwise
 * change confirmation semantics.
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
  // Escaped for the two display channels only — the bypass-warning log and
  // the confirm prompt. The thrown M3LError below deliberately uses
  // deps.description raw; see the @remarks above for why.
  const displayDescription = escapeTerminalControls(deps.description);

  if (deps.yes) {
    deps.logger.warning(
      `destructive confirmation bypassed (yes=true): ${displayDescription}`,
    );
    return;
  }

  const confirmed = await deps.prompt.confirm(
    `Confirm: ${displayDescription}?`,
  );

  if (!confirmed) {
    throw new M3LError(`aborted: ${deps.description}`, { code: deps.code });
  }
}
