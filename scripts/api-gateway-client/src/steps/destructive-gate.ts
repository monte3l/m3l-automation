import { Core } from "@m3l-automation/m3l-common";

/**
 * Shared confirmation step used by `single-request` and `batch-request` for
 * a mutating HTTP verb (`POST`/`PUT`/`PATCH`/`DELETE`; `GET`/`HEAD` are never
 * gated). Prompts via `prompt.confirm(description)` unless `yes` is `true`,
 * in which case the prompt is skipped and the bypass is logged as a warning
 * (so an unattended run still leaves an audit trail).
 *
 * @param deps - The prompt/logger facades, a human-readable description of
 *   the operation about to run, and whether confirmation should be bypassed.
 * @returns A promise that resolves once the operation is confirmed (or
 *   bypassed).
 * @throws {@link Core.M3LError} coded `"ERR_API_GATEWAY_CLIENT_ABORTED"` when
 *   the user declines the confirmation prompt.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { destructiveGate } from "./destructive-gate.js";
 *
 * await destructiveGate({
 *   prompt: new Core.M3LPrompt(),
 *   logger: new Core.M3LLogger([]),
 *   description: "POST https://api.example.test/items",
 *   yes: false,
 * });
 * ```
 */
export async function destructiveGate(deps: {
  readonly prompt: Core.M3LPrompt;
  readonly logger: Core.M3LLogger;
  readonly description: string;
  readonly yes: boolean;
}): Promise<void> {
  if (deps.yes) {
    deps.logger.warning(
      `destructive confirmation bypassed (yes=true): ${deps.description}`,
    );
    return;
  }

  const confirmed = await deps.prompt.confirm(`Confirm: ${deps.description}?`);
  if (!confirmed) {
    throw new Core.M3LError(`aborted: ${deps.description}`, {
      code: "ERR_API_GATEWAY_CLIENT_ABORTED",
    });
  }
}
