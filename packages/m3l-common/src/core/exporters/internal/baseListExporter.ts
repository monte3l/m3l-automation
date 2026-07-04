/**
 * `core/exporters/internal/baseListExporter` — shared `M3LListExporter`
 * scaffolding for the CSV/JSON/HTML list exporters.
 *
 * Private to `core/exporters`: never re-exported through the module barrel.
 *
 * @packageDocumentation
 */

import { M3LEventEmitterBase } from "../../events/index.js";

import { M3LWriteStreamLifecycle } from "./writeStreamLifecycle.js";

import type { M3LError } from "../../errors/index.js";
import type {
  M3LListExporter,
  M3LListExporterEvents,
  M3LListExporterStreamWriter,
} from "../types.js";

/**
 * Abstract base carrying the lifecycle scaffolding every list exporter shares:
 * emitting `export:started` / `export:completed` / `export:error` at the right
 * points, opening the `fs.WriteStream` lifecycle, and wrapping the stream
 * writer's `close()` so `export:completed` fires once the output is finalized.
 *
 * Subclasses supply only their serialization logic via three hooks —
 * {@link M3LBaseListExporter.renderBatch}, {@link M3LBaseListExporter.wrapError},
 * and {@link M3LBaseListExporter.createStreamWriter} — and never touch the
 * event channel directly.
 *
 * @typeParam TItem - The shape of each exported item.
 */
export abstract class M3LBaseListExporter<TItem extends object>
  extends M3LEventEmitterBase<M3LListExporterEvents>
  implements M3LListExporter<TItem>
{
  /** The destination file path, shared with subclass render/error hooks. */
  protected readonly filePath: string;

  /**
   * @param filePath - The destination file path.
   */
  protected constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  /**
   * Serializes `items` into the full file content for a batch `export()`.
   * Runs inside `export()`'s try block, so a serialization failure is wrapped
   * and surfaced through `export:error` like any write failure.
   *
   * @param items - The items to serialize.
   * @returns The complete file content.
   */
  protected abstract renderBatch(items: readonly TItem[]): string;

  /**
   * Wraps an unknown failure as a format-specific {@link M3LError}, unless it
   * already is one.
   *
   * @param cause - The caught value.
   * @returns An {@link M3LError} chaining `cause`.
   */
  protected abstract wrapError(cause: unknown): M3LError;

  /**
   * Builds the format-specific incremental writer over an opened `lifecycle`.
   *
   * @param lifecycle - The opened write-stream lifecycle to serialize into.
   * @param onError - Emits `export:error`; the writer guards it so it fires at
   *   most once per writer instance.
   * @returns The format-specific stream writer.
   */
  protected abstract createStreamWriter(
    lifecycle: M3LWriteStreamLifecycle,
    onError: (error: M3LError) => void,
  ): M3LListExporterStreamWriter<TItem>;

  /**
   * Writes all `items` to the configured file in a single call.
   *
   * @param items - The items to export.
   * @returns A promise that resolves once the file has been written.
   * @throws {@link M3LError} chaining the underlying failure; also emitted via
   *   `export:error`.
   */
  async export(items: readonly TItem[]): Promise<void> {
    this.emit("export:started", { filePath: this.filePath });
    try {
      const content = this.renderBatch(items);
      const lifecycle = new M3LWriteStreamLifecycle(this.filePath);
      await lifecycle.end(content);
      this.emit("export:completed", { filePath: this.filePath });
    } catch (cause) {
      const error = this.wrapError(cause);
      this.emit("export:error", { error });
      throw error;
    }
  }

  /**
   * Opens an incremental writer for the configured file.
   *
   * @returns A {@link M3LListExporterStreamWriter} for `TItem`.
   */
  exportStream(): M3LListExporterStreamWriter<TItem> {
    this.emit("export:started", { filePath: this.filePath });
    const lifecycle = new M3LWriteStreamLifecycle(this.filePath);
    const writer = this.createStreamWriter(lifecycle, (error) => {
      this.emit("export:error", { error });
    });
    return {
      append: (item) => writer.append(item),
      close: async () => {
        await writer.close();
        this.emit("export:completed", { filePath: this.filePath });
      },
    };
  }
}
