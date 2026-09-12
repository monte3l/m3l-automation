/**
 * `agent-operator/steps/create-invoker` — the one place a Bedrock model
 * client is constructed.
 *
 * @remarks
 * It exists as its own module for a single reason: it is the **network seam**,
 * and a seam that is one small module is a seam a test can replace with
 * `vi.mock` without faking anything else. `steps/run-health-check`'s tests
 * mock exactly two modules — this one and `lib/cli-process` — and let
 * `runBedrockToolLoop`, `gateToolSpec`, `buildAgentToolRegistry`,
 * `evaluateAgentAction`, `createMeteredInvoker`, and every projection run for
 * real. A wider fake would let a wiring bug hide behind it.
 *
 * Constructing the client makes **no network call** — the AWS SDK defers
 * every connection to the first command — which is what lets
 * `steps/run-health-check` build the metered invoker *before* the decision-log
 * preflight without spending anything on a run the preflight goes on to
 * refuse.
 *
 * @packageDocumentation
 */

import { AWS } from "@m3l-automation/m3l-common";
import type { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../lib/errors.js";

/** Inputs for {@link createInvoker}. */
export interface CreateInvokerDeps {
  /**
   * The provisioned AWS client facade from `script.aws`, or `undefined` when
   * stage 5 never ran. Passing it in — rather than reaching for a global —
   * is what keeps this module injectable.
   */
  readonly aws: Core.M3LScript["aws"];
  /**
   * The primary model id, then every fallback, in the order they are tried.
   *
   * Typed as a non-empty tuple, matching `M3LBedrockRuntimeOptions`: the
   * library rejects an empty list at runtime, and taking that check to
   * compile time means the call site has to prove `modelId` is present
   * rather than discover it on the first run.
   */
  readonly models: readonly [string, ...(readonly string[])];
}

/**
 * Builds the `AWS.M3LBedrockToolLoopInvoker` the tool loop drives.
 *
 * @remarks
 * `models` is `[modelId, ...fallbackModelIds]` — the caller assembles it, so
 * the ordering decision stays visible at the call site rather than hidden
 * here. This function rejects an absent AWS provider first, because that
 * failure has a different remedy (declare `aws.profile`, or run through the
 * real `M3LScript` lifecycle) and deserves its own message.
 *
 * @param deps - See {@link CreateInvokerDeps}.
 * @returns The invoker, ready to hand to `createMeteredInvoker`.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when no AWS provider was provisioned.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 * import { createInvoker } from "./create-invoker.js";
 *
 * declare const aws: Core.M3LScript["aws"];
 *
 * const invoker = createInvoker({
 *   aws,
 *   models: ["anthropic.claude-sonnet-4-5-20250929-v1:0"],
 * });
 * ```
 */
export function createInvoker(
  deps: CreateInvokerDeps,
): AWS.M3LBedrockToolLoopInvoker {
  if (deps.aws === undefined) {
    throw new M3LAgentOperatorCliError(
      "no AWS provider was provisioned, so no Bedrock client can be built; 'aws.profile' must be declared and the run must go through the M3LScript lifecycle",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return new AWS.M3LBedrockRuntimeOperations(deps.aws.clients.bedrockRuntime, {
    models: deps.models,
  });
}
