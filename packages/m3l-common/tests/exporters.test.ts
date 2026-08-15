/**
 * Tests for core/exporters submodule.
 *
 * Contract source: docs/reference/core/exporters.md
 * Exports under test: M3LFileExporter, M3LListExporter, M3LListExporterStreamWriter,
 *   M3LListExporterEvents, M3LCSVListExporter, M3LCSVListExporterOptions,
 *   ColumnConflictStrategy, M3LJSONListExporter, M3LJSONListExporterOptions,
 *   M3LJSONFileExporter, M3LHTMLListExporter, M3LHTMLListExporterOptions,
 *   M3LBinaryFileExporter, M3LFileListExporter (9+ surfaced symbols).
 *
 * Key behavioral contracts:
 *  - M3LListExporter<TItem>: { export(items): Promise<void>; exportStream(): M3LListExporterStreamWriter<TItem> }.
 *    exportStream() is SYNCHRONOUS — no await. The writer exposes
 *    append(item): Promise<void> and close(): Promise<void>.
 *  - export(items) returns Promise<void> — no result object.
 *  - CSV/JSON/HTML list exporters extend M3LEventEmitterBase (on/off only,
 *    emit is protected); event map export:started / export:completed /
 *    export:error fires at the right lifecycle points; handler isolation is
 *    inherited (a throwing handler must not block a second handler).
 *  - JSON mode is inferred from extension (.jsonl => JSONL, else array),
 *    overridable via options.format.
 *  - HTML substitutes {{count}} / {{items}} / {{date}}.
 *  - Whole-file exporters (M3LFileExporter, M3LJSONFileExporter,
 *    M3LBinaryFileExporter, M3LFileListExporter) take { filePath } at
 *    construction, expose async export(content): Promise<void>, do NOT emit
 *    export:* events, and do NOT have exportStream().
 *  - Error channel: a list exporter write/serialization failure emits
 *    export:error carrying an M3LError AND rejects the in-flight promise
 *    with that same M3LError, cause chained to the underlying failure.
 */

import type { WriteStream } from "node:fs";
import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// Named imports (not `fsp.<method>` member calls) are used for the real,
// unmocked filesystem calls in the torn-write round-trip tests below: the
// repo's `no-restricted-syntax` guard bans mutating `fs`/`fsp`/`fsPromises`
// *member-expression* calls in tests, but a bare identifier call
// (`mkdtemp(...)`) is unaffected — mirrors the pattern in
// `tests/checkpoint.test.ts`.
import { mkdtemp, readFile, rm } from "node:fs/promises";

// Make 'node:fs' and 'node:fs/promises' configurable so vi.spyOn can
// intercept individual functions (ESM namespace objects are non-writable).
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});

import { M3LError } from "../src/core/errors/index.js";
import type { M3LEventEmitterBase } from "../src/core/events/index.js";
import type {
  ColumnConflictStrategy,
  M3LCSVListExporterOptions,
  M3LHTMLListExporterOptions,
  M3LJSONListExporterOptions,
  M3LListExporter,
  M3LListExporterEvents,
  M3LListExporterStreamWriter,
} from "../src/core/exporters/index.js";
import {
  M3LBinaryFileExporter,
  M3LCSVListExporter,
  M3LFileExporter,
  M3LFileListExporter,
  M3LHTMLListExporter,
  M3LJSONFileExporter,
  M3LJSONListExporter,
} from "../src/core/exporters/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * A minimal fake fs.WriteStream: an EventEmitter that records every chunk
 * written to it and emits 'finish' on end() / 'error' when forced to fail.
 */
class FakeWriteStream extends EventEmitter {
  chunks: string[] = [];
  /**
   * Mirrors real `fs.WriteStream#bytesWritten`: the running total of bytes
   * pushed through `write()`/`end(chunk)`, used by the new
   * `M3LWriteStreamLifecycle#bytesWritten` getter under test.
   */
  bytesWritten = 0;
  #shouldFailWrite: boolean;
  #shouldFailEnd: boolean;
  #backpressure: boolean;
  #backpressureConsumed = false;

  constructor(
    options: {
      failWrite?: boolean;
      failEnd?: boolean;
      backpressure?: boolean;
    } = {},
  ) {
    super();
    this.#shouldFailWrite = options.failWrite ?? false;
    this.#shouldFailEnd = options.failEnd ?? false;
    this.#backpressure = options.backpressure ?? false;
  }

  write(chunk: string | Buffer, cb?: (error?: Error | null) => void): boolean {
    if (this.#shouldFailWrite) {
      const writeError = new Error("write failed");
      queueMicrotask(() => {
        this.emit("error", writeError);
        cb?.(writeError);
      });
      return false;
    }
    this.chunks.push(chunk.toString());
    this.bytesWritten += Buffer.byteLength(chunk.toString());
    // The FIRST write, when backpressure is enabled, reports the internal
    // buffer as full (returns false per the real fs.WriteStream contract)
    // and defers 'drain' to a later microtask; every subsequent write
    // accepts immediately, matching a stream that has caught up.
    if (this.#backpressure && !this.#backpressureConsumed) {
      this.#backpressureConsumed = true;
      queueMicrotask(() => {
        cb?.();
      });
      queueMicrotask(() => {
        this.emit("drain");
      });
      return false;
    }
    queueMicrotask(() => {
      cb?.();
    });
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) {
      this.chunks.push(chunk.toString());
      this.bytesWritten += Buffer.byteLength(chunk.toString());
    }
    if (this.#shouldFailEnd) {
      queueMicrotask(() => this.emit("error", new Error("end failed")));
      return this;
    }
    queueMicrotask(() => this.emit("finish"));
    return this;
  }

  content(): string {
    return this.chunks.join("");
  }
}

/** Installs a fake fs.createWriteStream that records writes for filePath. */
function stubWriteStream(
  options: {
    failWrite?: boolean;
    failEnd?: boolean;
    backpressure?: boolean;
  } = {},
): FakeWriteStream {
  const fake = new FakeWriteStream(options);
  vi.spyOn(fs, "createWriteStream").mockReturnValue(
    fake as unknown as WriteStream,
  );
  return fake;
}

/**
 * Same as {@link stubWriteStream}, but also returns the `createWriteStream`
 * spy so a test can assert on the exact arguments the lifecycle opened the
 * stream with (plain `filePath` vs. `(filePath, { flags, start })`).
 */
function stubWriteStreamWithSpy(
  options: {
    failWrite?: boolean;
    failEnd?: boolean;
    backpressure?: boolean;
  } = {},
) {
  const fake = new FakeWriteStream(options);
  const spy = vi
    .spyOn(fs, "createWriteStream")
    .mockReturnValue(fake as unknown as WriteStream);
  return { stream: fake, spy };
}

/** Installs a fake fs.createWriteStream that synchronously throws on open. */
function stubWriteStreamOpenFailure(): void {
  vi.spyOn(fs, "createWriteStream").mockImplementation(() => {
    const fake = new EventEmitter();
    queueMicrotask(() =>
      fake.emit(
        "error",
        Object.assign(new Error("ENOENT: no such directory"), {
          code: "ENOENT",
        }),
      ),
    );
    return fake as unknown as WriteStream;
  });
}

const noopHandle = {
  write: vi.fn(() => Promise.resolve({ bytesWritten: 0 })),
  close: vi.fn(() => Promise.resolve()),
} as unknown as FileHandle;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("type contracts", () => {
  test("M3LListExporterStreamWriter<TItem> shape", () => {
    expectTypeOf<M3LListExporterStreamWriter<{ id: string }>>().toMatchTypeOf<{
      append: (item: { id: string }) => Promise<void>;
      close: () => Promise<void>;
    }>();
  });

  test("M3LListExporterStreamWriter<TItem> gains a readonly bytesWritten: number (resume seam)", () => {
    expectTypeOf<M3LListExporterStreamWriter<{ id: string }>>().toMatchTypeOf<{
      append: (item: { id: string }) => Promise<void>;
      close: () => Promise<void>;
      bytesWritten: number;
    }>();
  });

  test("M3LJSONListExporterOptions gains an optional resumeFromByte: number", () => {
    expectTypeOf<M3LJSONListExporterOptions>()
      .toHaveProperty("resumeFromByte")
      .toEqualTypeOf<number | undefined>();
  });

  test("M3LCSVListExporterOptions gains optional resumeFromByte: number and columns: readonly string[]", () => {
    expectTypeOf<M3LCSVListExporterOptions>()
      .toHaveProperty("resumeFromByte")
      .toEqualTypeOf<number | undefined>();
    expectTypeOf<M3LCSVListExporterOptions>()
      .toHaveProperty("columns")
      .toEqualTypeOf<readonly string[] | undefined>();
  });

  test("M3LListExporter<TItem>.exportStream() is synchronous (returns writer directly)", () => {
    expectTypeOf<
      M3LListExporter<{ id: string }>["exportStream"]
    >().returns.toEqualTypeOf<M3LListExporterStreamWriter<{ id: string }>>();
  });

  test("M3LListExporter<TItem>.export(items) returns Promise<void> (no result object)", () => {
    expectTypeOf<
      M3LListExporter<{ id: string }>["export"]
    >().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<M3LListExporter<{ id: string }>["export"]>()
      .parameter(0)
      .toEqualTypeOf<readonly { id: string }[]>();
  });

  test("ColumnConflictStrategy is the union 'keep-generated' | 'keep-original'", () => {
    expectTypeOf<ColumnConflictStrategy>().toEqualTypeOf<
      "keep-generated" | "keep-original"
    >();
  });

  test("M3LListExporterEvents carries export:started / export:completed / export:error", () => {
    expectTypeOf<M3LListExporterEvents>().toHaveProperty("export:started");
    expectTypeOf<M3LListExporterEvents>().toHaveProperty("export:completed");
    expectTypeOf<M3LListExporterEvents>().toHaveProperty("export:error");
  });

  test("M3LCSVListExporter is assignable to M3LListExporter<TItem>", () => {
    expectTypeOf<M3LCSVListExporter<{ id: string }>>().toMatchTypeOf<
      M3LListExporter<{ id: string }>
    >();
  });

  test("M3LJSONListExporter is assignable to M3LListExporter<TItem>", () => {
    expectTypeOf<M3LJSONListExporter<{ id: string }>>().toMatchTypeOf<
      M3LListExporter<{ id: string }>
    >();
  });

  test("M3LHTMLListExporter is assignable to M3LListExporter<TItem>", () => {
    expectTypeOf<M3LHTMLListExporter<{ id: string }>>().toMatchTypeOf<
      M3LListExporter<{ id: string }>
    >();
  });

  test("M3LCSVListExporter extends M3LEventEmitterBase", () => {
    expectTypeOf<M3LCSVListExporter<{ id: string }>>().toMatchTypeOf<
      M3LEventEmitterBase<M3LListExporterEvents>
    >();
  });

  test("M3LJSONListExporter extends M3LEventEmitterBase", () => {
    expectTypeOf<M3LJSONListExporter<{ id: string }>>().toMatchTypeOf<
      M3LEventEmitterBase<M3LListExporterEvents>
    >();
  });

  test("M3LHTMLListExporter extends M3LEventEmitterBase", () => {
    expectTypeOf<M3LHTMLListExporter<{ id: string }>>().toMatchTypeOf<
      M3LEventEmitterBase<M3LListExporterEvents>
    >();
  });

  test("M3LCSVListExporter<TItem extends object> rejects a primitive item type and accepts an object/interface item type", () => {
    // Positive: an object literal and a named interface both compile.
    const csvWithObjectLiteral: M3LCSVListExporter<{ id: string }> =
      new M3LCSVListExporter<{ id: string }>({ filePath: "x.csv" });
    expectTypeOf(csvWithObjectLiteral).toMatchTypeOf<
      M3LCSVListExporter<{ id: string }>
    >();

    interface Row {
      id: string;
    }
    const csvWithInterface: M3LCSVListExporter<Row> =
      new M3LCSVListExporter<Row>({ filePath: "x.csv" });
    expectTypeOf(csvWithInterface).toMatchTypeOf<M3LCSVListExporter<Row>>();

    // Negative: a primitive TItem must be rejected at the type level.
    // @ts-expect-error — CSV items must be objects, not a primitive `number`
    new M3LCSVListExporter<number>({ filePath: "x.csv" });
  });

  test("M3LHTMLListExporter<TItem extends object> rejects a primitive item type and accepts an object/interface item type", () => {
    // Positive: an object literal and a named interface both compile.
    const htmlWithObjectLiteral: M3LHTMLListExporter<{ id: string }> =
      new M3LHTMLListExporter<{ id: string }>({ filePath: "x.html" });
    expectTypeOf(htmlWithObjectLiteral).toMatchTypeOf<
      M3LHTMLListExporter<{ id: string }>
    >();

    interface Row {
      id: string;
    }
    const htmlWithInterface: M3LHTMLListExporter<Row> =
      new M3LHTMLListExporter<Row>({ filePath: "x.html" });
    expectTypeOf(htmlWithInterface).toMatchTypeOf<M3LHTMLListExporter<Row>>();

    // Negative: a primitive TItem must be rejected at the type level.
    // @ts-expect-error — HTML items must be objects, not a primitive `string`
    new M3LHTMLListExporter<string>({ filePath: "x.html" });
  });

  test("M3LJSONListExporter<TItem extends object> rejects a primitive item type and accepts an object/interface item type", () => {
    // Positive: an object literal and a named interface both compile.
    const jsonWithObjectLiteral: M3LJSONListExporter<{ id: string }> =
      new M3LJSONListExporter<{ id: string }>({ filePath: "x.json" });
    expectTypeOf(jsonWithObjectLiteral).toMatchTypeOf<
      M3LJSONListExporter<{ id: string }>
    >();

    interface Row {
      id: string;
    }
    const jsonWithInterface: M3LJSONListExporter<Row> =
      new M3LJSONListExporter<Row>({ filePath: "x.json" });
    expectTypeOf(jsonWithInterface).toMatchTypeOf<M3LJSONListExporter<Row>>();

    // Negative: a primitive TItem must be rejected at the type level.
    // @ts-expect-error - M3LJSONListExporter requires TItem extends object, not a primitive `number`
    new M3LJSONListExporter<number>({ filePath: "x.json" });
  });

  test("M3LFileListExporter<TItem> accepts an object/interface item type", () => {
    // Positive: an object literal and a named interface both compile.
    const fileListWithObjectLiteral: M3LFileListExporter<{ id: string }> =
      new M3LFileListExporter<{ id: string }>({ filePath: "x.json" });
    expectTypeOf(fileListWithObjectLiteral).toMatchTypeOf<
      M3LFileListExporter<{ id: string }>
    >();

    interface Row {
      id: string;
    }
    const fileListWithInterface: M3LFileListExporter<Row> =
      new M3LFileListExporter<Row>({ filePath: "x.json" });
    expectTypeOf(fileListWithInterface).toMatchTypeOf<
      M3LFileListExporter<Row>
    >();
  });

  test("M3LListExporter<TItem extends object> rejects a primitive type argument and accepts an object/interface type argument", () => {
    // Positive: an object literal type and a named interface both instantiate cleanly.
    type _OkObjectLiteral = M3LListExporter<{ id: number }>;
    const okObjectLiteral: _OkObjectLiteral | undefined = undefined;
    expectTypeOf(okObjectLiteral).toMatchTypeOf<
      M3LListExporter<{ id: number }> | undefined
    >();

    interface Row {
      id: number;
    }
    type _OkInterface = M3LListExporter<Row>;
    const okInterface: _OkInterface | undefined = undefined;
    expectTypeOf(okInterface).toMatchTypeOf<M3LListExporter<Row> | undefined>();

    // Negative: a primitive TItem must be rejected at the type level.
    // @ts-expect-error - M3LListExporter requires TItem extends object, not a primitive `number`
    const badTypeArgument: M3LListExporter<number> | undefined = undefined;
    void badTypeArgument;
  });

  test("M3LListExporterStreamWriter<TItem extends object> rejects a primitive type argument and accepts an object/interface type argument", () => {
    // Positive: an object literal type and a named interface both instantiate cleanly.
    type _OkObjectLiteral = M3LListExporterStreamWriter<{ id: number }>;
    const okObjectLiteral: _OkObjectLiteral | undefined = undefined;
    expectTypeOf(okObjectLiteral).toMatchTypeOf<
      M3LListExporterStreamWriter<{ id: number }> | undefined
    >();

    interface Row {
      id: number;
    }
    type _OkInterface = M3LListExporterStreamWriter<Row>;
    const okInterface: _OkInterface | undefined = undefined;
    expectTypeOf(okInterface).toMatchTypeOf<
      M3LListExporterStreamWriter<Row> | undefined
    >();

    // Negative: a primitive TItem must be rejected at the type level.
    // @ts-expect-error - M3LListExporterStreamWriter requires TItem extends object, not a primitive `string`
    type _Bad = M3LListExporterStreamWriter<string>;
    void ({} as _Bad);
  });

  test("M3LCSVListExporterOptions requires filePath: string", () => {
    expectTypeOf<M3LCSVListExporterOptions>()
      .toHaveProperty("filePath")
      .toEqualTypeOf<string>();
  });

  test("M3LJSONListExporterOptions requires filePath: string", () => {
    expectTypeOf<M3LJSONListExporterOptions>()
      .toHaveProperty("filePath")
      .toEqualTypeOf<string>();
  });

  test("M3LHTMLListExporterOptions requires filePath: string", () => {
    expectTypeOf<M3LHTMLListExporterOptions>()
      .toHaveProperty("filePath")
      .toEqualTypeOf<string>();
  });

  test("whole-file exporters do not expose exportStream", () => {
    expectTypeOf<M3LFileExporter>().not.toHaveProperty("exportStream");
    expectTypeOf<M3LJSONFileExporter>().not.toHaveProperty("exportStream");
    expectTypeOf<M3LBinaryFileExporter>().not.toHaveProperty("exportStream");
    expectTypeOf<M3LFileListExporter<{ id: string }>>().not.toHaveProperty(
      "exportStream",
    );
  });
});

// ---------------------------------------------------------------------------
// M3LCSVListExporter
// ---------------------------------------------------------------------------

describe("M3LCSVListExporter", () => {
  interface Row {
    id: string;
    name: string;
  }

  test("export() batch-writes items readable back as CSV", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/exports/users.csv",
    });

    await exporter.export([
      { id: "1", name: "Ada" },
      { id: "2", name: "Linus" },
    ]);

    const content = stream.content();
    expect(content).toContain("Ada");
    expect(content).toContain("Linus");
    expect(content).toContain("1");
    expect(content).toContain("2");
  });

  test("exportStream() returns a writer synchronously (no await needed)", () => {
    stubWriteStream();
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/exports/stream.csv",
    });

    const writer = exporter.exportStream();

    expect(writer).toBeDefined();
    expect(typeof writer.append).toBe("function");
    expect(typeof writer.close).toBe("function");
  });

  test("streaming append() then close() writes both rows to CSV output", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/exports/stream.csv",
    });

    const writer = exporter.exportStream();
    await writer.append({ id: "1", name: "Ada" });
    await writer.append({ id: "2", name: "Linus" });
    await writer.close();

    const content = stream.content();
    expect(content).toContain("Ada");
    expect(content).toContain("Linus");
  });

  test("exportStream()'s bytesWritten getter delegates through the CSV stream writer and grows with each append()", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/exports/bytes.csv",
    });

    const writer = exporter.exportStream();
    expect(writer.bytesWritten).toBe(0);

    await writer.append({ id: "1", name: "Ada" });
    expect(writer.bytesWritten).toBe(Buffer.byteLength(stream.content()));

    await writer.append({ id: "2", name: "Linus" });
    expect(writer.bytesWritten).toBe(Buffer.byteLength(stream.content()));
  });

  test("emits export:started then export:completed for a successful export()", async () => {
    stubWriteStream();
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/exports/users.csv",
    });
    const events: string[] = [];
    exporter.on("export:started", () => {
      events.push("started");
    });
    exporter.on("export:completed", () => {
      events.push("completed");
    });

    await exporter.export([{ id: "1", name: "Ada" }]);

    expect(events).toEqual(["started", "completed"]);
  });

  test("export:error handler isolation — a throwing handler does not block a second handler", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    stubWriteStreamOpenFailure();
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/nonexistent-dir/users.csv",
    });
    const secondHandlerRan = vi.fn();
    exporter.on("export:error", () => {
      throw new Error("handler blew up");
    });
    exporter.on("export:error", secondHandlerRan);

    await exporter.export([{ id: "1", name: "Ada" }]).catch(() => undefined);

    expect(secondHandlerRan).toHaveBeenCalled();
  });

  test("a write failure emits export:error carrying an M3LError AND rejects export() with the same M3LError", async () => {
    stubWriteStreamOpenFailure();
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/nonexistent-dir/users.csv",
    });
    let emittedError: unknown;
    exporter.on("export:error", (payload: { error: unknown }) => {
      emittedError = payload.error;
    });

    await expect(
      exporter.export([{ id: "1", name: "Ada" }]),
    ).rejects.toBeInstanceOf(M3LError);

    expect(emittedError).toBeInstanceOf(M3LError);
  });

  test("a write failure during streaming append() rejects with an M3LError chaining the underlying cause", async () => {
    const stream = stubWriteStream({ failWrite: true });
    void stream;
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/exports/broken.csv",
    });
    const writer = exporter.exportStream();

    let thrown: unknown;
    try {
      await writer.append({ id: "1", name: "Ada" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).cause).toBeDefined();
  });

  test("once-guard: when append() fails and the caller then calls close(), export:error fires exactly once", async () => {
    const stream = stubWriteStream({ failWrite: true });
    void stream;
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/exports/broken-once.csv",
    });
    const errorHandler = vi.fn();
    exporter.on("export:error", errorHandler);
    const writer = exporter.exportStream();

    await writer.append({ id: "1", name: "Ada" }).catch(() => undefined);
    // A caller's finally-style cleanup calling close() after an append()
    // failure must not cause a second export:error emission for the same
    // underlying failure — the lifecycle's cached pending-error fast-path
    // would otherwise let close() independently observe and re-report it.
    await writer.close().catch(() => undefined);

    expect(errorHandler).toHaveBeenCalledTimes(1);
  });

  test("ColumnConflictStrategy 'keep-generated' vs 'keep-original' are both accepted at construction", () => {
    stubWriteStream();
    expect(
      () =>
        new M3LCSVListExporter<Row>({
          filePath: "/exports/a.csv",
          conflictStrategy: "keep-generated",
        }),
    ).not.toThrow();
    expect(
      () =>
        new M3LCSVListExporter<Row>({
          filePath: "/exports/b.csv",
          conflictStrategy: "keep-original",
        }),
    ).not.toThrow();
  });

  interface Extended {
    id: string;
    extra: string;
  }

  test("'keep-generated' orders columns using the first row's keys first, appending later rows' extra columns after", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LCSVListExporter<Extended>({
      filePath: "/exports/keep-generated.csv",
      conflictStrategy: "keep-generated",
    });

    await exporter.export([
      { id: "1", extra: "x" },
      { id: "2", extra: "y" },
    ]);

    const header = stream.content().split("\n")[0] ?? "";
    expect(header.indexOf("id")).toBeLessThan(header.indexOf("extra"));
  });

  test("'keep-original' orders a row's own keys before the generated column set", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LCSVListExporter<{ extra: string; id: string }>({
      filePath: "/exports/keep-original.csv",
      conflictStrategy: "keep-original",
    });

    await exporter.export([{ extra: "x", id: "1" }]);

    const header = stream.content().split("\n")[0] ?? "";
    expect(header.indexOf("extra")).toBeLessThan(header.indexOf("id"));
  });

  test("export([]) with no items writes a header derived from an empty column set without throwing", async () => {
    stubWriteStream();
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/exports/empty.csv",
    });

    await expect(exporter.export([])).resolves.toBeUndefined();
  });

  test("close() failure emits export:error and rejects with an M3LError chaining the underlying cause", async () => {
    stubWriteStream({ failEnd: true });
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/exports/broken-close.csv",
    });
    let emittedError: unknown;
    exporter.on("export:error", (payload: { error: unknown }) => {
      emittedError = payload.error;
    });
    const writer = exporter.exportStream();
    await writer.append({ id: "1", name: "Ada" });

    let thrown: unknown;
    try {
      await writer.close();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).cause).toBeDefined();
    expect(emittedError).toBeInstanceOf(M3LError);
  });

  test("a streaming append() failure caused by an already-open-failed stream rejects with the same M3LError on a subsequent append()", async () => {
    stubWriteStreamOpenFailure();
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/nonexistent-dir/pending.csv",
    });
    const writer = exporter.exportStream();

    // First append observes the open failure and rejects.
    await expect(
      writer.append({ id: "1", name: "Ada" }),
    ).rejects.toBeInstanceOf(M3LError);

    // A second append() must also reject via the pending-error fast path,
    // not hang waiting on a stream that never opened.
    await expect(
      writer.append({ id: "2", name: "Linus" }),
    ).rejects.toBeInstanceOf(M3LError);
  });

  test("a backpressured write() still resolves append() once the stream drains, without hanging", async () => {
    const stream = stubWriteStream({ backpressure: true });
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/exports/backpressure.csv",
    });
    const writer = exporter.exportStream();

    // A test-owned 'drain' listener (independent of the lifecycle's own)
    // records the moment drain fires, so we can compare it against when
    // append() actually resolves.
    let drainFiredAt = -1;
    let tick = 0;
    stream.on("drain", () => {
      drainFiredAt = tick++;
    });

    await writer.append({ id: "1", name: "Ada" });
    const appendResolvedAt = tick++;

    // append() must not resolve before 'drain' fires — proving the promise
    // genuinely waited on backpressure rather than resolving eagerly off the
    // write() callback alone.
    expect(drainFiredAt).toBeGreaterThanOrEqual(0);
    expect(drainFiredAt).toBeLessThan(appendResolvedAt);
    expect(stream.content()).toContain("Ada");
  });

  // -------------------------------------------------------------------------
  // resumeFromByte (streaming-safe resume seam)
  // -------------------------------------------------------------------------

  test("resumeFromByte > 0 with columns supplied: the header is not re-written and rows are resolved against the supplied columns, not the first appended row", async () => {
    const { stream } = stubWriteStreamWithSpy();
    vi.spyOn(fs, "truncateSync").mockImplementation(() => undefined);
    const exporter = new M3LCSVListExporter<Row>({
      filePath: "/exports/resume.csv",
      resumeFromByte: 256,
      columns: ["id", "name"],
    });

    const writer = exporter.exportStream();
    await writer.append({ id: "3", name: "Grace" });
    await writer.close();

    for (const chunk of stream.chunks) {
      expect(chunk).not.toMatch(/^id,name/);
    }
    expect(stream.content()).toContain("3");
    expect(stream.content()).toContain("Grace");
  });

  test("resumeFromByte > 0 WITHOUT columns: the constructor throws synchronously with M3LError code ERR_CSV_EXPORT", () => {
    stubWriteStreamWithSpy();

    let thrown: unknown;
    try {
      new M3LCSVListExporter<Row>({
        filePath: "/exports/resume-no-columns.csv",
        resumeFromByte: 256,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CSV_EXPORT");
  });

  test("resumeFromByte > 0 with columns: [] (empty array): the constructor throws the same M3LError/ERR_CSV_EXPORT as the columns-undefined case", () => {
    stubWriteStreamWithSpy();

    let thrown: unknown;
    try {
      new M3LCSVListExporter<Row>({
        filePath: "/exports/resume-empty-columns.csv",
        resumeFromByte: 1,
        columns: [],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CSV_EXPORT");
  });

  test.each([-1, 1.5])(
    "resumeFromByte: %s (invalid): the constructor throws synchronously with M3LError code ERR_CSV_EXPORT",
    (resumeFromByte) => {
      stubWriteStreamWithSpy();

      let thrown: unknown;
      try {
        new M3LCSVListExporter<Row>({
          filePath: "/exports/invalid-resume.csv",
          resumeFromByte,
          columns: ["id", "name"],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_CSV_EXPORT");
    },
  );
});

// ---------------------------------------------------------------------------
// M3LJSONListExporter
// ---------------------------------------------------------------------------

describe("M3LJSONListExporter", () => {
  interface Record_ {
    id: string;
  }

  test(".json path (default): array mode writes opening '[' and closing ']' with commas between items", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/records.json",
    });

    await exporter.export([{ id: "1" }, { id: "2" }]);

    const content = stream.content();
    expect(content.trimStart().startsWith("[")).toBe(true);
    expect(content.trimEnd().endsWith("]")).toBe(true);
    expect(content).toContain(",");
    const parsed: unknown = JSON.parse(content);
    expect(parsed).toEqual([{ id: "1" }, { id: "2" }]);
  });

  test(".jsonl path: writes newline-delimited objects with no surrounding brackets or inter-item commas", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/records.jsonl",
    });

    await exporter.export([{ id: "1" }, { id: "2" }]);

    const content = stream.content();
    expect(content.trimStart().startsWith("[")).toBe(false);
    expect(content.trimEnd().endsWith("]")).toBe(false);
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.includes(",")).toBe(false);
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toHaveProperty("id");
    }
  });

  test("explicit format: 'jsonl' overrides a .json extension", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/records.json",
      format: "jsonl",
    });

    await exporter.export([{ id: "1" }]);

    const content = stream.content();
    expect(content.trimStart().startsWith("[")).toBe(false);
  });

  test("explicit format: 'array' overrides a .jsonl extension", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/records.jsonl",
      format: "array",
    });

    await exporter.export([{ id: "1" }]);

    const content = stream.content();
    expect(content.trimStart().startsWith("[")).toBe(true);
  });

  test("streaming array mode: open bracket at first append, comma between items, close on close()", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/stream.json",
    });

    const writer = exporter.exportStream();
    await writer.append({ id: "1" });
    await writer.append({ id: "2" });
    await writer.close();

    const content = stream.content();
    const parsed: unknown = JSON.parse(content);
    expect(parsed).toEqual([{ id: "1" }, { id: "2" }]);
  });

  test("emits export:started on export() and export:completed once the stream is closed", async () => {
    stubWriteStream();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/records.json",
    });
    const events: string[] = [];
    exporter.on("export:started", () => {
      events.push("started");
    });
    exporter.on("export:completed", () => {
      events.push("completed");
    });

    await exporter.export([{ id: "1" }]);

    expect(events).toEqual(["started", "completed"]);
  });

  test("a serialization/write failure emits export:error with an M3LError and rejects export()", async () => {
    stubWriteStreamOpenFailure();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/nonexistent-dir/records.json",
    });
    let emittedError: unknown;
    exporter.on("export:error", (payload: { error: unknown }) => {
      emittedError = payload.error;
    });

    await expect(exporter.export([{ id: "1" }])).rejects.toBeInstanceOf(
      M3LError,
    );
    expect(emittedError).toBeInstanceOf(M3LError);
  });

  test("render-before-open: a synchronous serialization failure emits export:error, rejects, and never opens the write stream", async () => {
    const createSpy = vi.spyOn(fs, "createWriteStream");
    // A BigInt value makes JSON.stringify throw synchronously inside the
    // shared base's renderBatch(), BEFORE it opens the fs.WriteStream — so the
    // destination file is never created/truncated on this failure path.
    const exporter = new M3LJSONListExporter<{ id: bigint }>({
      filePath: "/exports/unserializable.json",
    });
    let emittedError: unknown;
    exporter.on("export:error", (payload: { error: unknown }) => {
      emittedError = payload.error;
    });

    await expect(exporter.export([{ id: 1n }])).rejects.toBeInstanceOf(
      M3LError,
    );
    expect(emittedError).toBeInstanceOf(M3LError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("close() rejects with an M3LError when the underlying stream fails to finish", async () => {
    stubWriteStream({ failEnd: true });
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/broken.json",
    });
    const writer = exporter.exportStream();
    await writer.append({ id: "1" });

    let thrown: unknown;
    try {
      await writer.close();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
  });

  test("streaming array mode: close() with zero appends writes an empty array '[]'", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/empty-stream.json",
    });

    const writer = exporter.exportStream();
    await writer.close();

    const parsed: unknown = JSON.parse(stream.content());
    expect(parsed).toEqual([]);
  });

  test("streaming JSONL mode: append() then close() writes newline-delimited objects readable back one per line", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/stream.jsonl",
    });

    const writer = exporter.exportStream();
    await writer.append({ id: "1" });
    await writer.append({ id: "2" });
    await writer.close();

    const lines = stream.content().trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ id: "1" });
    expect(JSON.parse(lines[1] ?? "")).toEqual({ id: "2" });
  });

  test("explicit format: 'array' on a .jsonl path round-trips via JSON.parse as an array", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/override.jsonl",
      format: "array",
    });

    await exporter.export([{ id: "1" }, { id: "2" }]);

    const parsed: unknown = JSON.parse(stream.content());
    expect(parsed).toEqual([{ id: "1" }, { id: "2" }]);
  });

  test("explicit format: 'jsonl' on a .json path round-trips each line via JSON.parse", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/override.json",
      format: "jsonl",
    });

    await exporter.export([{ id: "1" }, { id: "2" }]);

    const lines = stream.content().trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ id: "1" });
  });

  test("export([]) in array mode writes an empty array '[]'", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/empty.json",
    });

    await exporter.export([]);

    const parsed: unknown = JSON.parse(stream.content());
    expect(parsed).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // resumeFromByte (streaming-safe resume seam)
  // -------------------------------------------------------------------------

  test("fresh export (no resumeFromByte): exportStream() opens with a plain filePath — no flags/start options", () => {
    const { spy } = stubWriteStreamWithSpy();
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/fresh.jsonl",
      format: "jsonl",
    });

    exporter.exportStream();

    expect(spy).toHaveBeenCalledWith("/exports/fresh.jsonl");
    expect(spy.mock.calls[0]).toHaveLength(1);
  });

  test("resumeFromByte > 0 (jsonl): truncates to the offset, opens r+ at start, and bytesWritten accumulates from the offset", async () => {
    const { stream, spy } = stubWriteStreamWithSpy();
    const truncateSpy = vi
      .spyOn(fs, "truncateSync")
      .mockImplementation(() => undefined);
    const filePath = "/exports/resume.jsonl";
    const resumeFromByte = 128;
    const exporter = new M3LJSONListExporter<Record_>({
      filePath,
      format: "jsonl",
      resumeFromByte,
    });

    const writer = exporter.exportStream();

    expect(truncateSpy).toHaveBeenCalledWith(filePath, resumeFromByte);
    expect(spy).toHaveBeenCalledWith(filePath, {
      flags: "r+",
      start: resumeFromByte,
    });

    await writer.append({ id: "1" });
    const firstLine = `${JSON.stringify({ id: "1" })}\n`;
    expect(stream.content()).toBe(firstLine);
    expect(writer.bytesWritten).toBe(
      resumeFromByte + Buffer.byteLength(firstLine),
    );

    await writer.append({ id: "2" });
    const secondLine = `${JSON.stringify({ id: "2" })}\n`;
    expect(stream.content()).toBe(firstLine + secondLine);
    expect(writer.bytesWritten).toBe(
      resumeFromByte + Buffer.byteLength(firstLine + secondLine),
    );
  });

  test("resumeFromByte > 0 (array format): append() emits a leading comma (not '[') and close() still writes the trailing ']'", async () => {
    const { stream } = stubWriteStreamWithSpy();
    vi.spyOn(fs, "truncateSync").mockImplementation(() => undefined);
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/resume.json",
      format: "array",
      resumeFromByte: 64,
    });

    const writer = exporter.exportStream();
    await writer.append({ id: "2" });
    await writer.append({ id: "3" });
    await writer.close();

    expect(stream.content().startsWith(",")).toBe(true);
    expect(stream.content().startsWith("[")).toBe(false);
    expect(stream.content().endsWith("]")).toBe(true);

    // Simulate the pre-offset on-disk prefix (a valid partial array opened
    // with the first item already written) to prove the resumed tail
    // concatenates into a well-formed document.
    const fullDocument = `[${JSON.stringify({ id: "1" })}${stream.content()}`;
    const parsed: unknown = JSON.parse(fullDocument);
    expect(parsed).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
  });

  test("resumeFromByte on a file that no longer exists: the constructor does not throw, but the first append() rejects with a chained M3LError and export:error fires", async () => {
    stubWriteStreamWithSpy();
    const enoent = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
    });
    vi.spyOn(fs, "truncateSync").mockImplementation(() => {
      throw enoent;
    });
    let exporter: M3LJSONListExporter<Record_> | undefined;
    expect(() => {
      exporter = new M3LJSONListExporter<Record_>({
        filePath: "/exports/gone.jsonl",
        format: "jsonl",
        resumeFromByte: 32,
      });
    }).not.toThrow();

    const nonNullExporter = exporter;
    if (nonNullExporter === undefined) {
      throw new Error("exporter must have been constructed");
    }
    let emittedError: unknown;
    nonNullExporter.on("export:error", (payload: { error: unknown }) => {
      emittedError = payload.error;
    });
    const writer = nonNullExporter.exportStream();

    let thrown: unknown;
    try {
      await writer.append({ id: "1" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_JSON_LIST_EXPORT");
    expect((thrown as M3LError).cause).toBe(enoent);
    expect(emittedError).toBeInstanceOf(M3LError);
  });

  test.each([-1, 1.5])(
    "resumeFromByte: %s (invalid): the constructor throws synchronously with M3LError code ERR_JSON_LIST_EXPORT",
    (resumeFromByte) => {
      stubWriteStreamWithSpy();

      let thrown: unknown;
      try {
        new M3LJSONListExporter<Record_>({
          filePath: "/exports/invalid-resume.jsonl",
          format: "jsonl",
          resumeFromByte,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_JSON_LIST_EXPORT");
    },
  );

  test("a truncateSync failure is NOT clobbered by a later, distinct async stream 'error': the first append() rejects with the ORIGINAL truncate error, not the subsequent stream-open error", async () => {
    const truncateError = new Error("truncate failed: ENOENT");
    const streamOpenError = new Error("stream open failed: EACCES");
    vi.spyOn(fs, "truncateSync").mockImplementation(() => {
      throw truncateError;
    });
    vi.spyOn(fs, "createWriteStream").mockImplementation(() => {
      const fake = new EventEmitter();
      // Emitted AFTER the constructor's synchronous truncate failure has
      // already recorded #pendingError — a pre-fix implementation
      // unconditionally overwrites it here, discarding the more specific
      // truncate diagnostic.
      queueMicrotask(() => {
        fake.emit("error", streamOpenError);
      });
      return fake as unknown as WriteStream;
    });

    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/double-failure.jsonl",
      format: "jsonl",
      resumeFromByte: 16,
    });
    const writer = exporter.exportStream();

    // Let the queued async stream 'error' fire before appending, so a
    // pre-fix implementation would already have clobbered #pendingError by
    // the time append()/write() reads it.
    await Promise.resolve();
    await Promise.resolve();

    let thrown: unknown;
    try {
      await writer.append({ id: "1" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).cause).toBe(truncateError);
    expect((thrown as M3LError).cause).not.toBe(streamOpenError);
  });

  test("M3LBaseListExporter's batch export() ignores resumeFromByte — always opens with a plain filePath (no flags/start)", async () => {
    const { spy } = stubWriteStreamWithSpy();
    vi.spyOn(fs, "truncateSync").mockImplementation(() => undefined);
    const exporter = new M3LJSONListExporter<Record_>({
      filePath: "/exports/batch-ignores-resume.jsonl",
      format: "jsonl",
      resumeFromByte: 999,
    });

    await exporter.export([{ id: "1" }]);

    expect(spy).toHaveBeenCalledWith("/exports/batch-ignores-resume.jsonl");
    expect(spy.mock.calls[0]).toHaveLength(1);
  });

  test("torn-write round-trip (jsonl): resuming from the last known-good bytesWritten past a mid-line crash produces N well-formed, non-duplicated lines", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "m3l-exporter-resume-"));
    try {
      const filePath = path.join(dir, "records.jsonl");
      const items = [
        { id: "1" },
        { id: "2" },
        { id: "3" },
        { id: "4" },
      ] satisfies Record_[];

      const exporter1 = new M3LJSONListExporter<Record_>({
        filePath,
        format: "jsonl",
      });
      const writer1 = exporter1.exportStream();
      await writer1.append(items[0] as Record_);
      await writer1.append(items[1] as Record_);
      const lastKnownGoodOffset = writer1.bytesWritten;
      expect(typeof lastKnownGoodOffset).toBe("number");

      // Write a third, full line so we have real on-disk bytes to chop —
      // then truncate strictly inside it, simulating a crash mid-write.
      await writer1.append(items[2] as Record_);
      const fullOffset = writer1.bytesWritten;
      expect(typeof fullOffset).toBe("number");
      const midLineOffset = lastKnownGoodOffset + 3;
      expect(midLineOffset).toBeLessThan(fullOffset);
      fs.truncateSync(filePath, midLineOffset);
      // writer1 is abandoned here — it never observes the truncation, mimicking
      // a crashed process that never called close().

      const exporter2 = new M3LJSONListExporter<Record_>({
        filePath,
        format: "jsonl",
        resumeFromByte: lastKnownGoodOffset,
      });
      const writer2 = exporter2.exportStream();
      await writer2.append(items[2] as Record_);
      await writer2.append(items[3] as Record_);
      await writer2.close();

      const finalContent = await readFile(filePath, "utf8");
      const lines = finalContent.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(4);
      const parsedLines = lines.map((line) => JSON.parse(line) as unknown);
      expect(parsedLines).toEqual(items);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("torn-write round-trip (array): resuming from the last known-good bytesWritten past a mid-item crash still parses to N well-formed, non-duplicated items", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "m3l-exporter-resume-"));
    try {
      const filePath = path.join(dir, "records.json");
      const items = [
        { id: "1" },
        { id: "2" },
        { id: "3" },
        { id: "4" },
      ] satisfies Record_[];

      const exporter1 = new M3LJSONListExporter<Record_>({
        filePath,
        format: "array",
      });
      const writer1 = exporter1.exportStream();
      await writer1.append(items[0] as Record_);
      await writer1.append(items[1] as Record_);
      const lastKnownGoodOffset = writer1.bytesWritten;
      expect(typeof lastKnownGoodOffset).toBe("number");

      await writer1.append(items[2] as Record_);
      const fullOffset = writer1.bytesWritten;
      expect(typeof fullOffset).toBe("number");
      const midItemOffset = lastKnownGoodOffset + 3;
      expect(midItemOffset).toBeLessThan(fullOffset);
      fs.truncateSync(filePath, midItemOffset);
      // writer1 is abandoned here — never closed, so no trailing ']' either.

      const exporter2 = new M3LJSONListExporter<Record_>({
        filePath,
        format: "array",
        resumeFromByte: lastKnownGoodOffset,
      });
      const writer2 = exporter2.exportStream();
      await writer2.append(items[2] as Record_);
      await writer2.append(items[3] as Record_);
      await writer2.close();

      const finalContent = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(finalContent);
      expect(parsed).toEqual(items);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// M3LHTMLListExporter
// ---------------------------------------------------------------------------

describe("M3LHTMLListExporter", () => {
  interface Row {
    id: string;
    name: string;
  }

  test("renders varied cell value types: null/undefined blank, numbers/booleans stringified, objects JSON-serialized", async () => {
    const stream = stubWriteStream();
    interface Mixed {
      count: number;
      active: boolean;
      missing: undefined;
      empty: null;
      nested: { flag: boolean };
    }
    const exporter = new M3LHTMLListExporter<Mixed>({
      filePath: "/exports/mixed.html",
    });

    await exporter.export([
      {
        count: 42,
        active: true,
        missing: undefined,
        empty: null,
        nested: { flag: true },
      },
    ]);

    const content = stream.content();
    expect(content).toContain("42");
    expect(content).toContain("true");
    // The nested object is JSON.stringify'd then HTML-escaped, so its quotes
    // become `&quot;` in the rendered markup — assert the escaped form.
    expect(content).toContain("{&quot;flag&quot;:true}");
  });

  test("{{count}} reflects the exported item count and {{items}} contains the rows", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LHTMLListExporter<Row>({
      filePath: "/exports/report.html",
    });

    await exporter.export([
      { id: "1", name: "Ada" },
      { id: "2", name: "Linus" },
    ]);

    const content = stream.content();
    expect(content).toContain("2");
    expect(content).toContain("Ada");
    expect(content).toContain("Linus");
  });

  test("{{date}} is substituted with a non-empty value", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LHTMLListExporter<Row>({
      filePath: "/exports/report.html",
    });

    await exporter.export([{ id: "1", name: "Ada" }]);

    const content = stream.content();
    expect(content).not.toContain("{{date}}");
  });

  test("column selection restricts which fields are rendered", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LHTMLListExporter<Row>({
      filePath: "/exports/report.html",
      columns: ["name"],
    });

    await exporter.export([{ id: "should-not-appear", name: "Ada" }]);

    const content = stream.content();
    expect(content).toContain("Ada");
    expect(content).not.toContain("should-not-appear");
  });

  test("emits export:started then export:completed for a successful export()", async () => {
    stubWriteStream();
    const exporter = new M3LHTMLListExporter<Row>({
      filePath: "/exports/report.html",
    });
    const events: string[] = [];
    exporter.on("export:started", () => {
      events.push("started");
    });
    exporter.on("export:completed", () => {
      events.push("completed");
    });

    await exporter.export([{ id: "1", name: "Ada" }]);

    expect(events).toEqual(["started", "completed"]);
  });

  test("a write failure emits export:error with an M3LError and rejects export()", async () => {
    stubWriteStreamOpenFailure();
    const exporter = new M3LHTMLListExporter<Row>({
      filePath: "/nonexistent-dir/report.html",
    });
    let emittedError: unknown;
    exporter.on("export:error", (payload: { error: unknown }) => {
      emittedError = payload.error;
    });

    await expect(
      exporter.export([{ id: "1", name: "Ada" }]),
    ).rejects.toBeInstanceOf(M3LError);
    expect(emittedError).toBeInstanceOf(M3LError);
  });

  test("column ordering follows the configured columns array, not object key order", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LHTMLListExporter<{ a: string; b: string }>({
      filePath: "/exports/ordered.html",
      columns: ["b", "a"],
    });

    await exporter.export([{ a: "first", b: "second" }]);

    const content = stream.content();
    expect(content.indexOf("second")).toBeLessThan(content.indexOf("first"));
  });

  test("exportStream() returns a writer synchronously (no await needed)", () => {
    stubWriteStream();
    const exporter = new M3LHTMLListExporter<Row>({
      filePath: "/exports/stream.html",
    });

    const writer = exporter.exportStream();

    expect(writer).toBeDefined();
    expect(typeof writer.append).toBe("function");
    expect(typeof writer.close).toBe("function");
  });

  test("streaming: append() rows then close() renders {{count}} and {{items}} reflecting every appended row", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LHTMLListExporter<Row>({
      filePath: "/exports/stream.html",
    });

    const writer = exporter.exportStream();
    await writer.append({ id: "1", name: "Ada" });
    await writer.append({ id: "2", name: "Linus" });
    await writer.close();

    const content = stream.content();
    expect(content).toContain("2");
    expect(content).toContain("Ada");
    expect(content).toContain("Linus");
  });

  test("exportStream()'s bytesWritten getter delegates through the HTML stream writer: reads 0 while rows are buffered, and the real total only after close() flushes the document", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LHTMLListExporter<Row>({
      filePath: "/exports/bytes.html",
    });

    const writer = exporter.exportStream();
    expect(writer.bytesWritten).toBe(0);

    await writer.append({ id: "1", name: "Ada" });
    expect(writer.bytesWritten).toBe(0);

    await writer.close();
    expect(writer.bytesWritten).toBe(Buffer.byteLength(stream.content()));
    expect(writer.bytesWritten).toBeGreaterThan(0);
  });

  test("streaming: close() with zero appends still renders a valid document with {{count}} = 0", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LHTMLListExporter<Row>({
      filePath: "/exports/empty-stream.html",
    });

    const writer = exporter.exportStream();
    await writer.close();

    const content = stream.content();
    expect(content).toContain("0");
  });

  test("streaming: append() honors column selection for the buffered row", async () => {
    const stream = stubWriteStream();
    const exporter = new M3LHTMLListExporter<Row>({
      filePath: "/exports/stream-columns.html",
      columns: ["name"],
    });

    const writer = exporter.exportStream();
    await writer.append({ id: "should-not-appear", name: "Ada" });
    await writer.close();

    const content = stream.content();
    expect(content).toContain("Ada");
    expect(content).not.toContain("should-not-appear");
  });

  test("streaming: emits export:started at exportStream() and export:completed once close() resolves", async () => {
    stubWriteStream();
    const exporter = new M3LHTMLListExporter<Row>({
      filePath: "/exports/stream-events.html",
    });
    const events: string[] = [];
    exporter.on("export:started", () => {
      events.push("started");
    });
    exporter.on("export:completed", () => {
      events.push("completed");
    });

    const writer = exporter.exportStream();
    expect(events).toEqual(["started"]);
    await writer.append({ id: "1", name: "Ada" });
    await writer.close();

    expect(events).toEqual(["started", "completed"]);
  });

  test("streaming: a close() write failure emits export:error and rejects with an M3LError chaining the underlying cause", async () => {
    stubWriteStream({ failEnd: true });
    const exporter = new M3LHTMLListExporter<Row>({
      filePath: "/exports/broken-stream.html",
    });
    let emittedError: unknown;
    exporter.on("export:error", (payload: { error: unknown }) => {
      emittedError = payload.error;
    });
    const writer = exporter.exportStream();
    await writer.append({ id: "1", name: "Ada" });

    let thrown: unknown;
    try {
      await writer.close();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).cause).toBeDefined();
    expect(emittedError).toBeInstanceOf(M3LError);
  });
});

// ---------------------------------------------------------------------------
// M3LFileExporter (whole-file writer)
// ---------------------------------------------------------------------------

describe("M3LFileExporter", () => {
  test("export(string) writes the string content to the configured filePath", async () => {
    const writeFile = vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
    const exporter = new M3LFileExporter({ filePath: "/exports/doc.txt" });

    await exporter.export("hello world");

    expect(writeFile).toHaveBeenCalledWith(
      "/exports/doc.txt",
      expect.anything(),
    );
  });

  test("export(Buffer) writes the raw buffer content", async () => {
    vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
    const exporter = new M3LFileExporter({ filePath: "/exports/doc.bin" });

    await expect(
      exporter.export(Buffer.from("payload")),
    ).resolves.toBeUndefined();
  });

  test("rejects with an M3LError chaining the underlying cause when the write fails", async () => {
    const writeError = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
    });
    vi.spyOn(fsp, "writeFile").mockRejectedValue(writeError);
    const exporter = new M3LFileExporter({
      filePath: "/nonexistent-dir/doc.txt",
    });

    let thrown: unknown;
    try {
      await exporter.export("content");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).cause).toBe(writeError);
    expect((thrown as M3LError).context).toMatchObject({
      filePath: "/nonexistent-dir/doc.txt",
    });
  });

  test("re-throws an M3LError from the write path unwrapped, without double-wrapping", async () => {
    const original = new M3LError("underlying failure", {
      code: "ERR_UNDERLYING",
    });
    vi.spyOn(fsp, "writeFile").mockRejectedValue(original);
    const exporter = new M3LFileExporter({ filePath: "/exports/doc.txt" });

    let thrown: unknown;
    try {
      await exporter.export("content");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(original);
  });

  test("does not expose on/off (no export:* events)", () => {
    const exporter = new M3LFileExporter({ filePath: "/exports/doc.txt" });
    expect(
      (exporter as unknown as Record<string, unknown>)["on"],
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M3LJSONFileExporter (whole-file JSON document writer)
// ---------------------------------------------------------------------------

describe("M3LJSONFileExporter", () => {
  test("export(value) writes a JSON document that round-trips via JSON.parse", async () => {
    let written = "";
    vi.spyOn(fsp, "writeFile").mockImplementation((_path, data) => {
      if (typeof data === "string") {
        written = data;
      } else {
        const view = data as NodeJS.ArrayBufferView;
        written = Buffer.from(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        ).toString();
      }
      return Promise.resolve();
    });
    const exporter = new M3LJSONFileExporter({
      filePath: "/exports/document.json",
    });
    const value = { id: "1", nested: { flag: true }, list: [1, 2, 3] };

    await exporter.export(value);

    const parsed: unknown = JSON.parse(written);
    expect(parsed).toEqual(value);
  });

  test("rejects with an M3LError chaining the underlying cause when the write fails", async () => {
    const writeError = Object.assign(new Error("EACCES"), {
      code: "EACCES",
    });
    vi.spyOn(fsp, "writeFile").mockRejectedValue(writeError);
    const exporter = new M3LJSONFileExporter({
      filePath: "/nonexistent-dir/document.json",
    });

    let thrown: unknown;
    try {
      await exporter.export({ id: "1" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).cause).toBe(writeError);
    expect((thrown as M3LError).context).toMatchObject({
      filePath: "/nonexistent-dir/document.json",
    });
  });

  test("re-throws an M3LError from the write path unwrapped, without double-wrapping", async () => {
    const original = new M3LError("underlying failure", {
      code: "ERR_UNDERLYING",
    });
    vi.spyOn(fsp, "writeFile").mockRejectedValue(original);
    const exporter = new M3LJSONFileExporter({
      filePath: "/exports/document.json",
    });

    let thrown: unknown;
    try {
      await exporter.export({ id: "1" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// M3LBinaryFileExporter (raw binary writer)
// ---------------------------------------------------------------------------

describe("M3LBinaryFileExporter", () => {
  test("export(Buffer) round-trips the exact bytes written", async () => {
    let written: Buffer | Uint8Array | undefined;
    vi.spyOn(fsp, "writeFile").mockImplementation((_path, data) => {
      written = data as Buffer;
      return Promise.resolve();
    });
    const exporter = new M3LBinaryFileExporter({
      filePath: "/exports/blob.bin",
    });
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0x42]);

    await exporter.export(bytes);

    expect(written).toBeDefined();
    expect(Buffer.from(written as Buffer)).toEqual(bytes);
  });

  test("export(Uint8Array) is accepted", async () => {
    vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
    const exporter = new M3LBinaryFileExporter({
      filePath: "/exports/blob.bin",
    });

    await expect(
      exporter.export(new Uint8Array([1, 2, 3])),
    ).resolves.toBeUndefined();
  });

  test("rejects with an M3LError chaining the underlying cause when the write fails", async () => {
    const writeError = Object.assign(new Error("ENOSPC"), {
      code: "ENOSPC",
    });
    vi.spyOn(fsp, "writeFile").mockRejectedValue(writeError);
    const exporter = new M3LBinaryFileExporter({
      filePath: "/nonexistent-dir/blob.bin",
    });

    let thrown: unknown;
    try {
      await exporter.export(Buffer.from([1]));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).cause).toBe(writeError);
    expect((thrown as M3LError).context).toMatchObject({
      filePath: "/nonexistent-dir/blob.bin",
    });
  });

  test("re-throws an M3LError from the write path unwrapped, without double-wrapping", async () => {
    const original = new M3LError("underlying failure", {
      code: "ERR_UNDERLYING",
    });
    vi.spyOn(fsp, "writeFile").mockRejectedValue(original);
    const exporter = new M3LBinaryFileExporter({
      filePath: "/exports/blob.bin",
    });

    let thrown: unknown;
    try {
      await exporter.export(Buffer.from([1]));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// M3LFileListExporter<TItem> (whole-file list writer)
// ---------------------------------------------------------------------------

describe("M3LFileListExporter", () => {
  interface Row {
    id: string;
  }

  test("export(items) writes the whole list to the configured filePath in one call", async () => {
    let written = "";
    vi.spyOn(fsp, "writeFile").mockImplementation((_path, data) => {
      if (typeof data === "string") {
        written = data;
      } else {
        const view = data as NodeJS.ArrayBufferView;
        written = Buffer.from(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        ).toString();
      }
      return Promise.resolve();
    });
    const exporter = new M3LFileListExporter<Row>({
      filePath: "/exports/list.json",
    });

    await exporter.export([{ id: "1" }, { id: "2" }]);

    expect(written.length).toBeGreaterThan(0);
  });

  test("rejects with an M3LError chaining the underlying cause when the write fails", async () => {
    const writeError = Object.assign(new Error("EISDIR"), {
      code: "EISDIR",
    });
    vi.spyOn(fsp, "writeFile").mockRejectedValue(writeError);
    const exporter = new M3LFileListExporter<Row>({
      filePath: "/exports/is-a-directory",
    });

    let thrown: unknown;
    try {
      await exporter.export([{ id: "1" }]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).cause).toBe(writeError);
    expect((thrown as M3LError).context).toMatchObject({
      filePath: "/exports/is-a-directory",
    });
  });

  test("re-throws an M3LError from the write path unwrapped, without double-wrapping", async () => {
    const original = new M3LError("underlying failure", {
      code: "ERR_UNDERLYING",
    });
    vi.spyOn(fsp, "writeFile").mockRejectedValue(original);
    const exporter = new M3LFileListExporter<Row>({
      filePath: "/exports/list.json",
    });

    let thrown: unknown;
    try {
      await exporter.export([{ id: "1" }]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Sanity: the noop FileHandle double is referenced so eslint/no-unused-vars
// does not flag scaffolding retained for future post-open failure tests.
// ---------------------------------------------------------------------------
void noopHandle;
