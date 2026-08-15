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
 * Validates a caller-supplied `resumeFromByte` value: it must be a
 * non-negative safe integer. `0` is valid (it is the "no resume" default).
 *
 * Exported from `internal/` so both {@link M3LJSONListExporter} and
 * {@link M3LCSVListExporter} can validate `options.resumeFromByte` at their
 * public constructor boundary — before any offset reaches
 * `fs.truncateSync`/`fs.createWriteStream`, where an invalid value (a
 * negative offset silently falls through to the default truncate-on-open
 * path; a non-integer offset throws a raw, un-typed `ERR_OUT_OF_RANGE`
 * synchronously from `createWriteStream`) would fail loud but late, and not
 * as an {@link M3LError}.
 *
 * @param value - The candidate `resumeFromByte` value.
 * @returns `true` when `value` is a non-negative safe integer.
 */
export function isValidResumeFromByte(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * A promise-based wrapper around an `fs.WriteStream`, translating its
 * event-based error/finish signaling into awaitable operations.
 *
 * The stream is opened eagerly at construction (matching
 * `exportStream()`'s synchronous contract); any open failure surfaces on the
 * first {@link M3LWriteStreamLifecycle.write} or
 * {@link M3LWriteStreamLifecycle.end} call instead of throwing from the
 * constructor. The same deferred-failure contract applies to a `resumeFromByte`
 * truncate failure (e.g. the file being resumed no longer exists) — and to a
 * `resumeFromByte` that exceeds the file's actual on-disk size, which would
 * otherwise have `fs.truncateSync` silently zero-pad the gap instead of
 * erroring (a `bytesWritten`-derived checkpoint can legitimately outrun the
 * durably-flushed file after an unclean exit, or a checkpoint file can be
 * corrupted/hand-edited). Both are caught at construction and stored the same
 * way an async stream `'error'` is, rather than thrown synchronously, so a
 * caller can always treat "did construction throw" and "did the first write
 * reject" as two different, predictable questions.
 */
export class M3LWriteStreamLifecycle {
  readonly #stream: WriteStream;
  readonly #resumeFromByte: number;
  #pendingError: Error | undefined;

  /**
   * Opens the underlying write stream for `filePath`.
   *
   * @param filePath - The destination file path.
   * @param resumeFromByte - When greater than `0`, truncates the file to this
   *   byte offset and opens the stream in append-at-offset mode
   *   (`{ flags: "r+", start: resumeFromByte }`) instead of the default
   *   truncate-on-open behavior. Defaults to `0` (fresh export, unchanged
   *   behavior).
   */
  constructor(filePath: string, resumeFromByte = 0) {
    this.#resumeFromByte = resumeFromByte;
    if (resumeFromByte > 0) {
      // A truncate failure (including the file not existing) must not throw
      // synchronously — it is deferred to the first write()/end() call,
      // mirroring the async 'error' handling below. `createWriteStream`
      // itself never throws synchronously (it opens the fd lazily), so it is
      // always safe to call unconditionally afterward.
      //
      // Guard against `fs.truncateSync` silently EXTENDING a file shorter
      // than `resumeFromByte`: per POSIX/Node's documented truncate contract,
      // truncating to a length beyond the current size does not error, it
      // zero-pads the gap with NUL bytes. A file can legitimately be shorter
      // than a checkpoint claims because `fs.WriteStream`'s write callback
      // (and the `bytesWritten` counter a caller checkpoints from) fires once
      // the OS has *accepted* a write into its page cache, not once it is
      // durably flushed to disk — an unclean process/OS exit between those
      // two points leaves the on-disk file short. A hand-edited or corrupted
      // checkpoint has the same effect. Either way, resuming onto a
      // too-short file would silently corrupt its tail with NUL bytes and
      // raise no error — exactly what this resume seam exists to prevent.
      try {
        const stat = fs.statSync(filePath);
        if (stat.size < resumeFromByte) {
          throw new Error(
            `resumeFromByte (${String(resumeFromByte)}) exceeds '${filePath}''s actual size (${String(stat.size)}) — the file is shorter than the checkpoint claims; refusing to resume onto it`,
          );
        }
        fs.truncateSync(filePath, resumeFromByte);
      } catch (error) {
        this.#pendingError =
          error instanceof Error ? error : new Error(String(error));
      }
      this.#stream = fs.createWriteStream(filePath, {
        flags: "r+",
        start: resumeFromByte,
      });
    } else {
      this.#stream = fs.createWriteStream(filePath);
    }
    this.#stream.on("error", (error: Error) => {
      // First-error-wins: once a truncate failure (or an earlier stream
      // error) has already been recorded, a later distinct failure on the
      // same stream must not clobber it — the first failure is the more
      // specific diagnostic and the one callers should see.
      this.#pendingError ??= error;
    });
  }

  /**
   * The running total of bytes accepted by this lifecycle, counting from the
   * resume offset it was opened with (`0` for a fresh export).
   *
   * @remarks
   * Read this after an `append()`/`write()` call resolves and checkpoint it;
   * on resume, pass that exact value back in as `resumeFromByte` so the next
   * writer picks up exactly where this one left off, without re-deriving the
   * offset from a separate file-size read that could race a concurrent
   * writer or a partially-flushed OS buffer.
   */
  get bytesWritten(): number {
    return this.#resumeFromByte + this.#stream.bytesWritten;
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
