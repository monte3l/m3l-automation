/**
 * Tests for the X4 slice-7a addendum's Corrections 2 and 3 — a genuine
 * behavioral gap in code that ALREADY EXISTS on this branch, not a
 * not-yet-created module:
 *
 * - Correction 2: `src/runs/stream-events.ts`'s `createStreamRunEventSink`
 *   must, on a `run.ended` event, forward the event to the stream FIRST and
 *   only then end that stream — today it never calls `stream.end()` at all
 *   (verified by reading the module), so a watcher's `onEnd` never fires and
 *   an `openActiveStream`-style caller hangs forever. The ended stream must
 *   be RETAINED, never released (`hub.release()` must never be called) — a
 *   deliberate, documented tradeoff (see the addendum).
 * - Correction 3: `src/runs/composition.ts`'s `createRunSubsystem().drain()`
 *   must end every still-open stream on its own `eventHub` with reason
 *   `"draining"` — today `drain()` only delegates to
 *   `orchestrator.drain()` and never touches `eventHub` at all.
 *
 * Both are RED for a behavioral reason (the observed side effect never
 * happens), not an import-resolution failure — every module under test here
 * already exists on this branch.
 */
import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createRunSubsystem } from "../src/runs/composition.js";
import type { M3LRunEvent } from "../src/runs/events.js";
import { createStreamRunEventSink } from "../src/runs/stream-events.js";
import type { M3LRunOrchestratorConfig } from "../src/runs/orchestrator.js";
import type { M3LRunRegistry } from "../src/runs/registry.js";
import { createEventStreamHub } from "../src/stream/event-stream.js";
import type { M3LStreamEndReason } from "../src/stream/event-stream.js";

const RUN_STARTED: M3LRunEvent = {
  event: "run.started",
  runId: "run-1",
  atMs: 1_000,
};

const RUN_ENDED: M3LRunEvent = {
  event: "run.ended",
  runId: "run-1",
  outcome: "success",
  exitCode: 0,
};

describe("createStreamRunEventSink — run.ended ends the stream (Correction 2)", () => {
  test("forwards the run.ended event to a live subscriber BEFORE onEnd fires, then marks the stream ended", () => {
    const hub = createEventStreamHub<M3LRunEvent>({ bufferSize: 10 });
    const stream = hub.open("run-1");
    const sink = createStreamRunEventSink(hub);
    const order: string[] = [];

    stream.subscribe({
      onEvent: (event) => order.push(`event:${event.payload.event}`),
      onEnd: (reason) => order.push(`end:${reason}`),
      onGap: () => {},
    });

    sink.publish(RUN_STARTED);
    sink.publish(RUN_ENDED);

    // The terminal event must be observed before the stream is reported
    // ended — ending first would drop it entirely for a live watcher.
    expect(order).toEqual([
      "event:run.started",
      "event:run.ended",
      "end:completed",
    ]);
    expect(stream.ended).toBe(true);
  });

  test("is a silent no-op when no stream is open for the ended run's id — never throws", () => {
    const hub = createEventStreamHub<M3LRunEvent>({ bufferSize: 10 });
    const sink = createStreamRunEventSink(hub);

    expect(() => {
      sink.publish(RUN_ENDED);
    }).not.toThrow();
    expect(hub.openCount).toBe(0);
  });
});

describe("createStreamRunEventSink — an ended stream is retained, never released", () => {
  test("hub.get(id) still returns the stream after run.ended, and a late watcher replays the tail then gets onEnd synchronously", () => {
    const hub = createEventStreamHub<M3LRunEvent>({ bufferSize: 10 });
    hub.open("run-1");
    const sink = createStreamRunEventSink(hub);

    sink.publish(RUN_STARTED);
    sink.publish(RUN_ENDED);

    // Retained: a completed run's stream is deliberately kept, not
    // `hub.release()`d, so a watcher arriving after completion can still
    // read the full tail (see the addendum's documented retention tradeoff).
    const stream = hub.get("run-1");
    expect(stream).toBeDefined();

    const lateEvents: M3LRunEvent[] = [];
    let lateEndReason: M3LStreamEndReason | undefined;
    stream?.subscribe({
      onEvent: (event) => lateEvents.push(event.payload),
      onEnd: (reason) => {
        lateEndReason = reason;
      },
      onGap: () => {},
      lastEventId: 0,
    });

    expect(lateEvents).toEqual([RUN_STARTED, RUN_ENDED]);
    // `M3LEventStream.subscribe`'s own documented contract: subscribing to
    // an already-ended stream delivers the retained tail, THEN fires
    // `onEnd` synchronously, inside the same `subscribe()` call.
    expect(lateEndReason).toBe("completed");
  });
});

/** Builds a minimal, fully-valid {@link M3LRunOrchestratorConfig} fixture. */
function buildConfig(): M3LRunOrchestratorConfig {
  return {
    scriptsDir: "/scripts",
    maxPerScript: 4,
    queueCapacity: 16,
    streamRetention: 256,
    killTimeoutMs: 5_000,
    maxConcurrency: 4,
    queueTimeoutMs: 30_000,
  };
}

/**
 * A bare {@link M3LRunRegistry} stub: every method is a safe no-op. None of
 * this suite's tests ever launch a run through the orchestrator, so nothing
 * here is ever actually called — it exists solely to satisfy
 * `createRunSubsystem`'s constructor.
 */
function buildEmptyRegistry(): M3LRunRegistry {
  return {
    insertQueued: () => undefined,
    claimForStart: () => false,
    finish: () => false,
    get: () => undefined,
    list: () => [],
    countRunningForScript: () => 0,
    reconcileOrphaned: () => 0,
    abandonQueued: () => false,
  };
}

describe("createRunSubsystem — drain() ends open run streams (Correction 3)", () => {
  test("ends every stream still open on the subsystem's own eventHub with reason 'draining'", async () => {
    const subsystem = createRunSubsystem({
      config: buildConfig(),
      logger: new Core.M3LLogger([]),
      registry: buildEmptyRegistry(),
    });

    // Simulates an SSE watcher already attached to a still-active run —
    // `http/routes/run-stream.ts` is the real caller of `eventHub.open()` in
    // production, but this suite must not import `http/` (zone rules), so it
    // drives the hub directly, which is exactly what `drain()` must react to
    // regardless of who opened the stream.
    const stream = subsystem.eventHub.open("run-x");
    let receivedReason: M3LStreamEndReason | undefined;
    stream.subscribe({
      onEvent: () => undefined,
      onEnd: (reason) => {
        receivedReason = reason;
      },
      onGap: () => undefined,
    });

    await subsystem.drain();

    expect(receivedReason).toBe("draining");
    expect(stream.ended).toBe(true);
  });

  test("drain() still resolves cleanly when no stream is open at all", async () => {
    const subsystem = createRunSubsystem({
      config: buildConfig(),
      logger: new Core.M3LLogger([]),
      registry: buildEmptyRegistry(),
    });

    await expect(subsystem.drain()).resolves.toBeUndefined();
    expect(subsystem.eventHub.openCount).toBe(0);
  });
});

// Regression coverage for the SIGTERM-with-a-watcher-attached failure
// (X4 slice 7a acceptance-step-5): `lifecycle/shutdown.ts`'s
// `runShutdownSequence` called `runtime.drain.drain()` — which aborts every
// in-flight request signal SYNCHRONOUSLY — before the run subsystem ever
// reached `eventHub.endAll("draining")` via the (asynchronous)
// `orchestrator.drain()` path above. `endStreams()` is the new SYNCHRONOUS
// seam that lets `runShutdownSequence` end every stream BEFORE starting the
// HTTP drain, so a watcher learns the server is draining immediately rather
// than being severed with no explanation.
describe("createRunSubsystem — endStreams() (the new synchronous drain seam)", () => {
  test("ends every open stream synchronously with reason 'draining'; a subscriber's onEnd receives exactly that", () => {
    const subsystem = createRunSubsystem({
      config: buildConfig(),
      logger: new Core.M3LLogger([]),
      registry: buildEmptyRegistry(),
    });

    const stream = subsystem.eventHub.open("run-x");
    let receivedReason: M3LStreamEndReason | undefined;
    stream.subscribe({
      onEvent: () => undefined,
      onEnd: (reason) => {
        receivedReason = reason;
      },
      onGap: () => undefined,
    });

    subsystem.endStreams();

    expect(receivedReason).toBe("draining");
    expect(stream.ended).toBe(true);
  });

  test("is safe to call twice, and safe when followed by drain() — no subscriber sees a second onEnd", async () => {
    const subsystem = createRunSubsystem({
      config: buildConfig(),
      logger: new Core.M3LLogger([]),
      registry: buildEmptyRegistry(),
    });

    const stream = subsystem.eventHub.open("run-x");
    let endCallCount = 0;
    let lastReason: M3LStreamEndReason | undefined;
    stream.subscribe({
      onEvent: () => undefined,
      onEnd: (reason) => {
        endCallCount += 1;
        lastReason = reason;
      },
      onGap: () => undefined,
    });

    subsystem.endStreams();
    expect(() => {
      subsystem.endStreams();
    }).not.toThrow();

    // `EventStreamImpl.end` early-returns once already ended, so a second
    // `endStreams()` call — and the `drain()` call below, which also ends
    // whatever is still open on `eventHub` — must not double-fire `onEnd`.
    await expect(subsystem.drain()).resolves.toBeUndefined();

    expect(endCallCount).toBe(1);
    expect(lastReason).toBe("draining");
  });
});
