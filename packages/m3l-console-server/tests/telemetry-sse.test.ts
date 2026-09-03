/**
 * Tests for `src/http/finish-request.ts`'s `telemetry.sseStream` emission
 * (X8 slice 3b) — `finishRequest` emits exactly
 * `telemetry.sseStream({ outcome: inputs.streamOutcome.reason })` when, and
 * only when, `inputs.streamOutcome` is defined. `reason` is bounded to
 * exactly three values (`M3LStreamWriteOutcome.reason`): `"completed"`,
 * `"client-disconnected"`, `"write-failed"`.
 *
 * RED: the emit does not exist yet in `finish-request.ts`. Vitest does not
 * typecheck, so every case below runs; no `sseStream` sample is ever
 * recorded and the assertions fail for that reason — not a typo or a bad
 * import.
 *
 * Driven directly against `finishRequest` (not through the router/handler
 * stack), mirroring `tests/telemetry-http.test.ts`'s harness: reuse its
 * capturing-logger and capturing-recorder patterns, and its
 * `new Core.M3LLogger([handler])` construction (a plain-object logger fake
 * can never satisfy that class's `#private` fields).
 */
import type { ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type { RequestFaultContext } from "../src/http/access-log.js";
import { finishRequest } from "../src/http/finish-request.js";
import type { FinishRequestInputs } from "../src/http/finish-request.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import type { M3LStreamWriteOutcome } from "../src/http/stream-writer.js";
import type {
  M3LTelemetryHttpRequestSample,
  M3LTelemetryRecorder,
  M3LTelemetrySseStreamSample,
} from "../src/telemetry/port.js";

/** A capturing `M3LLoggerHandler` collecting every emitted event, synchronously. */
function createCapturingLogger(): {
  readonly logger: Core.M3LLogger;
  readonly events: Core.M3LLogEvent[];
} {
  const events: Core.M3LLogEvent[] = [];
  const handler: Core.M3LLoggerHandler = {
    handle: (event) => {
      events.push(event);
    },
    reset: () => {
      events.length = 0;
    },
  };
  return { logger: new Core.M3LLogger([handler]), events };
}

/**
 * Builds a capturing {@link M3LTelemetryRecorder} test double: every method
 * is implemented (a plain interface can never be satisfied by a partial
 * object), and every `httpRequest`/`sseStream` sample handed to it is
 * captured, in order. `onSseStream`, when supplied, runs AFTER the sample is
 * captured — so a throwing override still leaves a record that the call
 * happened.
 */
function createCapturingTelemetryRecorder(
  onSseStream?: (sample: M3LTelemetrySseStreamSample) => void,
): {
  readonly telemetry: M3LTelemetryRecorder;
  readonly httpRequestCalls: M3LTelemetryHttpRequestSample[];
  readonly sseStreamCalls: M3LTelemetrySseStreamSample[];
} {
  const httpRequestCalls: M3LTelemetryHttpRequestSample[] = [];
  const sseStreamCalls: M3LTelemetrySseStreamSample[] = [];
  const telemetry: M3LTelemetryRecorder = {
    httpRequest: (sample) => {
      httpRequestCalls.push(sample);
    },
    runFinished: () => undefined,
    sseStream: (sample) => {
      sseStreamCalls.push(sample);
      onSseStream?.(sample);
    },
    policyDecision: () => undefined,
    storeHealth: () => undefined,
  };
  return { telemetry, httpRequestCalls, sseStreamCalls };
}

/**
 * Builds a `ServerResponse` double that records `writeHead`/`end` calls,
 * mirroring `tests/telemetry-http.test.ts`'s `createRecordingServerResponse`.
 */
function createRecordingServerResponse(): {
  readonly res: ServerResponse;
} {
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(this: { headersSent: boolean }) {
      this.headersSent = true;
      return this;
    },
    end(this: { writableEnded: boolean }) {
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse & {
    headersSent: boolean;
    writableEnded: boolean;
  };
  return { res };
}

/** A minimal {@link M3LConsoleResponse}. */
const response: M3LConsoleResponse = {
  status: 200,
  headers: {},
  body: "ok",
};

/** A minimal {@link RequestFaultContext}. */
const context: RequestFaultContext = {
  method: "GET",
  path: "/api/v1/stream",
  correlationId: "corr-1",
};

/** Builds a minimal {@link M3LStreamWriteOutcome} for the given `reason`. */
function streamOutcome(
  reason: M3LStreamWriteOutcome["reason"],
): M3LStreamWriteOutcome {
  return { frames: 1, dropped: 0, reason };
}

/** Builds the common, non-telemetry {@link FinishRequestInputs} fields. */
function baseInputs(): Omit<
  FinishRequestInputs,
  "telemetry" | "streamOutcome"
> {
  const { res } = createRecordingServerResponse();
  const { logger } = createCapturingLogger();
  return {
    res,
    response,
    context,
    connectionController: new AbortController(),
    startedAt: 0,
    now: () => 5,
    accessMode: "required",
    logger,
    write: false,
    route: "/api/v1/stream",
  };
}

describe("finishRequest — telemetry.sseStream's outcome mirrors streamOutcome.reason verbatim", () => {
  test.each<M3LStreamWriteOutcome["reason"]>([
    "completed",
    "client-disconnected",
    "write-failed",
  ])("reason %s is recorded verbatim as outcome", (reason) => {
    const { telemetry, sseStreamCalls } = createCapturingTelemetryRecorder();

    finishRequest({
      ...baseInputs(),
      telemetry,
      streamOutcome: streamOutcome(reason),
    });

    expect(sseStreamCalls).toHaveLength(1);
    expect(sseStreamCalls[0]?.outcome).toBe(reason);
  });
});

describe("finishRequest — a non-stream response records zero sseStream samples", () => {
  test("streamOutcome undefined -> no sseStream call (naive optional chaining breaks this)", () => {
    const { telemetry, sseStreamCalls } = createCapturingTelemetryRecorder();

    finishRequest({
      ...baseInputs(),
      telemetry,
    });

    expect(sseStreamCalls).toHaveLength(0);
  });
});

describe("finishRequest — a stream result records both an sseStream AND an http.request sample", () => {
  test("exactly one sseStream call, and the httpRequest call still fires", () => {
    const { telemetry, httpRequestCalls, sseStreamCalls } =
      createCapturingTelemetryRecorder();

    finishRequest({
      ...baseInputs(),
      telemetry,
      streamOutcome: streamOutcome("completed"),
    });

    expect(sseStreamCalls).toHaveLength(1);
    expect(httpRequestCalls).toHaveLength(1);
  });
});

describe("finishRequest — the sseStream sample carries no measure field", () => {
  test('the sample\'s own keys are exactly ["outcome"] (v11 rejects a measure-bearing counter row)', () => {
    const { telemetry, sseStreamCalls } = createCapturingTelemetryRecorder();

    finishRequest({
      ...baseInputs(),
      telemetry,
      streamOutcome: streamOutcome("completed"),
    });

    expect(sseStreamCalls).toHaveLength(1);
    const sample = sseStreamCalls[0];
    // Object.keys/Object.hasOwn, never `toHaveProperty` — `not.toHaveProperty`
    // falls back to the `in` operator and walks the prototype chain, which
    // would make this assertion unfailable.
    expect(sample).toBeDefined();
    expect(Object.keys(sample as object)).toEqual(["outcome"]);
    expect(Object.hasOwn(sample as object, "outcome")).toBe(true);
  });
});

describe("finishRequest — telemetry.sseStream is unguarded, mirroring httpRequest's contract", () => {
  test("a recorder whose sseStream throws still leaves the response written and surfaces its own diagnostic upstream, not silently absorbed here", () => {
    const { telemetry, sseStreamCalls } = createCapturingTelemetryRecorder(
      () => {
        throw new Error("telemetry recorder exploded");
      },
    );
    const { res } = createRecordingServerResponse();
    const { logger, events } = createCapturingLogger();

    let thrown: unknown;
    try {
      finishRequest({
        ...baseInputs(),
        res,
        logger,
        telemetry,
        // Overrides `baseInputs()`'s `write: false` (the ordinary stream
        // shape, where `writeStream` already wrote the socket elsewhere):
        // this test needs `finishRequest` itself to perform an observable
        // write on ITS OWN `res` double, so that "the response was written
        // before the throw" is something this test can actually check
        // rather than merely narrate.
        write: true,
        streamOutcome: streamOutcome("completed"),
      });
    } catch (error) {
      thrown = error;
    }

    // The recorder's throw happened (captured before the throw), and — since
    // `finishRequest` itself does not guard the call — propagates out of
    // `finishRequest` rather than being silently swallowed here. It is the
    // caller (`handler.ts`'s `createConsoleRequestListener` `.catch`) that
    // turns this into its own "unhandled console request listener failure"
    // diagnostic; this test only asserts that `finishRequest` did not
    // swallow it and that the response write already happened before the
    // throw.
    expect(sseStreamCalls).toHaveLength(1);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("telemetry recorder exploded");
    // The actual "response written" assertion: `writeResponseGuarded` runs
    // BEFORE `telemetry.httpRequest`/`telemetry.sseStream` in
    // `finishRequest`'s own body, so by the time the recorder's throw
    // propagates out, `res.writeHead`/`res.end` have already run and left
    // their mark on this double.
    expect(res.headersSent).toBe(true);
    expect(res.writableEnded).toBe(true);
    // No log line was produced here — a genuine assertion that finish-request
    // itself never writes its own diagnostic for this; the upstream listener
    // does. This is a regression lock: it currently passes trivially since
    // no emit exists yet at RED, and must still hold once the emit exists.
    expect(events).toHaveLength(1);
  });
});

describe("finishRequest — telemetry.httpRequest and telemetry.sseStream fire in that order", () => {
  test("a stream request records httpRequest before sseStream (order is load-bearing per finish-request.ts's own TSDoc)", () => {
    type TaggedCall = { readonly kind: "http" } | { readonly kind: "sse" };
    const sequence: TaggedCall[] = [];
    const telemetry: M3LTelemetryRecorder = {
      httpRequest: () => {
        sequence.push({ kind: "http" });
      },
      runFinished: () => undefined,
      sseStream: () => {
        sequence.push({ kind: "sse" });
      },
      policyDecision: () => undefined,
      storeHealth: () => undefined,
    };

    finishRequest({
      ...baseInputs(),
      telemetry,
      streamOutcome: streamOutcome("completed"),
    });

    // A single shared, tagged sequence — not two independently-asserted
    // arrays — so swapping the two calls in `finishRequest` would actually
    // fail this test.
    expect(sequence).toEqual([{ kind: "http" }, { kind: "sse" }]);
  });
});
