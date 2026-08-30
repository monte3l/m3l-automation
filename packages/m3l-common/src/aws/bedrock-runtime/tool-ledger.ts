/**
 * `aws/bedrock-runtime/tool-ledger` — the per-iteration/tool-execution
 * bookkeeping types and cost/usage accumulation helpers `loop.ts`'s
 * `runBedrockToolLoop` builds up across a run: `M3LBedrockModelRate`,
 * `M3LBedrockToolExecution`, `M3LBedrockToolLoopIteration`,
 * `M3LBedrockToolLoopOutcome`, and the pure `sumUsage`/`countToolErrors`/
 * `computeCost`/`requireLastIteration` helpers.
 *
 * Split out of `loop.ts` as its own leaf module (ADR-0072's per-file size
 * ratchet) — accumulating token usage, summing per-model cost, and counting
 * tool-execution errors across a run is a self-contained bookkeeping concern
 * independent of `loop.ts`'s own concern (drive the invoke/dispatch control
 * flow). `loop.ts` re-exports every type here through its own export list —
 * see that module's doc comment — so the submodule barrel (`index.ts`) has
 * exactly one place to source the tool-use-loop public surface from.
 *
 * @packageDocumentation
 */

import { M3LBedrockRuntimeOperationError } from "./error.js";
import type { M3LBedrockConversation } from "./conversation.js";
import type {
  M3LBedrockMessage,
  M3LBedrockStopReason,
  M3LBedrockTokenUsage,
} from "./types.js";

/**
 * Per-1k-token pricing for one model, used by {@link runBedrockToolLoop} to
 * populate {@link M3LBedrockToolLoopOutcome.cost}.
 *
 * @example
 * ```ts
 * import type { M3LBedrockModelRate } from "@m3l-automation/m3l-common/aws";
 *
 * const rate: M3LBedrockModelRate = { inputPer1kTokens: 3, outputPer1kTokens: 15 };
 * ```
 */
export interface M3LBedrockModelRate {
  /** Cost per 1,000 input tokens. */
  readonly inputPer1kTokens: number;
  /** Cost per 1,000 output tokens. */
  readonly outputPer1kTokens: number;
}

/**
 * One tool call's disposition within an iteration, recorded on
 * {@link M3LBedrockToolLoopIteration.toolExecutions}.
 *
 * A discriminated union, not a single interface with an optional `cause`
 * (S3, 2026-08 security-pass follow-up): the earlier `cause?: unknown` shape
 * admitted illegal states on both sides — `{ status: "success", cause: err }`
 * type-checked despite success never carrying a cause, and because `unknown`
 * subsumes `undefined`, `{ status: "error", cause: undefined }` type-checked
 * too, indistinguishable at the type level from "no handler ever ran". Here,
 * the "handler ran and rejected" member is the ONLY member declaring `cause`
 * at all (required, not optional), so `"cause" in execution` narrows
 * `execution` to it exactly, and a `status: "success"` value can never carry
 * one (excess-property checking on the object literal rejects it).
 *
 * @example
 * ```ts
 * import type { M3LBedrockToolExecution } from "@m3l-automation/m3l-common/aws";
 *
 * const execution: M3LBedrockToolExecution = {
 *   toolUseId: "t1",
 *   name: "get_weather",
 *   status: "success",
 * };
 *
 * if ("cause" in execution) {
 *   console.error(execution.cause); // only reachable for a handler rejection
 * }
 * ```
 */
export type M3LBedrockToolExecution =
  | {
      /** Correlates this execution to the model's {@link M3LBedrockToolUseBlock.toolUseId}. */
      readonly toolUseId: string;
      /** The tool's name as the model requested it. */
      readonly name: string;
      /** The tool call succeeded. */
      readonly status: "success";
    }
  | {
      /** Correlates this execution to the model's {@link M3LBedrockToolUseBlock.toolUseId}. */
      readonly toolUseId: string;
      /** The tool's name as the model requested it. */
      readonly name: string;
      /** A model-input disposition (unknown tool name, or non-plain-object `input`) that never reached a handler — hence no `cause`. */
      readonly status: "error";
    }
  | {
      /** Correlates this execution to the model's {@link M3LBedrockToolUseBlock.toolUseId}. */
      readonly toolUseId: string;
      /** The tool's name as the model requested it. */
      readonly name: string;
      /** A registered handler ran and rejected. */
      readonly status: "error";
      /** The handler's rejection reason, unmodified. */
      readonly cause: unknown;
    };

/**
 * One `invoke()` round-trip within a {@link runBedrockToolLoop} run.
 *
 * @example
 * ```ts
 * import type { M3LBedrockToolLoopIteration } from "@m3l-automation/m3l-common/aws";
 *
 * const iteration: M3LBedrockToolLoopIteration = {
 *   index: 1,
 *   modelId: "anthropic.claude-sonnet-5",
 *   stopReason: "end_turn",
 *   usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
 *   toolExecutions: [],
 * };
 * ```
 */
export interface M3LBedrockToolLoopIteration {
  /** 1-based position of this iteration within the run. */
  readonly index: number;
  /** The model that actually served this iteration's invoke. */
  readonly modelId: string;
  /** Why the model stopped generating output on this iteration. */
  readonly stopReason: M3LBedrockStopReason;
  /** Token usage for this iteration only (not cumulative). */
  readonly usage: M3LBedrockTokenUsage;
  /** Every tool call dispatched this iteration, in block order. Empty on a terminal (non-`tool_use`) iteration. */
  readonly toolExecutions: readonly M3LBedrockToolExecution[];
}

/**
 * The result of a completed {@link runBedrockToolLoop} run.
 *
 * The `conversation`/`iterations` ledger deliberately carries every appended
 * turn and every handler rejection's `cause` — it is **not** redaction-safe
 * and must not be logged or forwarded without the caller's own review (V5
 * Slice B contract §5, "error-leak allowlist").
 *
 * @example
 * ```ts
 * import type { M3LBedrockToolLoopOutcome } from "@m3l-automation/m3l-common/aws";
 *
 * function summarize(outcome: M3LBedrockToolLoopOutcome): string {
 *   return `${outcome.stopReason} after ${outcome.iterations.length} iteration(s)`;
 * }
 * ```
 */
export interface M3LBedrockToolLoopOutcome {
  /** The final conversation state, including every turn this run appended. */
  readonly conversation: M3LBedrockConversation;
  /** The final assistant reply. */
  readonly message: M3LBedrockMessage;
  /** Why the loop stopped, terminal. */
  readonly stopReason: M3LBedrockStopReason;
  /** Token usage, summed across every iteration. */
  readonly usage: M3LBedrockTokenUsage;
  /** Every iteration this run performed, in order. */
  readonly iterations: readonly M3LBedrockToolLoopIteration[];
  /** Estimated cost. Omitted (not `undefined`) when `options.rates` was absent, or lacked an entry for a served `modelId`. */
  readonly cost?: number;
}

/** Adds two {@link M3LBedrockTokenUsage} values field-by-field. */
export function sumUsage(
  a: M3LBedrockTokenUsage,
  b: M3LBedrockTokenUsage,
): M3LBedrockTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** Counts every `status: "error"` tool execution across every recorded iteration. */
export function countToolErrors(
  iterations: readonly M3LBedrockToolLoopIteration[],
): number {
  let count = 0;
  for (const iteration of iterations) {
    for (const execution of iteration.toolExecutions) {
      if (execution.status === "error") {
        count += 1;
      }
    }
  }
  return count;
}

/** Divisor turning a raw token count into "thousands of tokens", matching {@link M3LBedrockModelRate}'s per-1k-token pricing unit. */
const TOKENS_PER_RATE_UNIT = 1000;

/**
 * Sums cost across every iteration using each iteration's OWN `modelId` rate
 * — never a blended/average rate across a run that changed models mid-way.
 * Returns `undefined` (never partial, never `NaN`) the moment any served
 * `modelId` lacks a `rates` entry, since throwing would discard the usage
 * the caller was already billed for (V5 Slice B contract §2.3).
 */
export function computeCost(
  iterations: readonly M3LBedrockToolLoopIteration[],
  rates: ReadonlyMap<string, M3LBedrockModelRate> | undefined,
): number | undefined {
  if (rates === undefined) {
    return undefined;
  }
  let total = 0;
  for (const iteration of iterations) {
    const rate = rates.get(iteration.modelId);
    if (rate === undefined) {
      return undefined;
    }
    total +=
      (iteration.usage.inputTokens / TOKENS_PER_RATE_UNIT) *
        rate.inputPer1kTokens +
      (iteration.usage.outputTokens / TOKENS_PER_RATE_UNIT) *
        rate.outputPer1kTokens;
  }
  return total;
}

/** Reads the last recorded iteration, throwing (rather than a silent `undefined`) if none exists — unreachable once `maxIterations >= 1` is enforced, but avoids an unchecked-index footgun under `noUncheckedIndexedAccess`. */
export function requireLastIteration(
  iterations: readonly M3LBedrockToolLoopIteration[],
): M3LBedrockToolLoopIteration {
  const last = iterations[iterations.length - 1];
  if (last === undefined) {
    throw new M3LBedrockRuntimeOperationError(
      "internal: tool-use loop ceiling reached with no completed iterations",
    );
  }
  return last;
}
