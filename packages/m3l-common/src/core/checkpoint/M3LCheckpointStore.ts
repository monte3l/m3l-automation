/**
 * `core/checkpoint/M3LCheckpointStore` — resume-state persistence for
 * long-running consumer scripts.
 *
 * @packageDocumentation
 */

import * as fsp from "node:fs/promises";

import { canonicalJsonHash } from "../json/index.js";
import { isEnoentError, isPlainObject } from "../utils/guards.js";
import { writeFileAtomic } from "../../internal/files/atomicWrite.js";
import { M3LCheckpointError } from "./M3LCheckpointError.js";

// ---------------------------------------------------------------------------
// M3LCheckpointRawEnvelope — untrusted parse-time shape
// ---------------------------------------------------------------------------

/**
 * The JSON-parsed shape of a content-addressed envelope before any field
 * types are trusted. Used only by {@link isCheckpointEnvelope} (as the
 * narrowed type) and {@link M3LCheckpointStore.#verifyEnvelope} (as its
 * parameter type). Not exported — the caller never sees this type directly.
 *
 * `fingerprint` is typed as `unknown` (not `string`) because `JSON.parse`
 * can produce any JSON value; the `string` constraint is enforced at runtime
 * inside `#verifyEnvelope`, allowing the method to throw
 * `"ERR_CHECKPOINT_CORRUPT"` on a present-but-non-string value rather than
 * silently accepting it.
 */
interface M3LCheckpointRawEnvelope {
  readonly __m3lCheckpointFormat: 1;
  readonly checksum: string;
  readonly fingerprint?: unknown;
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// M3LCheckpointEnvelope — trusted write-time shape
// ---------------------------------------------------------------------------

/**
 * The on-disk content-addressed envelope {@link M3LCheckpointStore.write}
 * persists. Not exported — an implementation detail of the file format, never
 * a value a caller constructs or receives directly.
 *
 * `fingerprint` is narrowed to `string` here (the trusted write shape) because
 * `write()` always sets it from `this.#fingerprint`, which is already a
 * `string`. The complementary parsed/untrusted shape is
 * {@link M3LCheckpointRawEnvelope}, used only on the read path.
 */
interface M3LCheckpointEnvelope<TCheckpoint> {
  readonly __m3lCheckpointFormat: 1;
  readonly checksum: string;
  readonly fingerprint?: string;
  readonly payload: TCheckpoint;
}

// ---------------------------------------------------------------------------
// isCheckpointEnvelope
// ---------------------------------------------------------------------------

/**
 * Narrows a JSON-parsed value to {@link M3LCheckpointRawEnvelope}. Uses
 * `Object.hasOwn` throughout rather than bracket access, since `value` came
 * from `JSON.parse` and must not be trusted to walk the prototype chain
 * safely (e.g. a field literally named `"__proto__"`).
 *
 * Deliberately does **not** check `fingerprint`'s presence or type — those
 * checks live inside `#verifyEnvelope`, where a present-but-non-string value
 * throws `"ERR_CHECKPOINT_CORRUPT"` rather than being ignored (widening the
 * guard here would demote such a file to the legacy bare-JSON path, silently
 * skipping the `checksum` check too).
 *
 * Edge case (accepted, not a design flaw): a legacy (pre-envelope)
 * `TCheckpoint` payload that happens to declare fields literally named
 * `__m3lCheckpointFormat` (value `1`), `checksum` (a string), and `payload`
 * would be misidentified as an envelope by this guard. This is considered an
 * acceptable, low-probability limitation given the namespaced marker field
 * name.
 */
function isCheckpointEnvelope(
  value: unknown,
): value is M3LCheckpointRawEnvelope {
  return (
    isPlainObject(value) &&
    Object.hasOwn(value, "__m3lCheckpointFormat") &&
    value["__m3lCheckpointFormat"] === 1 &&
    Object.hasOwn(value, "checksum") &&
    typeof value["checksum"] === "string" &&
    Object.hasOwn(value, "payload")
  );
}

// ---------------------------------------------------------------------------
// isContentDiscardingObject
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `value` is an object whose content would be silently
 * discarded by `JSON.stringify` — specifically, a non-array, non-plain object
 * with no `toJSON` method and no own enumerable properties (e.g. `Map`,
 * `Set`, `WeakMap`, `RegExp`). Such a value produces a canonical JSON hash
 * identical to `{}`, yielding a fingerprint that can never mismatch and
 * neutering the fingerprinting check silently.
 *
 * Returns `false` for plain objects (own enumerable properties ARE the
 * content), arrays, `null`, primitives, objects with a `toJSON` method, and
 * objects with at least one own enumerable property.
 *
 * Wraps `Object.keys` and the `in` operator in a `try`/`catch` so a hostile
 * `Proxy` with throwing traps cannot escape the constructor as a raw error —
 * it is treated as discarding content, which fails safe.
 */
function isContentDiscardingObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false; // primitive, null, or array — no discard concern
  }
  if (isPlainObject(value)) {
    return false; // plain object: own enumerable properties are the content
  }
  // Non-plain, non-array object: check whether JSON.stringify can reach its
  // content via toJSON or own enumerable properties.
  try {
    if ("toJSON" in value) return false; // controls its own serialisation
    if (Object.keys(value).length > 0) return false; // has own data
    return true; // no accessible content (Map, Set, WeakMap, RegExp, …)
  } catch {
    // Hostile Proxy with throwing traps — fail safe by treating as discarding.
    return true;
  }
}

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
  /**
   * **Optional.** The resolved configuration that gives this run's stored
   * offsets their meaning — an Athena SQL query, a Logs-Insights time window
   * plus log-group list, a DynamoDB table plus segment count. Supplying it
   * opts into **fingerprinting**: `write()` stamps
   * `canonicalJsonHash(definition)` onto the envelope as `fingerprint`, and
   * `read()` refuses to resume from a checkpoint written under a different
   * definition (throws `"ERR_CHECKPOINT_FINGERPRINT_MISMATCH"`).
   *
   * The hash is computed **once, at construction**, so a value the
   * constructor rejects (see below) throws `"ERR_CHECKPOINT_DEFINITION"` from
   * the constructor rather than surfacing on the first `read()` or `write()`.
   * The value is never persisted and never reaches a `message`, `context`, or
   * `cause` — only its hash is stored.
   *
   * **Rejected definitions.** The constructor rejects three categories:
   * - `function` or `symbol` — both canonicalise to `null` and cannot
   *   produce a meaningful fingerprint.
   * - A non-array object with no `toJSON` method and no own enumerable
   *   properties (e.g. `Map`, `Set`, `WeakMap`, `RegExp`) — such a value
   *   canonicalises identically to `{}` regardless of its internal state,
   *   so its fingerprint can never mismatch.
   * - A value `canonicalJsonHash` cannot hash (circular reference, `BigInt`,
   *   non-finite number).
   *
   * Accepted: `{ query: "SELECT 1" }`, an honestly-empty `{}`, `[]`, a
   * `Date` (has `toJSON`), a class instance carrying own data properties,
   * and primitives including `null`, `0`, `false`, `""`.
   *
   * Omitting this field preserves today's behaviour exactly (no
   * fingerprinting).
   *
   * @throws {@link M3LCheckpointError} `"ERR_CHECKPOINT_DEFINITION"` — from
   *   the constructor — when the supplied value is a function, a symbol, a
   *   non-array object with no accessible content, or unhashable by
   *   `canonicalJsonHash`.
   */
  readonly definition?: unknown;
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
   * `canonicalJsonHash(definition)` when `definition` was supplied; otherwise
   * `undefined`. Stamped onto envelopes by `write()` and compared by `read()`.
   */
  readonly #fingerprint: string | undefined = undefined;

  /**
   * Creates a new `M3LCheckpointStore`.
   *
   * @param options - Constructor options; see
   *   {@link M3LCheckpointStoreOptions}.
   * @throws Whatever `options.paths.resolveOutput` throws (e.g.
   *   `M3LPathResolutionError` for an unsafe `name`) — propagated unchanged,
   *   never wrapped in `M3LCheckpointError`. Path resolution runs first;
   *   definition hashing does not begin until the path succeeds.
   * @throws {@link M3LCheckpointError} `"ERR_CHECKPOINT_DEFINITION"` when
   *   `options.definition` is supplied but is a `function`, a `symbol`, a
   *   non-array object with no `toJSON` and no own enumerable properties
   *   (e.g. `Map`, `Set`, `WeakMap`, `RegExp`), or a value `canonicalJsonHash`
   *   cannot hash (circular reference, `BigInt`, non-finite number). Never
   *   chains a `cause` — the underlying error's message can embed the
   *   definition value.
   */
  constructor(options: M3LCheckpointStoreOptions<TCheckpoint>) {
    // Path resolution must come first — an unsafe name throws
    // M3LPathResolutionError unwrapped, before definition hashing begins.
    this.#path = options.paths.resolveOutput(`${options.name}.checkpoint.json`);
    this.#validate = options.validate;
    this.#missing = options.missing;

    if (options.definition !== undefined) {
      // Reject definitions whose canonical form silently discards content:
      // functions and symbols both canonicalise to null, and non-plain objects
      // with no toJSON and no own properties (Map, Set, WeakMap, RegExp, …)
      // canonicalise identically to {} regardless of their internal state.
      // Either case yields a fingerprint that can never mismatch — a no-op
      // exactly where fingerprinting is supposed to fail loud.
      if (
        typeof options.definition === "function" ||
        typeof options.definition === "symbol"
      ) {
        throw new M3LCheckpointError(
          `checkpoint store at '${this.#path}': definition must be a JSON-serializable value — functions and symbols canonicalise to null and cannot produce a meaningful fingerprint`,
          {
            code: "ERR_CHECKPOINT_DEFINITION",
            context: { path: this.#path },
          },
        );
      }
      if (isContentDiscardingObject(options.definition)) {
        throw new M3LCheckpointError(
          `checkpoint store at '${this.#path}': definition must expose its content as own enumerable properties or via a toJSON method — Map, Set, WeakMap, and RegExp instances fingerprint identically to {}`,
          {
            code: "ERR_CHECKPOINT_DEFINITION",
            context: { path: this.#path },
          },
        );
      }
      try {
        this.#fingerprint = canonicalJsonHash(options.definition);
      } catch {
        // Never chain `cause`: canonicalJsonHash's thrown message can embed
        // the caller's actual (possibly sensitive) definition value.
        throw new M3LCheckpointError(
          `checkpoint store at '${this.#path}' could not hash the supplied definition: must be JSON-serializable (no circular references, BigInt, or non-finite numbers)`,
          {
            code: "ERR_CHECKPOINT_DEFINITION",
            context: { path: this.#path },
          },
        );
      }
    }
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
   * Reads, JSON-parses, verifies, and validates the checkpoint file.
   *
   * Applies the `missing` policy only on `ENOENT` — a present-but-unusable
   * file (fails validation, fails its integrity check, or carries a mismatched
   * fingerprint) always throws, regardless of the `missing` policy. When the
   * parsed content is a content-addressed envelope (see {@link write}), its
   * stored `checksum` is recomputed and compared before the wrapped payload
   * is unwrapped and validated — a mismatch throws
   * `"ERR_CHECKPOINT_CORRUPT"` even though the file is valid JSON and its
   * payload might otherwise pass `validate`. A pre-existing bare-format file
   * (written before this integrity check existed, or by an older library
   * version) has no envelope and thus nothing to compare against: it is read
   * and validated exactly as before, with no integrity check performed.
   *
   * @returns The parsed, verified, and validated checkpoint.
   * @throws {@link M3LCheckpointError} `"ERR_CHECKPOINT_MISSING"` when the
   *   file is absent under a `{ kind: "error" }` policy;
   *   `"ERR_CHECKPOINT_CORRUPT"` when an envelope's stored `checksum` does
   *   not match the recomputed hash of its `payload`, or when the envelope's
   *   `fingerprint` field is present but not a string; `"ERR_CHECKPOINT_PARSE"`
   *   when the file is present but not valid JSON, fails `validate`, or its
   *   envelope's `payload` cannot be hashed for checksum verification (e.g. a
   *   deeply-nested external payload overflows the call stack);
   *   `"ERR_CHECKPOINT_FINGERPRINT_MISMATCH"` when a `definition` was
   *   supplied to the constructor and the envelope carries a `fingerprint` that
   *   does not match — checked after the `checksum` succeeds;
   *   `"ERR_CHECKPOINT_IO"` for any other read failure.
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

    const payload = isCheckpointEnvelope(parsed)
      ? this.#verifyEnvelope(parsed)
      : parsed;

    if (!this.#validate(payload)) {
      throw new M3LCheckpointError(
        `checkpoint file at '${this.#path}' has an unrecognized shape`,
        { code: "ERR_CHECKPOINT_PARSE", context: { path: this.#path } },
      );
    }

    return payload;
  }

  /**
   * Verifies the checksum and fingerprint of a detected content-addressed
   * envelope and returns its `payload`.
   *
   * Separated from {@link read} to keep each method within the project's
   * complexity budget. All thrown errors use the same `"ERR_CHECKPOINT_*"`
   * codes as the surrounding `read()` call.
   *
   * @param envelope - A value already narrowed by `isCheckpointEnvelope`.
   *   Typed as {@link M3LCheckpointRawEnvelope} (the untrusted parse-time
   *   shape) so `fingerprint` is `unknown` rather than `string`, avoiding
   *   any cast to perform the runtime type check.
   * @returns The envelope's `payload` when all checks pass.
   * @throws {@link M3LCheckpointError} `"ERR_CHECKPOINT_PARSE"` when the
   *   payload cannot be hashed; `"ERR_CHECKPOINT_CORRUPT"` on a checksum
   *   mismatch or a non-string `fingerprint` field;
   *   `"ERR_CHECKPOINT_FINGERPRINT_MISMATCH"` when the stored fingerprint
   *   differs from the store's current definition fingerprint.
   */
  #verifyEnvelope(envelope: M3LCheckpointRawEnvelope): unknown {
    // Guard the checksum recomputation: canonicalJsonHash recurses per nesting
    // level of `envelope.payload`, which is untrusted external content that
    // may be deeply nested (a stack-overflow RangeError) or otherwise
    // unhashable — never chain as `cause`, matching the JSON.parse guard.
    let recomputed: string;
    try {
      recomputed = canonicalJsonHash(envelope.payload);
    } catch {
      throw new M3LCheckpointError(
        `checkpoint file at '${this.#path}' could not be verified`,
        { code: "ERR_CHECKPOINT_PARSE", context: { path: this.#path } },
      );
    }

    if (recomputed !== envelope.checksum) {
      throw new M3LCheckpointError(
        `checkpoint file at '${this.#path}' failed its integrity check: stored content does not match its checksum`,
        { code: "ERR_CHECKPOINT_CORRUPT", context: { path: this.#path } },
      );
    }

    // Read the fingerprint using Object.hasOwn — not direct property access —
    // so a value literally named "fingerprint" on Object.prototype (prototype
    // pollution) is never treated as an own property. A polluted prototype
    // getter that throws would otherwise propagate a raw Error out of read()
    // with no M3LCheckpointError code, breaking the documented contract.
    // isCheckpointEnvelope already documents and follows this convention.
    // The envelope type is M3LCheckpointRawEnvelope (fingerprint?: unknown),
    // so no cast is needed to perform the runtime string check below.
    const rawFingerprint: unknown = Object.hasOwn(envelope, "fingerprint")
      ? envelope.fingerprint
      : undefined;

    // A present-but-non-string fingerprint is a corrupt envelope, not a
    // legacy file — see the spec note on why the guard is not widened to
    // cover fingerprint's type (it would skip the checksum check too).
    if (rawFingerprint !== undefined && typeof rawFingerprint !== "string") {
      throw new M3LCheckpointError(
        `checkpoint file at '${this.#path}' has a corrupt fingerprint field`,
        { code: "ERR_CHECKPOINT_CORRUPT", context: { path: this.#path } },
      );
    }

    // After the throw above, rawFingerprint is narrowed to string | undefined.
    // The typeof conjunct is not needed — the compiler narrows correctly
    // through the negation of the previous guard.
    //
    // Fingerprint mismatch: the envelope is intact but was written under a
    // different definition — its offsets no longer mean what they meant.
    // Only checked when both the store has a definition (this.#fingerprint)
    // and the envelope carries a string fingerprint; all other combinations
    // fall through and read as before (see spec read matrix).
    if (
      this.#fingerprint !== undefined &&
      rawFingerprint !== undefined &&
      rawFingerprint !== this.#fingerprint
    ) {
      throw new M3LCheckpointError(
        `checkpoint file at '${this.#path}' was written under a different definition`,
        {
          code: "ERR_CHECKPOINT_FINGERPRINT_MISMATCH",
          context: { path: this.#path },
        },
      );
    }

    return envelope.payload;
  }

  /**
   * Persists `checkpoint` atomically (write-temp-then-rename), replacing any
   * prior contents.
   *
   * Wraps `checkpoint` in a content-addressed envelope (format marker,
   * `canonicalJsonHash` checksum, optional `fingerprint`, and the checkpoint
   * itself as `payload`) rather than persisting the bare value. This lets a
   * later `read()` verify the file's integrity against **accidental**
   * corruption. When a `definition` was supplied to the constructor, the
   * envelope also carries `fingerprint: canonicalJsonHash(definition)` so
   * `read()` can detect a configuration change between runs. When no
   * `definition` was supplied, the `fingerprint` key is omitted entirely.
   *
   * The checksum and fingerprint are not tamper-evidence or authentication
   * guarantees: both are unkeyed hashes over publicly canonical JSON
   * (computable via the exported `canonicalJsonHash`), so anyone with write
   * access to the file can recompute matching values, or strip the envelope
   * back to the legacy bare format — either bypasses the checks with no
   * special knowledge.
   *
   * Does **not** create the output directory — an `ENOENT` from a missing
   * parent directory maps to `"ERR_CHECKPOINT_IO"`, never
   * `"ERR_CHECKPOINT_MISSING"` (that code is reserved for `read()`).
   *
   * The checksum is computed inside its own `try`/`catch`: `canonicalJsonHash`
   * throws on a circular, `BigInt`, or non-finite-number `checkpoint`, and its
   * thrown message can embed the caller's actual value — so that failure is
   * never chained as `cause` (it may carry sensitive checkpoint data, e.g. a
   * DynamoDB primary key). The subsequent `writeFileAtomic` call carries no
   * such risk (an I/O errno has no caller content) and safely chains `cause`.
   * Both failures map to the same `"ERR_CHECKPOINT_IO"` code, but with
   * distinct messages so a caller logging `code + message` can distinguish
   * a hash failure from an I/O failure.
   *
   * @param checkpoint - The checkpoint value to persist.
   * @throws {@link M3LCheckpointError} `"ERR_CHECKPOINT_IO"` on any write
   *   failure, including a `checkpoint` value `canonicalJsonHash` cannot hash.
   */
  async write(checkpoint: TCheckpoint): Promise<void> {
    let checksum: string;
    try {
      checksum = canonicalJsonHash(checkpoint);
    } catch {
      // Never chain `cause` here: canonicalJsonHash's thrown message can
      // embed the caller's actual (possibly sensitive) checkpoint value.
      throw new M3LCheckpointError(
        `checkpoint at '${this.#path}' is not JSON-serializable and cannot be written: no circular references, BigInt, or non-finite numbers`,
        { code: "ERR_CHECKPOINT_IO", context: { path: this.#path } },
      );
    }

    const envelope: M3LCheckpointEnvelope<TCheckpoint> = {
      __m3lCheckpointFormat: 1,
      checksum,
      ...(this.#fingerprint !== undefined
        ? { fingerprint: this.#fingerprint }
        : {}),
      payload: checkpoint,
    };
    try {
      await writeFileAtomic(this.#path, JSON.stringify(envelope));
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
