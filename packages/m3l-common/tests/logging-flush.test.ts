/**
 * Sibling test file for `core/logging`'s `M3LFileLoggerHandler.flush()` —
 * extracted from `logging.test.ts` after it grew past its
 * `check:file-budget` ceiling (ADR-0072). Follows this repo's
 * `<module>-<facet>.test.ts` sibling convention.
 *
 * Contract source: docs/reference/core/logging.md
 * Exports under test: M3LFileLoggerHandler, M3LLogEventCategory.
 *
 * Key behavioral contracts specific to this file:
 *  - flush() resolves immediately when nothing has been queued.
 *  - flush() waits for a write enqueued *during* the flush() call itself,
 *    not just the queue as it stood when flush() was called — a naive
 *    `async flush() { await this.#writeQueue; }` would capture the queue's
 *    promise reference too early and resolve before a same-tick handle()
 *    lands.
 *  - flush() never rejects, even when every queued write fails (the
 *    underlying exporter failure is reported to stderr instead).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { M3LFileListExporter } from "../src/core/exporters/index.js";
import type { M3LLogEvent } from "../src/core/logging/index.js";
import {
  M3LFileLoggerHandler,
  M3LLogEventCategory,
} from "../src/core/logging/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("M3LFileLoggerHandler.flush()", () => {
  let tempFileCounter = 0;
  let sandboxDir = "";

  // Per-test mkdtemp sandbox (mirrors exporters-atomic-write.test.ts) rather
  // than writing straight into the bare OS tmpdir().
  beforeEach(async () => {
    sandboxDir = await mkdtemp(path.join(tmpdir(), "m3l-logging-flush-"));
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  function nextTempFilePath(): string {
    tempFileCounter += 1;
    return path.join(
      sandboxDir,
      `m3l-logging-flush-test-${tempFileCounter}-${randomUUID()}.json`,
    );
  }

  test("flush() resolves immediately when nothing has been queued", async () => {
    const filePath = nextTempFilePath();
    const handler = new M3LFileLoggerHandler({ filePath });

    await expect(handler.flush()).resolves.toBeUndefined();
  });

  test("flush() waits for a write enqueued during the flush() call itself, not just the queue as it stood when flush() was called", async () => {
    // A naive `async flush() { await this.#writeQueue; }` captures the
    // queue's promise reference *before* the second handle() call below
    // re-chains it onto a new promise — so it would resolve after only the
    // first event landed. The correct implementation loops until the
    // captured reference is stable, which requires this second handle() to
    // land inside the flush too.
    const filePath = nextTempFilePath();
    const handler = new M3LFileLoggerHandler({ filePath });

    handler.handle({ category: M3LLogEventCategory.INFO, message: "first" });
    const flushPromise = handler.flush();
    handler.handle({ category: M3LLogEventCategory.INFO, message: "second" });

    await flushPromise;

    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as M3LLogEvent[];
    expect(parsed.map((event) => event.message)).toEqual(["first", "second"]);
  });

  test("flush() never rejects even when every queued write fails", async () => {
    const exportSpy = vi
      .spyOn(M3LFileListExporter.prototype, "export")
      .mockRejectedValue(new Error("always fails"));
    const filePath = nextTempFilePath();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const handler = new M3LFileLoggerHandler({ filePath });

    handler.handle({
      category: M3LLogEventCategory.INFO,
      message: "will fail to write",
    });

    await expect(handler.flush()).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalled();
    exportSpy.mockRestore();
  });
});
