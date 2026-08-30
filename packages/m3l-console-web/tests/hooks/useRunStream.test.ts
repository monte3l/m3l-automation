import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { encodePathSegment } from "../../src/internal/path-segment.js";
import type { M3LRunStreamState } from "../../src/hooks/useRunStream.js";
import { MAX_TAIL_LINES, useRunStream } from "../../src/hooks/useRunStream.js";

/**
 * jsdom does not implement `EventSource` (verified in the X10d contract:
 * `typeof globalThis.EventSource` is `undefined` under this project's
 * config) — the hook's contract makes the constructor an injectable
 * option for exactly this reason, so every test below supplies this fake
 * instead of relying on a real network connection.
 *
 * Only the surface `useRunStream` actually touches is implemented:
 * `addEventListener`/`removeEventListener`/`close`, plus a couple of
 * inert instance properties a real `EventSource` carries. A `Partial`-ish
 * stand-in is enough — the hook never inspects `readyState` etc.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  /** Mirrors the real `EventSource.readyState` constants of the same name. */
  static readonly readyStateConnecting = 0;
  static readonly readyStateOpen = 1;
  static readonly readyStateClosed = 2;

  readonly url: string;
  closed = false;
  /**
   * Settable by tests to simulate the browser's native `EventSource`
   * reconnect cycle: it flips to `readyStateConnecting` (not
   * `readyStateClosed`) while auto-reconnecting after a transient drop, and
   * only `readyStateClosed` means the connection is truly dead. Defaults to
   * `readyStateOpen` since most tests never touch it.
   */
  readyState: number = FakeEventSource.readyStateOpen;

  private readonly listeners = new Map<
    string,
    Set<(event: MessageEvent) => void>
  >();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener as (event: MessageEvent) => void);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener as (event: MessageEvent) => void);
  }

  close(): void {
    this.closed = true;
  }

  /** Test-only helper: dispatches a named SSE event to registered listeners. */
  emit(type: string, data: unknown): void {
    const serialized = typeof data === "string" ? data : JSON.stringify(data);
    const event = new MessageEvent(type, { data: serialized });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function latestInstance(): FakeEventSource {
  const instance =
    FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!instance) {
    throw new Error("expected a FakeEventSource instance to exist");
  }
  return instance;
}

function renderStream(
  runId: string,
  onResync: () => void = vi.fn(),
): ReturnType<typeof renderHook<M3LRunStreamState, unknown>> {
  return renderHook(() =>
    useRunStream(runId, {
      // Cast: the fake only implements the slice of EventSource the hook
      // actually uses (see the class's own doc comment above).
      eventSource: FakeEventSource as unknown as typeof EventSource,
      onResync,
    }),
  );
}

afterEach(() => {
  FakeEventSource.instances = [];
  vi.restoreAllMocks();
});

describe("useRunStream", () => {
  test("opens the stream at /api/v1/runs/:id/stream with the id encoded via encodePathSegment", () => {
    renderStream("0193f0c2-1234-7abc-9def-000000000000");

    expect(latestInstance().url).toBe(
      `/api/v1/runs/${encodePathSegment("0193f0c2-1234-7abc-9def-000000000000")}/stream`,
    );
  });

  test("encodes a '..' runId so the stream path cannot resolve up a level", () => {
    renderStream("..");

    const resolved = new URL(latestInstance().url, "http://localhost");
    expect(resolved.pathname.startsWith("/api/v1/runs/")).toBe(true);
  });

  test("accumulates run.line events into state.lines in order", () => {
    const { result } = renderStream("run-1");

    act(() => {
      latestInstance().emit("run.line", {
        event: "run.line",
        runId: "run-1",
        line: "first line",
      });
      latestInstance().emit("run.line", {
        event: "run.line",
        runId: "run-1",
        line: "second line",
      });
    });

    expect(result.current.lines).toEqual(["first line", "second line"]);
  });

  test("drops the oldest line once MAX_TAIL_LINES is exceeded", () => {
    const { result } = renderStream("run-1");

    act(() => {
      for (let index = 0; index < MAX_TAIL_LINES + 1; index += 1) {
        latestInstance().emit("run.line", {
          event: "run.line",
          runId: "run-1",
          line: `line-${index}`,
        });
      }
    });

    expect(result.current.lines).toHaveLength(MAX_TAIL_LINES);
    expect(result.current.lines[0]).toBe("line-1");
    expect(result.current.lines.at(-1)).toBe(`line-${MAX_TAIL_LINES}`);
  });

  test("stream.gap increments gapCount and invokes onResync for the oldestRetainedId payload shape, without reading any field off it", () => {
    const onResync = vi.fn();
    const { result } = renderStream("run-1", onResync);

    act(() => {
      latestInstance().emit("stream.gap", { oldestRetainedId: 3 });
    });

    expect(result.current.gapCount).toBe(1);
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  test("stream.gap increments gapCount and invokes onResync for the lastEventId payload shape, without reading any field off it", () => {
    // This is the key regression: console.md documents only the
    // `oldestRetainedId` shape, but the backpressure gap emits
    // `{ lastEventId }` instead (stream-writer.ts:340). A client that reads
    // a field off the payload to decide what to do would silently no-op on
    // this shape; the contract is that a gap means exactly one thing
    // (re-fetch authoritative state) regardless of payload shape.
    const onResync = vi.fn();
    const { result } = renderStream("run-1", onResync);

    act(() => {
      latestInstance().emit("stream.gap", { lastEventId: 3 });
    });

    expect(result.current.gapCount).toBe(1);
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  test("stream.gap accumulates across repeated gaps", () => {
    const onResync = vi.fn();
    const { result } = renderStream("run-1", onResync);

    act(() => {
      latestInstance().emit("stream.gap", { oldestRetainedId: 1 });
      latestInstance().emit("stream.gap", { lastEventId: 2 });
    });

    expect(result.current.gapCount).toBe(2);
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  test("stream.end sets phase to ended, records the reason, and closes the source", () => {
    const { result } = renderStream("run-1");

    act(() => {
      latestInstance().emit("stream.end", { reason: "completed" });
    });

    expect(result.current.phase).toBe("ended");
    expect(result.current.endReason).toBe("completed");
    expect(latestInstance().closed).toBe(true);
  });

  test("run.ended alone does not close the source or end the phase — only stream.end does", () => {
    const { result } = renderStream("run-1");

    act(() => {
      latestInstance().emit("run.ended", {
        event: "run.ended",
        runId: "run-1",
        outcome: "success",
        exitCode: 0,
      });
    });

    expect(result.current.phase).not.toBe("ended");
    expect(latestInstance().closed).toBe(false);
  });

  test("ignores a malformed JSON data payload rather than throwing", () => {
    const { result } = renderStream("run-1");

    expect(() => {
      act(() => {
        latestInstance().emit("run.line", "{not valid json");
      });
    }).not.toThrow();

    expect(result.current.lines).toEqual([]);
  });

  test("closes the source on unmount", () => {
    const { unmount } = renderStream("run-1");
    const instance = latestInstance();

    unmount();

    expect(instance.closed).toBe(true);
  });

  test("degrades to a terminal 'unavailable' phase rather than throwing when no EventSource is available", () => {
    const originalEventSource = (
      globalThis as { EventSource?: typeof EventSource }
    ).EventSource;
    delete (globalThis as { EventSource?: typeof EventSource }).EventSource;

    let result: { current: M3LRunStreamState } | undefined;
    expect(() => {
      const rendered = renderHook(() => useRunStream("run-1"));
      result = rendered.result;
    }).not.toThrow();

    // Distinct from "ended" — a missing EventSource constructor never opened
    // a connection at all, so it is not the same event as a well-formed
    // stream.end and must not share that phase (nor its endReason slot,
    // which the type-design review folded into "unavailable" not having an
    // endReason at all).
    expect(result?.current.phase).toBe("unavailable");

    if (originalEventSource) {
      (globalThis as { EventSource?: typeof EventSource }).EventSource =
        originalEventSource;
    }
  });

  describe("stream.end with a malformed or reason-less payload", () => {
    // [KNOWN BUG] src/hooks/useRunStream.ts's handleStreamEnd sets
    // endReason to null when the payload has no string `reason` — the same
    // value RunLogTail treats as "hasn't ended yet" (RunLogTail.tsx:42).
    // The type-design review's fix folds "ended" into its own branch that
    // always carries a distinguishable endReason, defaulting to "unknown"
    // rather than null.
    test("ends with endReason 'unknown' when the data is not valid JSON", () => {
      const { result } = renderStream("run-1");

      act(() => {
        latestInstance().emit("stream.end", "{not valid json");
      });

      expect(result.current.phase).toBe("ended");
      expect(result.current.endReason).toBe("unknown");
    });

    test("ends with endReason 'unknown' when the payload is a well-formed object lacking a string reason field", () => {
      const { result } = renderStream("run-1");

      act(() => {
        latestInstance().emit("stream.end", {});
      });

      expect(result.current.phase).toBe("ended");
      expect(result.current.endReason).toBe("unknown");
    });
  });

  describe("a dead connection with no stream.end (error event)", () => {
    // [KNOWN BUG] attachRunStreamListeners never registers an "error"
    // listener. When the connection dies without a well-formed stream.end
    // (TLS reset, LB idle timeout, server crash mid-run), phase stays "open"
    // forever with no signal to the operator.
    test("an error event with readyState CLOSED drives phase to 'lost', distinguishable from a normal stream.end", () => {
      const { result } = renderStream("run-1");

      act(() => {
        latestInstance().emit("open", undefined);
      });
      act(() => {
        const instance = latestInstance();
        instance.readyState = FakeEventSource.readyStateClosed;
        instance.emit("error", undefined);
      });

      expect(result.current.phase).toBe("lost");
    });

    test("an error event with readyState CONNECTING does not terminate the stream (native auto-reconnect in flight)", () => {
      // The browser's native EventSource auto-reconnects on a transient
      // drop, flipping readyState to CONNECTING rather than CLOSED — the
      // fix for the dead-connection bug above must not treat that as fatal,
      // or it introduces a worse bug than the one being fixed.
      const { result } = renderStream("run-1");

      act(() => {
        latestInstance().emit("open", undefined);
      });
      act(() => {
        const instance = latestInstance();
        instance.readyState = FakeEventSource.readyStateConnecting;
        instance.emit("error", undefined);
      });

      expect(result.current.phase).toBe("open");
      expect(latestInstance().closed).toBe(false);
    });
  });
});
