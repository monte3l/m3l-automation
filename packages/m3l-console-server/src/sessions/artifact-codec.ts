/**
 * `sessions/artifact-codec` — the wire codec for a persisted session
 * artifact reference (X6 workbench-sessions module, slice 3, ADR-0068/
 * ADR-0069).
 *
 * `encodeArtifactRef`/`decodeArtifactRef` are the exact inverse pair used to
 * serialize a {@link M3LSessionArtifactRef} into (and parse it back out of)
 * a `console_session_steps.result_ref`-style text column. Split out of
 * `sessions/artifacts.ts` purely to keep that file under the 25,000-byte
 * file-budget cap (`bin/check-file-budget.mjs`) — a pure,
 * behavior-preserving extraction, not a design change.
 *
 * **The dependency direction is one-way.** `sessions/artifacts.ts` imports
 * `assertSafeArtifactFilePath` from this module at runtime (it re-validates
 * a ref's `path` before ever opening a file), so this module must import
 * NOTHING from `sessions/artifacts.ts` — not even a type — or the two would
 * form a cycle. That is also why `M3LSessionArtifactRef` lives here rather
 * than in `sessions/artifacts.ts`.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";
import { toParametersJson } from "../store/parameters-json.js";

/**
 * The charset a `sessionId`/`stepId` must match: letters, digits,
 * underscore, hyphen — never a path separator or `.`. Exported so
 * `sessions/artifacts.ts`'s `assertSafeId` (the write-time check for a
 * caller-supplied `sessionId`/`stepId`) can enforce the same charset this
 * module's `assertSafeArtifactFilePath` re-validates at read time, without
 * this module importing anything back from `artifacts.ts`.
 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/**
 * The maximum length, in characters, a `sessionId`/`stepId` may be —
 * generous for any real caller, small enough to reject before it ever
 * reaches a path join or the filesystem. Exported for the same reason as
 * {@link SAFE_ID_PATTERN}.
 */
export const SAFE_ID_MAX_LENGTH = 128;
/** The charset a persisted artifact reference's SHA-256 `digest` field must match: exactly 64 lowercase hex characters. */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/** The `.json` suffix a file-backed artifact reference's final path segment must end with. */
const ARTIFACT_FILE_SUFFIX = ".json";
/** The exact number of `/`-delimited segments a file-backed artifact reference's `path` must decompose into: `<sessionId>/<stepId>.json`. */
const ARTIFACT_PATH_SEGMENT_COUNT = 2;

/**
 * A resolved reference to a persisted step-output artifact: either the
 * value itself (`"inline"`, for a small payload) or a pointer to a file
 * holding it (`"file"`, for a larger one), discriminated by `kind`.
 *
 * @example
 * ```ts
 * function describe(ref: M3LSessionArtifactRef): string {
 *   return ref.kind === "inline" ? "inline" : `file (${String(ref.sizeBytes)}B)`;
 * }
 * ```
 */
export type M3LSessionArtifactRef =
  | {
      /** The artifact's payload is small enough to be carried directly. */
      readonly kind: "inline";
      /** The artifact's payload. */
      readonly value: unknown;
    }
  | {
      /** The artifact's payload is persisted to a file. */
      readonly kind: "file";
      /** The artifact file's path, relative to the store's `root`. */
      readonly path: string;
      /** The artifact file's JSON-serialized byte size. */
      readonly sizeBytes: number;
      /** The SHA-256 hex digest of the artifact file's contents, verified on every `M3LSessionArtifactStore.readArtifact` call. */
      readonly digest: string;
    };

/**
 * Serializes `ref` to its JSON envelope text, for persistence in a
 * `console_session_steps.result_ref`-style column.
 *
 * @param ref - The ref to serialize.
 * @returns The serialized text — the exact inverse of {@link decodeArtifactRef}.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `ref` is not JSON-serializable — only reachable via an `"inline"` ref
 *   whose `value` contains a `BigInt`, a circular reference, or another
 *   non-serializable value.
 *
 * @example
 * ```ts
 * import { encodeArtifactRef } from "@m3l-automation/m3l-console-server/sessions";
 *
 * encodeArtifactRef({ kind: "inline", value: "hello" });
 * // '{"kind":"inline","value":"hello"}'
 * ```
 */
export function encodeArtifactRef(ref: M3LSessionArtifactRef): string {
  return toParametersJson(ref);
}

/**
 * Validates a `"file"`-kind envelope's `path` field decomposes into exactly
 * `<sessionId>/<stepId>.json`, with both segments individually passing
 * `SAFE_ID_PATTERN` (the same charset check `sessions/artifacts.ts`'s
 * `assertSafeId` enforces at write time). This is the trust-boundary check
 * for a PERSISTED reference: without it, an attacker-controlled `path`
 * (`..` traversal, an absolute path, or a path with the wrong segment
 * count) could resolve outside `<root>/<sessionId>/<stepId>.json` entirely.
 *
 * Throws `ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT` when `path` does not match
 * this shape.
 */
export function assertSafeArtifactFilePath(path: string): void {
  const segments = path.split("/");
  const [sessionSegment, fileSegment] = segments;
  if (
    segments.length !== ARTIFACT_PATH_SEGMENT_COUNT ||
    sessionSegment === undefined ||
    fileSegment === undefined
  ) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      `artifact reference path "${path}" must have exactly two path segments`,
    );
  }
  if (!fileSegment.endsWith(ARTIFACT_FILE_SUFFIX)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      `artifact reference path "${path}" must end in "${ARTIFACT_FILE_SUFFIX}"`,
    );
  }
  const stepSegment = fileSegment.slice(
    0,
    fileSegment.length - ARTIFACT_FILE_SUFFIX.length,
  );
  if (
    !SAFE_ID_PATTERN.test(sessionSegment) ||
    !SAFE_ID_PATTERN.test(stepSegment)
  ) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      `artifact reference path "${path}" must be "<sessionId>/<stepId>${ARTIFACT_FILE_SUFFIX}" with both segments matching ${SAFE_ID_PATTERN.source}`,
    );
  }
}

/**
 * Validates `parsed` matches {@link M3LSessionArtifactRef}'s shape, throwing
 * `ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT` otherwise. `parsed` is untrusted,
 * PERSISTED reference text (a database column, in a later slice) — every
 * field of a `"file"`-kind envelope is re-validated here, not merely
 * type-checked: `path` must decompose safely (see
 * {@link assertSafeArtifactFilePath}), `sizeBytes` must be a non-negative
 * safe integer, and `digest` must be a well-formed SHA-256 hex digest.
 */
function parseArtifactRefShape(parsed: unknown): M3LSessionArtifactRef {
  if (!Core.isPlainObject(parsed)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      "the persisted artifact reference is not an object",
    );
  }
  if (parsed["kind"] === "inline") {
    return { kind: "inline", value: parsed["value"] };
  }
  if (parsed["kind"] === "file") {
    const { path, sizeBytes, digest } = parsed;
    if (typeof path !== "string") {
      throw new M3LConsoleError(
        "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
        "the persisted artifact reference's path is not a string",
      );
    }
    assertSafeArtifactFilePath(path);
    if (
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0
    ) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
        "the persisted artifact reference's sizeBytes is not a non-negative safe integer",
      );
    }
    if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
        `the persisted artifact reference's digest must match ${DIGEST_PATTERN.source}`,
      );
    }
    return { kind: "file", path, sizeBytes, digest };
  }
  throw new M3LConsoleError(
    "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    `unrecognized artifact reference kind "${String(parsed["kind"])}"`,
  );
}

/**
 * Parses `text` back into a {@link M3LSessionArtifactRef} — the exact
 * inverse of {@link encodeArtifactRef}.
 *
 * @param text - The persisted reference text.
 * @returns The decoded ref.
 * @throws {@link M3LConsoleError} with code
 *   `"ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT"` when `text` is not valid JSON,
 *   or does not match the reference envelope shape.
 *
 * @example
 * ```ts
 * import { decodeArtifactRef } from "@m3l-automation/m3l-console-server/sessions";
 *
 * decodeArtifactRef('{"kind":"inline","value":"hello"}');
 * // { kind: "inline", value: "hello" }
 * ```
 */
export function decodeArtifactRef(text: string): M3LSessionArtifactRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      "the persisted artifact reference is not valid JSON",
      { cause },
    );
  }
  return parseArtifactRefShape(parsed);
}
