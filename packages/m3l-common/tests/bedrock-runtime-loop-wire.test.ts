/**
 * Wire-level and regression tests for aws/bedrock-runtime's V5 Slice B tool-
 * use loop (`runBedrockToolLoop`), extending
 * `tests/bedrock-runtime-loop.test.ts` after a five-spoke review found two
 * proven security defects invisible to that file's structural `{ invoke }`
 * fake (see that file's own doc comment, lines 22-25): a fake test author
 * controls the "response" object directly, so it can accidentally exercise
 * the exact shape a real `BedrockRuntimeClient` response deserializer would
 * produce, or it can just as easily skip the adversarial case nobody thought
 * to construct by hand. Both Must-fix defects here (M1: an unvalidated
 * model-controlled `toolUse.input` re-entering the request builder; M2: a
 * handler's rejection reason reaching the wire unsanitized/uncapped) are
 * genuinely response-shape/wire-shape bugs, so this file follows Slice A's
 * `tests/bedrock-runtime-wire.test.ts` pattern instead: a REAL
 * `BedrockRuntimeClient` with a stub `requestHandler` that captures the
 * already-serialized request body before returning a stubbed Converse HTTP
 * response — no `vi.mock("@aws-sdk/client-bedrock-runtime")`, no structural
 * fake standing in for the SDK's own (de)serializer.
 *
 * Deliberately a SEPARATE file from both `bedrock-runtime-loop.test.ts`
 * (51,782 B) and `bedrock-runtime-wire.test.ts` (49,185 B) — both are close
 * enough to ADR-0072's 60,000 B per-file ceiling that neither can absorb
 * this — and deliberately imports only this slice's loop-scoped symbols
 * (`runBedrockToolLoop` and its option/registry/handler types) plus the
 * shared `M3LBedrockRuntimeOperationError`/`M3LBedrockRuntimeOperations`,
 * so `perFile` v8 coverage (`vitest.config.ts:73`) binds within this slice.
 *
 * `runBedrockToolLoop` takes a **port** (`M3LBedrockToolLoopInvoker`), not
 * the concrete nominally-typed `M3LBedrockRuntimeOperations` class — but
 * that class satisfies the port structurally (it declares a compatible
 * `invoke()` method), so passing the real, wire-backed instance in works
 * unchanged and is exactly what every test below does.
 *
 * As of 2026-08-30, all four review findings are fixed in `src/`: M1
 * (response-side `toolUse.input` validation in `validateToolUseBatch`), M2
 * (sanitize + length-cap a handler's failure text before it reaches the
 * wire), M3 (`isAborted(signal) && isAbortError(cause)`, abort
 * reclassification), and M4 (`inferenceConfig` uniform
 * `exactOptionalPropertyTypes` rejection) — every group below is a
 * regression lock proving each fix, not an intended-RED test.
 */

import { describe, expect, test, vi } from "vitest";

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

import {
  M3LBedrockRuntimeOperationError,
  M3LBedrockRuntimeOperations,
  runBedrockToolLoop,
} from "../src/aws/index.js";
import type {
  M3LBedrockConversation,
  M3LBedrockToolContext,
  M3LBedrockToolExecution,
  M3LBedrockToolHandler,
  M3LBedrockToolLoopOptions,
  M3LBedrockToolRegistration,
  M3LBedrockToolRegistry,
  M3LBedrockToolUseBlock,
} from "../src/aws/index.js";
import { M3LOperationAbortedError } from "../src/core/errors/index.js";
// Deep import, deliberately: `dispatchToolUseTurn` is not re-exported
// through the `aws` barrel or `loop.ts`'s own export list (it is
// `tool-dispatch.ts`'s internal collaborator, driven by `loop.ts`) — see
// Group W3's doc comment for why THIS is the one seam that can actually
// observe the M3 fix, when `runBedrockToolLoop`'s own Check 1 masks it.
import { dispatchToolUseTurn } from "../src/aws/bedrock-runtime/tool-dispatch.js";

/** A minimal, well-formed Converse HTTP response body (`end_turn`, one text block) — the terminal reply every queued-response harness falls back on so a loop that (incorrectly) issues more requests than a test expects fails loudly instead of hanging. */
function stubEndTurnPayload(): Record<string, unknown> {
  return {
    output: { message: { role: "assistant", content: [{ text: "ok" }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

/** The stub `requestHandler`'s `handle()` argument shape — only what this file reads. */
interface StubHttpRequest {
  readonly body: unknown;
}

/**
 * Builds a REAL `BedrockRuntimeClient` (genuine request serializer, genuine
 * response deserializer) wired to a stub `requestHandler` that never
 * touches the network: `handle()` decodes and records the already-
 * serialized request body into `sent`, then replies with the next payload
 * off `payloads` (or {@link stubEndTurnPayload} once the queue is
 * exhausted, so an unexpectedly-extra request still resolves instead of
 * hanging the test — `sent.length` is what actually proves how many
 * requests fired).
 */
function newQueuedWireOps(payloads: readonly Record<string, unknown>[]): {
  readonly ops: M3LBedrockRuntimeOperations;
  readonly sent: string[];
} {
  const sent: string[] = [];
  let index = 0;
  const client = new BedrockRuntimeClient({
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "y" },
    requestHandler: {
      handle(request: StubHttpRequest) {
        sent.push(new TextDecoder().decode(request.body as Uint8Array));
        const payload = payloads[index] ?? stubEndTurnPayload();
        index += 1;
        const body = new TextEncoder().encode(JSON.stringify(payload));
        return Promise.resolve({
          response: { statusCode: 200, headers: {}, body },
        });
      },
    },
  });
  return {
    ops: new M3LBedrockRuntimeOperations(client, { models: ["m1"] }),
    sent,
  };
}

/** Captures a thrown value from an async call without a try/catch at every call site. */
async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

const BASE_CONVERSATION: M3LBedrockConversation = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

/** A registry with one tool ("get_weather") whose handler is a spy, so every test can assert call count/args without redefining this shape per test. */
function spyToolRegistry(handler: M3LBedrockToolHandler): {
  readonly tools: M3LBedrockToolRegistry;
  readonly spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(handler);
  const registration: M3LBedrockToolRegistration = {
    inputSchema: {},
    handler: spy,
  };
  const tools: M3LBedrockToolRegistry = new Map<
    string,
    M3LBedrockToolRegistration
  >([["get_weather", registration]]);
  return { tools, spy };
}

/** A single-tool-call `tool_use` Converse response payload naming `get_weather`, with `input` set to `poisonedInput` verbatim (the exact shape `tools.ts`'s `mapNarrowedToolUse` forwards unvalidated per its own doc comment: "forwarded exactly as the SDK decoded it ... never re-parsed, re-shaped, or validated"). */
function toolUseResponsePayload(
  poisonedInput: unknown,
): Record<string, unknown> {
  return {
    output: {
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              toolUseId: "call-1",
              name: "get_weather",
              input: poisonedInput,
            },
          },
        ],
      },
    },
    stopReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

describe("wire harness sanity — proves the real serializer/deserializer actually run for this file's loop-driven requests", () => {
  test("a benign tool_use reply IS dispatched to the registered handler, and the loop completes with a second (terminal) request sent", async () => {
    const { ops, sent } = newQueuedWireOps([
      toolUseResponsePayload({ city: "Boston" }),
    ]);
    const { tools, spy } = spyToolRegistry(() =>
      Promise.resolve([{ type: "text", text: "72F, sunny" }]),
    );

    const outcome = await runBedrockToolLoop(ops, BASE_CONVERSATION, {
      tools,
    });

    expect(outcome.stopReason).toBe("end_turn");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toEqual({ city: "Boston" });
    const context = spy.mock.calls[0]?.[1] as M3LBedrockToolContext;
    expect(context.toolUseId).toBe("call-1");
    expect(context.name).toBe("get_weather");
    // Two requests: the original tool_use turn, then the follow-up carrying
    // the toolResult — proving this harness actually drives a two-request
    // loop, not just a single invoke().
    expect(sent).toHaveLength(2);
  });
});

/**
 * Group W1 — the poisoned-conversation defect (security M1). A
 * model-controlled `toolUse.input` re-entered the request builder
 * unvalidated: response-side mapping (`tools.ts`'s `mapNarrowedToolUse`)
 * applies no depth bound, no node budget, and no reserved-key refusal,
 * while request-side `copyDocument` (`document.ts`) applies all three.
 *
 * Fixed behavior under test: `validateToolUseBatch` (`tool-dispatch.ts`)
 * rejects an `input` containing a reserved key (`__proto__`/`constructor`/
 * `prototype`), or exceeding `MAX_DOCUMENT_DEPTH` (32) or
 * `MAX_DOCUMENT_NODES` (10,000) — throwing `M3LBedrockRuntimeOperationError`
 * BEFORE any handler runs, and before the poisoned assistant turn is ever
 * re-appended and re-sent.
 *
 * `validateToolUseBatch` now routes every block's `input` through
 * `validateToolUseInputShape` (which delegates to `copyDocument`'s own
 * bound), closing the gap this group guards.
 */
describe("W1 — a poisoned response-side toolUse.input is rejected before any handler runs or the conversation is re-sent", () => {
  const RESERVED_KEYS = ["__proto__", "constructor", "prototype"] as const;

  test.each(RESERVED_KEYS)(
    "a toolUse.input carrying the reserved key %s throws M3LBedrockRuntimeOperationError, calls no handler, and sends no second request",
    async (reservedKey) => {
      const poisoned = JSON.parse(
        `{"a":1,"${reservedKey}":{"injected":"X"}}`,
      ) as Record<string, unknown>;
      const { ops, sent } = newQueuedWireOps([
        toolUseResponsePayload(poisoned),
      ]);
      const { tools, spy } = spyToolRegistry(() =>
        Promise.resolve([{ type: "text", text: "72F, sunny" }]),
      );

      const thrown = await captureThrow(() =>
        runBedrockToolLoop(ops, BASE_CONVERSATION, { tools }),
      );

      expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
      expect(spy).toHaveBeenCalledTimes(0);
      // Guards the exact hazard named in the task: even if a handler read
      // its `input` via `Object.assign({}, input)`, it can never observe an
      // own `__proto__` data property — trivially true here since the
      // handler is never called at all, but asserted explicitly per call
      // (there are none) for documentation.
      for (const call of spy.mock.calls) {
        expect(Object.hasOwn(call[0] as object, "__proto__")).toBe(false);
      }
      // The poisoned assistant turn is never re-appended and re-sent: only
      // the original request went out.
      expect(sent).toHaveLength(1);
      expect(Object.hasOwn(Object.prototype, "injected")).toBe(false);
    },
  );

  test("a toolUse.input nested 33 levels deep (exceeding MAX_DOCUMENT_DEPTH=32) throws M3LBedrockRuntimeOperationError, calls no handler, and sends no second request", async () => {
    function makeDeep(levels: number): unknown {
      let value: unknown = "leaf";
      for (let index = 0; index < levels; index += 1) {
        value = { nest: value };
      }
      return value;
    }
    const { ops, sent } = newQueuedWireOps([
      toolUseResponsePayload(makeDeep(33)),
    ]);
    const { tools, spy } = spyToolRegistry(() =>
      Promise.resolve([{ type: "text", text: "72F, sunny" }]),
    );

    const thrown = await captureThrow(() =>
      runBedrockToolLoop(ops, BASE_CONVERSATION, { tools }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(sent).toHaveLength(1);
  });

  test("a toolUse.input carrying a flat 10,001-element array (exceeding MAX_DOCUMENT_NODES=10,000; a plain oversized structure, not a shared DAG — unlike copyDocument's REQUEST-side sharing exploit, a genuine Converse HTTP response is JSON text, which JSON.parse always re-materializes as a fresh tree with no aliasing, so a shared-reference node-count amplification is not reachable from a real response) throws M3LBedrockRuntimeOperationError, calls no handler, and sends no second request", async () => {
    const oversized = { items: Array.from({ length: 10_001 }, (_, i) => i) };
    const { ops, sent } = newQueuedWireOps([toolUseResponsePayload(oversized)]);
    const { tools, spy } = spyToolRegistry(() =>
      Promise.resolve([{ type: "text", text: "72F, sunny" }]),
    );

    const thrown = await captureThrow(() =>
      runBedrockToolLoop(ops, BASE_CONVERSATION, { tools }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(sent).toHaveLength(1);
  });
});

/**
 * Group W2 — handler exception text reaching the wire (security M2). A
 * handler throwing `new Error(\`db password is ${CANARY_MARKER}\`)` put the
 * literal secret in the outbound request body, uncapped and unescaped. Fixed:
 * `describeToolFailure` (`tool-dispatch.ts`) routes the rendered failure
 * text through `sanitizeForMessage`, capped at 1,024 code points with a
 * truncation marker. These assertions inspect the CAPTURED WIRE BYTES of
 * the follow-up (second) request — never the in-memory ledger — since the
 * whole point is proving what actually reaches Bedrock.
 */
describe("W2 — a handler rejection's text reaches the model sanitized and length-capped on the wire", () => {
  /** Extracts the first `toolResult` block's first content item's `text` out of a captured wire request body. */
  function extractToolResultText(wireBody: string): string {
    const parsed = JSON.parse(wireBody) as {
      readonly messages?: readonly {
        readonly content?: readonly {
          readonly toolResult?: {
            readonly content?: readonly { readonly text?: string }[];
          };
        }[];
      }[];
    };
    for (const message of parsed.messages ?? []) {
      for (const item of message.content ?? []) {
        const text = item.toolResult?.content?.[0]?.text;
        if (text !== undefined) {
          return text;
        }
      }
    }
    throw new Error("no toolResult text found in captured wire body");
  }

  /**
   * Runs a two-turn loop: turn 1 gets a `tool_use` reply naming
   * `get_weather`, whose handler rejects with `rejection`; turn 2 (the
   * follow-up carrying the toolResult) is answered with a terminal
   * `end_turn`. Returns every captured wire request body.
   */
  async function runRejectingTwoTurnLoop(
    rejection: Error,
  ): Promise<readonly string[]> {
    const { ops, sent } = newQueuedWireOps([
      toolUseResponsePayload({}),
      stubEndTurnPayload(),
    ]);
    const { tools } = spyToolRegistry(() => Promise.reject(rejection));

    const outcome = await runBedrockToolLoop(ops, BASE_CONVERSATION, {
      tools,
    });

    expect(outcome.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(2);
    return sent;
  }

  test("benign control: an ordinary short failure message round-trips intact on the wire", async () => {
    const sent = await runRejectingTwoTurnLoop(
      new Error("insufficient balance"),
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted via toHaveLength(2) above
    expect(extractToolResultText(sent[1]!)).toBe("insufficient balance");
  });

  test("a planted canary secret in a handler rejection still reaches the model as text (not redacted), but control characters (raw newline, ESC ANSI, U+202E RLO) never appear raw on the wire", async () => {
    const CANARY_MARKER = "canary-not-a-real-secret";
    const rawMessage = `db password is ${CANARY_MARKER}\nDROP\x1b[31mTABLE‮users`;
    const sent = await runRejectingTwoTurnLoop(new Error(rawMessage));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted via toHaveLength(2) above
    const wireBody = sent[1]!;
    const text = extractToolResultText(wireBody);

    // Reaches the model as text — this is not a redaction fix.
    expect(text).toContain(CANARY_MARKER);
    // ... but every control character is neutralized, never raw, on the wire.
    expect(wireBody).not.toContain("\n");
    expect(wireBody).not.toContain("\x1b[31m");
    expect(wireBody).not.toContain("‮");
    expect(text).not.toContain("\n");
    expect(text).not.toContain("\x1b[31m");
    expect(text).not.toContain("‮");
    // sanitizeForMessage's own escape format proves it actually ran, not
    // merely that JSON.stringify's own \u00XX escaping (which would ALSO
    // hide a raw \n/ESC, but never U+202E, from the wire — see this
    // group's doc comment) happened to hide these.
    expect(text).toContain("\\x0a");
    expect(text).toContain("\\x1b");
    expect(text).toContain("\\x202e");
  });

  test("a 5 MB rejection message does not produce a multi-megabyte request body: the toolResult text is capped at 1,024 code points with a truncation marker", async () => {
    const HUGE_LENGTH = 5 * 1024 * 1024;
    const rawMessage = "A".repeat(HUGE_LENGTH);
    const sent = await runRejectingTwoTurnLoop(new Error(rawMessage));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted via toHaveLength(2) above
    const wireBody = sent[1]!;
    const text = extractToolResultText(wireBody);

    expect(wireBody.length).toBeLessThan(10_000);
    expect(text.length).toBeLessThanOrEqual(1025);
    expect(text.endsWith("…")).toBe(true);
  });
});

/**
 * Group W3 — abort reclassification (silent-failure M3). The catch was
 * `isAborted(signal) || cause instanceof M3LOperationAbortedError`, which
 * reclassified ANY handler rejection into a contentless
 * `M3LOperationAbortedError` whenever the shared `signal` happened to be
 * aborted — even when the rejection was a wholly unrelated domain fault
 * (e.g. `AccessDeniedException`). Fixed to
 * `isAborted(signal) && isAbortError(cause)`, with the `instanceof` rethrow
 * kept as a preceding check.
 *
 * These three tests exercise `dispatchToolUseTurn` DIRECTLY (a deep import
 * from `tool-dispatch.ts`, not re-exported through the `aws` barrel/
 * `loop.ts`'s export list) rather than the full `runBedrockToolLoop` —
 * deliberately: `loop.ts`'s OWN `enforceIterationCeiling` ("Check 1")
 * unconditionally rechecks `isAborted(options.signal)` at the top of EVERY
 * iteration, including the one immediately following any tool-use turn (a
 * tool-use turn always continues, never terminal). Once a test aborts the
 * shared signal at all, that next Check 1 throws `M3LOperationAbortedError`
 * regardless of whether THIS fix's dispatch-level reclassification is
 * correct or still buggy — the two are indistinguishable from
 * `runBedrockToolLoop`'s own return value alone. `dispatchToolUseTurn`'s
 * own resolved/rejected outcome is the one seam where the fix is actually
 * observable.
 */
/** Narrows {@link M3LBedrockToolExecution}'s two `status: "error"` union members to the one that actually ran a handler (the only member declaring an own `cause`) — the two are otherwise indistinguishable by `status` alone. */
function hasCause(
  execution: M3LBedrockToolExecution,
): execution is Extract<M3LBedrockToolExecution, { readonly cause: unknown }> {
  return Object.hasOwn(execution, "cause");
}

describe("W3 — abort reclassification requires BOTH an aborted signal AND an abort-shaped cause", () => {
  function oneToolUseBlock(): M3LBedrockToolUseBlock {
    return { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} };
  }

  test("W3.1 (re-verify): a handler that itself throws M3LOperationAbortedError propagates unwrapped — the SAME instance, never re-wrapped, regardless of signal state", async () => {
    const original = new M3LOperationAbortedError("cancelled mid tool call");
    const { tools, spy } = spyToolRegistry(() => Promise.reject(original));

    const thrown = await captureThrow(() =>
      dispatchToolUseTurn([oneToolUseBlock()], tools, undefined),
    );

    expect(thrown).toBe(original);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('W3.2 (the whole point): signal aborted AND handler rejects with an UNRELATED domain error — the real cause survives as a normal status:"error" disposition, never replaced by a bare M3LOperationAbortedError', async () => {
    const controller = new AbortController();
    const domainError = Object.assign(new Error("access denied"), {
      name: "AccessDeniedException",
    });
    const { tools, spy } = spyToolRegistry(() => {
      // Simulates a signal SHARED with an unrelated concurrent operation:
      // it fires mid-handler, after Check 2 already passed, for a reason
      // that has nothing to do with this handler's own (unrelated) fault.
      controller.abort();
      return Promise.reject(domainError);
    });

    const { executions, resultBlocks } = await dispatchToolUseTurn(
      [oneToolUseBlock()],
      tools,
      controller.signal,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(executions).toHaveLength(1);
    const execution = executions[0];
    expect(execution?.status).toBe("error");
    expect(execution !== undefined && hasCause(execution)).toBe(true);
    if (execution !== undefined && hasCause(execution)) {
      expect(execution.cause).toBe(domainError);
    }
    expect(resultBlocks[0]?.status).toBe("error");
  });

  test("W3.3: handler honors the signal via an abort-shaped DOMException (not our M3LOperationAbortedError class) while the signal is genuinely aborted — treated as a cancellation, the turn does not resolve", async () => {
    const controller = new AbortController();
    const { tools, spy } = spyToolRegistry(() => {
      controller.abort();
      // A genuine DOMException, not our M3LOperationAbortedError — proving the isAbortError(cause) arm.
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });

    const thrown = await captureThrow(() =>
      dispatchToolUseTurn([oneToolUseBlock()], tools, controller.signal),
    );

    expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Group W4 — regression for the `exactOptionalPropertyTypes` hole (M4).
 * `inferenceConfig` was the one `M3LBedrockToolLoopOptions` field typed to
 * accept an explicit `undefined` (`M3LBedrockToolInvokeRequest["inferenceConfig"]`,
 * an indexed-access type that already includes `| undefined`) while the
 * other four optional fields (`maxIterations`, `maxToolsPerTurn`, `signal`,
 * `rates`) rejected it under `exactOptionalPropertyTypes`. Fixed: all five
 * now reject `key: undefined` uniformly — each `@ts-expect-error` below
 * must still be load-bearing (not "unused directive") for this test file to
 * typecheck clean, so a regression on any one field surfaces here first.
 */
describe("W4 — M3LBedrockToolLoopOptions rejects an explicit `undefined` uniformly across all five optional fields", () => {
  test("maxIterations rejects `undefined` under exactOptionalPropertyTypes", () => {
    const tools: M3LBedrockToolRegistry = new Map();
    // @ts-expect-error -- exactOptionalPropertyTypes forbids `maxIterations: undefined`; omit the key instead.
    const options: M3LBedrockToolLoopOptions = {
      tools,
      maxIterations: undefined,
    };
    expect(options.tools).toBe(tools);
  });

  test("maxToolsPerTurn rejects `undefined` under exactOptionalPropertyTypes", () => {
    const tools: M3LBedrockToolRegistry = new Map();
    // @ts-expect-error -- exactOptionalPropertyTypes forbids `maxToolsPerTurn: undefined`; omit the key instead.
    const options: M3LBedrockToolLoopOptions = {
      tools,
      maxToolsPerTurn: undefined,
    };
    expect(options.tools).toBe(tools);
  });

  test("signal rejects `undefined` under exactOptionalPropertyTypes", () => {
    const tools: M3LBedrockToolRegistry = new Map();
    // @ts-expect-error -- exactOptionalPropertyTypes forbids `signal: undefined`; omit the key instead.
    const options: M3LBedrockToolLoopOptions = { tools, signal: undefined };
    expect(options.tools).toBe(tools);
  });

  test("rates rejects `undefined` under exactOptionalPropertyTypes", () => {
    const tools: M3LBedrockToolRegistry = new Map();
    // @ts-expect-error -- exactOptionalPropertyTypes forbids `rates: undefined`; omit the key instead.
    const options: M3LBedrockToolLoopOptions = { tools, rates: undefined };
    expect(options.tools).toBe(tools);
  });

  test("inferenceConfig rejects `undefined` under exactOptionalPropertyTypes (M4 regression — previously the one field that accepted it)", () => {
    const tools: M3LBedrockToolRegistry = new Map();
    // @ts-expect-error -- exactOptionalPropertyTypes forbids `inferenceConfig: undefined`; omit the key instead. M4: previously UNUSED here (this line compiled clean) because the field's declared type carried a redundant `| undefined`.
    const options: M3LBedrockToolLoopOptions = {
      tools,
      inferenceConfig: undefined,
    };
    expect(options.tools).toBe(tools);
  });
});
