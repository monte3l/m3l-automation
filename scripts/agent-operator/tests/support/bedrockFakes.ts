/**
 * Test-only fakes for the `AWS.M3LBedrockToolLoopInvoker` port
 * (`aws/bedrock-runtime/loop.ts:125` — "the port. Structural, safe to
 * fake."). `metering-invoker.test.ts` (and, later, `gate-tool.test.ts`)
 * inject {@link createFakeBedrockToolLoopInvoker}'s `invoker` in place of a
 * real `M3LBedrockRuntimeOperations`, so no test in this package ever makes
 * a real Bedrock Converse call.
 *
 * Mirrors `tests/support/cliFakes.ts`'s shape: a `calls` array recording
 * every invocation verbatim, an `enqueueResult`/`enqueueRejection` FIFO, and
 * a hard failure (never `undefined`) when a test forgets to queue enough
 * responses.
 */
import type { AWS } from "@m3l-automation/m3l-common";

/** One recorded `invoke()` call, exactly as the invoker received it. */
export interface BedrockInvokeCall {
  readonly request: AWS.M3LBedrockToolInvokeRequest;
  readonly options: AWS.M3LBedrockInvokeOptions | undefined;
}

/**
 * A scripted `AWS.M3LBedrockToolLoopInvoker`, plus the recorded `calls` so a
 * test can assert both what was sent to `invoke()` AND how many times it was
 * called.
 */
export interface FakeBedrockToolLoopInvoker {
  /** Drop-in replacement for a real `M3LBedrockRuntimeOperations`. */
  readonly invoker: AWS.M3LBedrockToolLoopInvoker;
  /** One entry per `invoke()` call, in call order. */
  readonly calls: BedrockInvokeCall[];
  /** Scripts the next `invoke()` call to resolve with `result` (FIFO). */
  enqueueResult(result: AWS.M3LBedrockInvocationResult): void;
  /** Scripts the next `invoke()` call to reject with `error` (FIFO). */
  enqueueRejection(error: unknown): void;
}

/**
 * Creates a {@link FakeBedrockToolLoopInvoker}. Each call to `invoke` records
 * the exact `request`/`options` it received into `calls` and resolves or
 * rejects with the next queued entry — throwing a plain `Error` (a
 * test-fixture bug, not a scenario under test) when the queue is empty, so a
 * forgotten `enqueueResult`/`enqueueRejection` fails loudly instead of
 * hanging.
 *
 * @example
 * ```ts
 * const fake = createFakeBedrockToolLoopInvoker();
 * fake.enqueueResult(makeBedrockInvocationResult());
 * const outcome = await fake.invoker.invoke(makeBedrockToolInvokeRequest());
 * expect(fake.calls).toHaveLength(1);
 * ```
 */
export function createFakeBedrockToolLoopInvoker(): FakeBedrockToolLoopInvoker {
  const calls: BedrockInvokeCall[] = [];
  const queue: Array<
    | {
        readonly kind: "result";
        readonly value: AWS.M3LBedrockInvocationResult;
      }
    | { readonly kind: "rejection"; readonly value: unknown }
  > = [];

  const invoker: AWS.M3LBedrockToolLoopInvoker = {
    invoke(request, options) {
      calls.push({ request, options });
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(
          new Error(
            `createFakeBedrockToolLoopInvoker: no result queued for call #${String(calls.length)}`,
          ),
        );
      }
      return next.kind === "result"
        ? Promise.resolve(next.value)
        : // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- `enqueueRejection` takes `unknown` deliberately, so a test can prove a rejection reason (any shape, not just `Error`) is rethrown unchanged
          Promise.reject(next.value);
    },
  };

  return {
    invoker,
    calls,
    enqueueResult(result) {
      queue.push({ kind: "result", value: result });
    },
    enqueueRejection(error) {
      queue.push({ kind: "rejection", value: error });
    },
  };
}

// ---------------------------------------------------------------------------
// Builders — one per shape a test fixture needs, with sane defaults so a
// test only overrides the fields its scenario cares about.
// ---------------------------------------------------------------------------

/** Builds an `M3LBedrockTokenUsage`, defaulting `totalTokens` to the sum of the other two unless overridden explicitly. */
export function makeBedrockTokenUsage(
  overrides: Partial<AWS.M3LBedrockTokenUsage> = {},
): AWS.M3LBedrockTokenUsage {
  const inputTokens = overrides.inputTokens ?? 10;
  const outputTokens = overrides.outputTokens ?? 5;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...overrides,
  };
}

/** Builds a minimal, valid `M3LBedrockInvocationResult` — every field required, none optional. */
export function makeBedrockInvocationResult(
  overrides: Partial<AWS.M3LBedrockInvocationResult> = {},
): AWS.M3LBedrockInvocationResult {
  return {
    message: { role: "assistant", content: [] },
    stopReason: "end_turn",
    usage: makeBedrockTokenUsage(),
    modelId: "anthropic.claude-sonnet-5",
    ...overrides,
  };
}

/** Builds a minimal, valid `M3LBedrockToolInvokeRequest` — an empty message list is a structurally valid request. */
export function makeBedrockToolInvokeRequest(
  overrides: Partial<AWS.M3LBedrockToolInvokeRequest> = {},
): AWS.M3LBedrockToolInvokeRequest {
  return {
    messages: [],
    ...overrides,
  };
}

/** Builds an `M3LBedrockModelRate`. */
export function makeBedrockModelRate(
  overrides: Partial<AWS.M3LBedrockModelRate> = {},
): AWS.M3LBedrockModelRate {
  return {
    inputPer1kTokens: 3,
    outputPer1kTokens: 15,
    ...overrides,
  };
}
