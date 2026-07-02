/**
 * `core/exporters/internal/writeStreamLifecycle` — shared `fs.WriteStream`
 * lifecycle wrapper for list exporters (CSV/JSON/HTML).
 *
 * Private to `core/exporters`: never re-exported through the module barrel.
 *
 * @packageDocumentation
 */

import * as fs from "node:fs";

import type { WriteStream } from "node:fs";

/**
 * A promise-based wrapper around an `fs.WriteStream`, translating its
 * event-based error/finish signaling into awaitable operations.
 *
 * The stream is opened eagerly at construction (matching
 * `exportStream()`'s synchronous contract); any open failure surfaces on the
 * first {@link M3LWriteStreamLifecycle.write} or
 * {@link M3LWriteStreamLifecycle.end} call instead of throwing from the
 * constructor.
 */
export class M3LWriteStreamLifecycle {
  readonly #stream: WriteStream;
  #pendingError: Error | undefined;

  /**
   * Opens the underlying write stream for `filePath`.
   *
   * @param filePath - The destination file path.
   */
  constructor(filePath: string) {
    this.#stream = fs.createWriteStream(filePath);
    this.#stream.on("error", (error: Error) => {
      this.#pendingError = error;
    });
  }

  /**
   * Writes a chunk to the stream, resolving once the write has been accepted
   * or rejecting with the underlying stream error.
   *
   * Honors backpressure: when the stream's internal buffer is full,
   * `fs.WriteStream#write` returns `false` and the returned promise does not
   * resolve until the stream emits `'drain'`, so a large streaming export
   * cannot buffer unboundedly in memory.
   *
   * @param chunk - The text to write.
   * @returns A promise that resolves once the chunk has been accepted and,
   *   if backpressure applied, the stream has drained.
   */
  write(chunk: string): Promise<void> {
    if (this.#pendingError !== undefined) {
      return Promise.reject(this.#pendingError);
    }
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        this.#stream.off("error", onError);
        this.#stream.off("drain", onDrain);
      };
      this.#stream.once("error", onError);
      const accepted = this.#stream.write(chunk, (writeError) => {
        if (writeError) {
          cleanup();
          reject(writeError);
          return;
        }
        if (accepted) {
          cleanup();
          resolve();
        }
        // else: backpressure applied — the 'drain' listener below resolves
        // once the stream has flushed; 'error' stays registered until
        // whichever of drain/error fires first.
      });
      if (!accepted) {
        this.#stream.once("drain", onDrain);
      }
    });
  }

  /**
   * Ends the stream, optionally writing a final chunk first, resolving once
   * the underlying stream has fully flushed (`finish`) or rejecting on
   * `error`.
   *
   * @param chunk - An optional final chunk to write before ending.
   * @returns A promise that resolves once the stream has finished.
   */
  end(chunk?: string): Promise<void> {
    if (this.#pendingError !== undefined) {
      return Promise.reject(this.#pendingError);
    }
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onFinish = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        this.#stream.off("error", onError);
        this.#stream.off("finish", onFinish);
      };
      this.#stream.once("error", onError);
      this.#stream.once("finish", onFinish);
      if (chunk === undefined) {
        this.#stream.end();
      } else {
        this.#stream.end(chunk);
      }
    });
  }
}
