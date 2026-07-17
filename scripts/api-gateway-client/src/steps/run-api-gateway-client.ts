import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `run-api-gateway-client` — the thin composition step: reads the already
 * `oneOf`-validated `command` config parameter and dispatches, unchanged,
 * the full deps object to the matching step. This module owns no business
 * logic of its own beyond the dispatch `switch`.
 */

/** The dependencies every dispatched step receives, unchanged. */
interface RunApiGatewayClientDeps {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly httpClient: Core.M3LHttpClient;
  readonly signer: AWS.M3LRequestSigner | undefined;
  readonly prompt: Core.M3LPrompt;
}

/**
 * Runs `api-gateway-client`: dispatches to the `steps/` module matching the
 * resolved `command`.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, the
 *   script-constructed `Core.M3LHttpClient`, the optional
 *   `AWS.M3LRequestSigner` (present only when `auth: iam` provisioned
 *   `script.aws`), and the interactive-prompt facade — forwarded unchanged
 *   to whichever step is selected.
 * @returns A promise that resolves once the dispatched step completes.
 * @throws {@link Core.M3LError} coded `"ERR_API_GATEWAY_CLIENT_CONFIG"` when
 *   `command` is not one of the two declared modes — unreachable through the
 *   declared config schema's `oneOf` validator, guarded here defensively.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { runApiGatewayClient } from "./run-api-gateway-client.js";
 *
 * await runApiGatewayClient({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "api-gateway-client", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   httpClient: new Core.M3LHttpClient({ baseUrl: "https://api.example.com" }),
 *   signer: undefined,
 *   prompt: new Core.M3LPrompt(),
 * });
 * ```
 */
export async function runApiGatewayClient(
  deps: RunApiGatewayClientDeps,
): Promise<void> {
  const command = deps.config.get("command");

  // Each step module is imported dynamically, at dispatch time rather than
  // at this module's top level: `steps/*.test.ts` files replace these
  // modules with `vi.mock` factories that close over `vi.fn()` spies
  // declared later in the same test file, so a top-level static import here
  // would resolve the (mocked) module graph before those spies are
  // initialized. Dispatch-time dynamic import defers resolution until the
  // switch actually runs — inside a test body, after the spies exist.
  switch (command) {
    case "request": {
      const { singleRequest } = await import("./single-request.js");
      return singleRequest(deps);
    }
    case "batch": {
      const { batchRequest } = await import("./batch-request.js");
      return batchRequest(deps);
    }
    default:
      throw new Core.M3LError(
        `unrecognized 'command' value: ${String(command)}`,
        { code: "ERR_API_GATEWAY_CLIENT_CONFIG", context: { command } },
      );
  }
}
