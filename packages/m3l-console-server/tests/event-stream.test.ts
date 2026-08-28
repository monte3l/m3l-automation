/**
 * Tests for `src/stream/event-stream.ts` — the generic, transport-agnostic
 * event fan-out leaf backing X4 live run streaming (#552).
 *
 * `stream/` may import only `@m3l-automation/m3l-common`, `node:` builtins,
 * and `../errors/` — this file therefore never imports `runs/` or `http/`,
 * and every fixture is deliberately generic over `TPayload` (see the
 * `expectTypeOf` block at the bottom) so nothing here accidentally pins the
 * module to a run-specific shape.
 *
 * No real I/O, no real timers: `M3LEventStream`/`M3LEventStreamHub` are pure
 * in-memory data structures, so nothing needs mocking and there is no
 * `afterEach` teardown.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  createEventStreamHub,
  type M3LEventStream,
  type M3LStreamEndReason,
  type M3LStreamEvent,
  type M3LStreamListener,
  type M3LStreamSubscription,
  type M3LSubscribeOptions,
} from "../src/stream/event-stream.js";

/** Runs `run`, capturing whatever it throws synchronously as a single `unknown` value. */
function captureFailure(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Convenience: a hub of `bufferSize` opened at a single stream id, typed at `string` payloads. */
function openStringStream(bufferSize: number): M3LEventStream<string> {
  const hub = createEventStreamHub<string>({ bufferSize });
  return hub.open("run-1");
}

describe("publish — id sequencing", () => {
  test("the first publish returns id 1", () => {
    const stream = openStringStream(10);

    const event = stream.publish("a");

    expect(event.id).toBe(1);
  });

  test("ids increase by 1 and never repeat across successive publishes", () => {
    const stream = openStringStream(10);

    const ids = [
      stream.publish("a").id,
      stream.publish("b").id,
      stream.publish("c").id,
    ];

    expect(ids).toEqual([1, 2, 3]);
  });
});

describe("the ring buffer", () => {
  test("retains at most bufferSize events and reports the highest and oldest retained id after eviction", () => {
    const stream = openStringStream(3);

    for (const payload of ["a", "b", "c", "d", "e"]) {
      stream.publish(payload);
    }

    expect(stream.retained).toBe(3);
    expect(stream.lastEventId).toBe(5);
    expect(stream.oldestRetainedId).toBe(3);
  });

  test("eviction does not renumber retained events", () => {
    const stream = openStringStream(3);
    const published = ["a", "b", "c", "d", "e"].map((payload) =>
      stream.publish(payload),
    );

    // The last 3 published events (ids 3, 4, 5) are the ones still retained;
    // their ids must be unchanged by the eviction of ids 1 and 2.
    const retainedIds = published.slice(2).map((event) => event.id);
    expect(retainedIds).toEqual([3, 4, 5]);
  });

  test("a fresh stream reports lastEventId 0 and oldestRetainedId 0", () => {
    const stream = openStringStream(5);

    expect(stream.lastEventId).toBe(0);
    expect(stream.oldestRetainedId).toBe(0);
    expect(stream.retained).toBe(0);
  });
});

describe("createEventStreamHub — bufferSize validation", () => {
  test.each([
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 1.5],
    ["NaN", Number.NaN],
  ])(
    "rejects a %s bufferSize with ERR_CONSOLE_INTERNAL",
    (_label, bufferSize) => {
      const thrown = captureFailure(() =>
        createEventStreamHub<string>({ bufferSize }),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
    },
  );
});

describe("live delivery to a fresh subscriber", () => {
  test("a subscriber with no lastEventId receives only events published after it subscribed, never a replay", () => {
    const stream = openStringStream(10);
    stream.publish("before-1");
    stream.publish("before-2");

    const received: string[] = [];
    stream.subscribe({
      onEvent: (event: M3LStreamEvent<string>) => received.push(event.payload),
      onEnd: () => undefined,
      onGap: () => undefined,
    });

    stream.publish("after-1");
    stream.publish("after-2");

    expect(received).toEqual(["after-1", "after-2"]);
  });

  test("multiple subscribers all receive the same event, in subscription order", () => {
    const stream = openStringStream(10);
    const order: string[] = [];

    stream.subscribe({
      onEvent: () => order.push("first"),
      onEnd: () => undefined,
      onGap: () => undefined,
    });
    stream.subscribe({
      onEvent: () => order.push("second"),
      onEnd: () => undefined,
      onGap: () => undefined,
    });

    stream.publish("x");

    expect(order).toEqual(["first", "second"]);
  });
});

describe("resume via lastEventId", () => {
  test("resuming from a retained lastEventId replays exactly the missed ids in order, then continues live", () => {
    const stream = openStringStream(10);
    for (const payload of ["1", "2", "3", "4", "5"]) {
      stream.publish(payload);
    }

    const receivedIds: number[] = [];
    stream.subscribe({
      onEvent: (event: M3LStreamEvent<string>) => receivedIds.push(event.id),
      onEnd: () => undefined,
      onGap: () => undefined,
      lastEventId: 2,
    });
    stream.publish("6");

    expect(receivedIds).toEqual([3, 4, 5, 6]);
  });

  test("a lastEventId equal to the current lastEventId replays nothing and does not call onGap", () => {
    const stream = openStringStream(10);
    stream.publish("1");
    stream.publish("2");

    const received: number[] = [];
    let gapCalled = false;
    stream.subscribe({
      onEvent: (event: M3LStreamEvent<string>) => received.push(event.id),
      onEnd: () => undefined,
      onGap: () => {
        gapCalled = true;
      },
      lastEventId: 2,
    });

    expect(received).toEqual([]);
    expect(gapCalled).toBe(false);
  });

  test("resuming at an evicted lastEventId calls onGap with the oldest retained id, and does not replay the evicted ids", () => {
    const stream = openStringStream(3);
    for (const payload of ["1", "2", "3", "4", "5"]) {
      stream.publish(payload);
    }
    // ids 1 and 2 are now evicted; 3, 4, 5 remain retained.

    const receivedIds: number[] = [];
    const gapArgs: number[] = [];
    stream.subscribe({
      onEvent: (event: M3LStreamEvent<string>) => receivedIds.push(event.id),
      onEnd: () => undefined,
      onGap: (oldestRetainedId: number) => gapArgs.push(oldestRetainedId),
      lastEventId: 1,
    });

    expect(gapArgs).toEqual([3]);
    expect(receivedIds).not.toContain(1);
    expect(receivedIds).not.toContain(2);
  });

  test("a lastEventId ahead of the current lastEventId calls onGap rather than a negative-length replay or silent live-only fall-through", () => {
    const stream = openStringStream(10);
    for (const payload of ["1", "2", "3", "4", "5"]) {
      stream.publish(payload);
    }

    const receivedIds: number[] = [];
    const gapArgs: number[] = [];
    stream.subscribe({
      onEvent: (event: M3LStreamEvent<string>) => receivedIds.push(event.id),
      onEnd: () => undefined,
      onGap: (oldestRetainedId: number) => gapArgs.push(oldestRetainedId),
      lastEventId: 99,
    });

    expect(gapArgs).toHaveLength(1);
    expect(receivedIds).toEqual([]);
  });

  test("a lastEventId of 0 replays everything currently retained, not a gap", () => {
    const stream = openStringStream(10);
    for (const payload of ["1", "2", "3"]) {
      stream.publish(payload);
    }

    const receivedIds: number[] = [];
    let gapCalled = false;
    stream.subscribe({
      onEvent: (event: M3LStreamEvent<string>) => receivedIds.push(event.id),
      onEnd: () => undefined,
      onGap: () => {
        gapCalled = true;
      },
      lastEventId: 0,
    });

    expect(receivedIds).toEqual([1, 2, 3]);
    expect(gapCalled).toBe(false);
  });
});

describe("ending a stream", () => {
  test("end(reason) calls every live subscriber's onEnd exactly once with that reason, and flips ended to true", () => {
    const stream = openStringStream(10);
    const endedReasons: M3LStreamEndReason[] = [];
    const endedReasons2: M3LStreamEndReason[] = [];
    stream.subscribe({
      onEvent: () => undefined,
      onEnd: (reason: M3LStreamEndReason) => endedReasons.push(reason),
      onGap: () => undefined,
    });
    stream.subscribe({
      onEvent: () => undefined,
      onEnd: (reason: M3LStreamEndReason) => endedReasons2.push(reason),
      onGap: () => undefined,
    });

    stream.end("completed");

    expect(endedReasons).toEqual(["completed"]);
    expect(endedReasons2).toEqual(["completed"]);
    expect(stream.ended).toBe(true);
  });

  test("a second end() call is a no-op and does not re-fire onEnd", () => {
    const stream = openStringStream(10);
    const endedReasons: M3LStreamEndReason[] = [];
    stream.subscribe({
      onEvent: () => undefined,
      onEnd: (reason: M3LStreamEndReason) => endedReasons.push(reason),
      onGap: () => undefined,
    });

    stream.end("completed");
    stream.end("draining");

    expect(endedReasons).toEqual(["completed"]);
  });

  test("subscribing after end() still replays retained events before firing onEnd, rather than hanging", () => {
    const stream = openStringStream(10);
    stream.publish("1");
    stream.publish("2");
    stream.end("completed");

    const calls: string[] = [];
    stream.subscribe({
      onEvent: (event: M3LStreamEvent<string>) =>
        calls.push(`event:${String(event.id)}`),
      onEnd: (reason: M3LStreamEndReason) => calls.push(`end:${reason}`),
      onGap: () => calls.push("gap"),
    });

    expect(calls).toEqual(["event:1", "event:2", "end:completed"]);
  });

  test("publish after end() throws ERR_CONSOLE_STREAM_CLOSED", () => {
    const stream = openStringStream(10);
    stream.end("completed");

    const thrown = captureFailure(() => stream.publish("too-late"));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STREAM_CLOSED");
  });
});

describe("subscription lifecycle", () => {
  test("unsubscribe() stops delivery immediately", () => {
    const stream = openStringStream(10);
    const received: string[] = [];
    // Annotated with the module's own listener/options/subscription types
    // (rather than left to inference) so this double actually exercises
    // `M3LStreamListener`, `M3LSubscribeOptions`, and `M3LStreamSubscription`
    // as real contract surface, not just runtime shapes.
    const onEvent: M3LStreamListener<string> = (event) =>
      received.push(event.payload);
    const options: M3LSubscribeOptions<string> = {
      onEvent,
      onEnd: () => undefined,
      onGap: () => undefined,
    };
    const subscription: M3LStreamSubscription = stream.subscribe(options);

    stream.publish("a");
    subscription.unsubscribe();
    stream.publish("b");

    expect(received).toEqual(["a"]);
  });

  test("calling unsubscribe() twice does not throw and does not affect other subscribers", () => {
    const stream = openStringStream(10);
    const received: string[] = [];
    const subscription = stream.subscribe({
      onEvent: () => undefined,
      onEnd: () => undefined,
      onGap: () => undefined,
    });
    stream.subscribe({
      onEvent: (event: M3LStreamEvent<string>) => received.push(event.payload),
      onEnd: () => undefined,
      onGap: () => undefined,
    });

    subscription.unsubscribe();
    expect(() => {
      subscription.unsubscribe();
    }).not.toThrow();

    stream.publish("still-here");

    expect(received).toEqual(["still-here"]);
  });

  test("unsubscribing from within an onEvent callback does not disturb other subscribers of that same event", () => {
    const stream = openStringStream(10);
    const received: string[] = [];

    // `selfUnsub` is referenced inside its own `onEvent` closure; that is
    // safe because the closure only runs during a later `publish` call,
    // by which point `subscribe` has already returned and initialized it.
    const selfUnsub = stream.subscribe({
      onEvent: () => {
        received.push("first");
        selfUnsub.unsubscribe();
      },
      onEnd: () => undefined,
      onGap: () => undefined,
    });
    stream.subscribe({
      onEvent: () => received.push("second"),
      onEnd: () => undefined,
      onGap: () => undefined,
    });

    stream.publish("a");
    stream.publish("b");

    // Both subscribers see the first event ("first", "second"); the
    // self-unsubscribing one is dropped, so only "second" survives for "b".
    expect(received).toEqual(["first", "second", "second"]);
  });
});

describe("a throwing listener", () => {
  // `stream/` may import only `errors/` — it has no logger, so catching a
  // listener's throw here would mean swallowing it silently, which this
  // project forbids outright. The seam that owns a logger
  // (`http/stream-writer.ts`, a later slice) is responsible for never
  // throwing out of its own listener; this module must let the throw
  // propagate so a defect there is visible immediately.
  test("a throw from onEvent propagates out of publish, after subscribers registered before it already received the event", () => {
    const stream = openStringStream(10);
    const received: string[] = [];
    stream.subscribe({
      onEvent: () => received.push("first"),
      onEnd: () => undefined,
      onGap: () => undefined,
    });
    stream.subscribe({
      onEvent: () => {
        throw new Error("listener boom");
      },
      onEnd: () => undefined,
      onGap: () => undefined,
    });

    expect(() => stream.publish("x")).toThrow("listener boom");
    expect(received).toEqual(["first"]);
  });
});

describe("createEventStreamHub — open/get/release", () => {
  test("open returns a stream whose id is the requested id, and increments openCount", () => {
    const hub = createEventStreamHub<string>({ bufferSize: 5 });

    const stream = hub.open("run-42");

    expect(stream.id).toBe("run-42");
    expect(hub.openCount).toBe(1);
  });

  test("open on an id that is already open throws ERR_CONSOLE_STREAM_DUPLICATE", () => {
    const hub = createEventStreamHub<string>({ bufferSize: 5 });
    hub.open("run-42");

    const thrown = captureFailure(() => hub.open("run-42"));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STREAM_DUPLICATE",
    );
  });

  test("get returns undefined for an id that was never opened", () => {
    const hub = createEventStreamHub<string>({ bufferSize: 5 });

    expect(hub.get("never-opened")).toBeUndefined();
  });

  test("release drops a stream: get returns undefined afterward and openCount decrements", () => {
    const hub = createEventStreamHub<string>({ bufferSize: 5 });
    hub.open("run-42");

    hub.release("run-42");

    expect(hub.get("run-42")).toBeUndefined();
    expect(hub.openCount).toBe(0);
  });
});

describe("createEventStreamHub — endAll", () => {
  test("endAll(reason) ends every open stream with that reason", () => {
    const hub = createEventStreamHub<string>({ bufferSize: 5 });
    const streamA = hub.open("run-a");
    const streamB = hub.open("run-b");
    const endedA: M3LStreamEndReason[] = [];
    const endedB: M3LStreamEndReason[] = [];
    streamA.subscribe({
      onEvent: () => undefined,
      onEnd: (reason: M3LStreamEndReason) => endedA.push(reason),
      onGap: () => undefined,
    });
    streamB.subscribe({
      onEvent: () => undefined,
      onEnd: (reason: M3LStreamEndReason) => endedB.push(reason),
      onGap: () => undefined,
    });

    hub.endAll("draining");

    expect(endedA).toEqual(["draining"]);
    expect(endedB).toEqual(["draining"]);
    expect(streamA.ended).toBe(true);
    expect(streamB.ended).toBe(true);
  });
});

describe("generics — the hub and stream track TPayload, not a fixed shape", () => {
  interface RunStatusPayload {
    readonly status: "running" | "completed";
  }

  test("a hub instantiated at a payload type only ever delivers that type's values", () => {
    const numberHub = createEventStreamHub<number>({ bufferSize: 5 });
    const numberStream = numberHub.open("numbers");
    const received: number[] = [];
    numberStream.subscribe({
      onEvent: (event: M3LStreamEvent<number>) => received.push(event.payload),
      onEnd: () => undefined,
      onGap: () => undefined,
    });
    numberStream.publish(42);

    const recordHub = createEventStreamHub<RunStatusPayload>({
      bufferSize: 5,
    });
    const recordStream = recordHub.open("statuses");
    const receivedStatuses: RunStatusPayload[] = [];
    recordStream.subscribe({
      onEvent: (event: M3LStreamEvent<RunStatusPayload>) =>
        receivedStatuses.push(event.payload),
      onEnd: () => undefined,
      onGap: () => undefined,
    });
    recordStream.publish({ status: "running" });

    expect(received).toEqual([42]);
    expect(receivedStatuses).toEqual([{ status: "running" }]);
  });

  test("publish's argument and M3LStreamEvent.payload track TPayload at the type level", () => {
    const numberHub = createEventStreamHub<number>({ bufferSize: 5 });
    const numberStream = numberHub.open("numbers");

    // `typeof numberStream.publish` (a type reference) rather than the value
    // `numberStream.publish` itself, so this stays a pure type-level check —
    // passing the unbound method as a runtime value would trip
    // `@typescript-eslint/unbound-method` for no behavioral gain here.
    expectTypeOf<typeof numberStream.publish>()
      .parameter(0)
      .toMatchTypeOf<number>();
    expectTypeOf(numberStream.publish(1)).toMatchTypeOf<
      M3LStreamEvent<number>
    >();

    // `subscribe`'s options parameter and its returned subscription must
    // themselves track `TPayload` — this is what stops a caller from
    // subscribing to a `number`-payload stream with a listener built for
    // some other payload shape.
    expectTypeOf<typeof numberStream.subscribe>()
      .parameter(0)
      .toMatchTypeOf<M3LSubscribeOptions<number>>();
    expectTypeOf<
      typeof numberStream.subscribe
    >().returns.toEqualTypeOf<M3LStreamSubscription>();

    const recordHub = createEventStreamHub<RunStatusPayload>({
      bufferSize: 5,
    });
    const recordStream = recordHub.open("statuses");

    expectTypeOf<typeof recordStream.publish>()
      .parameter(0)
      .toMatchTypeOf<RunStatusPayload>();
    expectTypeOf(recordStream.publish({ status: "running" })).toMatchTypeOf<
      M3LStreamEvent<RunStatusPayload>
    >();
  });
});
