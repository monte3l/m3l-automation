/**
 * Tests for core/logging submodule.
 *
 * Contract source: docs/reference/core/logging.md
 * Exports under test: M3LLogEventCategory, M3LLogEvent, M3LLogger,
 *   M3LLoggerOptions, M3LConsoleLoggerHandler, M3LFileLoggerHandler,
 *   M3LJsonLoggerHandler, M3LTableFormatter, M3LTableOptions, M3LTableColumn,
 *   redactSensitiveLogText, redactSensitiveLogValue (12 surfaced symbols).
 *
 * WS-D (Correlation IDs, docs/reference/core/logging.md#correlation-ids):
 *   `M3LLoggerOptions` is a NET-NEW export (`{ readonly correlationId?:
 *   string }`) not yet implemented — every test referencing it is RED until
 *   the symbol exists. `M3LLogEvent.correlationId` is likewise unimplemented.
 *   The constructor widens additively: `new M3LLogger(handlers)` must keep
 *   type-checking alongside the new 2-arg form.
 *
 * Key behavioral contracts:
 *  - M3LLogger fans each message method out to every handler in the ordered
 *    constructor array, in array order; a throwing handler does not block the
 *    rest (handler error isolation).
 *  - Each message method emits exactly one M3LLogEvent whose category matches
 *    the method name; newline() emits a spacer event (TEXT, empty message).
 *  - Table methods (table/simpleTable/keyValueTable) emit a single TEXT event
 *    whose message is the pre-rendered table string.
 *  - M3LConsoleLoggerHandler: error/fatal -> stderr, everything else ->
 *    stdout; ANSI is suppressed when the target stream is non-TTY.
 *  - M3LFileLoggerHandler: delegates to M3LFileListExporter, overwriting the
 *    whole file with the accumulated event list on every write; reset() is a
 *    documented no-op (does not clear the accumulated history).
 *  - M3LJsonLoggerHandler: one JSON line per event; scalar fields under
 *    `data` are promoted to the top level; spacer (newline()) events are
 *    dropped entirely (no stdout write).
 *  - M3LTableFormatter: per-column alignment, ANSI-aware width via
 *    string-width, three border styles (full / border-less / compact),
 *    default border is "full".
 *  - redactSensitiveLogText/redactSensitiveLogValue: non-destructive,
 *    case-insensitive sensitive-key redaction; redactSensitiveLogValue
 *    recurses into nested objects/arrays; net-new, does not import from
 *    `security` (DangerousKeys is an unrelated prototype-pollution guard).
 */

import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import { serializeErrorChain } from "../src/core/diagnostics/index.js";
import { M3LError } from "../src/core/errors/index.js";
import { M3LFileListExporter } from "../src/core/exporters/index.js";
import type {
  M3LConsoleLoggerHandlerOptions,
  M3LFileLoggerHandlerOptions,
  M3LJsonLoggerHandlerOptions,
  M3LLogEvent,
  M3LLogLevelFloor,
  M3LLoggerOptions,
  M3LTableColumn,
  M3LTableOptions,
} from "../src/core/logging/index.js";
import {
  M3LConsoleLoggerHandler,
  M3LFileLoggerHandler,
  M3LJsonLoggerHandler,
  M3LLogEventCategory,
  M3LLogger,
  M3LTableFormatter,
  redactSensitiveLogText,
  redactSensitiveLogValue,
} from "../src/core/logging/index.js";

// ---------------------------------------------------------------------------
// Ensure isTTY properties exist as configurable own-properties before any spy
// tries to intercept them. In non-TTY environments (CI) these properties are
// absent on the stream objects, which causes assignment/spy setup to throw.
// ---------------------------------------------------------------------------
beforeAll(() => {
  for (const stream of [process.stdout, process.stderr]) {
    if (!Object.prototype.hasOwnProperty.call(stream, "isTTY")) {
      Object.defineProperty(stream, "isTTY", {
        value: false,
        configurable: true,
        writable: true,
      });
    }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test doubles — a fake handler implementing the internal M3LLoggerHandler
// shape structurally (handle + reset). The interface itself is internal and
// not imported here. Mocks are given explicit function-type parameters (the
// vitest 4 typed-mock form) so they carry the concrete `(event: M3LLogEvent)
// => void` / `() => void` signatures instead of the bare `vi.fn()` inferred
// `Mock<Procedure | Constructable>`, which is not structurally assignable to
// `M3LLoggerHandler` under strict mode.
// ---------------------------------------------------------------------------
interface FakeHandler {
  handle: ReturnType<typeof vi.fn<(event: M3LLogEvent) => void>>;
  reset: ReturnType<typeof vi.fn<() => void>>;
}

function makeFakeHandler(): FakeHandler {
  return {
    handle: vi.fn<(event: M3LLogEvent) => void>(),
    reset: vi.fn<() => void>(),
  };
}

// ---------------------------------------------------------------------------
// M3LLogEventCategory — enum shape
// ---------------------------------------------------------------------------
describe("M3LLogEventCategory", () => {
  test("has the ten documented members with lowercase-name string values (ADR-0035 phase 3 adds DEBUG)", () => {
    expect(M3LLogEventCategory.TEXT).toBe("text");
    expect(M3LLogEventCategory.STEP).toBe("step");
    expect(M3LLogEventCategory.SUCCESS).toBe("success");
    expect(M3LLogEventCategory.ERROR).toBe("error");
    expect(M3LLogEventCategory.FATAL).toBe("fatal");
    expect(M3LLogEventCategory.WARNING).toBe("warning");
    expect(M3LLogEventCategory.HEADER).toBe("header");
    expect(M3LLogEventCategory.INFO).toBe("info");
    expect(M3LLogEventCategory.SECTION).toBe("section");
    expect(M3LLogEventCategory.DEBUG).toBe("debug");
  });

  test("exposes exactly the ten documented member keys", () => {
    expect(Object.keys(M3LLogEventCategory).sort()).toEqual(
      [
        "TEXT",
        "STEP",
        "SUCCESS",
        "ERROR",
        "FATAL",
        "WARNING",
        "HEADER",
        "INFO",
        "SECTION",
        "DEBUG",
      ].sort(),
    );
  });

  test("type-level: each member's runtime value has its documented lowercase string-literal type", () => {
    // M3LLogEventCategory is a `const` object (not a TS enum), so each
    // member is a plain string VALUE — expectTypeOf runs against the value
    // expression itself, not a namespaced member type.
    expectTypeOf(M3LLogEventCategory.TEXT).toEqualTypeOf<"text">();
    expectTypeOf(M3LLogEventCategory.STEP).toEqualTypeOf<"step">();
    expectTypeOf(M3LLogEventCategory.SUCCESS).toEqualTypeOf<"success">();
    expectTypeOf(M3LLogEventCategory.ERROR).toEqualTypeOf<"error">();
    expectTypeOf(M3LLogEventCategory.FATAL).toEqualTypeOf<"fatal">();
    expectTypeOf(M3LLogEventCategory.WARNING).toEqualTypeOf<"warning">();
    expectTypeOf(M3LLogEventCategory.HEADER).toEqualTypeOf<"header">();
    expectTypeOf(M3LLogEventCategory.INFO).toEqualTypeOf<"info">();
    expectTypeOf(M3LLogEventCategory.SECTION).toEqualTypeOf<"section">();
    expectTypeOf(M3LLogEventCategory.DEBUG).toEqualTypeOf<"debug">();
  });

  test("type-level: the M3LLogEventCategory TYPE is the 10-member string literal union (ADR-0035 phase 3 adds 'debug')", () => {
    expectTypeOf<M3LLogEventCategory>().toEqualTypeOf<
      | "text"
      | "step"
      | "success"
      | "error"
      | "fatal"
      | "warning"
      | "header"
      | "info"
      | "section"
      | "debug"
    >();
  });
});

// ---------------------------------------------------------------------------
// M3LLogEvent — type-level shape
// ---------------------------------------------------------------------------
describe("M3LLogEvent type", () => {
  test("has the documented readonly fields", () => {
    expectTypeOf<M3LLogEvent>().toMatchTypeOf<{
      readonly category: M3LLogEventCategory;
      readonly message: string;
      readonly data?: Record<string, unknown>;
      readonly indent?: number;
      readonly timestamp?: Date;
    }>();
  });

  test("category and message are required; data, indent, timestamp are optional", () => {
    const event: M3LLogEvent = {
      category: M3LLogEventCategory.TEXT,
      message: "hello",
    };
    expect(event.category).toBe(M3LLogEventCategory.TEXT);
  });

  // WS-D: `correlationId` is a per-run trace id, documented as optional on
  // every M3LLogEvent (docs/reference/core/logging.md#correlation-ids).
  test("type-level: correlationId is string | undefined", () => {
    expectTypeOf<M3LLogEvent>().toHaveProperty("correlationId");
    expectTypeOf<M3LLogEvent["correlationId"]>().toEqualTypeOf<
      string | undefined
    >();
  });

  test("an event omitting correlationId is still a valid M3LLogEvent", () => {
    const event: M3LLogEvent = {
      category: M3LLogEventCategory.TEXT,
      message: "no id",
    };
    expect(event.correlationId).toBeUndefined();
  });

  test("an event carrying correlationId preserves it as a plain string field", () => {
    const event: M3LLogEvent = {
      category: M3LLogEventCategory.TEXT,
      message: "with id",
      correlationId: "abc-123",
    };
    expect(event.correlationId).toBe("abc-123");
  });
});

// ---------------------------------------------------------------------------
// M3LLoggerOptions — construction widening (WS-D correlation IDs)
// ---------------------------------------------------------------------------
describe("M3LLoggerOptions — type-level contract", () => {
  test("M3LLoggerOptions equals { readonly correlationId?: string; readonly minLevel?: M3LLogLevelFloor } (review fix round narrows minLevel to the 6-member floor type)", () => {
    expectTypeOf<M3LLoggerOptions>().toEqualTypeOf<{
      readonly correlationId?: string;
      readonly minLevel?: M3LLogLevelFloor;
    }>();
  });

  test("the constructor widens additively: its second parameter accepts M3LLoggerOptions", () => {
    // `M3LLoggerHandler` (the first parameter's element type) is an internal,
    // non-barrel-exported interface (see the FakeHandler comment above), so
    // the constructor's SECOND parameter is asserted directly rather than
    // the whole parameter tuple. The parameter is OPTIONAL (see the
    // one-arg-still-constructs runtime test below), so `M3LLoggerOptions`
    // must be a valid value for it — asserted via `toMatchTypeOf` rather than
    // `toEqualTypeOf` against a `| undefined` union, which is redundant while
    // the not-yet-implemented `M3LLoggerOptions` is an error/`any` type in RED.
    expectTypeOf(M3LLogger).constructorParameters.toHaveProperty("1");
    const options: M3LLoggerOptions = { correlationId: "x" };
    expectTypeOf(options).toMatchTypeOf<
      ConstructorParameters<typeof M3LLogger>[1]
    >();
  });

  test("both the one-arg and two-arg constructor calls actually construct without throwing", () => {
    expect(() => new M3LLogger([])).not.toThrow();
    expect(
      () => new M3LLogger([], { correlationId: "ctor-widen-check" }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// M3LLogger — fan-out and category mapping
// ---------------------------------------------------------------------------
describe("M3LLogger — fan-out", () => {
  const methodToCategory: ReadonlyArray<
    readonly [
      (
        | "text"
        | "step"
        | "info"
        | "success"
        | "warning"
        | "error"
        | "fatal"
        | "section"
        | "header"
      ),
      M3LLogEventCategory,
    ]
  > = [
    ["text", M3LLogEventCategory.TEXT],
    ["step", M3LLogEventCategory.STEP],
    ["info", M3LLogEventCategory.INFO],
    ["success", M3LLogEventCategory.SUCCESS],
    ["warning", M3LLogEventCategory.WARNING],
    ["error", M3LLogEventCategory.ERROR],
    ["fatal", M3LLogEventCategory.FATAL],
    ["section", M3LLogEventCategory.SECTION],
    ["header", M3LLogEventCategory.HEADER],
  ];

  test.each(methodToCategory)(
    "%s(message, data) emits exactly one event with the matching category, message, data, and a stamped ISO timestamp",
    (method, category) => {
      const handler = makeFakeHandler();
      const logger = new M3LLogger([handler]);

      logger[method]("hello world", { rows: 3 });

      expect(handler.handle).toHaveBeenCalledTimes(1);
      const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
      expect(event.category).toBe(category);
      expect(event.message).toBe("hello world");
      expect(event.data).toEqual({ rows: 3 });
      // M3LLogger stamps `timestamp: new Date()` on every emitted event.
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.timestamp?.toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    },
  );

  test("calls every handler, in constructor array order, for a single message method call", () => {
    const callLog: string[] = [];
    const first: FakeHandler = {
      handle: vi.fn<(event: M3LLogEvent) => void>(() => {
        callLog.push("first");
      }),
      reset: vi.fn<() => void>(),
    };
    const second: FakeHandler = {
      handle: vi.fn<(event: M3LLogEvent) => void>(() => {
        callLog.push("second");
      }),
      reset: vi.fn<() => void>(),
    };
    const logger = new M3LLogger([first, second]);

    logger.info("ping");

    expect(callLog).toEqual(["first", "second"]);
    expect(first.handle).toHaveBeenCalledTimes(1);
    expect(second.handle).toHaveBeenCalledTimes(1);
  });

  test("handler invocation order is verifiable via invocationCallOrder", () => {
    const first = makeFakeHandler();
    const second = makeFakeHandler();
    const logger = new M3LLogger([first, second]);

    logger.step("step one");

    expect(first.handle.mock.invocationCallOrder[0]).toBeLessThan(
      second.handle.mock.invocationCallOrder[0] as number,
    );
  });

  test("a message call with no data omits the data field (or passes undefined)", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    logger.warning("no data here");

    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.data).toBeUndefined();
  });

  // WS-D: a logger constructed WITH a correlationId stamps it onto every
  // event it dispatches to every handler (docs/reference/core/logging.md#correlation-ids).
  test("a logger constructed with a correlationId stamps it onto every dispatched event", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler], { correlationId: "run-abc" });

    logger.info("hello");

    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.correlationId).toBe("run-abc");
  });

  test("a logger constructed WITHOUT a correlationId leaves the field undefined on every dispatched event", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    logger.info("hello");

    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.correlationId).toBeUndefined();
  });

  test("the stamped correlationId is identical across multiple message calls from the same logger instance", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler], { correlationId: "run-stable" });

    logger.step("first");
    logger.success("second");

    const firstEvent = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    const secondEvent = handler.handle.mock.calls[1]?.[0] as M3LLogEvent;
    expect(firstEvent.correlationId).toBe("run-stable");
    expect(secondEvent.correlationId).toBe("run-stable");
  });

  test("newline() emits one spacer event with an empty message and TEXT category", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    logger.newline();

    expect(handler.handle).toHaveBeenCalledTimes(1);
    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.category).toBe(M3LLogEventCategory.TEXT);
    expect(event.message).toBe("");
    expect(event.timestamp?.toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("handler error isolation: a throwing handler[0] does not block handler[1] from receiving the event", () => {
    const throwing: FakeHandler = {
      handle: vi.fn<(event: M3LLogEvent) => void>(() => {
        throw new Error("handler blew up");
      }),
      reset: vi.fn<() => void>(),
    };
    const survivor = makeFakeHandler();
    const logger = new M3LLogger([throwing, survivor]);

    expect(() => logger.error("boom")).not.toThrow();

    expect(throwing.handle).toHaveBeenCalledTimes(1);
    expect(survivor.handle).toHaveBeenCalledTimes(1);
    const event = survivor.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.category).toBe(M3LLogEventCategory.ERROR);
    expect(event.message).toBe("boom");
  });

  test("an empty handler array is accepted and message calls do not throw", () => {
    const logger = new M3LLogger([]);
    expect(() => logger.info("nobody is listening")).not.toThrow();
  });

  test("handler error isolation: a handler throwing a non-Error value is stringified in the stderr diagnostic without crashing dispatch", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const throwing: FakeHandler = {
      handle: vi.fn<(event: M3LLogEvent) => void>(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error throw to exercise the String(cause) branch of the diagnostic
        throw "raw string failure";
      }),
      reset: vi.fn<() => void>(),
    };
    const logger = new M3LLogger([throwing]);

    expect(() => logger.error("boom")).not.toThrow();

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(written).toContain("raw string failure");
  });

  test("handler error isolation: a thrown Error with no stack falls back to its message in the stderr diagnostic", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const throwing: FakeHandler = {
      handle: vi.fn<(event: M3LLogEvent) => void>(() => {
        const error = new Error("stackless failure");
        // `Error.stack` is `stack?: string` — under exactOptionalPropertyTypes
        // a direct `error.stack = undefined` assignment fails to typecheck
        // (TS2412). Redefine the property instead, which still produces a
        // genuinely stackless Error and keeps `cause instanceof Error` true,
        // exercising the `cause.stack ?? cause.message` fallback.
        Object.defineProperty(error, "stack", {
          value: undefined,
          configurable: true,
        });
        throw error;
      }),
      reset: vi.fn<() => void>(),
    };
    const logger = new M3LLogger([throwing]);

    expect(() => logger.error("boom")).not.toThrow();

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(written).toContain("stackless failure");
  });
});

// ---------------------------------------------------------------------------
// M3LLogger — table methods
// ---------------------------------------------------------------------------
describe("M3LLogger — table methods", () => {
  const rows = [
    { profile: "prod", rows: 1200 },
    { profile: "staging", rows: 42 },
  ];

  test("table() emits a single TEXT-category event whose message is the pre-rendered table string", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    logger.table(rows);

    expect(handler.handle).toHaveBeenCalledTimes(1);
    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.category).toBe(M3LLogEventCategory.TEXT);
    expect(typeof event.message).toBe("string");
    expect(event.message).toContain("prod");
    expect(event.message.includes("\n")).toBe(true);
    expect(event.timestamp?.toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("simpleTable() emits a single TEXT-category event with a rendered table string", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    logger.simpleTable(rows);

    expect(handler.handle).toHaveBeenCalledTimes(1);
    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.category).toBe(M3LLogEventCategory.TEXT);
    expect(event.message).toContain("staging");
  });

  test("keyValueTable() emits a single TEXT-category event rendering the record", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    logger.keyValueTable({ region: "eu-south-1", mode: "standalone" });

    expect(handler.handle).toHaveBeenCalledTimes(1);
    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.category).toBe(M3LLogEventCategory.TEXT);
    expect(event.message).toContain("region");
    expect(event.message).toContain("eu-south-1");
  });

  test("table() accepts M3LTableOptions and does not throw", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    expect(() => logger.table(rows, { border: "compact" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// M3LConsoleLoggerHandler
// ---------------------------------------------------------------------------
describe("M3LConsoleLoggerHandler", () => {
  test("constructs with no required arguments", () => {
    expect(() => new M3LConsoleLoggerHandler()).not.toThrow();
  });

  test("error category writes to stderr, not stdout", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const handler = new M3LConsoleLoggerHandler();

    handler.handle({ category: M3LLogEventCategory.ERROR, message: "oops" });

    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test("fatal category writes to stderr, not stdout", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const handler = new M3LConsoleLoggerHandler();

    handler.handle({ category: M3LLogEventCategory.FATAL, message: "dead" });

    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test.each([
    M3LLogEventCategory.TEXT,
    M3LLogEventCategory.STEP,
    M3LLogEventCategory.SUCCESS,
    M3LLogEventCategory.WARNING,
    M3LLogEventCategory.HEADER,
    M3LLogEventCategory.INFO,
    M3LLogEventCategory.SECTION,
  ])("%s category writes to stdout, not stderr", (category) => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const handler = new M3LConsoleLoggerHandler();

    handler.handle({ category, message: "hi" });

    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("non-TTY stdout: the written string carries no ANSI escape sequence", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const handler = new M3LConsoleLoggerHandler();

    handler.handle({ category: M3LLogEventCategory.SUCCESS, message: "ok" });

    const written = stdoutSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of an ANSI escape sequence in non-TTY output
    expect(/\x1b\[/.test(written)).toBe(false);
    expect(written).toContain("ok");
  });

  test("non-TTY stderr: the written string carries no ANSI escape sequence", () => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const handler = new M3LConsoleLoggerHandler();

    handler.handle({ category: M3LLogEventCategory.ERROR, message: "bad" });

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of an ANSI escape sequence in non-TTY output
    expect(/\x1b\[/.test(written)).toBe(false);
    expect(written).toContain("bad");
  });

  test("TTY stdout: the written output still contains the message text", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const handler = new M3LConsoleLoggerHandler();

    handler.handle({
      category: M3LLogEventCategory.SUCCESS,
      message: "tty ok",
    });

    const written = stdoutSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(written).toContain("tty ok");
  });

  test("reset() does not throw", () => {
    const handler = new M3LConsoleLoggerHandler();
    expect(() => {
      handler.reset();
    }).not.toThrow();
  });

  test.each([-3, 1.5])(
    "regression: an out-of-range indent value (%s) does not throw and still writes the message, clamped to indent 0",
    (indent) => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const handler = new M3LConsoleLoggerHandler();

      expect(() => {
        handler.handle({
          category: M3LLogEventCategory.INFO,
          message: "x",
          indent,
        });
      }).not.toThrow();

      expect(stdoutSpy).toHaveBeenCalled();
      const written = stdoutSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      expect(written).toContain("x");
    },
  );
});

// ---------------------------------------------------------------------------
// M3LFileLoggerHandler — real temp file, drained via vi.waitFor
// ---------------------------------------------------------------------------
describe("M3LFileLoggerHandler", () => {
  let tempFileCounter = 0;
  const tempFiles: string[] = [];

  function nextTempFilePath(): string {
    tempFileCounter += 1;
    const filePath = path.join(
      tmpdir(),
      `m3l-logging-test-${tempFileCounter}-${randomUUID()}.json`,
    );
    tempFiles.push(filePath);
    return filePath;
  }

  afterEach(async () => {
    while (tempFiles.length > 0) {
      const filePath = tempFiles.pop();
      if (filePath === undefined) continue;
      await rm(filePath, { force: true });
    }
  });

  test("constructs with { filePath }", () => {
    const filePath = nextTempFilePath();
    expect(() => new M3LFileLoggerHandler({ filePath })).not.toThrow();
  });

  test("after emitting N events, the file eventually contains a JSON array of N events in emit order", async () => {
    const filePath = nextTempFilePath();
    const handler = new M3LFileLoggerHandler({ filePath });

    handler.handle({ category: M3LLogEventCategory.INFO, message: "first" });
    handler.handle({
      category: M3LLogEventCategory.SUCCESS,
      message: "second",
    });
    handler.handle({ category: M3LLogEventCategory.ERROR, message: "third" });

    await vi.waitFor(async () => {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown[];
      expect(parsed).toHaveLength(3);
    });

    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as M3LLogEvent[];
    expect(parsed.map((event) => event.message)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("reset() is a no-op: earlier events remain in the file after reset() and a further emit", async () => {
    const filePath = nextTempFilePath();
    const handler = new M3LFileLoggerHandler({ filePath });

    handler.handle({
      category: M3LLogEventCategory.INFO,
      message: "before-reset",
    });
    await vi.waitFor(async () => {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown[];
      expect(parsed).toHaveLength(1);
    });

    handler.reset();

    handler.handle({
      category: M3LLogEventCategory.INFO,
      message: "after-reset",
    });
    await vi.waitFor(async () => {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown[];
      expect(parsed).toHaveLength(2);
    });

    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as M3LLogEvent[];
    expect(parsed.map((event) => event.message)).toEqual([
      "before-reset",
      "after-reset",
    ]);
  });

  test("a write failure against an unwritable path reports a diagnostic to stderr carrying the exporter's error code, never the event's own message/data", async () => {
    const filePath = path.join(
      tmpdir(),
      `m3l-logging-test-nonexistent-dir-${randomUUID()}`,
      "log.json",
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const handler = new M3LFileLoggerHandler({ filePath });

    handler.handle({
      category: M3LLogEventCategory.ERROR,
      message: "SECRET_MESSAGE_MUST_NOT_LEAK",
      data: { SECRET_DATA_MUST_NOT_LEAK: true },
    });

    await vi.waitFor(() => {
      expect(stderrSpy).toHaveBeenCalled();
    });

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(written).toContain("ERR_FILE_LIST_EXPORT");
    expect(written).not.toContain("SECRET_MESSAGE_MUST_NOT_LEAK");
    expect(written).not.toContain("SECRET_DATA_MUST_NOT_LEAK");
  });

  test("minLevel drops an event below the floor before it ever reaches the exporter, but still exports one at or above the floor", async () => {
    const exportSpy = vi
      .spyOn(M3LFileListExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const filePath = nextTempFilePath();
    const handler = new M3LFileLoggerHandler({
      filePath,
      minLevel: M3LLogEventCategory.WARNING,
    });

    handler.handle({
      category: M3LLogEventCategory.INFO,
      message: "below the WARNING floor",
    });
    expect(exportSpy).not.toHaveBeenCalled();

    handler.handle({
      category: M3LLogEventCategory.ERROR,
      message: "at or above the WARNING floor",
    });
    await vi.waitFor(() => {
      expect(exportSpy).toHaveBeenCalledTimes(1);
    });

    const [writtenEvents] = exportSpy.mock.calls[0] ?? [];
    expect(
      (writtenEvents as readonly M3LLogEvent[]).map((event) => event.message),
    ).toEqual(["at or above the WARNING floor"]);

    exportSpy.mockRestore();
  });

  test("a non-M3LError export failure is stringified in the stderr diagnostic (the exporter's own error-normalization branch)", async () => {
    // M3LFileListExporter.export() always normalizes its failures to an
    // M3LError, so the handler's `String(cause)` fallback for a raw,
    // non-M3LError cause can only be exercised by stubbing the collaborator's
    // public export() method directly.
    const exportSpy = vi
      .spyOn(M3LFileListExporter.prototype, "export")
      .mockRejectedValue(new Error("raw export failure"));
    const filePath = nextTempFilePath();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const handler = new M3LFileLoggerHandler({ filePath });

    handler.handle({ category: M3LLogEventCategory.INFO, message: "x" });

    await vi.waitFor(() => {
      expect(stderrSpy).toHaveBeenCalled();
    });

    const written = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(written).toContain("raw export failure");
    exportSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// M3LJsonLoggerHandler
// ---------------------------------------------------------------------------
describe("M3LJsonLoggerHandler", () => {
  test("constructs with no required arguments", () => {
    expect(() => new M3LJsonLoggerHandler()).not.toThrow();
  });

  test("emits exactly one newline-terminated line of valid JSON per event", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const handler = new M3LJsonLoggerHandler();

    handler.handle({ category: M3LLogEventCategory.INFO, message: "hi" });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const written = String(stdoutSpy.mock.calls[0]?.[0]);
    expect(written.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(written.trimEnd()) as Record<string, unknown>;
    expect(parsed.category).toBe(M3LLogEventCategory.INFO);
    expect(parsed.message).toBe("hi");
  });

  test("promotes scalar fields from data to the top level of the JSON payload", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const handler = new M3LJsonLoggerHandler();

    handler.handle({
      category: M3LLogEventCategory.SUCCESS,
      message: "imported",
      data: { rows: 1200 },
    });

    const written = String(stdoutSpy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(written.trimEnd()) as Record<string, unknown>;
    expect(parsed.rows).toBe(1200);
  });

  test.each([
    ["string", "eu-south-1"],
    ["number", 7],
    ["boolean", true],
    ["null", null],
  ])(
    "promotes a scalar %s data field to the top level unchanged",
    (_kind, value) => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const handler = new M3LJsonLoggerHandler();

      handler.handle({
        category: M3LLogEventCategory.INFO,
        message: "scalar",
        data: { field: value },
      });

      const written = String(stdoutSpy.mock.calls[0]?.[0]);
      const parsed = JSON.parse(written.trimEnd()) as Record<string, unknown>;
      expect(parsed.field).toEqual(value);
    },
  );

  test("drops spacer (newline) events entirely — no stdout write occurs", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const handler = new M3LJsonLoggerHandler();

    handler.handle({ category: M3LLogEventCategory.TEXT, message: "" });

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test("an event with indent set carries a top-level indent field in the JSON payload", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const handler = new M3LJsonLoggerHandler();

    handler.handle({
      category: M3LLogEventCategory.INFO,
      message: "nested step",
      indent: 2,
    });

    const written = String(stdoutSpy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(written.trimEnd()) as Record<string, unknown>;
    expect(parsed.indent).toBe(2);
  });

  test("an event with timestamp set carries the ISO string at the top level of the JSON payload", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const handler = new M3LJsonLoggerHandler();
    const timestamp = new Date("2020-01-01T00:00:00.000Z");

    handler.handle({
      category: M3LLogEventCategory.INFO,
      message: "timestamped",
      timestamp,
    });

    const written = String(stdoutSpy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(written.trimEnd()) as Record<string, unknown>;
    expect(parsed.timestamp).toBe("2020-01-01T00:00:00.000Z");
  });

  test("a non-scalar data field stays nested under a top-level data object alongside promoted scalars", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const handler = new M3LJsonLoggerHandler();

    handler.handle({
      category: M3LLogEventCategory.SUCCESS,
      message: "imported",
      data: { rows: 1200, meta: { a: 1 } },
    });

    const written = String(stdoutSpy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(written.trimEnd()) as Record<string, unknown>;
    expect(parsed.rows).toBe(1200);
    expect(parsed.data).toEqual({ meta: { a: 1 } });
  });

  // WS-D: a logger constructed with a correlationId stamps it onto every
  // M3LLogEvent, and M3LJsonLoggerHandler includes it as a top-level key in
  // the emitted JSON line (docs/reference/core/logging.md#correlation-ids).
  test("a logger constructed with a correlationId produces a JSON line carrying it at the top level", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const logger = new M3LLogger([new M3LJsonLoggerHandler()], {
      correlationId: "abc",
    });

    logger.info("hello");

    const written = String(stdoutSpy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(written.trimEnd()) as Record<string, unknown>;
    expect(parsed.correlationId).toBe("abc");
  });

  // exactOptionalPropertyTypes note: this must drive the implementer toward a
  // conditional spread (never `correlationId: undefined`), so the key is
  // TRULY absent — assert with `.not.toHaveProperty`, not `.toBeUndefined()`.
  test("a logger constructed WITHOUT a correlationId emits a JSON line with NO correlationId key at all", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const logger = new M3LLogger([new M3LJsonLoggerHandler()]);

    logger.info("hello");

    const written = String(stdoutSpy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(written.trimEnd()) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("correlationId");
  });

  test("reset() does not throw", () => {
    const handler = new M3LJsonLoggerHandler();
    expect(() => {
      handler.reset();
    }).not.toThrow();
  });

  test("regression (M1): a data field colliding with a reserved envelope key does not clobber the envelope", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const handler = new M3LJsonLoggerHandler();

    handler.handle({
      category: M3LLogEventCategory.SUCCESS,
      message: "ok",
      data: { category: "SPOOFED", message: "pwned", rows: 1200 },
    });

    const written = String(stdoutSpy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(written.trimEnd()) as Record<string, unknown>;
    expect(parsed.category).toBe(M3LLogEventCategory.SUCCESS);
    expect(parsed.message).toBe("ok");
    // The colliding keys are routed under the nested `data` object instead
    // of promoted, while the non-colliding scalar `rows` is still promoted.
    expect(parsed.rows).toBe(1200);
    expect(parsed.data).toEqual({ category: "SPOOFED", message: "pwned" });
  });

  test("regression (M2): a __proto__ key in data never reaches the global Object.prototype and is not emitted", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const handler = new M3LJsonLoggerHandler();
    const data = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as Record<
      string,
      unknown
    >;

    handler.handle({
      category: M3LLogEventCategory.INFO,
      message: "x",
      data,
    });

    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    const written = String(stdoutSpy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(written.trimEnd()) as Record<string, unknown>;
    expect(parsed.ok).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// M3LTableFormatter
// ---------------------------------------------------------------------------
describe("M3LTableFormatter", () => {
  test("constructs with no required arguments", () => {
    expect(() => new M3LTableFormatter()).not.toThrow();
  });

  test("right-aligned numeric column pads shorter values on the left", () => {
    const formatter = new M3LTableFormatter();
    const columns: readonly M3LTableColumn[] = [
      { key: "rows", align: "right" },
    ];

    const output = formatter.format([{ rows: 1 }, { rows: 1200 }], {
      columns,
      border: "border-less",
    });
    const lines = output.split("\n").filter((line) => line.trim().length > 0);
    // The short value's row line must contain leading padding before the
    // digit so that it right-aligns against the widest value ("1200").
    const shortValueLine = lines.find((line) => /(?<!\d)1(?!\d)/.test(line));
    expect(shortValueLine).toBeDefined();
    expect(shortValueLine?.trimEnd()).not.toBe(shortValueLine?.trim());
  });

  test("ANSI-aware width: a colored cell and a plain cell of equal visible width produce equal column layout", () => {
    const formatter = new M3LTableFormatter();
    const columns: readonly M3LTableColumn[] = [{ key: "label" }];
    const colored = "[31mABC[39m";

    const coloredOutput = formatter.format(
      [{ label: colored }, { label: "wide-plain-label" }],
      { columns, border: "border-less" },
    );
    const plainOutput = formatter.format(
      [{ label: "ABC" }, { label: "wide-plain-label" }],
      { columns, border: "border-less" },
    );

    const coloredLines = coloredOutput
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const plainLines = plainOutput
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(coloredLines).toHaveLength(plainLines.length);
    // The overall column width (line length after stripping the colored
    // cell's own ANSI codes) must match the plain-text layout, proving the
    // formatter measured visible width, not raw string length.
    const coloredLineLengths = coloredLines.map(
      // eslint-disable-next-line no-control-regex -- stripping ANSI escapes to compare visible column widths
      (line) => line.replace(/\x1b\[[0-9;]*m/g, "").length,
    );
    const plainLineLengths = plainLines.map((line) => line.length);
    expect(coloredLineLengths).toEqual(plainLineLengths);
  });

  test("border: 'full' output contains the documented box-drawing characters", () => {
    const formatter = new M3LTableFormatter();

    const output = formatter.format([{ id: "1" }], { border: "full" });

    for (const char of ["┌", "─", "│", "└", "┐", "┘"]) {
      expect(output).toContain(char);
    }
  });

  test("border: 'border-less' output does not contain the full-border box characters", () => {
    const formatter = new M3LTableFormatter();

    const output = formatter.format([{ id: "1" }], { border: "border-less" });

    expect(output).not.toContain("┌");
    expect(output).not.toContain("│");
  });

  test("border: 'compact' output has no border characters at all", () => {
    const formatter = new M3LTableFormatter();

    const output = formatter.format([{ id: "1" }], { border: "compact" });

    for (const char of ["┌", "─", "│", "├", "┤", "└", "┐", "┘"]) {
      expect(output).not.toContain(char);
    }
  });

  test("omitting border defaults to 'full' rendering", () => {
    const formatter = new M3LTableFormatter();

    const withoutOption = formatter.format([{ id: "1" }]);
    const withFullOption = formatter.format([{ id: "1" }], { border: "full" });

    expect(withoutOption).toContain("┌");
    expect(withoutOption).toBe(withFullOption);
  });

  test("column header overrides the raw key in the rendered output", () => {
    const formatter = new M3LTableFormatter();
    const columns: readonly M3LTableColumn[] = [
      { key: "rows", header: "Row Count" },
    ];

    const output = formatter.format([{ rows: 5 }], { columns });

    expect(output).toContain("Row Count");
  });

  test("center alignment pads a short cell with whitespace on both sides", () => {
    const formatter = new M3LTableFormatter();
    const columns: readonly M3LTableColumn[] = [
      { key: "a", header: "HEADER", align: "center" },
    ];

    const output = formatter.format([{ a: "x" }], {
      columns,
      border: "border-less",
    });

    const lines = output.split("\n");
    const cellLine = lines.find((line) => line.includes("x"));
    expect(cellLine).toBeDefined();
    const line = cellLine ?? "";
    const leadingSpaces = line.length - line.trimStart().length;
    const trailingSpaces = line.length - line.trimEnd().length;
    // A centered short cell inside a header-driven wider column ("HEADER" is
    // wider than "x") has non-zero padding on BOTH sides — left/right
    // alignment would produce zero padding on one side instead.
    expect(leadingSpaces).toBeGreaterThan(0);
    expect(trailingSpaces).toBeGreaterThan(0);
  });

  test("a missing declared column key renders an empty cell, not '[object Object]' and without throwing", () => {
    const formatter = new M3LTableFormatter();
    const columns: readonly M3LTableColumn[] = [{ key: "missing" }];

    let output = "";
    expect(() => {
      output = formatter.format([{ present: "x" }], { columns });
    }).not.toThrow();
    expect(output).not.toContain("[object Object]");
  });

  test("a null cell value renders as an empty cell, not '[object Object]'", () => {
    const formatter = new M3LTableFormatter();

    const output = formatter.format([{ a: null }]);

    expect(output).not.toContain("[object Object]");
    expect(output).not.toContain("null");
  });

  test("a boolean cell value renders as 'true' / 'false' text", () => {
    const formatter = new M3LTableFormatter();

    const output = formatter.format([{ ok: true }, { ok: false }]);

    expect(output).toContain("true");
    expect(output).toContain("false");
  });

  test("an object cell value renders as JSON.stringify output, not '[object Object]'", () => {
    const formatter = new M3LTableFormatter();

    const output = formatter.format([{ meta: { n: 1 } }]);

    expect(output).toContain(JSON.stringify({ n: 1 }));
    expect(output).not.toContain("[object Object]");
  });

  test("empty rows with no declared columns renders a string without throwing", () => {
    const formatter = new M3LTableFormatter();

    let output = "";
    expect(() => {
      output = formatter.format([]);
    }).not.toThrow();
    expect(typeof output).toBe("string");
  });

  test("an invalid border value throws an M3LError with code ERR_LOG_TABLE_BORDER", () => {
    const formatter = new M3LTableFormatter();
    const invalidBorder = "nope" as unknown as NonNullable<
      M3LTableOptions["border"]
    >;

    let thrown: unknown;
    try {
      formatter.format([{ a: 1 }], { border: invalidBorder });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_LOG_TABLE_BORDER");
  });

  test("an invalid align value throws an M3LError with code ERR_LOG_TABLE_ALIGN", () => {
    const formatter = new M3LTableFormatter();
    const invalidAlign = "nope" as unknown as NonNullable<
      M3LTableColumn["align"]
    >;
    const columns: readonly M3LTableColumn[] = [
      { key: "a", align: invalidAlign },
    ];

    let thrown: unknown;
    try {
      formatter.format([{ a: 1 }], { columns });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_LOG_TABLE_ALIGN");
  });
});

// ---------------------------------------------------------------------------
// M3LTableOptions / M3LTableColumn — type-level contract
// ---------------------------------------------------------------------------
describe("M3LTableOptions / M3LTableColumn types", () => {
  test("M3LTableOptions['border'] is the documented union or undefined", () => {
    expectTypeOf<M3LTableOptions["border"]>().toEqualTypeOf<
      "full" | "border-less" | "compact" | undefined
    >();
  });

  test("M3LTableOptions['columns'] is a readonly array of M3LTableColumn or undefined", () => {
    expectTypeOf<M3LTableOptions["columns"]>().toEqualTypeOf<
      readonly M3LTableColumn[] | undefined
    >();
  });

  test("M3LTableColumn['align'] is the documented union or undefined", () => {
    expectTypeOf<M3LTableColumn["align"]>().toEqualTypeOf<
      "left" | "right" | "center" | undefined
    >();
  });

  test("M3LTableColumn['key'] is required and typed string", () => {
    expectTypeOf<M3LTableColumn>()
      .toHaveProperty("key")
      .toEqualTypeOf<string>();
  });
});

// ---------------------------------------------------------------------------
// redactSensitiveLogText
// ---------------------------------------------------------------------------
describe("redactSensitiveLogText", () => {
  test("redacts a key=value sensitive pair while leaving non-sensitive pairs intact", () => {
    const result = redactSensitiveLogText("token=abc123 user=alice");

    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("abc123");
    expect(result).toContain("user=alice");
  });

  test("redacts a 'key: value' sensitive pair", () => {
    const result = redactSensitiveLogText(
      "password: hunter2, region: eu-west-1",
    );

    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("hunter2");
    expect(result).toContain("region: eu-west-1");
  });

  test("redacts a 'key=\"value\"' sensitive pair", () => {
    const result = redactSensitiveLogText(
      'secret="topvalue" region="eu-west-1"',
    );

    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("topvalue");
    expect(result).toContain('region="eu-west-1"');
  });

  test.each([
    "token",
    "apiKey",
    "api_key",
    "password",
    "passwd",
    "pwd",
    "secret",
    "authorization",
    "auth",
    "accessKey",
    "secretKey",
    "sessionToken",
    "credential",
    "credentials",
    "privateKey",
  ])("redacts the sensitive key '%s' case-insensitively", (key) => {
    const upper = key.toUpperCase();
    const result = redactSensitiveLogText(`${upper}=leaked-value`);

    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("leaked-value");
  });

  test.each(["user", "region", "rows"])(
    "leaves the non-sensitive key '%s' intact",
    (key) => {
      const result = redactSensitiveLogText(`${key}=some-value`);

      expect(result).toContain(`${key}=some-value`);
    },
  );

  test("a string with no sensitive key is returned unchanged", () => {
    const input = "region=eu-south-1 rows=1200";
    expect(redactSensitiveLogText(input)).toBe(input);
  });

  test("type-level: param and return are both string", () => {
    expectTypeOf(redactSensitiveLogText).parameter(0).toBeString();
    expectTypeOf(redactSensitiveLogText).returns.toBeString();
  });

  test("regression (S1): token=value redacts the value only, leaving an adjacent unrelated pair intact", () => {
    const result = redactSensitiveLogText("token=abc123 user=alice");

    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("abc123");
    expect(result).toContain("user=alice");
  });

  test("regression (S1): an Authorization: Bearer <token> header masks the token, not just the scheme word", () => {
    const result = redactSensitiveLogText("Authorization: Bearer abc123");

    expect(result).not.toContain("abc123");
    expect(result).toContain("[REDACTED]");
  });

  test.each(["X-Api-Key: secret", "api-key=secret"])(
    "regression (S1): a hyphenated key form '%s' masks the value",
    (text) => {
      const result = redactSensitiveLogText(text);

      expect(result).not.toContain("secret");
      expect(result).toContain("[REDACTED]");
    },
  );

  test("regression (S1): a JSON-embedded sensitive pair is masked while a sibling pair is preserved", () => {
    const result = redactSensitiveLogText('{"token":"abc","user":"alice"}');

    expect(result).not.toContain("abc");
    expect(result).toContain("alice");
  });

  test("regression (S1): 'author' is not a false-positive match for the sensitive key 'auth'", () => {
    const input = "author=alice";
    expect(redactSensitiveLogText(input)).toBe(input);
  });

  test("regression (N1): a sensitive key=value embedded as a URL query parameter is redacted, leaving the non-secret prefix intact", () => {
    const result = redactSensitiveLogText("url=https://x.com/?token=secret");

    expect(result).not.toContain("secret");
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("url=https://x.com/");
  });

  test("regression (N1): a sensitive key=value embedded in a Cookie header value is redacted, leaving a sibling directive intact", () => {
    const result = redactSensitiveLogText("Cookie: token=abc; path=/");

    expect(result).not.toContain("abc");
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("path=/");
  });

  test("regression (N1): a sensitive query-string parameter deep inside a URL is redacted, leaving a sibling non-secret parameter intact", () => {
    const result = redactSensitiveLogText(
      "https://api.example.com/v1?apiKey=XYZ&user=bob",
    );

    expect(result).not.toContain("XYZ");
    expect(result).toContain("user=bob");
  });
});

// ---------------------------------------------------------------------------
// redactSensitiveLogValue
// ---------------------------------------------------------------------------
describe("redactSensitiveLogValue", () => {
  test("redacts a sensitive top-level key's value and preserves the key", () => {
    const input = { apiKey: "secret" };

    const result = redactSensitiveLogValue(input) as Record<string, unknown>;

    expect(result.apiKey).toBe("[REDACTED]");
  });

  test("returns a new object — the original input is not mutated", () => {
    const input = { apiKey: "secret" };

    redactSensitiveLogValue(input);

    expect(input.apiKey).toBe("secret");
  });

  test.each([
    "token",
    "apiKey",
    "api_key",
    "password",
    "passwd",
    "pwd",
    "secret",
    "authorization",
    "auth",
    "accessKey",
    "secretKey",
    "sessionToken",
    "credential",
    "credentials",
    "privateKey",
  ])(
    "redacts the sensitive key '%s' (case-insensitive) in an object value",
    (key) => {
      const input: Record<string, unknown> = { [key.toUpperCase()]: "leaked" };

      const result = redactSensitiveLogValue(input) as Record<string, unknown>;

      expect(result[key.toUpperCase()]).toBe("[REDACTED]");
    },
  );

  test.each(["user", "region", "rows"])(
    "leaves the non-sensitive key '%s' untouched",
    (key) => {
      const input: Record<string, unknown> = { [key]: "kept-value" };

      const result = redactSensitiveLogValue(input) as Record<string, unknown>;

      expect(result[key]).toBe("kept-value");
    },
  );

  test("recurses into nested objects, redacting sensitive keys at any depth non-destructively", () => {
    const input = {
      outer: { password: "p" },
      list: [{ token: "t" }],
    };

    const result = redactSensitiveLogValue(input) as {
      outer: { password: string };
      list: { token: string }[];
    };

    expect(result.outer.password).toBe("[REDACTED]");
    expect(result.list[0]?.token).toBe("[REDACTED]");
    expect(input.outer.password).toBe("p");
    expect(input.list[0]?.token).toBe("t");
  });

  test("a non-sensitive leaf within a nested structure is left untouched", () => {
    const input = { outer: { region: "eu-south-1" } };

    const result = redactSensitiveLogValue(input) as {
      outer: { region: string };
    };

    expect(result.outer.region).toBe("eu-south-1");
  });

  test("a bare non-sensitive scalar string passes through unchanged", () => {
    expect(redactSensitiveLogValue("just a plain string")).toBe(
      "just a plain string",
    );
  });

  test("a bare number scalar passes through unchanged", () => {
    expect(redactSensitiveLogValue(42)).toBe(42);
  });

  test("a bare string containing an embedded 'token=xyz' pattern is redacted via the text path", () => {
    const result = redactSensitiveLogValue(
      "prefix token=xyz123 suffix",
    ) as string;

    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("xyz123");
  });

  test("type-level: param and return are both unknown", () => {
    expectTypeOf(redactSensitiveLogValue).parameter(0).toBeUnknown();
    expectTypeOf(redactSensitiveLogValue).returns.toBeUnknown();
  });

  test("regression (M3): a __proto__ key never pollutes the global Object.prototype and the sensitive sibling is still redacted", () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"apiKey":"secret"}',
    ) as Record<string, unknown>;

    const out = redactSensitiveLogValue(input) as Record<string, unknown>;

    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.apiKey).toBe("[REDACTED]");
    // Non-destructive: the original input's apiKey is untouched.
    expect(input.apiKey).toBe("secret");
  });

  // WS-D: `correlationId` is documented as a tracing value, never a secret —
  // the key matches no sensitive-key pattern, so it survives redaction
  // untouched (docs/reference/core/logging.md#correlation-ids). Both
  // assertions live in ONE payload to prove non-interference: the id must
  // survive AND a genuine secret in the same object must still be redacted.
  test("correlationId survives redaction untouched while a sibling secret in the same payload is still redacted", () => {
    const input = { correlationId: "abc-123", token: "s3cr3t" };

    const result = redactSensitiveLogValue(input) as {
      correlationId: string;
      token: string;
    };

    expect(result.correlationId).toBe("abc-123");
    expect(result.token).toBe("[REDACTED]");
  });
});

// =============================================================================
// ADR-0035 phase 3 (A3): DEBUG category, minLevel severity floors,
// logger.errorFrom(), logger.time().
//
// Severity ranks (DEBUG(0) < TEXT/STEP/INFO/SECTION/HEADER(1) < SUCCESS(2) <
// WARNING(3) < ERROR(4) < FATAL(5)) are an internal, unexported detail
// (src/internal/logging/levels.ts) — the rank table below is a TEST-LOCAL
// fixture used only to compute expected pass/fail sets against the PUBLIC
// M3LLoggerOptions.minLevel / handler minLevel behavior. It is not an import
// of the internal module.
// =============================================================================

/** Every category, in the order the contract lists them (rank ascending). */
const ALL_CATEGORIES: readonly M3LLogEventCategory[] = [
  M3LLogEventCategory.DEBUG,
  M3LLogEventCategory.TEXT,
  M3LLogEventCategory.STEP,
  M3LLogEventCategory.INFO,
  M3LLogEventCategory.SECTION,
  M3LLogEventCategory.HEADER,
  M3LLogEventCategory.SUCCESS,
  M3LLogEventCategory.WARNING,
  M3LLogEventCategory.ERROR,
  M3LLogEventCategory.FATAL,
];

/** Test-local mirror of the documented severity ranks, for computing expectations only. */
const TEST_CATEGORY_RANK: Record<M3LLogEventCategory, number> = {
  [M3LLogEventCategory.DEBUG]: 0,
  [M3LLogEventCategory.TEXT]: 1,
  [M3LLogEventCategory.STEP]: 1,
  [M3LLogEventCategory.INFO]: 1,
  [M3LLogEventCategory.SECTION]: 1,
  [M3LLogEventCategory.HEADER]: 1,
  [M3LLogEventCategory.SUCCESS]: 2,
  [M3LLogEventCategory.WARNING]: 3,
  [M3LLogEventCategory.ERROR]: 4,
  [M3LLogEventCategory.FATAL]: 5,
};

/**
 * Emits exactly one event of `category` through the PUBLIC API — the message
 * method matching that category, or (for DEBUG, which has no direct message
 * method) a completed `time()` call.
 */
function emitCategory(logger: M3LLogger, category: M3LLogEventCategory): void {
  switch (category) {
    case M3LLogEventCategory.DEBUG: {
      const stop = logger.time("probe");
      stop();
      break;
    }
    case M3LLogEventCategory.TEXT:
      logger.text("probe");
      break;
    case M3LLogEventCategory.STEP:
      logger.step("probe");
      break;
    case M3LLogEventCategory.INFO:
      logger.info("probe");
      break;
    case M3LLogEventCategory.SECTION:
      logger.section("probe");
      break;
    case M3LLogEventCategory.HEADER:
      logger.header("probe");
      break;
    case M3LLogEventCategory.SUCCESS:
      logger.success("probe");
      break;
    case M3LLogEventCategory.WARNING:
      logger.warning("probe");
      break;
    case M3LLogEventCategory.ERROR:
      logger.error("probe");
      break;
    case M3LLogEventCategory.FATAL:
      logger.fatal("probe");
      break;
  }
}

/** Emits every category once through `logger` and returns the categories the handler actually received, in call order. */
function admittedCategories(
  logger: M3LLogger,
  handler: FakeHandler,
): M3LLogEventCategory[] {
  for (const category of ALL_CATEGORIES) {
    emitCategory(logger, category);
  }
  return handler.handle.mock.calls.map((call) => call[0].category);
}

describe("M3LLoggerOptions.minLevel — severity floor filtering (ADR-0035 phase 3)", () => {
  test("additive guarantee: a logger built the old way (no options) still delivers all ten categories to its handler", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    const admitted = admittedCategories(logger, handler);

    expect(admitted).toHaveLength(ALL_CATEGORIES.length);
    expect(new Set(admitted)).toEqual(new Set(ALL_CATEGORIES));
  });

  test.each([
    M3LLogEventCategory.DEBUG,
    M3LLogEventCategory.INFO,
    M3LLogEventCategory.SUCCESS,
    M3LLogEventCategory.WARNING,
    M3LLogEventCategory.ERROR,
    M3LLogEventCategory.FATAL,
  ])(
    // INFO stands in for the excluded rank-1 spellings (TEXT/STEP/SECTION/
    // HEADER) — review fix round narrows `minLevel` to `M3LLogLevelFloor`,
    // which admits only INFO among the tied rank-1 categories.
    "minLevel: %s admits exactly the categories at or above its rank",
    (floor) => {
      const handler = makeFakeHandler();
      const logger = new M3LLogger([handler], { minLevel: floor });

      const admitted = new Set(admittedCategories(logger, handler));
      const floorRank = TEST_CATEGORY_RANK[floor];
      const expected = new Set(
        ALL_CATEGORIES.filter(
          (category) => TEST_CATEGORY_RANK[category] >= floorRank,
        ),
      );

      expect(admitted).toEqual(expected);
    },
  );

  // Review fix round (M3LLogLevelFloor narrowing): `minLevel: TEXT` and
  // `minLevel: HEADER` no longer type-check as a floor at all (both are
  // excluded from M3LLogLevelFloor), so the old "tie is symmetric across two
  // floor spellings" test can no longer be expressed that way. The runtime
  // tie among the five rank-1 categories is still real — it is asserted
  // directly below, through the one spelling (`INFO`) that remains a valid
  // floor.
  test("a floor of INFO admits all five rank-1 categories (text, step, info, section, header) — the rank-1 tie is still real even though it can no longer be spelled via an excluded category as the floor itself", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler], {
      minLevel: M3LLogEventCategory.INFO,
    });

    logger.text("probe");
    logger.step("probe");
    logger.info("probe");
    logger.section("probe");
    logger.header("probe");

    expect(handler.handle).toHaveBeenCalledTimes(5);
    const admitted = new Set(
      handler.handle.mock.calls.map((call) => call[0].category),
    );
    expect(admitted).toEqual(
      new Set([
        M3LLogEventCategory.TEXT,
        M3LLogEventCategory.STEP,
        M3LLogEventCategory.INFO,
        M3LLogEventCategory.SECTION,
        M3LLogEventCategory.HEADER,
      ]),
    );
  });

  test("newline() and the three table methods emit TEXT, so a floor above TEXT filters all of them out", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler], {
      minLevel: M3LLogEventCategory.SUCCESS,
    });

    logger.newline();
    logger.table([{ a: 1 }]);
    logger.simpleTable([{ a: 1 }]);
    logger.keyValueTable({ a: 1 });

    expect(handler.handle).not.toHaveBeenCalled();
  });
});

describe("per-handler minLevel — self-filtering, independent of other handlers (ADR-0035 phase 3)", () => {
  test("two handlers on one logger with different minLevel values each admit their own subset from a single emit call", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // jsonHandler has no floor (admits everything); consoleHandler only
    // admits ERROR and above.
    const jsonHandler = new M3LJsonLoggerHandler();
    const consoleHandler = new M3LConsoleLoggerHandler({
      minLevel: M3LLogEventCategory.ERROR,
    });
    const logger = new M3LLogger([jsonHandler, consoleHandler]);

    // A single emit call: WARNING. jsonHandler's floor admits it (writes to
    // stdout); consoleHandler's floor (ERROR) rejects it (no write at all).
    logger.warning("below the console handler's floor");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).not.toHaveBeenCalled();

    stdoutSpy.mockClear();
    stderrSpy.mockClear();

    // A second, single emit call: FATAL. Both handlers' floors now admit
    // it — jsonHandler writes to stdout, consoleHandler (FATAL routes to
    // stderr) writes to stderr.
    logger.fatal("above both handlers' floors");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  test("composition: a stricter LOGGER floor blocks a handler with a lenient minLevel (handler.handle is never invoked)", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const jsonHandler = new M3LJsonLoggerHandler({
      minLevel: M3LLogEventCategory.DEBUG,
    });
    const logger = new M3LLogger([jsonHandler], {
      minLevel: M3LLogEventCategory.WARNING,
    });

    logger.info("blocked by the logger's own floor");
    expect(stdoutSpy).not.toHaveBeenCalled();

    logger.warning("admitted by the logger's floor and the handler's floor");
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  test("composition: a stricter HANDLER floor suppresses the write even when the logger's own floor admits the event", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const jsonHandler = new M3LJsonLoggerHandler({
      minLevel: M3LLogEventCategory.ERROR,
    });
    const logger = new M3LLogger([jsonHandler], {
      minLevel: M3LLogEventCategory.DEBUG,
    });

    logger.warning("admitted by the logger, rejected by the handler's floor");
    expect(stdoutSpy).not.toHaveBeenCalled();

    logger.error("admitted by both floors");
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Review fix round (CRITICAL defect 1): an unranked minLevel used to make
// `passesFloor`'s rank comparison coerce to NaN, silently dropping every
// event with no throw and no diagnostic. The fix validates `minLevel` at
// CONSTRUCTION time and throws M3LError({ code: "ERR_INVALID_ARGUMENT" }),
// following the `assertValidLimit` precedent in
// `core/diagnostics/breadcrumbs.ts`. Each test reaches the invalid value via
// `as unknown as M3LLogLevelFloor` — the established pattern this file
// already uses for M3LTableOptions.border / M3LTableColumn.align.
// ---------------------------------------------------------------------------
describe("minLevel validation — construction time, not first emit (review fix round, CRITICAL defect 1)", () => {
  const invalidMinLevel = "warn" as unknown as M3LLogLevelFloor;

  test("new M3LLogger throws M3LError with code ERR_INVALID_ARGUMENT for an unranked minLevel, at construction", () => {
    const handler = makeFakeHandler();

    let thrown: unknown;
    try {
      new M3LLogger([handler], { minLevel: invalidMinLevel });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
    // No event was ever dispatched — the throw happened before any emit path
    // could run, not lazily on the first logged event.
    expect(handler.handle).not.toHaveBeenCalled();
  });

  test("new M3LConsoleLoggerHandler throws M3LError with code ERR_INVALID_ARGUMENT for an unranked minLevel, at construction", () => {
    let thrown: unknown;
    try {
      new M3LConsoleLoggerHandler({ minLevel: invalidMinLevel });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
  });

  test("new M3LJsonLoggerHandler throws M3LError with code ERR_INVALID_ARGUMENT for an unranked minLevel, at construction", () => {
    let thrown: unknown;
    try {
      new M3LJsonLoggerHandler({ minLevel: invalidMinLevel });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
  });

  test("new M3LFileLoggerHandler throws M3LError with code ERR_INVALID_ARGUMENT for an unranked minLevel, at construction", () => {
    let thrown: unknown;
    try {
      new M3LFileLoggerHandler({
        filePath: "review-fix-round.log",
        minLevel: invalidMinLevel,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
  });

  test("a valid minLevel still constructs each of the four types without throwing", () => {
    expect(
      () => new M3LLogger([], { minLevel: M3LLogEventCategory.WARNING }),
    ).not.toThrow();
    expect(
      () =>
        new M3LConsoleLoggerHandler({
          minLevel: M3LLogEventCategory.WARNING,
        }),
    ).not.toThrow();
    expect(
      () => new M3LJsonLoggerHandler({ minLevel: M3LLogEventCategory.WARNING }),
    ).not.toThrow();
    expect(
      () =>
        new M3LFileLoggerHandler({
          filePath: "review-fix-round.log",
          minLevel: M3LLogEventCategory.WARNING,
        }),
    ).not.toThrow();
  });

  test("omitting minLevel still constructs each of the four types without throwing (the additive default)", () => {
    expect(() => new M3LLogger([])).not.toThrow();
    expect(() => new M3LConsoleLoggerHandler()).not.toThrow();
    expect(() => new M3LJsonLoggerHandler()).not.toThrow();
    expect(
      () => new M3LFileLoggerHandler({ filePath: "review-fix-round.log" }),
    ).not.toThrow();
  });
});

describe("logger.errorFrom() (ADR-0035 phase 3)", () => {
  test("promotes code/context and the full 3-deep mixed chain, preserving A2 origin/retryable per M3LError level", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    const root = new M3LError("upstream http call failed", {
      code: "ERR_HTTP_REQUEST",
      context: { attempt: 3 },
    });
    const middle = new Error("an intermediate plain failure", {
      cause: root,
    });
    const top = new M3LError("required config value missing", {
      code: "ERR_CONFIG_MISSING",
      context: { key: "API_URL" },
      cause: middle,
    });

    logger.errorFrom(top);

    expect(handler.handle).toHaveBeenCalledTimes(1);
    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.category).toBe(M3LLogEventCategory.ERROR);

    const expectedChain = serializeErrorChain(top);
    expect(expectedChain).toHaveLength(3);

    const data = event.data as Record<string, unknown>;
    expect(data.chain).toEqual(expectedChain);
    expect(data.code).toBe(expectedChain[0]?.code);
    expect(data.context).toEqual(expectedChain[0]?.context);

    const chain = data.chain as typeof expectedChain;
    expect(chain[0]?.code).toBe("ERR_CONFIG_MISSING");
    expect(chain[0]?.origin).toBe("caller");
    expect(chain[0]?.retryable).toBe(false);

    // The middle, plain-Error level carries no code/origin/retryable at all.
    expect(chain[1]).not.toHaveProperty("code");
    expect(chain[1]).not.toHaveProperty("origin");
    expect(chain[1]).not.toHaveProperty("retryable");

    expect(chain[2]?.code).toBe("ERR_HTTP_REQUEST");
    expect(chain[2]?.origin).toBe("external");
    expect(chain[2]?.retryable).toBe(true);
  });

  test("uses the given message override when supplied, otherwise falls back to the error's own message", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    logger.errorFrom(new Error("underlying failure"), "custom description");
    const withOverride = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(withOverride.message).toBe("custom description");

    logger.errorFrom(new Error("underlying failure"));
    const withoutOverride = handler.handle.mock.calls[1]?.[0] as M3LLogEvent;
    expect(withoutOverride.message).toBe("underlying failure");
  });

  test.each([
    ["a thrown string", "boom"],
    ["a thrown null", null],
  ])("handles %s on the unknown channel without throwing", (_label, thrown) => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    expect(() => logger.errorFrom(thrown)).not.toThrow();

    expect(handler.handle).toHaveBeenCalledTimes(1);
    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.category).toBe(M3LLogEventCategory.ERROR);
    const data = event.data as Record<string, unknown>;
    expect(Array.isArray(data.chain)).toBe(true);
    expect((data.chain as unknown[]).length).toBeGreaterThan(0);
  });

  test("emits an ERROR event, which a FATAL floor suppresses", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler], {
      minLevel: M3LLogEventCategory.FATAL,
    });

    logger.errorFrom(new Error("suppressed by the FATAL floor"));

    expect(handler.handle).not.toHaveBeenCalled();
  });

  test("redacts a secret-looking value in a cause's context — it does not reach the handler verbatim", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    const cause = new M3LError("upstream call failed", {
      code: "ERR_HTTP_REQUEST",
      context: { apiKey: "s3cr3t-upstream-value" },
    });
    const top = new M3LError("request failed", {
      code: "ERR_HTTP_REQUEST",
      cause,
    });

    logger.errorFrom(top);

    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(JSON.stringify(event.data)).not.toContain("s3cr3t-upstream-value");
  });

  // ---------------------------------------------------------------------------
  // Review fix round (CRITICAL defect 2): `errorFrom` called
  // `getErrorMessage(error)` directly and unguarded, so an `Error` whose
  // `message` getter throws made `errorFrom` ITSELF throw — the original
  // failure was never reported, and a new exception escaped the caller's own
  // `catch` block. Each case below builds the hostile getter via
  // `Object.defineProperty` on an already-constructed `Error` instance rather
  // than a subclass `get message()` override — the base `Error` constructor
  // defines `message` as an own data property that shadows a prototype
  // accessor, so only a post-construction `defineProperty` actually
  // intercepts reads.
  // ---------------------------------------------------------------------------
  test("does not throw when the error's own message getter throws, and still emits an ERROR event carrying a chain", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    const hostile = new Error("original message");
    Object.defineProperty(hostile, "message", {
      get(): string {
        throw new Error("message getter exploded");
      },
      configurable: true,
    });

    expect(() => logger.errorFrom(hostile)).not.toThrow();

    expect(handler.handle).toHaveBeenCalledTimes(1);
    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.category).toBe(M3LLogEventCategory.ERROR);
    const data = event.data as Record<string, unknown>;
    expect(Array.isArray(data.chain)).toBe(true);
    expect((data.chain as unknown[]).length).toBeGreaterThan(0);
  });

  test("does not throw when the error's own stack getter throws, and still emits an ERROR event carrying a chain", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    const hostile = new Error("a normal message");
    Object.defineProperty(hostile, "stack", {
      get(): string {
        throw new Error("stack getter exploded");
      },
      configurable: true,
    });

    expect(() => logger.errorFrom(hostile)).not.toThrow();

    expect(handler.handle).toHaveBeenCalledTimes(1);
    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.category).toBe(M3LLogEventCategory.ERROR);
    const data = event.data as Record<string, unknown>;
    expect(Array.isArray(data.chain)).toBe(true);
    expect((data.chain as unknown[]).length).toBeGreaterThan(0);
  });

  test("does not throw when a NESTED cause's message getter throws, and still emits an ERROR event carrying a chain", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    const nestedCause = new Error("nested cause message");
    Object.defineProperty(nestedCause, "message", {
      get(): string {
        throw new Error("nested message getter exploded");
      },
      configurable: true,
    });
    const top = new Error("top-level message is fine", { cause: nestedCause });

    expect(() => logger.errorFrom(top)).not.toThrow();

    expect(handler.handle).toHaveBeenCalledTimes(1);
    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.category).toBe(M3LLogEventCategory.ERROR);
    const data = event.data as Record<string, unknown>;
    expect(Array.isArray(data.chain)).toBe(true);
    expect((data.chain as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("logger.time() (ADR-0035 phase 3)", () => {
  test("returns a plain callable; invoking it emits a DEBUG event with the label and a non-negative numeric durationMs", () => {
    const handler = makeFakeHandler();
    const logger = new M3LLogger([handler]);

    const stop = logger.time("import-step");
    expect(handler.handle).not.toHaveBeenCalled();

    stop();

    expect(handler.handle).toHaveBeenCalledTimes(1);
    const event = handler.handle.mock.calls[0]?.[0] as M3LLogEvent;
    expect(event.category).toBe(M3LLogEventCategory.DEBUG);
    const data = event.data as Record<string, unknown>;
    expect(data.label).toBe("import-step");
    expect(typeof data.durationMs).toBe("number");
    expect(data.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  test("is suppressed by any floor above DEBUG", () => {
    const handler = makeFakeHandler();
    // INFO stands in for the excluded TEXT spelling — both are rank 1, and
    // INFO is the M3LLogLevelFloor-narrowed representative of that rank.
    const logger = new M3LLogger([handler], {
      minLevel: M3LLogEventCategory.INFO,
    });

    const stop = logger.time("import-step");
    stop();

    expect(handler.handle).not.toHaveBeenCalled();
  });
});

describe("A3 type-level contracts (minLevel across four options interfaces, time's return type)", () => {
  test("M3LLoggerOptions.minLevel is optional and typed M3LLogLevelFloor", () => {
    expectTypeOf<M3LLoggerOptions["minLevel"]>().toEqualTypeOf<
      M3LLogLevelFloor | undefined
    >();
  });

  test("M3LConsoleLoggerHandlerOptions equals { readonly minLevel?: M3LLogLevelFloor }", () => {
    expectTypeOf<M3LConsoleLoggerHandlerOptions>().toEqualTypeOf<{
      readonly minLevel?: M3LLogLevelFloor;
    }>();
  });

  test("M3LJsonLoggerHandlerOptions equals { readonly minLevel?: M3LLogLevelFloor }", () => {
    expectTypeOf<M3LJsonLoggerHandlerOptions>().toEqualTypeOf<{
      readonly minLevel?: M3LLogLevelFloor;
    }>();
  });

  test("M3LFileLoggerHandlerOptions.minLevel is optional and typed M3LLogLevelFloor, alongside the existing filePath field", () => {
    expectTypeOf<M3LFileLoggerHandlerOptions>().toEqualTypeOf<{
      readonly filePath: string;
      readonly minLevel?: M3LLogLevelFloor;
    }>();
  });

  test("logger.time returns a plain () => void callable", () => {
    expectTypeOf<M3LLogger["time"]>().returns.toEqualTypeOf<() => void>();
  });
});
