import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import {
  M3LEventEmitter,
  M3LEventEmitterBase,
  type M3LEventHandler,
} from "../src/core/events/index.js";

// ---------------------------------------------------------------------------
// Test-subclass — thin wrapper that promotes protected methods for testing.
// M3LEventEmitterBase is abstract and emit/emitAsync are protected, so
// direct instantiation and direct calls from outside the class are not
// possible. This subclass is local to the test file and not exported.
// ---------------------------------------------------------------------------
interface TestEvents {
  ping: { id: string };
  tick: number;
}

class TestEmitter extends M3LEventEmitterBase<TestEvents> {
  fire<TEvent extends keyof TestEvents>(
    event: TEvent,
    payload: TestEvents[TEvent],
  ): void {
    this.emit(event, payload);
  }

  async fireAsync<TEvent extends keyof TestEvents>(
    event: TEvent,
    payload: TestEvents[TEvent],
  ): Promise<void> {
    await this.emitAsync(event, payload);
  }
}

// ---------------------------------------------------------------------------
// M3LEventHandler type
// ---------------------------------------------------------------------------
describe("M3LEventHandler type", () => {
  test("is a function from payload to void | Promise<void>", () => {
    expectTypeOf<M3LEventHandler<{ id: string }>>().toEqualTypeOf<
      (payload: { id: string }) => void | Promise<void>
    >();
  });

  test("is a function from a primitive payload to void | Promise<void>", () => {
    expectTypeOf<M3LEventHandler<number>>().toEqualTypeOf<
      (payload: number) => void | Promise<void>
    >();
  });
});

// ---------------------------------------------------------------------------
// M3LEventEmitterBase — on / off
// ---------------------------------------------------------------------------
describe("M3LEventEmitterBase — on / off", () => {
  test("registered handler receives the emitted payload", () => {
    const emitter = new TestEmitter();
    const received: Array<{ id: string }> = [];

    emitter.on("ping", (p) => {
      received.push(p);
    });
    emitter.fire("ping", { id: "a" });

    expect(received).toEqual([{ id: "a" }]);
  });

  test("handler receives the correct primitive payload", () => {
    const emitter = new TestEmitter();
    const received: number[] = [];

    emitter.on("tick", (n) => {
      received.push(n);
    });
    emitter.fire("tick", 42);

    expect(received).toEqual([42]);
  });

  test("multiple handlers for the same event all receive the payload", () => {
    const emitter = new TestEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on("ping", h1);
    emitter.on("ping", h2);
    emitter.fire("ping", { id: "multi" });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
    expect(h1).toHaveBeenCalledWith({ id: "multi" });
    expect(h2).toHaveBeenCalledWith({ id: "multi" });
  });

  test("handlers are called in registration order", () => {
    const emitter = new TestEmitter();
    const order: number[] = [];

    emitter.on("tick", () => {
      order.push(1);
    });
    emitter.on("tick", () => {
      order.push(2);
    });
    emitter.on("tick", () => {
      order.push(3);
    });
    emitter.fire("tick", 0);

    expect(order).toEqual([1, 2, 3]);
  });

  test("registering the same handler reference twice is a no-op (set semantics)", () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();

    emitter.on("ping", handler);
    emitter.on("ping", handler); // duplicate — ignored
    emitter.fire("ping", { id: "c" });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("off removes the handler — no further invocations", () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();

    emitter.on("ping", handler);
    emitter.off("ping", handler);
    emitter.fire("ping", { id: "b" });

    expect(handler).not.toHaveBeenCalled();
  });

  test("off only removes the specified handler, not all handlers for the event", () => {
    const emitter = new TestEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on("ping", h1);
    emitter.on("ping", h2);
    emitter.off("ping", h1);
    emitter.fire("ping", { id: "selective" });

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  test("removing a handler that was never registered is a no-op (no throw)", () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();

    expect(() => emitter.off("ping", handler)).not.toThrow();
  });

  test("removing a handler for an event with no listeners is a no-op (no throw)", () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();

    // No handlers at all registered yet
    expect(() => emitter.off("tick", handler)).not.toThrow();
  });

  test("emitting an event with no registered handlers is a no-op (no throw)", () => {
    const emitter = new TestEmitter();

    expect(() => emitter.fire("ping", { id: "silent" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// M3LEventEmitterBase — emit (sync) error isolation
// ---------------------------------------------------------------------------
describe("M3LEventEmitterBase — emit error isolation", () => {
  test("a throwing handler does not prevent subsequent handlers from running", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const emitter = new TestEmitter();
    const log: string[] = [];

    emitter.on("tick", () => {
      throw new Error("boom");
    });
    emitter.on("tick", () => {
      log.push("ran");
    });

    // Must not propagate the error to the caller
    expect(() => emitter.fire("tick", 1)).not.toThrow();
    // Second handler must have executed despite the first failing
    expect(log).toEqual(["ran"]);
  });

  test("emit swallows errors from multiple failing handlers, still calls remaining", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const emitter = new TestEmitter();
    const log: string[] = [];

    emitter.on("tick", () => {
      throw new Error("fail 1");
    });
    emitter.on("tick", () => {
      log.push("middle");
    });
    emitter.on("tick", () => {
      throw new Error("fail 2");
    });
    emitter.on("tick", () => {
      log.push("last");
    });

    expect(() => emitter.fire("tick", 99)).not.toThrow();
    expect(log).toEqual(["middle", "last"]);
  });

  test("async handler promises are discarded — emit does not await them", async () => {
    const emitter = new TestEmitter();
    const settled: boolean[] = [];

    // This async handler resolves after a microtask tick
    emitter.on("tick", async () => {
      await Promise.resolve();
      settled.push(true);
    });

    // fire completes synchronously; at this point the promise has not settled
    emitter.fire("tick", 0);

    // settled is still empty because emit did not await the async handler
    expect(settled).toHaveLength(0);

    // After flushing the microtask queue the handler has completed, but that
    // is invisible to the caller of emit — it never resolves to them.
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// M3LEventEmitterBase — emitAsync
// ---------------------------------------------------------------------------
describe("M3LEventEmitterBase — emitAsync", () => {
  test("awaits all handlers — async handlers complete before emitAsync resolves", async () => {
    const emitter = new TestEmitter();
    const order: number[] = [];

    emitter.on("tick", async () => {
      await Promise.resolve(); // yield one microtask tick
      order.push(1);
    });
    emitter.on("tick", () => {
      order.push(2);
    });

    await emitter.fireAsync("tick", 42);

    expect(order).toHaveLength(2);
  });

  test("emitAsync resolves to undefined when all handlers succeed", async () => {
    const emitter = new TestEmitter();
    emitter.on("ping", vi.fn());

    await expect(
      emitter.fireAsync("ping", { id: "ok" }),
    ).resolves.toBeUndefined();
  });

  test("a rejecting async handler does not prevent other handlers from running", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const emitter = new TestEmitter();
    const log: string[] = [];

    emitter.on("tick", () => Promise.reject(new Error("async boom")));
    emitter.on("tick", () => {
      log.push("ran");
    });

    // emitAsync resolves (does not reject) despite the failing handler
    await expect(emitter.fireAsync("tick", 1)).resolves.toBeUndefined();
    expect(log).toEqual(["ran"]);
  });

  test("emitAsync resolves even when all handlers reject", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const emitter = new TestEmitter();

    emitter.on("tick", () => Promise.reject(new Error("all fail 1")));
    emitter.on("tick", () => Promise.reject(new Error("all fail 2")));

    // Must resolve, not reject — Promise.allSettled semantics
    await expect(emitter.fireAsync("tick", 0)).resolves.toBeUndefined();
  });

  test("emitAsync with no registered handlers resolves immediately to undefined", async () => {
    const emitter = new TestEmitter();

    await expect(
      emitter.fireAsync("ping", { id: "nobody" }),
    ).resolves.toBeUndefined();
  });

  test("a sync-throwing handler inside emitAsync does not prevent others from running", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const emitter = new TestEmitter();
    const log: string[] = [];

    emitter.on("tick", () => {
      throw new Error("sync inside async path");
    });
    emitter.on("tick", () => {
      log.push("async ran");
    });

    await expect(emitter.fireAsync("tick", 5)).resolves.toBeUndefined();
    expect(log).toEqual(["async ran"]);
  });
});

// ---------------------------------------------------------------------------
// M3LEventEmitter — concrete class (public emit / emitAsync)
// ---------------------------------------------------------------------------
describe("M3LEventEmitter — concrete emitter with public emit", () => {
  test("can be instantiated directly without subclassing", () => {
    expect(() => new M3LEventEmitter<TestEvents>()).not.toThrow();
  });

  test("emit is callable on an M3LEventEmitter instance (public, not protected)", () => {
    const emitter = new M3LEventEmitter<TestEvents>();
    const handler = vi.fn();

    emitter.on("ping", handler);
    emitter.emit("ping", { id: "direct" });

    expect(handler).toHaveBeenCalledWith({ id: "direct" });
  });

  test("emitAsync is callable on an M3LEventEmitter instance (public, not protected)", async () => {
    const emitter = new M3LEventEmitter<TestEvents>();
    const handler = vi.fn().mockResolvedValue(undefined);

    emitter.on("tick", handler);
    await emitter.emitAsync("tick", 7);

    expect(handler).toHaveBeenCalledWith(7);
  });

  test("M3LEventEmitter inherits on/off/handler-isolation from the base", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const emitter = new M3LEventEmitter<TestEvents>();
    const log: string[] = [];

    emitter.on("tick", () => {
      throw new Error("concrete boom");
    });
    emitter.on("tick", () => {
      log.push("concrete ran");
    });

    expect(() => emitter.emit("tick", 3)).not.toThrow();
    expect(log).toEqual(["concrete ran"]);
  });

  test("set semantics hold on M3LEventEmitter — same handler registered twice fires once", () => {
    const emitter = new M3LEventEmitter<TestEvents>();
    const handler = vi.fn();

    emitter.on("ping", handler);
    emitter.on("ping", handler);
    emitter.emit("ping", { id: "dedup" });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Type-level tests
// ---------------------------------------------------------------------------
describe("M3LEventEmitter type-level", () => {
  test("M3LEventEmitter is assignable to M3LEventEmitterBase (extends it)", () => {
    expectTypeOf<M3LEventEmitter<{ x: number }>>().toMatchTypeOf<
      M3LEventEmitterBase<{ x: number }>
    >();
  });

  test("emit is public on M3LEventEmitter — property access is not a compile error", () => {
    // If emit were protected this indexed-access type would be a compile error.
    type EmitFn = M3LEventEmitter<{ x: number }>["emit"];
    expectTypeOf<EmitFn>().toBeFunction();
  });

  test("emitAsync is public on M3LEventEmitter", () => {
    type EmitAsyncFn = M3LEventEmitter<{ x: number }>["emitAsync"];
    expectTypeOf<EmitAsyncFn>().toBeFunction();
  });
});

// ---------------------------------------------------------------------------
// Compile-time enforcement (ts-expect-error)
// ---------------------------------------------------------------------------
describe("M3LEventEmitterBase compile-time enforcement", () => {
  test("on rejects an event name not in the event map", () => {
    const emitter = new TestEmitter();
    // @ts-expect-error — 'unknown-event' is not a key of TestEvents
    emitter.on("unknown-event", () => {});
  });

  test("off rejects an event name not in the event map", () => {
    const emitter = new TestEmitter();
    // @ts-expect-error — 'missing-event' is not a key of TestEvents
    emitter.off("missing-event", () => {});
  });

  test("on rejects a handler with the wrong payload type", () => {
    const emitter = new TestEmitter();
    // @ts-expect-error — handler receives number but 'ping' payload is { id: string }
    emitter.on("ping", (_p: number) => {});
  });

  test("on rejects a handler with the wrong object shape", () => {
    const emitter = new TestEmitter();
    // @ts-expect-error — handler receives { id: number } but 'ping' payload is { id: string }
    emitter.on("ping", (_p: { id: number }) => {});
  });
});

// ---------------------------------------------------------------------------
// M3LEventEmitterBase — best-effort stderr diagnostics on handler failure
// (WS-7 / SF-1: a throwing/rejecting handler must leave a trace instead of
// vanishing silently, without ever leaking the event payload.)
// ---------------------------------------------------------------------------
describe("M3LEventEmitterBase — handler-failure diagnostics", () => {
  test("emit: a throwing handler surfaces a stderr diagnostic naming the event and error, without throwing", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const emitter = new TestEmitter();
    const log: string[] = [];

    emitter.on("tick", () => {
      throw new Error("boom");
    });
    emitter.on("tick", () => {
      log.push("ran");
    });

    expect(() => emitter.fire("tick", 1)).not.toThrow();

    // The good handler still ran despite the first handler throwing.
    expect(log).toEqual(["ran"]);

    // A diagnostic was written to stderr naming the event and the error detail.
    const diagnostics = writeSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (chunk): chunk is string =>
          typeof chunk === "string" && chunk.includes("tick"),
      );
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((chunk) => chunk.includes("boom"))).toBe(true);
  });

  test("emit: the stderr diagnostic never contains the event payload (only event name + error detail)", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const emitter = new TestEmitter();
    const secret = "sk-super-secret-token-value";

    emitter.on("ping", () => {
      // The thrown error's message intentionally does not contain the payload.
      throw new Error("handler failed");
    });

    expect(() => emitter.fire("ping", { id: secret })).not.toThrow();

    const allWrites = writeSpy.mock.calls
      .map((call) => call[0])
      .filter((chunk): chunk is string => typeof chunk === "string")
      .join("\n");

    expect(allWrites).not.toContain(secret);
    expect(allWrites).toContain("ping");
    expect(allWrites).toContain("handler failed");
  });

  test("emitAsync: a rejecting handler surfaces a stderr diagnostic naming the event and rejection reason, and emitAsync still resolves", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const emitter = new TestEmitter();
    const log: string[] = [];

    emitter.on("tick", () => Promise.reject(new Error("async boom")));
    emitter.on("tick", async () => {
      await Promise.resolve();
      log.push("ran");
    });

    await expect(emitter.fireAsync("tick", 1)).resolves.toBeUndefined();

    expect(log).toEqual(["ran"]);

    const diagnostics = writeSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (chunk): chunk is string =>
          typeof chunk === "string" && chunk.includes("tick"),
      );
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((chunk) => chunk.includes("async boom"))).toBe(
      true,
    );
  });

  test("emit: never throws even if process.stderr.write itself throws", () => {
    vi.spyOn(process.stderr, "write").mockImplementationOnce(() => {
      throw new Error("stderr unavailable");
    });
    const emitter = new TestEmitter();

    emitter.on("ping", () => {
      throw new Error("handler boom");
    });

    expect(() => emitter.fire("ping", { id: "resilient" })).not.toThrow();
  });

  test("emit: a handler throwing a non-Error value surfaces its String() conversion in the stderr diagnostic", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const emitter = new TestEmitter();

    emitter.on("tick", () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to exercise the String(cause) diagnostic branch
      throw "plain string boom";
    });

    expect(() => emitter.fire("tick", 1)).not.toThrow();

    const allWrites = writeSpy.mock.calls
      .map((call) => call[0])
      .filter((chunk): chunk is string => typeof chunk === "string")
      .join("\n");

    expect(allWrites).toContain("tick");
    expect(allWrites).toContain("plain string boom");
  });

  test("emit: a thrown Error without a .stack falls back to its .message in the stderr diagnostic", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const emitter = new TestEmitter();

    emitter.on("ping", () => {
      const error = new Error("no stack here");
      delete error.stack;
      throw error;
    });

    expect(() => emitter.fire("ping", { id: "no-stack" })).not.toThrow();

    const allWrites = writeSpy.mock.calls
      .map((call) => call[0])
      .filter((chunk): chunk is string => typeof chunk === "string")
      .join("\n");

    expect(allWrites).toContain("ping");
    expect(allWrites).toContain("no stack here");
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
afterEach(() => {
  vi.restoreAllMocks();
});
