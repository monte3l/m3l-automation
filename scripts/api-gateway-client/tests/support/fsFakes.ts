import type { FileHandle } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import type { WriteStream } from "node:fs";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";

import { vi } from "vitest";

/**
 * Shared fs-mocking helpers for `api-gateway-client` step tests, mirroring
 * the pattern in `scripts/sqs-etl/tests/support/fsFakes.ts`. Callers must
 * still call `vi.mock("node:fs/promises", ...)` / `vi.mock("node:fs", ...)`
 * directly in their OWN test file (vi.mock hoisting is per-file) before
 * using these helpers.
 */

interface FakeJSONFileHandleShape {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
  stat(): Promise<{ size: number }>;
  close(): Promise<void>;
}

/** Fakes the FileHandle a JSONL importer opens via node:fs/promises.open. */
export function fakeJSONFileHandle(content: string): FileHandle {
  const source = Buffer.from(content, "utf8");
  const handle: FakeJSONFileHandleShape = {
    read: (buffer, offset, length, position) => {
      const slice = source.subarray(position, position + length);
      slice.copy(buffer, offset);
      return Promise.resolve({ bytesRead: slice.length, buffer });
    },
    stat: () => Promise.resolve({ size: source.length }),
    close: () => Promise.resolve(),
  };
  return handle as unknown as FileHandle;
}

/** Stubs both fs read paths a JSONL importer uses for a string source. */
export function stubInput(content: string): void {
  vi.spyOn(fsp, "readFile").mockResolvedValue(Buffer.from(content, "utf8"));
  vi.spyOn(fsp, "open").mockImplementation(() =>
    Promise.resolve(fakeJSONFileHandle(content)),
  );
}

/** A minimal fake fs.WriteStream: records every chunk written to it. */
export class FakeWriteStream extends EventEmitter {
  chunks: string[] = [];
  #closeFailure: Error | undefined;

  write(chunk: string | Buffer, cb?: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk.toString());
    queueMicrotask(() => {
      cb?.();
    });
    return true;
  }

  /**
   * Arms this stream so its next `end()` call emits `'error'` with `error`
   * instead of `'finish'` — simulates a close failure (e.g. disk full) for
   * covering the try/finally-masks-the-real-error bug. Does not affect
   * `write()`; every other test's default `end()` -> `'finish'` behavior is
   * unchanged unless this is called first.
   */
  armCloseFailure(error: Error): void {
    this.#closeFailure = error;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) {
      this.chunks.push(chunk.toString());
    }
    const closeFailure = this.#closeFailure;
    if (closeFailure !== undefined) {
      queueMicrotask(() => this.emit("error", closeFailure));
      return this;
    }
    queueMicrotask(() => this.emit("finish"));
    return this;
  }

  content(): string {
    return this.chunks.join("");
  }
}

/**
 * Installs a fake `fs.createWriteStream` that hands back a fresh
 * {@link FakeWriteStream} per call (a step may open more than one output —
 * e.g. the main output plus `failed.jsonl`), collecting every stream created
 * in call order.
 */
export function stubOutputStreams(): { streams: FakeWriteStream[] } {
  const streams: FakeWriteStream[] = [];
  vi.spyOn(fs, "createWriteStream").mockImplementation(() => {
    const stream = new FakeWriteStream();
    streams.push(stream);
    return stream as unknown as WriteStream;
  });
  return { streams };
}

/** Parses a fake write stream's buffered content as newline-delimited JSON. */
export function writtenJsonlRecords(stream: FakeWriteStream): unknown[] {
  return stream
    .content()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));
}
