/**
 * Tests for core/messaging submodule.
 *
 * Contract source: docs/reference/core/messaging.md, plus the hub-locked
 * spec-silent decisions for this change set (error codes, constructor shape,
 * interpolation semantics).
 *
 * Exports under test: M3LMessenger, M3LMessageWriter, M3LMessageReader,
 *   M3LOutboundMessage, M3LReceivedMessage, M3LMessageTarget,
 *   M3LMessageAuthor, M3LMessageReceipt, M3LInboundAttachment,
 *   M3LOutboundAttachment (10 symbols).
 *
 * This module ships only abstract interfaces + a facade — no concrete
 * transport. Tests supply fake in-test M3LMessageWriter / M3LMessageReader
 * implementations.
 *
 * Key behavioral contracts:
 *  - M3LMessenger is constructed with an inline options object
 *    `{ writer (required), reader?, defaultTarget? }` — there is no exported
 *    M3LMessengerOptions type.
 *  - sendMessage/sendReport/sendError are all async, resolving to whatever
 *    M3LMessageReceipt the writer returned (passthrough).
 *  - Omitting an explicit target falls back to `defaultTarget`; if neither is
 *    available the send rejects with M3LError code "M3L_MESSAGING_NO_TARGET"
 *    and the writer is never invoked.
 *  - Consuming read() without a configured reader rejects/throws M3LError
 *    code "M3L_MESSAGING_NO_READER".
 *  - sendReport renders `{{ key }}` placeholders (whitespace-tolerant) via
 *    String(data[key]); an unresolved key is left verbatim and the send still
 *    resolves.
 *  - sendError never re-throws: the underlying `error` (typed `unknown`) is
 *    attached to the outbound message and handed to the writer.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import { M3LMessenger } from "../src/core/messaging/index.js";
import type {
  M3LInboundAttachment,
  M3LMessageAuthor,
  M3LMessageReader,
  M3LMessageReceipt,
  M3LMessageTarget,
  M3LMessageWriter,
  M3LOutboundAttachment,
  M3LOutboundMessage,
  M3LReceivedMessage,
} from "../src/core/messaging/index.js";

// =============================================================================
// Test doubles
// =============================================================================

/**
 * Recording writer: captures every M3LOutboundMessage it receives and
 * returns a canned receipt (or a fresh one per call if a factory is given).
 */
class RecordingWriter implements M3LMessageWriter {
  readonly received: M3LOutboundMessage[] = [];

  constructor(
    private readonly makeReceipt: (
      message: M3LOutboundMessage,
    ) => M3LMessageReceipt | Promise<M3LMessageReceipt> = () => ({
      id: "receipt-1",
    }),
  ) {}

  write(
    message: M3LOutboundMessage,
  ): M3LMessageReceipt | Promise<M3LMessageReceipt> {
    this.received.push(message);
    return this.makeReceipt(message);
  }
}

/** Fake reader yielding a fixed, ordered sequence of received messages. */
class FixedReader implements M3LMessageReader {
  constructor(private readonly messages: readonly M3LReceivedMessage[]) {}

  read(): AsyncIterable<M3LReceivedMessage> {
    const messages = this.messages;
    return {
      [Symbol.asyncIterator](): AsyncIterator<M3LReceivedMessage> {
        let index = 0;
        return {
          next(): Promise<IteratorResult<M3LReceivedMessage>> {
            const value = messages[index];
            if (value !== undefined) {
              index += 1;
              return Promise.resolve({ value, done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }
}

const author: M3LMessageAuthor = { id: "user-1" };
const target: M3LMessageTarget = { id: "ops-channel" };

// =============================================================================
// Constructor / target resolution
// =============================================================================
describe("M3LMessenger construction and target resolution", () => {
  test("sendMessage passes an explicit target to the writer verbatim", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer });
    const explicitTarget: M3LMessageTarget = { id: "explicit-channel" };

    await messenger.sendMessage("hello", explicitTarget);

    expect(writer.received).toHaveLength(1);
    expect(writer.received[0]?.target).toEqual(explicitTarget);
  });

  test("sendMessage falls back to defaultTarget when no target is passed", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });

    await messenger.sendMessage("hello");

    expect(writer.received).toHaveLength(1);
    expect(writer.received[0]?.target).toEqual(target);
  });

  test("an explicit target overrides defaultTarget", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });
    const explicitTarget: M3LMessageTarget = { id: "override-channel" };

    await messenger.sendMessage("hello", explicitTarget);

    expect(writer.received[0]?.target).toEqual(explicitTarget);
  });

  test("rejects with M3L_MESSAGING_NO_TARGET when neither explicit nor default target is available, and never calls the writer", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer });

    await expect(messenger.sendMessage("x")).rejects.toBeInstanceOf(M3LError);

    let thrown: unknown;
    try {
      await messenger.sendMessage("x");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("M3L_MESSAGING_NO_TARGET");
    expect(writer.received).toHaveLength(0);
  });

  test("sendReport also rejects with M3L_MESSAGING_NO_TARGET when no target resolves", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer });

    let thrown: unknown;
    try {
      await messenger.sendReport("Hi {{ name }}", { name: "world" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("M3L_MESSAGING_NO_TARGET");
    expect(writer.received).toHaveLength(0);
  });

  test("sendError also rejects with M3L_MESSAGING_NO_TARGET when no target resolves", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer });

    let thrown: unknown;
    try {
      await messenger.sendError("boom");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("M3L_MESSAGING_NO_TARGET");
    expect(writer.received).toHaveLength(0);
  });
});

// =============================================================================
// Writer receipt passthrough + sync/async writer support
// =============================================================================
describe("M3LMessenger writer receipt passthrough", () => {
  test("sendMessage resolves to exactly the receipt object the writer returned (sync writer)", async () => {
    const canned: M3LMessageReceipt = { id: "sync-receipt" };
    const writer = new RecordingWriter(() => canned);
    const messenger = new M3LMessenger({ writer, defaultTarget: target });

    const receipt = await messenger.sendMessage("hello");

    expect(receipt).toBe(canned);
  });

  test("sendMessage resolves to exactly the receipt object the writer returned (async writer)", async () => {
    const canned: M3LMessageReceipt = { id: "async-receipt" };
    const writer = new RecordingWriter(() => Promise.resolve(canned));
    const messenger = new M3LMessenger({ writer, defaultTarget: target });

    const receipt = await messenger.sendMessage("hello");

    expect(receipt).toBe(canned);
  });

  test("sendReport and sendError also pass through the writer's receipt referentially", async () => {
    const reportReceipt: M3LMessageReceipt = { id: "report-receipt" };
    const errorReceipt: M3LMessageReceipt = { id: "error-receipt" };
    let call = 0;
    const writer = new RecordingWriter(() => {
      call += 1;
      return call === 1 ? reportReceipt : errorReceipt;
    });
    const messenger = new M3LMessenger({ writer, defaultTarget: target });

    const receipt1 = await messenger.sendReport("Hi {{ name }}", {
      name: "world",
    });
    const receipt2 = await messenger.sendError("boom");

    expect(receipt1).toBe(reportReceipt);
    expect(receipt2).toBe(errorReceipt);
  });
});

// =============================================================================
// sendMessage — text passthrough
// =============================================================================
describe("M3LMessenger.sendMessage", () => {
  test("the writer receives the exact text passed", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });

    await messenger.sendMessage("plain text message");

    expect(writer.received[0]?.text).toBe("plain text message");
  });
});

// =============================================================================
// sendReport — {{ key }} interpolation
// =============================================================================
describe("M3LMessenger.sendReport interpolation", () => {
  test("replaces {{ key }} with String(data[key])", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });

    await messenger.sendReport("Processed {{ count }} rows in {{ seconds }}s", {
      count: 1280,
      seconds: 42,
    });

    expect(writer.received[0]?.text).toBe("Processed 1280 rows in 42s");
  });

  test.each([
    ["{{ count }}", "spaced"],
    ["{{count}}", "unspaced"],
    ["{{  count  }}", "extra-spaced"],
  ])(
    "whitespace-tolerant token %s (%s) resolves the same key",
    async (token) => {
      const writer = new RecordingWriter();
      const messenger = new M3LMessenger({ writer, defaultTarget: target });

      await messenger.sendReport(`Value: ${token}`, { count: 7 });

      expect(writer.received[0]?.text).toBe("Value: 7");
    },
  );

  test.each([
    [42, "42"],
    [true, "true"],
  ])(
    "stringifies non-string values via String() (%s -> %s)",
    async (value, expected) => {
      const writer = new RecordingWriter();
      const messenger = new M3LMessenger({ writer, defaultTarget: target });

      await messenger.sendReport("v={{ v }}", { v: value });

      expect(writer.received[0]?.text).toBe(`v=${expected}`);
    },
  );

  test("a missing key is left verbatim in the rendered text and the send resolves", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });

    const receipt = await messenger.sendReport("Hi {{ missing }}", {});

    expect(writer.received[0]?.text).toBe("Hi {{ missing }}");
    expect(receipt).toBeDefined();
  });

  test("a malformed token ({{ + many spaces, no closing braces) is returned verbatim without pathological backtracking", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });
    const evil = "{{" + " ".repeat(50_000); // no closing }} — must not match, must not hang

    await messenger.sendReport(evil, {});

    expect(writer.received[0]?.text).toBe(evil);
  });

  test("a key present with value `undefined` stringifies to the literal 'undefined', unlike a missing key", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });

    await messenger.sendReport("v={{ v }}", { v: undefined });

    expect(writer.received[0]?.text).toBe("v=undefined");
  });

  test("single braces are not treated as interpolation tokens", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });

    await messenger.sendReport("literal {brace} stays {{ count }}", {
      count: 3,
    });

    expect(writer.received[0]?.text).toBe("literal {brace} stays 3");
  });

  test("attachments passed to sendReport appear on the outbound message", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });
    const attachments: readonly M3LOutboundAttachment[] = [
      { filename: "report.csv", content: "a,b,c\n1,2,3\n" },
    ];

    await messenger.sendReport("Hi {{ name }}", { name: "world" }, attachments);

    expect(writer.received[0]?.attachments).toEqual(attachments);
  });

  test("a caller passing target passes it as the 4th argument, after attachments", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });
    const attachments: readonly M3LOutboundAttachment[] = [
      { filename: "report.csv", content: "a,b,c\n1,2,3\n" },
    ];
    const explicitTarget: M3LMessageTarget = { id: "fourth-arg-channel" };

    await messenger.sendReport(
      "Hi {{ name }}",
      { name: "world" },
      attachments,
      explicitTarget,
    );

    expect(writer.received[0]?.target).toEqual(explicitTarget);
    expect(writer.received[0]?.attachments).toEqual(attachments);
  });
});

// =============================================================================
// sendError — carries cause, always resolves
// =============================================================================
describe("M3LMessenger.sendError", () => {
  test("resolves to the writer's receipt and attaches the underlying Error", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });
    const cause = new Error("job blew up");

    const receipt = await messenger.sendError("Job failed", cause);

    expect(receipt).toBeDefined();
    expect(writer.received[0]?.error).toBe(cause);
    expect(writer.received[0]?.text).toBe("Job failed");
  });

  test("resolves with no error argument supplied", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });

    const receipt = await messenger.sendError("just a notice");

    expect(receipt).toBeDefined();
    expect(writer.received[0]?.text).toBe("just a notice");
  });

  test("resolves with a non-Error string cause", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });

    const receipt = await messenger.sendError("x", "a string cause");

    expect(receipt).toBeDefined();
    expect(writer.received[0]?.error).toBe("a string cause");
  });

  test("resolves with a non-Error object cause", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });
    const cause = { some: "object" };

    const receipt = await messenger.sendError("x", cause);

    expect(receipt).toBeDefined();
    expect(writer.received[0]?.error).toEqual(cause);
  });
});

// =============================================================================
// read() — reader-less failure path and happy-path iteration
// =============================================================================
describe("M3LMessenger.read", () => {
  test("throws/rejects M3L_MESSAGING_NO_READER when no reader is configured", async () => {
    const writer = new RecordingWriter();
    const messenger = new M3LMessenger({ writer, defaultTarget: target });

    let thrown: unknown;
    try {
      for await (const _message of messenger.read()) {
        // no-op: the iteration itself should throw before yielding anything
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("M3L_MESSAGING_NO_READER");
  });

  test("iterates every message the reader yields, in order, each carrying its author", async () => {
    const messages: readonly M3LReceivedMessage[] = [
      { author, text: "first" },
      {
        author: { id: "user-2" },
        text: "second",
      },
    ];
    const writer = new RecordingWriter();
    const reader = new FixedReader(messages);
    const messenger = new M3LMessenger({
      writer,
      reader,
      defaultTarget: target,
    });

    const collected: M3LReceivedMessage[] = [];
    for await (const message of messenger.read()) {
      collected.push(message);
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]?.text).toBe("first");
    expect(collected[0]?.author).toEqual(author);
    expect(collected[1]?.text).toBe("second");
    expect(collected[1]?.author).toEqual({ id: "user-2" });
  });
});

// =============================================================================
// Type-level contract
// =============================================================================
describe("M3LMessenger — type-level contract", () => {
  test("sendMessage/sendReport/sendError resolve to Promise<M3LMessageReceipt>", () => {
    expectTypeOf<M3LMessenger["sendMessage"]>().returns.toEqualTypeOf<
      Promise<M3LMessageReceipt>
    >();
    expectTypeOf<M3LMessenger["sendReport"]>().returns.toEqualTypeOf<
      Promise<M3LMessageReceipt>
    >();
    expectTypeOf<M3LMessenger["sendError"]>().returns.toEqualTypeOf<
      Promise<M3LMessageReceipt>
    >();
  });

  test("read() returns an AsyncIterable<M3LReceivedMessage>", () => {
    expectTypeOf<M3LMessenger["read"]>().returns.toEqualTypeOf<
      AsyncIterable<M3LReceivedMessage>
    >();
  });

  test("sendError's second parameter accepts unknown, not narrowed to Error", () => {
    expectTypeOf<M3LMessenger["sendError"]>()
      .parameter(1)
      .toEqualTypeOf<unknown>();
  });

  test("sendReport's data parameter is Record<string, unknown>, not Record<string, string>", () => {
    expectTypeOf<M3LMessenger["sendReport"]>()
      .parameter(1)
      .toEqualTypeOf<Record<string, unknown>>();
  });

  test("M3LMessageWriter.write returns sync-or-async M3LMessageReceipt", () => {
    expectTypeOf<M3LMessageWriter["write"]>().returns.toEqualTypeOf<
      M3LMessageReceipt | Promise<M3LMessageReceipt>
    >();
  });

  test("constructor requires writer and accepts optional reader/defaultTarget", () => {
    expectTypeOf<typeof M3LMessenger>().constructorParameters.toEqualTypeOf<
      [
        {
          readonly writer: M3LMessageWriter;
          readonly reader?: M3LMessageReader;
          readonly defaultTarget?: M3LMessageTarget;
        },
      ]
    >();

    // @ts-expect-error -- writer is required; omitting it must be a type error
    expectTypeOf(() => new M3LMessenger({})).not.toBeCallableWith();
  });

  test("M3LMessageTarget requires only a readonly string id", () => {
    expectTypeOf<M3LMessageTarget>().toMatchTypeOf<{ readonly id: string }>();
  });

  test("M3LReceivedMessage carries an author of type M3LMessageAuthor", () => {
    expectTypeOf<M3LReceivedMessage>().toMatchTypeOf<{
      author: M3LMessageAuthor;
    }>();
  });

  test("M3LInboundAttachment and M3LOutboundAttachment are distinct exported shapes", () => {
    expectTypeOf<M3LInboundAttachment>().not.toEqualTypeOf<M3LOutboundAttachment>();
  });
});
