/**
 * Tests for `src/http/body.ts` — `readJsonBody`, the async request-body
 * reader `http/handler`'s `runRequest` will call before dispatch for a
 * method that may carry one (X4 slice 7-pre).
 *
 * The contract under test (chosen here, ahead of the implementation):
 *
 * ```ts
 * export interface M3LReadJsonBodyOptions {
 *   readonly maxBytes: number;
 *   readonly signal: AbortSignal;
 * }
 * export function readJsonBody(
 *   req: IncomingMessage,
 *   options: M3LReadJsonBodyOptions,
 * ): Promise<unknown>;
 * ```
 *
 * `readJsonBody` resolves `undefined` for an empty body, resolves the parsed
 * JSON value otherwise, and rejects with `M3LConsoleError` (`ERR_CONSOLE_
 * BODY_TOO_LARGE` / `ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE` / `ERR_CONSOLE_
 * BAD_REQUEST`) or `Core.M3LOperationAbortedError` (a client disconnect via
 * `options.signal`, per ADR-0049's dedicated abort code — this module
 * raises no console-specific code of its own for that case).
 *
 * Every request double here is a REAL `node:stream` `Readable` subclass
 * (`FakeBodyRequest`), not a hand-rolled `EventEmitter` stand-in: the
 * highest-value test in this file — proving the size cap is enforced
 * WHILE streaming, not after buffering the whole body — only means anything
 * against a double that can exercise real chunked delivery and expose how
 * much of it was actually consumed before rejecting.
 */
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { readJsonBody } from "../src/http/body.js";

/**
 * A real `Readable` standing in for `IncomingMessage`: serves `parts` one
 * chunk per `_read()` call (never more), so `readCalls` and `served` are an
 * honest record of how much of the body a caller actually pulled before
 * giving up — the seam the streaming-cap test discriminates on. Passing an
 * empty `parts` array models a body-less request (ends on the very first
 * `_read()`).
 */
class FakeBodyRequest extends Readable {
  public readonly headers: Record<string, string | undefined>;
  public readonly method: string;
  public readCalls = 0;
  public endEmitted = false;
  private served = 0;
  private readonly parts: readonly Buffer[];

  constructor(
    parts: readonly Buffer[],
    headers: Record<string, string | undefined> = {},
    method = "POST",
  ) {
    super();
    this.parts = parts;
    this.headers = headers;
    this.method = method;
    this.on("end", () => {
      this.endEmitted = true;
    });
  }

  /** How many of `parts` were actually pushed before the stream stopped (end, destroy, or still pending). */
  get chunksServed(): number {
    return this.served;
  }

  override _read(): void {
    this.readCalls += 1;
    const next = this.parts[this.served];
    if (next === undefined) {
      this.push(null);
      return;
    }
    this.served += 1;
    this.push(next);
  }
}

/** A request whose `_read()` pushes the first chunk then never advances — models a client that stalls mid-body. */
class StallingBodyRequest extends Readable {
  public readonly headers: Record<string, string | undefined>;
  public readonly method: string;
  public readCalls = 0;
  private pushedFirst = false;

  constructor(
    private readonly firstChunk: Buffer,
    headers: Record<string, string | undefined> = {},
    method = "POST",
  ) {
    super();
    this.headers = headers;
    this.method = method;
  }

  override _read(): void {
    this.readCalls += 1;
    if (!this.pushedFirst) {
      this.pushedFirst = true;
      this.push(this.firstChunk);
    }
    // Deliberately push nothing further: the stream stays open and pending,
    // exactly as a stalled client connection would.
  }
}

function toBuffers(chunks: readonly string[]): Buffer[] {
  return chunks.map((chunk) => Buffer.from(chunk, "utf8"));
}

function asIncomingMessage(req: Readable): IncomingMessage {
  return req as unknown as IncomingMessage;
}

const DEFAULT_MAX_BYTES = 65_536;

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("readJsonBody — happy path", () => {
  test("resolves the parsed JSON value for a well-formed application/json body", async () => {
    const body = JSON.stringify({ scriptName: "hello-world", dryRun: true });
    const req = new FakeBodyRequest(toBuffers([body]), {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });

    await expect(
      readJsonBody(asIncomingMessage(req), {
        maxBytes: DEFAULT_MAX_BYTES,
        signal: neverAbortedSignal(),
      }),
    ).resolves.toEqual({ scriptName: "hello-world", dryRun: true });
  });

  test.each([
    "application/json",
    "application/json; charset=utf-8",
    "application/json;charset=UTF-8",
  ])("accepts content-type %s", async (contentType) => {
    const body = JSON.stringify({ ok: true });
    const req = new FakeBodyRequest(toBuffers([body]), {
      "content-type": contentType,
      "content-length": String(Buffer.byteLength(body)),
    });

    await expect(
      readJsonBody(asIncomingMessage(req), {
        maxBytes: DEFAULT_MAX_BYTES,
        signal: neverAbortedSignal(),
      }),
    ).resolves.toEqual({ ok: true });
  });

  test("resolves undefined for a body-less request (no content-length, no data)", async () => {
    const req = new FakeBodyRequest([], {});

    await expect(
      readJsonBody(asIncomingMessage(req), {
        maxBytes: DEFAULT_MAX_BYTES,
        signal: neverAbortedSignal(),
      }),
    ).resolves.toBeUndefined();
  });

  test("resolves undefined for a request with content-length: 0", async () => {
    const req = new FakeBodyRequest([], {
      "content-type": "application/json",
      "content-length": "0",
    });

    await expect(
      readJsonBody(asIncomingMessage(req), {
        maxBytes: DEFAULT_MAX_BYTES,
        signal: neverAbortedSignal(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("readJsonBody — content-type validation", () => {
  test("rejects a non-JSON content-type with ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE", async () => {
    const req = new FakeBodyRequest(toBuffers(["hello"]), {
      "content-type": "text/plain",
      "content-length": "5",
    });

    let thrown: unknown;
    try {
      await readJsonBody(asIncomingMessage(req), {
        maxBytes: DEFAULT_MAX_BYTES,
        signal: neverAbortedSignal(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE",
    );
  });

  test("rejects an unsupported content-type before reading any bytes", async () => {
    const req = new FakeBodyRequest(toBuffers(["hello", "world"]), {
      "content-type": "text/plain",
      "content-length": "10",
    });

    await expect(
      readJsonBody(asIncomingMessage(req), {
        maxBytes: DEFAULT_MAX_BYTES,
        signal: neverAbortedSignal(),
      }),
    ).rejects.toBeInstanceOf(M3LConsoleError);

    expect(req.readCalls).toBe(0);
  });
});

describe("readJsonBody — malformed JSON", () => {
  test("rejects malformed JSON with ERR_CONSOLE_BAD_REQUEST", async () => {
    const body = "{ not valid json ";
    const req = new FakeBodyRequest(toBuffers([body]), {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });

    let thrown: unknown;
    try {
      await readJsonBody(asIncomingMessage(req), {
        maxBytes: DEFAULT_MAX_BYTES,
        signal: neverAbortedSignal(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).cause).toBeInstanceOf(Error);
  });

  test("does not echo the malformed body's content in the thrown message", async () => {
    // The canary substring stands in for caller data (e.g. a script
    // parameter) that must never reach an operator-facing error message.
    const canary = "unparseable-canary-token-do-not-echo";
    const body = `{ "broken": ${canary}`;
    const req = new FakeBodyRequest(toBuffers([body]), {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });

    let thrown: unknown;
    try {
      await readJsonBody(asIncomingMessage(req), {
        maxBytes: DEFAULT_MAX_BYTES,
        signal: neverAbortedSignal(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).message).not.toContain(canary);
  });
});

describe("readJsonBody — size cap", () => {
  test("rejects a content-length already above the cap before reading any bytes (fast path)", async () => {
    const maxBytes = 1_024;
    const req = new FakeBodyRequest(toBuffers(["x".repeat(2_048)]), {
      "content-type": "application/json",
      "content-length": "2048",
    });

    let thrown: unknown;
    try {
      await readJsonBody(asIncomingMessage(req), {
        maxBytes,
        signal: neverAbortedSignal(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BODY_TOO_LARGE");
    // The fast path must reject on the header alone: `_read()` is only ever
    // invoked once something starts consuming the stream, so zero calls
    // proves not a single byte was pulled off the wire.
    expect(req.readCalls).toBe(0);
  });

  test(
    "caps a chunked body with NO content-length while still streaming, " +
      "not after buffering the whole thing",
    async () => {
      const maxBytes = 50;
      // 5 chunks x 20 bytes = 100 bytes: comfortably over the cap, but only
      // reachable by actually consuming the stream (there's no
      // content-length to short-circuit on).
      const chunks = Array.from({ length: 5 }, () => "a".repeat(20));
      const req = new FakeBodyRequest(toBuffers(chunks), {
        "content-type": "application/json",
      });

      // Counts `data` events actually delivered to a listener — attached
      // before the read starts, so it sees exactly what `readJsonBody`'s
      // own listener sees. This (not `chunksServed`, which counts `_read()`
      // pushes) is the safe discriminator once the cap response is
      // `pause()` rather than `destroy()`: pausing a Node `Readable` stops
      // it emitting further `data` events, but its internal read-ahead
      // keeps pulling already-available bytes into its buffer regardless,
      // so `chunksServed` reaches `chunks.length` even under a correctly
      // streaming implementation for a body this small.
      let dataEventsSeen = 0;
      req.on("data", () => {
        dataEventsSeen += 1;
      });

      let thrown: unknown;
      try {
        await readJsonBody(asIncomingMessage(req), {
          maxBytes,
          signal: neverAbortedSignal(),
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_BODY_TOO_LARGE",
      );

      // THE discriminating assertion: a buffer-then-check implementation
      // has no way to learn the body exceeds the cap without first reading
      // every chunk through to the stream's natural `end` (there is no
      // content-length to consult instead) — so it would necessarily drain
      // all 5 chunks and observe `end`. A genuinely streaming implementation
      // stops consuming the moment the running total crosses `maxBytes`
      // (after chunk 3: 60 > 50): it removes its own `data`/`end` listeners
      // and pauses the request right there — rather than destroying it,
      // which would tear down the connection before the 413 response could
      // reach a client still mid-upload — so `end` never fires and
      // `dataEventsSeen` never reaches all 5 chunks.
      expect(req.endEmitted).toBe(false);
      expect(dataEventsSeen).toBeLessThan(chunks.length);
      expect(req.isPaused()).toBe(true);
    },
  );

  test("caps a body whose content-length UNDERSTATES the real payload", async () => {
    const maxBytes = 50;
    const chunks = Array.from({ length: 5 }, () => "b".repeat(20));
    const req = new FakeBodyRequest(toBuffers(chunks), {
      "content-type": "application/json",
      // Lies: claims 10 bytes (under the cap) while 100 will actually arrive.
      "content-length": "10",
    });

    // Same discriminator as the streaming-cap test above: counts `data`
    // events actually delivered, which stays capped under a `pause()`-based
    // implementation even though `chunksServed` (a push-into-buffer count)
    // does not — see the comment there for why.
    let dataEventsSeen = 0;
    req.on("data", () => {
      dataEventsSeen += 1;
    });

    let thrown: unknown;
    try {
      await readJsonBody(asIncomingMessage(req), {
        maxBytes,
        signal: neverAbortedSignal(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BODY_TOO_LARGE");
    // A lying content-length must not let the fast path wave this through:
    // the streaming path must actually have run (readCalls > 0), and — same
    // discriminator as above — must not have delivered the whole body as
    // `data` events before stopping.
    expect(req.readCalls).toBeGreaterThan(0);
    expect(req.endEmitted).toBe(false);
    expect(dataEventsSeen).toBeLessThan(chunks.length);
  });
});

describe("readJsonBody — abort", () => {
  test("rejects with Core.M3LOperationAbortedError when the signal fires mid-read", async () => {
    const controller = new AbortController();
    const req = new StallingBodyRequest(Buffer.from('{"a":', "utf8"), {
      "content-type": "application/json",
    });

    const pending = readJsonBody(asIncomingMessage(req), {
      maxBytes: DEFAULT_MAX_BYTES,
      signal: controller.signal,
    });

    // Give the reader a turn to attach its first listener/read before the
    // client "disconnects" mid-body.
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(Core.M3LOperationAbortedError);
    expect(req.destroyed).toBe(true);
  });

  test("rejects immediately when the signal is already aborted before the call", async () => {
    const controller = new AbortController();
    controller.abort();
    const req = new StallingBodyRequest(Buffer.from("{}", "utf8"), {
      "content-type": "application/json",
    });

    await expect(
      readJsonBody(asIncomingMessage(req), {
        maxBytes: DEFAULT_MAX_BYTES,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(Core.M3LOperationAbortedError);
  });
});
