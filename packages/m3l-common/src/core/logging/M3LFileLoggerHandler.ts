/**
 * `core/logging/M3LFileLoggerHandler` — whole-file, order-preserving log
 * sink.
 *
 * @packageDocumentation
 */

import {
  assertValidFloor,
  passesFloor,
} from "../../internal/logging/levels.js";
import { M3LError } from "../errors/index.js";
import { M3LFileListExporter } from "../exporters/M3LFileListExporter.js";
import type {
  M3LLogEventCategory,
  M3LLogLevelFloor,
} from "./M3LLogEventCategory.js";
import type { M3LLogEvent, M3LLoggerHandler } from "./M3LLogEvent.js";

/**
 * Construction options for {@link M3LFileLoggerHandler}.
 *
 * @example
 * ```ts
 * import type { M3LFileLoggerHandlerOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LFileLoggerHandlerOptions = { filePath: "run.log" };
 * ```
 */
export interface M3LFileLoggerHandlerOptions {
  /** The destination file path. */
  readonly filePath: string;
  /**
   * This handler's own severity floor; see
   * {@link M3LLoggerOptions.minLevel} for the full contract (composition
   * with the owning {@link M3LLogger}'s floor, the rank-tie behavior).
   */
  readonly minLevel?: M3LLogLevelFloor;
}

/**
 * Accumulates every {@link M3LLogEvent} it receives and streams the whole
 * accumulated list to `filePath` via {@link M3LFileListExporter}, whose
 * `export()` overwrites the file on every call. Writes are serialized
 * through an internal sequential promise-chain queue so concurrent or rapid
 * `handle()` calls never interleave and the file always reflects the events
 * in emit order.
 *
 * `handle()` is synchronous and returns before the queued write settles;
 * callers that need the write to have landed should poll the file (as the
 * test suite does with `vi.waitFor`).
 *
 * `reset()` is intentionally a no-op — logs must survive a script reset
 * rather than being silently discarded.
 *
 * **Ratified tradeoff — bounded, single-run use only.** Every event is kept
 * in memory for the handler's lifetime, and every `handle()` call rewrites
 * the *entire* accumulated history to disk (O(n²) total I/O across a run,
 * plus unbounded memory growth). This is intended for a bounded, per-run log
 * (a script's own execution log), not a high-volume or long-lived streaming
 * sink — for that, use a streaming exporter instead.
 *
 * **Security note.** Events are persisted **verbatim** (unredacted) to
 * `filePath`. If a message or its `data` may carry secrets, pre-redact with
 * {@link redactSensitiveLogText} / {@link redactSensitiveLogValue} before
 * calling a logger method — this handler performs no redaction itself.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const handler = new Core.M3LFileLoggerHandler({ filePath: "run.log" });
 * const logger = new Core.M3LLogger([handler]);
 * logger.step("Reading source file");
 * ```
 */
export class M3LFileLoggerHandler implements M3LLoggerHandler {
  readonly #exporter: M3LFileListExporter<M3LLogEvent>;
  readonly #events: M3LLogEvent[] = [];
  readonly #minLevel: M3LLogEventCategory | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  /**
   * Creates a file logger handler writing to `options.filePath`.
   *
   * @param options - Construction options.
   */
  constructor(options: M3LFileLoggerHandlerOptions) {
    assertValidFloor(options.minLevel, "M3LFileLoggerHandler");
    this.#exporter = new M3LFileListExporter<M3LLogEvent>({
      filePath: options.filePath,
    });
    this.#minLevel = options.minLevel;
  }

  /**
   * Appends `event` to the in-memory history and enqueues a whole-file
   * rewrite of the accumulated history. Returns synchronously; the queued
   * write settles asynchronously. Self-filters against this handler's own
   * `minLevel` floor before appending.
   *
   * @param event - The event to append and persist.
   */
  handle(event: M3LLogEvent): void {
    if (!passesFloor(event.category, this.#minLevel)) return;

    this.#events.push(event);
    const snapshot = [...this.#events];
    // Chain onto the existing queue so writes stay strictly sequential. The
    // chained callback always resolves (see #writeSnapshot) so a failed
    // write never poisons the chain for the writes queued after it.
    this.#writeQueue = this.#writeQueue.then(() =>
      this.#writeSnapshot(snapshot),
    );
  }

  /**
   * Exports `snapshot`, reporting (never throwing) a failure. A rejection
   * here must not become an unhandled promise rejection and must not break
   * the sequential queue for subsequent writes, so it is caught and
   * reported to `process.stderr` as a best-effort diagnostic — `handle()`
   * is synchronous and gives the caller no promise to await or catch.
   */
  async #writeSnapshot(snapshot: readonly M3LLogEvent[]): Promise<void> {
    try {
      await this.#exporter.export(snapshot);
    } catch (cause) {
      // The exporter throws a typed M3LError (code ERR_FILE_LIST_EXPORT);
      // surface its code/message instead of flattening to `String(cause)`,
      // which would discard the structured diagnostic. Never include event
      // `message`/`data` here — only the exporter's own failure detail.
      const detail =
        cause instanceof M3LError
          ? `[${cause.code}] ${cause.message}`
          : String(cause);
      process.stderr.write(
        `m3l-logging: M3LFileLoggerHandler failed to write log file: ${detail}\n`,
      );
    }
  }

  /**
   * No-op: the accumulated log history must survive a `reset()` call, so
   * this method intentionally does nothing.
   */
  reset(): void {
    // Intentionally empty — logs are never cleared by reset().
  }
}
