/**
 * `tests/support/healthFakes` — the scripted Bedrock conversation the
 * fleet-health tests drive `runBedrockToolLoop` with, plus the tiny AWS
 * facade `steps/create-invoker` reads.
 *
 * Only **two** seams are ever faked across the health-check suite:
 * `steps/create-invoker` (so no `BedrockRuntimeClient` is constructed and no
 * network call is possible) and `lib/cli-process`'s `runCliProcess` (so no
 * `m3l` child process is spawned). `runBedrockToolLoop`, `gateToolSpec`,
 * `buildAgentToolRegistry`, `Core.evaluateAgentAction`,
 * `createMeteredInvoker`, and every `lib/model-safety` projection run for
 * real — a wider fake would let a wiring bug hide behind it.
 *
 * The helpers here build the *replies* a fake invoker hands back, so a test
 * writes "the model asks for `fleet_doctor`, then finishes" rather than
 * hand-assembling Converse content blocks.
 */

import type { AWS, Core } from "@m3l-automation/m3l-common";

import { makeBedrockTokenUsage } from "./bedrockFakes.js";

/** The model id every fake reply reports as having served the turn. */
export const FAKE_MODEL_ID = "anthropic.claude-sonnet-4-5-20250929-v1:0";

/**
 * An assistant reply requesting one tool call.
 *
 * @param name - The tool name the model asks for.
 * @param input - The tool input. Defaults to `{}` — **never `undefined`**:
 *   the library refuses to transmit a `toolUse` block whose input cannot
 *   round-trip through the Converse document type, and `undefined` cannot.
 *   A real no-argument tool call therefore arrives as an empty object, which
 *   is exactly what `fleet_list`/`fleet_doctor` are built to ignore.
 * @param toolUseId - Correlation id; must be unique within one turn, which
 *   `runBedrockToolLoop` enforces.
 */
export function toolUseReply(
  name: string,
  input: unknown = {},
  toolUseId = `use-${name}`,
): AWS.M3LBedrockInvocationResult {
  return {
    message: {
      role: "assistant",
      content: [{ type: "toolUse", toolUseId, name, input }],
    },
    stopReason: "tool_use",
    usage: makeBedrockTokenUsage(),
    modelId: FAKE_MODEL_ID,
  };
}

/** A terminal assistant reply carrying free text — the model's summary. */
export function textReply(
  text: string,
  usage: AWS.M3LBedrockTokenUsage = makeBedrockTokenUsage(),
): AWS.M3LBedrockInvocationResult {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    stopReason: "end_turn",
    usage,
    modelId: FAKE_MODEL_ID,
  };
}

/** A terminal assistant reply carrying no text block at all. */
export function emptyReply(): AWS.M3LBedrockInvocationResult {
  return {
    message: { role: "assistant", content: [] },
    stopReason: "end_turn",
    usage: makeBedrockTokenUsage(),
    modelId: FAKE_MODEL_ID,
  };
}

/**
 * The minimal `script.aws` stand-in `steps/create-invoker` reads.
 *
 * @remarks
 * Only used by tests that let the **real** `createInvoker` run — everything
 * else mocks that module wholesale. `bedrockRuntime` is a bare object rather
 * than a real `BedrockRuntimeClient`: `M3LBedrockRuntimeOperations` stores it
 * and touches nothing until the first `invoke`, and no test here ever gets
 * that far.
 */
export function fakeAwsProvider(): Core.M3LScript["aws"] {
  return {
    clients: { bedrockRuntime: {} },
  } as unknown as Core.M3LScript["aws"];
}
