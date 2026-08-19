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
 * `TPayload` is `unknown` on the write path so the snapshot (type `unknown`)
 * can be assigned without a cast while keeping the shape well-typed. The
 * complementary parsed/untrusted shape is {@link M3LCheckpointRawEnvelope},
 * used only on the read path.
 */
interface M3LCheckpointEnvelope<TPayload> {
  readonly __m3lCheckpointFormat: 1;
  readonly checksum: string;
  readonly fingerprint?: string;
  readonly payload: TPayload;
}

// ---------------------------------------------------------------------------
// NonFiniteNumberError — module-private write() sentinel
// ---------------------------------------------------------------------------

/**
 * Module-private sentinel thrown inside the `write()` replacer when it
 * encounters a non-finite number (`NaN`, `Infinity`, `-Infinity`). Propagates
 * through `JSON.stringify` and is immediately caught by the snapshot `try`
 * block, which re-throws it as `ERR_CHECKPOINT_IO` with no `cause` (the
 * sentinel message must never reach a caller or a log sink).
 *
 * Using a named subclass satisfies the ESLint `only-throw-error` rule while
 * keeping the sentinel unexported — callers cannot construct or catch it.
 */
class NonFiniteNumberError extends Error {
  constructor() {
    super("non-finite number in checkpoint payload");
  }
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
// Definition projection — validate AND project in a single traversal
// ---------------------------------------------------------------------------

/**
 * Maximum recursion depth for {@link projectDefinitionValue}. A definition
 * nested more deeply than this is rejected with `ERR_CHECKPOINT_DEFINITION`
 * rather than risking a call-stack overflow. The limit is generous enough to
 * cover any realistic configuration structure.
 */
const DEFINITION_MAX_DEPTH = 512;

/**
 * Sentinel returned (not thrown) by the projection helpers when a value
 * anywhere in the definition tree is not on the allowlist. Module-private and
 * unexported — a caller cannot produce this exact symbol value because it is
 * never accessible outside this file, and every class instance is rejected by
 * the allowlist itself before the sentinel could be confused with caller data.
 */
const REJECTED = Symbol("REJECTED");

/**
 * Returns `true` when `value`'s prototype is `Object.prototype` or `null`,
 * confirming it is a plain object whose content is fully enumerable. Guards
 * `Object.getPrototypeOf` (can throw on a revoked or hostile `Proxy`) and
 * returns `false` on any trap error (fail-closed). Extracted from
 * {@link projectDefinitionValue} to keep that function within the project's
 * cyclomatic-complexity budget.
 */
function isDefinitionPlainObject(value: object): boolean {
  let proto: unknown;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return false; // Proxy getPrototypeOf trap — fail-closed
  }
  return proto === Object.prototype || proto === null;
}

/**
 * Returns `true` when `arr` has no own symbol keys and no own non-index
 * enumerable properties — i.e. it is "shape-valid" for projection. Detects:
 *
 * - **symbol keys** via `Object.getOwnPropertySymbols` (two arrays differing
 *   only in symbol-keyed data would produce identical fingerprints);
 * - **non-index enumerable properties** by comparing `Object.keys(arr).length`
 *   against `capturedLength` (for a dense `[x, y, z]` they are equal; for an
 *   array carrying an extra own property such as `{ extra: true }` they
 *   differ).
 *
 * `capturedLength` is passed in by the caller — {@link projectDefinitionArray}
 * — rather than re-reading `arr.length`, so that both the shape check and the
 * iteration loop agree on exactly one observed value. A hostile accessor that
 * mutates `arr.length` mid-walk cannot shrink the projection: the loop
 * iterates to `capturedLength`, `Object.hasOwn` detects any resulting holes,
 * and the call returns `REJECTED`.
 *
 * Guards both Proxy-trap-triggering calls under a single outer `try` — a
 * throw from either returns `false` (fail-closed). Extracted from
 * {@link projectDefinitionArray} to keep that function within the complexity
 * budget.
 */
function isDefinitionArrayShapeValid(
  arr: unknown[],
  capturedLength: number,
): boolean {
  try {
    const symbols = Object.getOwnPropertySymbols(arr);
    if (symbols.length > 0) return false;
    const ownKeys = Object.keys(arr);
    return ownKeys.length === capturedLength;
  } catch {
    return false; // Proxy ownKeys/getOwnPropertySymbols trap — fail-closed
  }
}

/**
 * Array branch of {@link projectDefinitionValue}. Reads `arr.length` exactly
 * once into `capturedLength`, reads each element exactly once, validates it,
 * and copies it into a fresh `unknown[]`. Returns the {@link REJECTED}
 * sentinel when:
 *
 * - `arr`'s shape is invalid (own symbol keys or non-index enumerable
 *   properties — see {@link isDefinitionArrayShapeValid});
 * - the array is sparse — a hole at any index (detected via `Object.hasOwn`);
 * - any Proxy trap throws;
 * - any element is not on the allowlist.
 *
 * **Single `length` read.** `arr.length` is captured once before both the
 * shape check and the loop, so a hostile accessor at e.g. index 0 that shrinks
 * `arr.length` mid-walk cannot truncate the projection: the loop continues to
 * `capturedLength`, and `Object.hasOwn` detects the resulting holes as
 * sparse-array evidence, returning `REJECTED`. The shape check
 * (`isDefinitionArrayShapeValid`) uses the same `capturedLength` rather than
 * re-reading `arr.length`, so both observations are guaranteed to agree.
 *
 * Tracks `arr` in `visited` while recursing to detect cycles. Extracted from
 * {@link projectDefinitionValue} to keep each function within the project's
 * complexity budget.
 */
function projectDefinitionArray(
  arr: unknown[],
  visited: WeakSet<object>,
  depth: number,
): unknown[] | typeof REJECTED {
  visited.add(arr);
  try {
    // Read arr.length exactly once. On a hostile Proxy the `length` get trap
    // can throw; the outer catch returns REJECTED (fail-closed). This single
    // captured value is used by both the shape check and the loop — a
    // mid-walk mutation of arr.length cannot shrink the projection.
    const capturedLength = arr.length;

    // Reject arrays carrying own symbol keys or non-index enumerable
    // properties — both are invisible to indexed iteration and would cause two
    // arrays with different data to produce identical projections.
    if (!isDefinitionArrayShapeValid(arr, capturedLength)) return REJECTED;

    const result: unknown[] = [];
    for (let i = 0; i < capturedLength; i++) {
      // Detect holes: a sparse array has no own property at the hole index.
      // Object.hasOwn invokes the [[GetOwnProperty]] trap on a Proxy.
      let hasIndex: boolean;
      try {
        hasIndex = Object.hasOwn(arr, i);
      } catch {
        return REJECTED; // Proxy getOwnProperty trap — fail-closed
      }
      if (!hasIndex) return REJECTED; // sparse array — hole rejects

      // Read the element exactly once into a local. This is the single
      // observation — the value is never re-read by a subsequent hash pass.
      let elem: unknown;
      try {
        elem = arr[i];
      } catch {
        return REJECTED; // Proxy get trap — fail-closed
      }
      const projected = projectDefinitionValue(elem, visited, depth + 1);
      if (projected === REJECTED) return REJECTED;
      result.push(projected);
    }
    return result;
  } catch {
    return REJECTED;
  } finally {
    visited.delete(arr);
  }
}

/**
 * Plain-object branch of {@link projectDefinitionValue}. Reads each own
 * enumerable property value exactly once, validates it, and copies it into a
 * fresh `Object.create(null)` map (no prototype — no inherited `toJSON` or
 * other method can influence how `canonicalJsonHash` serializes the result).
 * Returns the {@link REJECTED} sentinel when:
 *
 * - any Proxy trap throws;
 * - the object carries own symbol keys (invisible to `Object.keys` and to
 *   JSON serialization, so two objects with different symbol-keyed data would
 *   produce identical fingerprints);
 * - any property value is not on the allowlist.
 *
 * Properties whose value is `undefined` are accepted and **skipped** (not
 * copied into the projection), so omitting a key and setting it to
 * `undefined` produce the same fingerprint — which is the documented
 * contract.
 *
 * Tracks `obj` in `visited` while recursing to detect cycles. Extracted from
 * {@link projectDefinitionValue} to keep each function within the project's
 * complexity budget.
 */
function projectDefinitionObject(
  obj: object,
  visited: WeakSet<object>,
  depth: number,
): Record<string, unknown> | typeof REJECTED {
  visited.add(obj);
  try {
    // Reject objects carrying own symbol keys — invisible to Object.keys and
    // to JSON serialization, so two objects with different symbol-keyed data
    // would produce identical projections and therefore identical fingerprints.
    let symbols: symbol[];
    try {
      symbols = Object.getOwnPropertySymbols(obj);
    } catch {
      return REJECTED; // Proxy ownKeys trap — fail-closed
    }
    if (symbols.length > 0) return REJECTED;

    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch {
      return REJECTED; // Proxy ownKeys trap — fail-closed
    }

    // Use Object.create(null) so the projected object carries no prototype and
    // therefore no inherited toJSON or other method that could influence how
    // canonicalJsonHash serializes the result.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      // Read the property value exactly once into a local. This is the single
      // observation — the value is never re-read by a subsequent hash pass.
      let propVal: unknown;
      try {
        propVal = (obj as Record<string, unknown>)[key];
      } catch {
        return REJECTED; // Proxy get trap — fail-closed
      }
      // An undefined-valued property is allowed and skipped — omitting a key
      // and setting it to undefined both fingerprint identically by design,
      // which is how adopters express an absent optional setting.
      if (propVal === undefined) continue;
      const projected = projectDefinitionValue(propVal, visited, depth + 1);
      if (projected === REJECTED) return REJECTED;
      result[key] = projected;
    }
    return result;
  } catch {
    return REJECTED;
  } finally {
    visited.delete(obj);
  }
}

/**
 * Projects a non-object, non-null primitive `value`. Returns the value itself
 * when it is on the allowlist (`string`, `boolean`, or finite `number`), and
 * the {@link REJECTED} sentinel for everything else (`function`, `symbol`,
 * `bigint`, non-finite `number`). No Proxy traps are involved — the call sites
 * that dispatch here have already confirmed `typeof value !== "object"`.
 * Extracted from {@link projectDefinitionValue} to keep that function within
 * the project's complexity budget.
 */
function projectDefinitionPrimitive(value: unknown): unknown {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : REJECTED;
  if (typeof value === "string" || typeof value === "boolean") return value;
  return REJECTED; // function, symbol, bigint
}

/**
 * Validates and projects `value` in a **single traversal**: every value is
 * read exactly once, checked against the allowlist below, and copied into a
 * fresh plain-JSON structure. Returns the projected value on success, or the
 * {@link REJECTED} sentinel when any value anywhere in the tree is not on the
 * allowlist.
 *
 * **Why one traversal, not validate-then-hash.** Two earlier approaches
 * validated the caller's object and then let `canonicalJsonHash` read it
 * again — the checked bytes were not the hashed bytes. A getter was read twice
 * and could return an allowed array the first time and a `Set` the second; a
 * **non-enumerable** own `toJSON` was invisible to `Object.keys` yet applied
 * by the serializer (so two entirely different definitions both fingerprinted
 * as `{}` and could resume on each other's offsets); own non-index properties
 * on an array were invisible to both traversals. Reading the graph once
 * removes the divergence: there is only one observation, and the fingerprint
 * provably covers exactly what was validated.
 *
 * **`toJSON` is never consulted** — own or inherited. Because the projection
 * is a fresh plain object/array tree built entirely from copied primitives and
 * new `Object.create(null)` maps, it contains no caller objects by reference;
 * `canonicalJsonHash` on the projection cannot reach any caller `toJSON`.
 *
 * At every depth the walk accepts only:
 *
 * - `null`, a finite `number`, a `string`, or a `boolean`;
 * - a **dense** `Array` with no own non-index properties and no own symbol
 *   keys, whose every element is accepted;
 * - a **plain object** (prototype exactly `Object.prototype` or `null`) with
 *   no own symbol keys, whose every own enumerable property value is accepted.
 *   A property whose value is `undefined` is allowed and skipped.
 *
 * Everything else is rejected: `function`, `symbol`, `bigint`, non-finite
 * numbers, `Map`, `Set`, `WeakMap`, `RegExp`, `Date`, any class instance.
 *
 * The walk is robust against hostile input:
 *
 * - **Cycles**: tracked via a `WeakSet` of objects currently on the visit
 *   stack; a circular reference terminates immediately with {@link REJECTED}.
 * - **Depth**: compared against `DEFINITION_MAX_DEPTH` before any recursion;
 *   a pathologically deep definition is rejected without overflowing the stack.
 * - **Hostile `Proxy`**: every Proxy-trap-triggering operation — `Array.isArray`,
 *   `Object.getPrototypeOf`, `Object.getOwnPropertySymbols`, `Object.keys`,
 *   `Object.hasOwn`, and property reads — is guarded; a throwing trap causes
 *   {@link REJECTED} to be returned (fail-closed).
 *
 * @param value - The value to inspect and project.
 * @param visited - The set of objects currently being visited (cycle guard).
 * @param depth - The current recursion depth (overflow guard).
 * @returns The projected plain-JSON value, or {@link REJECTED} when `value`
 *   is not on the allowlist at any depth.
 */
function projectDefinitionValue(
  value: unknown,
  visited: WeakSet<object>,
  depth: number,
): unknown {
  // Null is accepted and projects to null.
  if (value === null) return null;

  // Non-object types: handled without any Proxy trap involvement.
  if (typeof value !== "object") {
    return projectDefinitionPrimitive(value);
  }

  // Non-null object from here. Reject on depth limit or cycle.
  if (depth >= DEFINITION_MAX_DEPTH || visited.has(value)) return REJECTED;

  // Array.isArray invokes [[IsArray]] which throws on a revoked Proxy.
  let isArr: boolean;
  try {
    isArr = Array.isArray(value);
  } catch {
    return REJECTED; // fail-closed
  }
  if (isArr) return projectDefinitionArray(value as unknown[], visited, depth);

  // Reject class instances, Map, Set, RegExp, Date, etc. Proxy-safe.
  if (!isDefinitionPlainObject(value)) return REJECTED;
  return projectDefinitionObject(value, visited, depth);
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
   * opts into **fingerprinting**: `write()` stamps the definition's
   * fingerprint onto the envelope, and `read()` refuses to resume from a
   * checkpoint written under a different definition (throws
   * `"ERR_CHECKPOINT_FINGERPRINT_MISMATCH"`).
   *
   * **Validated and projected in a single traversal at construction.** The
   * definition is walked **once**: every value is read exactly once, checked
   * against the allowlist below, and copied into a fresh plain-JSON structure.
   * The fingerprint is computed as `canonicalJsonHash(projection)` — over the
   * projection, not the caller's object. This removes any divergence between
   * what is validated and what is hashed: two earlier approaches validated the
   * caller's object and then let the hasher read it again, and both were
   * defeated — a non-enumerable own `toJSON`, a non-idempotent getter, and
   * own non-index array properties all caused the checked bytes and the hashed
   * bytes to diverge. Reading the graph once and fingerprinting the projection
   * eliminates the gap by construction.
   *
   * **`toJSON` is never consulted** — own or inherited. The projected tree is
   * built entirely from copied primitives and fresh `Object.create(null)` maps
   * with no inherited methods; `canonicalJsonHash` on the projection cannot
   * reach any caller `toJSON`. Pass a `Date` as `date.toISOString()` and any
   * richer collection as the plain array or object you want fingerprinted.
   *
   * **Accepted definitions — an allowlist, applied recursively.** At every
   * depth the constructor accepts only:
   *
   * - a finite `number`, a `string`, a `boolean`, or `null`;
   * - a **dense** `Array` (no holes, no own non-index properties, no own
   *   symbol keys) whose every element is accepted;
   * - a plain object (prototype `Object.prototype` or `null`) with **no own
   *   symbol keys**, whose every own enumerable property value is accepted. A
   *   property whose value is `undefined` is allowed and skipped — omitting a
   *   key and setting it to `undefined` both fingerprint identically by design.
   *
   * Everything else is rejected wherever it appears: `function`, `symbol`,
   * `bigint`, non-finite numbers, `Map`, `Set`, `WeakMap`, `RegExp`, `Date`,
   * and any other class instance. An honestly-empty `{}` or `[]` is accepted.
   * The walk also terminates safely on circular references and pathologically
   * deep structures — both yield `ERR_CHECKPOINT_DEFINITION` rather than a
   * raw error.
   *
   * The projection and its hash are computed **once, at construction**, so a
   * definition the constructor rejects throws `"ERR_CHECKPOINT_DEFINITION"`
   * at composition time rather than surfacing on the first `read()` or
   * `write()`. The value is never persisted and never reaches a `message`,
   * `context`, or `cause` — only its hash is stored.
   *
   * Omitting this field preserves today's behaviour exactly (no
   * fingerprinting).
   *
   * @throws {@link M3LCheckpointError} `"ERR_CHECKPOINT_DEFINITION"` — from
   *   the constructor — when the supplied value is not on the allowlist at any
   *   depth. Never chains a `cause` — the underlying error's message could
   *   embed the caller's definition value.
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
   * `canonicalJsonHash(projection)` when a `definition` was supplied and
   * successfully projected; otherwise `undefined`. Stamped onto envelopes by
   * `write()` and compared by `read()`. Computed over the projection of the
   * caller's definition (a fresh plain-JSON structure built in one traversal),
   * not over the caller's original object.
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
   *   definition projection does not begin until the path succeeds.
   * @throws {@link M3LCheckpointError} `"ERR_CHECKPOINT_DEFINITION"` when
   *   `options.definition` is supplied but is not on the allowlist at any
   *   depth (see {@link M3LCheckpointStoreOptions.definition}). Never chains
   *   a `cause` — the underlying error's message could embed the caller's
   *   definition value.
   */
  constructor(options: M3LCheckpointStoreOptions<TCheckpoint>) {
    // Path resolution must come first — an unsafe name throws
    // M3LPathResolutionError unwrapped, before definition projection begins.
    this.#path = options.paths.resolveOutput(`${options.name}.checkpoint.json`);
    this.#validate = options.validate;
    this.#missing = options.missing;

    if (options.definition !== undefined) {
      // Project the definition in one traversal: read every value exactly once,
      // validate it, and copy it into a fresh plain-JSON structure. This
      // prevents fingerprints that can never mismatch (a nested Set, a
      // non-enumerable toJSON, a non-idempotent getter, or own non-index array
      // properties would all be invisible to a separate hash pass — causing two
      // different definitions to share a fingerprint and cross-resume silently).
      const projection = projectDefinitionValue(
        options.definition,
        new WeakSet(),
        0,
      );
      if (projection === REJECTED) {
        throw new M3LCheckpointError(
          `checkpoint store at '${this.#path}': definition must contain only finite numbers, strings, booleans, null, dense plain arrays (no holes, no own non-index properties, no symbol keys), and plain objects (prototype Object.prototype or null, no symbol keys) with accepted values at every depth — functions, symbols, class instances (Map, Set, Date, RegExp), non-finite numbers, circular references, and structures exceeding the depth limit are rejected`,
          {
            code: "ERR_CHECKPOINT_DEFINITION",
            context: { path: this.#path },
          },
        );
      }
      // Fingerprint the projection, not the caller's original object. The
      // projection is a fresh plain-JSON tree with no caller objects by
      // reference, so canonicalJsonHash cannot reach any caller toJSON.
      try {
        this.#fingerprint = canonicalJsonHash(projection);
      } catch {
        // Never chain `cause`: this arm is a safety net — an accepted
        // projection is always hashable — but is kept for robustness. The
        // underlying error's message could embed definition value details.
        throw new M3LCheckpointError(
          `checkpoint store at '${this.#path}' could not hash the definition projection: must be JSON-serializable`,
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
   * checksum, optional `fingerprint`, and the checkpoint as `payload`) rather
   * than persisting the bare value. This lets a later `read()` verify the
   * file's integrity against **accidental** corruption. When a `definition`
   * was supplied to the constructor, the envelope also carries a `fingerprint`
   * so `read()` can detect a configuration change between runs. When no
   * `definition` was supplied, the `fingerprint` key is omitted entirely.
   *
   * **The checkpoint is snapshotted once** —
   * `JSON.parse(JSON.stringify(checkpoint, replacer))` — so the stored
   * `checksum` provably covers the exact bytes that are persisted. Without
   * snapshotting, `canonicalJsonHash` and `JSON.stringify` could observe
   * different representations for sparse arrays or non-idempotent `toJSON`
   * getters, causing `write()` to persist a file whose stored checksum cannot
   * match on `read()`, permanently deadlocking the resume. The replacer rejects
   * non-finite numbers (`NaN`, `Infinity`, `-Infinity`) with
   * `ERR_CHECKPOINT_IO` rather than letting `JSON.stringify` silently render
   * them as `null` — a value substitution that the resume logic would read back
   * as real, violating the no-silent-failure rule. The snapshot is a plain JSON
   * value; for any ordinary `TCheckpoint` the checksum is unchanged from prior
   * versions.
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
   * Four distinct failure modes, all mapped to `"ERR_CHECKPOINT_IO"` with
   * distinct messages so a caller logging `code + message` can distinguish
   * them:
   *
   * 1. **Snapshot failure** — `JSON.stringify(checkpoint)` throws on a
   *    circular, `BigInt`, or non-finite-number `checkpoint`. Never chains a
   *    `cause`: `JSON.stringify`'s thrown message can embed the caller's actual
   *    checkpoint value (e.g. a DynamoDB primary key).
   * 2. **Checksum failure** — `canonicalJsonHash(snapshot)` throws (safety net
   *    only; a successfully snapshotted value is always hashable). Never chains
   *    a `cause`.
   * 3. **Serialization failure** — `JSON.stringify(envelope)` throws (safety
   *    net only; after snapshotting the payload is plain JSON). Never chains a
   *    `cause`.
   * 4. **I/O failure** — `writeFileAtomic` fails (e.g. `ENOSPC`, `EPERM`,
   *    missing parent directory). Chains the OS `cause` — an errno has no
   *    caller-supplied content.
   *
   * @param checkpoint - The checkpoint value to persist.
   * @throws {@link M3LCheckpointError} `"ERR_CHECKPOINT_IO"` on any write
   *   failure, including a `checkpoint` value `JSON.stringify` cannot
   *   serialize.
   */
  async write(checkpoint: TCheckpoint): Promise<void> {
    // Snapshot the checkpoint once: serialize it and immediately parse it back.
    // Both the checksum and the persisted `payload` come from this snapshot,
    // so they are provably the same view — a sparse array or a non-idempotent
    // `toJSON` getter can no longer cause the stored checksum to disagree with
    // the persisted payload on a later `read()`.
    //
    // The replacer rejects non-finite numbers (`NaN`, `Infinity`, `-Infinity`)
    // by throwing {@link NonFiniteNumberError}, which propagates through
    // `JSON.stringify`. Without the replacer, `JSON.stringify` renders a
    // non-finite number as `null`, so the stored file would silently carry
    // `null` where the caller passed `Infinity` — a value substitution the
    // resume logic reads back as real, violating the no-silent-failure rule.
    // Circular references and `BigInt` throw natively from `JSON.stringify`,
    // so no replacer handling is needed for those; all three fall through to
    // the same catch block, which maps them to `ERR_CHECKPOINT_IO` with no
    // `cause`.
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(
        JSON.stringify(checkpoint, (_key: string, value: unknown): unknown => {
          if (typeof value === "number" && !Number.isFinite(value))
            throw new NonFiniteNumberError();
          return value;
        }),
      ) as unknown;
    } catch {
      // Never chain `cause`: JSON.stringify's thrown message can embed the
      // caller's actual checkpoint value (e.g. a DynamoDB primary key), and
      // NonFiniteNumberError's message names the constraint without caller
      // data — both must be suppressed to prevent leaking sensitive content.
      throw new M3LCheckpointError(
        `checkpoint at '${this.#path}' is not JSON-serializable and cannot be written: no circular references, BigInt, or non-finite numbers`,
        { code: "ERR_CHECKPOINT_IO", context: { path: this.#path } },
      );
    }

    let checksum: string;
    try {
      checksum = canonicalJsonHash(snapshot);
    } catch {
      // After a successful JSON round-trip the snapshot is a plain JSON value;
      // this arm is a safety net only. Never chain `cause`.
      throw new M3LCheckpointError(
        `checkpoint at '${this.#path}' is not JSON-serializable and cannot be written: no circular references, BigInt, or non-finite numbers`,
        { code: "ERR_CHECKPOINT_IO", context: { path: this.#path } },
      );
    }

    const envelope: M3LCheckpointEnvelope<unknown> = {
      __m3lCheckpointFormat: 1,
      checksum,
      ...(this.#fingerprint !== undefined
        ? { fingerprint: this.#fingerprint }
        : {}),
      payload: snapshot,
    };

    // Serialize the envelope before the I/O try so that a JSON.stringify
    // failure (safety net — the payload is already plain JSON) does not reach
    // the I/O catch where its thrown message would be chained as `cause`.
    let body: string;
    try {
      body = JSON.stringify(envelope);
    } catch {
      // Never chain `cause`: the stringify error can embed caller property
      // paths (e.g. "property 'key' closes the circle").
      throw new M3LCheckpointError(
        `checkpoint at '${this.#path}' could not be serialized to JSON`,
        { code: "ERR_CHECKPOINT_IO", context: { path: this.#path } },
      );
    }

    try {
      await writeFileAtomic(this.#path, body);
    } catch (cause) {
      // An OS errno (ENOSPC, EPERM, missing parent dir) has no caller-supplied
      // content — chaining cause is safe and provides actionable diagnostics.
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
