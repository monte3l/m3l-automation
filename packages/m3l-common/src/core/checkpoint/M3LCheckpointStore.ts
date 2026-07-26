/**
 * `core/checkpoint/M3LCheckpointStore` — resume-state persistence for
 * long-running consumer scripts.
 *
 * @packageDocumentation
 */

import * as fsp from "node:fs/promises";

import { isEnoentError } from "../utils/guards.js";
import { writeFileAtomic } from "../../internal/files/atomicWrite.js";
import { M3LCheckpointError } from "./M3LCheckpointError.js";

// ---------------------------------------------------------------------------
// M3LCheckpointPathsPort
// ---------------------------------------------------------------------------

/**
 * The structural subset of `M3LPaths` {@link M3LCheckpointStore} needs — just
 * `resolveOutput`. A real `M3LPaths` instance satisfies this port, and a test
 * can inject a bare object without constructing one.
 *
 * @example
 * ```ts
 * import type { M3LCheckpointPathsPort } from "@m3l-automation/m3l-common/core";
 * import path from "node:path";
 *
 * const port: M3LCheckpointPathsPort = {
 *   resolveOutput: (name) => path.join("/tmp/out", name),
 * };
 * ```
 */
export interface M3LCheckpointPathsPort {
  /**
   * Resolves `name` to an absolute path inside the output directory.
   *
   * @param name - A relative file name to resolve.
   * @returns The resolved absolute path.
   */
  resolveOutput(name: string): string;
}

// ---------------------------------------------------------------------------
// M3LCheckpointMissingPolicy
// ---------------------------------------------------------------------------

/**
 * What {@link M3LCheckpointStore.read} does when no checkpoint file exists
 * (`ENOENT`).
 *
 * - `{ kind: "empty", value: TCheckpoint }` — a fresh run starts from `value`
 *   (returned by identity, not cloned).
 * - `{ kind: "error" }` — throws {@link M3LCheckpointError} with code
 *   `"ERR_CHECKPOINT_MISSING"`. This is the contract for `--resume`: an
 *   absent checkpoint under an explicit resume request is a caller/config
 *   error, never a silent fresh start.
 *
 * @example
 * ```ts
 * import type { M3LCheckpointMissingPolicy } from "@m3l-automation/m3l-common/core";
 *
 * interface RunCheckpoint {
 *   readonly cursor?: string;
 * }
 *
 * const policy: M3LCheckpointMissingPolicy<RunCheckpoint> = {
 *   kind: "empty",
 *   value: {},
 * };
 * ```
 */
export type M3LCheckpointMissingPolicy<TCheckpoint extends object> =
  | { readonly kind: "empty"; readonly value: TCheckpoint }
  | { readonly kind: "error" };

// ---------------------------------------------------------------------------
// M3LCheckpointStoreOptions
// ---------------------------------------------------------------------------

/**
 * Constructor options for {@link M3LCheckpointStore}.
 *
 * @example
 * ```ts
 * import type { M3LCheckpointStoreOptions } from "@m3l-automation/m3l-common/core";
 * import { M3LPaths } from "@m3l-automation/m3l-common/core";
 *
 * interface RunCheckpoint {
 *   readonly cursor?: string;
 * }
 *
 * function isRunCheckpoint(value: unknown): value is RunCheckpoint {
 *   if (typeof value !== "object" || value === null) return false;
 *   const cursor = (value as Partial<RunCheckpoint>).cursor;
 *   return cursor === undefined || typeof cursor === "string";
 * }
 *
 * const options: M3LCheckpointStoreOptions<RunCheckpoint> = {
 *   paths: new M3LPaths(),
 *   name: "my-run",
 *   validate: isRunCheckpoint,
 *   missing: { kind: "empty", value: {} },
 * };
 * ```
 */
export interface M3LCheckpointStoreOptions<TCheckpoint extends object> {
  /** Resolves the checkpoint file's directory. */
  readonly paths: M3LCheckpointPathsPort;
  /**
   * The run's stable identity key. The file is
   * `<output-dir>/<name>.checkpoint.json`. Never a correlation id — a
   * resuming invocation must regenerate the same `name` a prior invocation
   * used.
   */
  readonly name: string;
  /**
   * Narrows a JSON-parsed value to `TCheckpoint`. Required, not optional — a
   * value that fails this predicate is treated identically to malformed JSON
   * (`"ERR_CHECKPOINT_PARSE"`).
   */
  readonly validate: (value: unknown) => value is TCheckpoint;
  /** What `read()` returns when the checkpoint file does not exist. */
  readonly missing: M3LCheckpointMissingPolicy<TCheckpoint>;
}

// ---------------------------------------------------------------------------
// M3LCheckpointStore
// ---------------------------------------------------------------------------

/**
 * A generic, atomic JSON checkpoint store: resume-state persistence for
 * long-running consumer scripts. A checkpoint is a small JSON document — a
 * query id, a scan cursor, a set of completed pagination windows — written
 * to a single flat file at `<output-dir>/<name>.checkpoint.json` and read
 * back when a script is invoked with `--resume`.
 *
 * The store is deliberately narrow: it owns file I/O, atomicity, and the
 * missing-checkpoint policy. It has no opinion on the checkpoint's payload
 * shape, on when a caller writes (cadence), or on whether a caller deletes
 * on success — those stay script-specific.
 *
 * `TCheckpoint extends object` — bounded this way rather than
 * `Record<string, unknown>` so a declared `interface` payload (which has no
 * implicit index signature) is a valid instantiation.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * interface AthenaCheckpoint {
 *   readonly queryExecutionId?: string;
 * }
 *
 * function isAthenaCheckpoint(value: unknown): value is AthenaCheckpoint {
 *   if (typeof value !== "object" || value === null) return false;
 *   const id = (value as Partial<AthenaCheckpoint>).queryExecutionId;
 *   return id === undefined || typeof id === "string";
 * }
 *
 * const paths = new Core.M3LPaths();
 * const store = new Core.M3LCheckpointStore<AthenaCheckpoint>({
 *   paths,
 *   name: "athena-run-2026-07-26",
 *   validate: isAthenaCheckpoint,
 *   missing: { kind: "empty", value: {} },
 * });
 *
 * const checkpoint = await store.read();
 * await store.write({ queryExecutionId: "q-123" });
 * await store.delete();
 * ```
 */
export class M3LCheckpointStore<TCheckpoint extends object> {
  /** Resolved absolute checkpoint file path, computed once at construction. */
  readonly #path: string;

  /** Narrows a JSON-parsed value to `TCheckpoint`. */
  readonly #validate: (value: unknown) => value is TCheckpoint;

  /** What `read()` does when the checkpoint file does not exist. */
  readonly #missing: M3LCheckpointMissingPolicy<TCheckpoint>;

  /**
   * Creates a new `M3LCheckpointStore`.
   *
   * @param options - Constructor options; see
   *   {@link M3LCheckpointStoreOptions}.
   * @throws Whatever `options.paths.resolveOutput` throws (e.g.
   *   `M3LPathResolutionError` for an unsafe `name`) — propagated unchanged,
   *   never wrapped in `M3LCheckpointError`.
   */
  constructor(options: M3LCheckpointStoreOptions<TCheckpoint>) {
    this.#path = options.paths.resolveOutput(`${options.name}.checkpoint.json`);
    this.#validate = options.validate;
    this.#missing = options.missing;
  }

  /**
   * The resolved absolute checkpoint file path, computed once at
   * construction. Safe to log.
   *
   * @returns The absolute checkpoint file path.
   */
  get path(): string {
    return this.#path;
  }

  /**
   * Reads, JSON-parses, and validates the checkpoint file.
   *
   * Applies the `missing` policy only on `ENOENT` — a present-but-corrupt
   * file (or one that fails `validate`) always throws
   * `"ERR_CHECKPOINT_PARSE"`, regardless of the `missing` policy.
   *
   * @returns The parsed and validated checkpoint.
   * @throws {@link M3LCheckpointError} `"ERR_CHECKPOINT_MISSING"` when the
   *   file is absent under a `{ kind: "error" }` policy;
   *   `"ERR_CHECKPOINT_PARSE"` when the file is present but not valid JSON or
   *   fails `validate`; `"ERR_CHECKPOINT_IO"` for any other read failure.
   */
  async read(): Promise<TCheckpoint> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.#path, "utf8");
    } catch (cause) {
      if (isEnoentError(cause)) {
        if (this.#missing.kind === "empty") return this.#missing.value;
        throw new M3LCheckpointError(
          `checkpoint file at '${this.#path}' does not exist`,
          {
            code: "ERR_CHECKPOINT_MISSING",
            context: { path: this.#path },
            cause,
          },
        );
      }
      throw new M3LCheckpointError(
        `failed to read checkpoint file at '${this.#path}'`,
        { code: "ERR_CHECKPOINT_IO", context: { path: this.#path }, cause },
      );
    }

    // Guard the parse step separately: a SyntaxError's message embeds a
    // snippet of the malformed content, so it must never propagate raw or be
    // chained as `cause` — a checkpoint may hold caller data.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new M3LCheckpointError(
        `checkpoint file at '${this.#path}' is not valid JSON`,
        { code: "ERR_CHECKPOINT_PARSE", context: { path: this.#path } },
      );
    }

    if (!this.#validate(parsed)) {
      throw new M3LCheckpointError(
        `checkpoint file at '${this.#path}' has an unrecognized shape`,
        { code: "ERR_CHECKPOINT_PARSE", context: { path: this.#path } },
      );
    }

    return parsed;
  }

  /**
   * Persists `checkpoint` atomically (write-temp-then-rename), replacing
   * any prior contents.
   *
   * Does **not** create the output directory — an `ENOENT` from a missing
   * parent directory maps to `"ERR_CHECKPOINT_IO"`, never
   * `"ERR_CHECKPOINT_MISSING"` (that code is reserved for `read()`).
   *
   * @param checkpoint - The checkpoint value to persist.
   * @throws {@link M3LCheckpointError} `"ERR_CHECKPOINT_IO"` on any write
   *   failure.
   */
  async write(checkpoint: TCheckpoint): Promise<void> {
    try {
      await writeFileAtomic(this.#path, JSON.stringify(checkpoint));
    } catch (cause) {
      throw new M3LCheckpointError(
        `failed to write checkpoint file at '${this.#path}'`,
        { code: "ERR_CHECKPOINT_IO", context: { path: this.#path }, cause },
      );
    }
  }

  /**
   * Deletes the checkpoint file. Tolerant of it already being absent.
   *
   * @throws {@link M3LCheckpointError} `"ERR_CHECKPOINT_IO"` on any deletion
   *   failure other than the file already being absent.
   */
  async delete(): Promise<void> {
    try {
      await fsp.unlink(this.#path);
    } catch (cause) {
      if (isEnoentError(cause)) return;
      throw new M3LCheckpointError(
        `failed to delete checkpoint file at '${this.#path}'`,
        { code: "ERR_CHECKPOINT_IO", context: { path: this.#path }, cause },
      );
    }
  }
}
