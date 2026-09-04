/**
 * `sessions/artifacts` — the session artifact store (X6 workbench-sessions
 * module, slice 3, ADR-0068/ADR-0069).
 *
 * `M3LSessionArtifactStore.put` decides, purely from the JSON-serialized
 * byte size of the payload, whether to persist it inline (no I/O at all) or
 * to a real file under a per-store root directory — enforcing an
 * artifact-level cap and a caller-supplied running session-total cap.
 * `readArtifact` is the inverse, verifying a file-backed artifact's SHA-256
 * digest on every read.
 *
 * Deliberately does NOT import `config/` — the eslint zone for this module
 * (`sessions/` may import only `sessions`, `errors`, `store`) forbids it. A
 * later slice's composition root resolves the config and root path and
 * passes them into {@link createSessionArtifactStore}'s options.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  mkdir,
  open,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { M3LConsoleError } from "../errors/console-error.js";
import { toParametersJson } from "../store/parameters-json.js";
import {
  SAFE_ID_MAX_LENGTH,
  SAFE_ID_PATTERN,
  assertSafeArtifactFilePath,
} from "./artifact-codec.js";
import type { M3LSessionArtifactRef } from "./artifact-codec.js";

/** The permission mode applied to a session's artifact directory. */
const ARTIFACT_DIRECTORY_MODE = 0o700;
/** The permission mode applied to a file-backed artifact. */
const ARTIFACT_FILE_MODE = 0o600;

/**
 * The byte-size caps {@link createSessionArtifactStore} enforces — a subset
 * of `config/sessions.ts`'s `M3LConsoleSessionsConfig` fields, named
 * separately here since this module may not import `config/` (see this
 * module's own `@packageDocumentation`). A `M3LConsoleSessionsConfig` value
 * satisfies this type structurally. Not exported: reached only through
 * {@link CreateSessionArtifactStoreOptions.config}, which a caller can
 * satisfy structurally without ever naming this type directly.
 */
interface M3LSessionArtifactCaps {
  /** The maximum JSON-serialized byte size a payload may be to be stored inline. */
  readonly artifactInlineMaxBytes: number;
  /** The maximum JSON-serialized byte size any single artifact may be. */
  readonly artifactMaxBytes: number;
  /** The maximum cumulative byte size of every artifact persisted within one session. */
  readonly sessionTotalMaxBytes: number;
}

/**
 * Constructor options for {@link createSessionArtifactStore}.
 *
 * @example
 * ```ts
 * const options: CreateSessionArtifactStoreOptions = {
 *   root: "/var/lib/m3l/console/artifacts",
 *   config: {
 *     artifactInlineMaxBytes: 65536,
 *     artifactMaxBytes: 33554432,
 *     sessionTotalMaxBytes: 268435456,
 *   },
 * };
 * ```
 */
export interface CreateSessionArtifactStoreOptions {
  /** The directory file-backed artifacts are written under, one subdirectory per session. */
  readonly root: string;
  /** The byte-size caps to enforce. */
  readonly config: M3LSessionArtifactCaps;
}

/**
 * A session's step-output artifact store: decides inline-vs-file placement
 * by size, enforces the configured caps, and verifies a file-backed
 * artifact's digest on read.
 *
 * @example
 * ```ts
 * import { createSessionArtifactStore } from "@m3l-automation/m3l-console-server/sessions";
 *
 * const store = createSessionArtifactStore({
 *   root: "/var/lib/m3l/console/artifacts",
 *   config: {
 *     artifactInlineMaxBytes: 65536,
 *     artifactMaxBytes: 33554432,
 *     sessionTotalMaxBytes: 268435456,
 *   },
 * });
 * const ref = await store.put("session-1", "step-1", { ok: true }, 0);
 * ```
 */
export interface M3LSessionArtifactStore {
  /**
   * Persists `payload` for `(sessionId, stepId)`, returning an inline ref
   * (no I/O) when its JSON-serialized byte size is at most
   * `config.artifactInlineMaxBytes`, or a file ref otherwise.
   *
   * @param sessionId - The owning session's id; must match
   *   {@link "./artifact-codec.js".SAFE_ID_PATTERN}.
   * @param stepId - The step's id; must match
   *   {@link "./artifact-codec.js".SAFE_ID_PATTERN}.
   * @param payload - The value to persist; must be JSON-serializable.
   * @param currentSessionTotalBytes - The session's running total of
   *   already-persisted artifact bytes, supplied by the caller.
   * @returns The resulting {@link "./artifact-codec.js".M3LSessionArtifactRef}.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` for
   *   an unsafe (wrong charset, or over
   *   {@link "./artifact-codec.js".SAFE_ID_MAX_LENGTH} characters)
   *   `sessionId`/`stepId`, a `currentSessionTotalBytes` that is not a
   *   non-negative safe integer, or a `payload` that is not
   *   JSON-serializable.
   * @throws {@link M3LConsoleError} with code
   *   `"ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE"` when the payload's byte size
   *   exceeds `config.artifactMaxBytes`, or when
   *   `currentSessionTotalBytes + sizeBytes` exceeds
   *   `config.sessionTotalMaxBytes`.
   * @throws {@link M3LConsoleError} with code
   *   `"ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT"` when persisting the file
   *   fails (including an exclusive-create collision with an existing
   *   artifact for the same `(sessionId, stepId)` pair).
   */
  put(
    sessionId: string,
    stepId: string,
    payload: unknown,
    currentSessionTotalBytes: number,
  ): Promise<M3LSessionArtifactRef>;
  /**
   * Resolves `ref` back to its value: returns `ref.value` directly for an
   * inline ref, or reads, digest-verifies, and JSON-parses the file for a
   * file ref. `ref` is treated as untrusted regardless of whether it came
   * from {@link "./artifact-codec.js".decodeArtifactRef} or was
   * hand-constructed by a caller — the
   * `path`-shape check and the size cap are both re-verified here, not
   * merely assumed from decode.
   *
   * @param ref - The ref to resolve.
   * @returns The artifact's value.
   * @throws {@link M3LConsoleError} with code
   *   `"ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE"` when `ref.sizeBytes` exceeds
   *   the store's configured `artifactMaxBytes` cap — checked before any
   *   filesystem access.
   * @throws {@link M3LConsoleError} with code
   *   `"ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT"` when `ref.path` does not
   *   decompose into the expected `<sessionId>/<stepId>.json` shape; when the
   *   file cannot be opened or read (including a symlink at the final path
   *   component, rejected via `O_NOFOLLOW`); when the resolved location is
   *   not a regular file; when the file's actual size (checked via the same
   *   open file descriptor used for the subsequent read, before any content
   *   is read into memory) disagrees with `ref.sizeBytes`; when its digest no
   *   longer matches `ref.digest` (checked before the content is trusted or
   *   parsed); or when digest-verified content still fails to `JSON.parse`.
   */
  readArtifact(ref: M3LSessionArtifactRef): Promise<unknown>;
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` when `value` does not match
 * {@link "./artifact-codec.js".SAFE_ID_PATTERN}, or exceeds
 * {@link "./artifact-codec.js".SAFE_ID_MAX_LENGTH} characters.
 */
function assertSafeId(label: string, value: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `${label} must match ${SAFE_ID_PATTERN.source}`,
    );
  }
  if (value.length > SAFE_ID_MAX_LENGTH) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `${label} must be at most ${String(SAFE_ID_MAX_LENGTH)} characters`,
    );
  }
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` when `value` is not a non-negative safe
 * integer — guards `put`'s caller-supplied running session-total against a
 * `NaN`/negative value silently disabling the session-total cap (both
 * comparisons it feeds evaluate to `false` otherwise).
 */
function assertNonNegativeSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `${label} must be a non-negative safe integer`,
    );
  }
}

/**
 * Throws `ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE` when `sizeBytes` exceeds
 * `caps.artifactMaxBytes`, or when `currentSessionTotalBytes + sizeBytes`
 * exceeds `caps.sessionTotalMaxBytes`.
 */
function assertWithinCaps(
  caps: M3LSessionArtifactCaps,
  sizeBytes: number,
  currentSessionTotalBytes: number,
): void {
  if (sizeBytes > caps.artifactMaxBytes) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
      `artifact payload of ${String(sizeBytes)} bytes exceeds the configured cap of ${String(caps.artifactMaxBytes)} bytes`,
    );
  }
  const projectedTotal = currentSessionTotalBytes + sizeBytes;
  if (projectedTotal > caps.sessionTotalMaxBytes) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
      `session artifact total of ${String(projectedTotal)} bytes would exceed the configured cap of ${String(caps.sessionTotalMaxBytes)} bytes`,
    );
  }
}

/**
 * Persists `json` to `<root>/<sessionId>/<stepId>.json`, creating the
 * session directory (`0700`) if needed and writing the file exclusively
 * (`0600`, `wx` flag — never overwrites an existing artifact). Wraps the
 * entire mkdir+write lifecycle under one catch: an `EEXIST` collision and
 * any other filesystem failure both surface as
 * `ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT`.
 */
async function writeArtifactFile(
  root: string,
  sessionId: string,
  stepId: string,
  json: string,
): Promise<string> {
  const sessionDir = join(root, sessionId);
  const absolutePath = join(sessionDir, `${stepId}.json`);
  const relativePath = join(sessionId, `${stepId}.json`);

  try {
    await mkdir(sessionDir, { recursive: true, mode: ARTIFACT_DIRECTORY_MODE });
    await writeFile(absolutePath, json, {
      flag: "wx",
      mode: ARTIFACT_FILE_MODE,
    });
  } catch (cause) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      `failed to persist the artifact for session "${sessionId}" step "${stepId}"`,
      { cause },
    );
  }

  return relativePath;
}

/** Runs `put`'s full validate-size-persist pipeline. */
async function putArtifact(
  root: string,
  caps: M3LSessionArtifactCaps,
  sessionId: string,
  stepId: string,
  payload: unknown,
  currentSessionTotalBytes: number,
): Promise<M3LSessionArtifactRef> {
  assertNonNegativeSafeInteger(
    "currentSessionTotalBytes",
    currentSessionTotalBytes,
  );
  assertSafeId("sessionId", sessionId);
  assertSafeId("stepId", stepId);

  const json = toParametersJson(payload);
  const sizeBytes = Buffer.byteLength(json, "utf8");
  assertWithinCaps(caps, sizeBytes, currentSessionTotalBytes);

  if (sizeBytes <= caps.artifactInlineMaxBytes) {
    return { kind: "inline", value: JSON.parse(json) as unknown };
  }

  const relativePath = await writeArtifactFile(root, sessionId, stepId, json);
  const digest = createHash("sha256").update(json, "utf8").digest("hex");

  return { kind: "file", path: relativePath, sizeBytes, digest };
}

/**
 * Opens `absolutePath` exactly once (`O_NOFOLLOW`, so a symlink at the
 * final path component fails with `ELOOP` rather than being silently
 * followed; `O_NONBLOCK`, so a FIFO planted at the path with no writer
 * connected returns immediately instead of blocking the call — and, by
 * extension, starving Node's libuv fs thread pool — forever; `O_NONBLOCK` is
 * a no-op for a regular file on Linux, so it does not affect the normal
 * case), verifies via that SAME descriptor that the resolved location is a
 * regular file whose actual size matches `ref.sizeBytes`, and returns its
 * raw bytes — never a second, independently re-resolved path lookup.
 * `close()` runs best-effort in `finally` so a failing close can never
 * shadow the real outcome above it.
 */
async function readArtifactFileBuffer(
  absolutePath: string,
  ref: Extract<M3LSessionArtifactRef, { kind: "file" }>,
): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      absolutePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
        `artifact file at "${ref.path}" is not a regular file`,
      );
    }
    if (stats.size !== ref.sizeBytes) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
        `artifact file size mismatch for "${ref.path}"`,
      );
    }
    return await handle.readFile();
  } catch (cause) {
    if (cause instanceof M3LConsoleError) throw cause;
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      `failed to read the artifact file at "${ref.path}"`,
      { cause },
    );
  } finally {
    // Best-effort: a failing close() must not mask the primary outcome
    // (a successful read, or one of the typed errors thrown above).
    try {
      await handle?.close();
    } catch {
      /* ignore — the outcome above is what matters */
    }
  }
}

/**
 * Reads, size-bounds, digest-verifies, and JSON-parses a file-backed
 * artifact under `root`. `ref` is untrusted regardless of provenance
 * (decoded, or hand-constructed by a caller — both are public), so every
 * check below re-validates it rather than assuming a prior decode already
 * did. Ordering is deliberate and security-relevant:
 *
 * 1. {@link assertSafeArtifactFilePath} re-validates `ref.path`'s shape (no
 *    filesystem access) — the same check `artifact-codec.ts`'s
 *    `parseArtifactRefShape` runs at decode time — so a hand-constructed ref
 *    cannot resolve outside `root`.
 * 2. `ref.sizeBytes` vs `caps.artifactMaxBytes`, before any filesystem
 *    access — an internally-consistent but over-cap ref is rejected without
 *    ever opening the file.
 * 3. {@link readArtifactFileBuffer} opens the file exactly once
 *    (`O_NOFOLLOW`), rejects a non-regular file and a real/claimed size
 *    mismatch via that SAME descriptor — closing the TOCTOU gap between a
 *    path-based `stat()` and a later path-based `readFile()`.
 * 4. The SHA-256 digest of the raw bytes is verified against `ref.digest`
 *    _before_ `JSON.parse`, so untrusted bytes never reach the parser (a
 *    `SyntaxError` on untrusted content embeds a content snippet).
 * 5. Only once the digest matches does `JSON.parse` run; a failure there is
 *    a genuine internal corruption, safe to chain as `cause`.
 */
async function readFileArtifact(
  root: string,
  caps: M3LSessionArtifactCaps,
  ref: Extract<M3LSessionArtifactRef, { kind: "file" }>,
): Promise<unknown> {
  assertSafeArtifactFilePath(ref.path);

  if (ref.sizeBytes > caps.artifactMaxBytes) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
      `artifact reference at "${ref.path}" claims ${String(ref.sizeBytes)} bytes, exceeding the configured cap of ${String(caps.artifactMaxBytes)} bytes`,
    );
  }

  const absolutePath = join(root, ref.path);
  const buffer = await readArtifactFileBuffer(absolutePath, ref);

  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== ref.digest) {
    // Digest mismatch on unverified bytes: never chain a content-derived
    // cause (a raw JSON.parse SyntaxError embeds a snippet of the file's
    // actual content in its message).
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      `artifact digest mismatch for "${ref.path}"`,
    );
  }

  const content = buffer.toString("utf8");
  try {
    return JSON.parse(content) as unknown;
  } catch (cause) {
    // Content is digest-verified at this point, so a parse failure here is
    // a genuine internal corruption — safe to chain, unlike the unverified
    // path above.
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      `artifact file at "${ref.path}" matched its recorded digest but is not valid JSON`,
      { cause },
    );
  }
}

/**
 * Creates a {@link M3LSessionArtifactStore} bound to `options.root` and
 * `options.config`. Performs no filesystem I/O by itself — the root
 * directory is created lazily, only when a file-backed artifact is first
 * written.
 *
 * @param options - See {@link CreateSessionArtifactStoreOptions}.
 * @returns The created store.
 *
 * @example
 * ```ts
 * import { createSessionArtifactStore } from "@m3l-automation/m3l-console-server/sessions";
 *
 * const store = createSessionArtifactStore({
 *   root: "/var/lib/m3l/console/artifacts",
 *   config: {
 *     artifactInlineMaxBytes: 65536,
 *     artifactMaxBytes: 33554432,
 *     sessionTotalMaxBytes: 268435456,
 *   },
 * });
 * ```
 */
export function createSessionArtifactStore(
  options: CreateSessionArtifactStoreOptions,
): M3LSessionArtifactStore {
  const { root, config } = options;
  return {
    put: (sessionId, stepId, payload, currentSessionTotalBytes) =>
      putArtifact(
        root,
        config,
        sessionId,
        stepId,
        payload,
        currentSessionTotalBytes,
      ),
    readArtifact: (ref) =>
      ref.kind === "inline"
        ? Promise.resolve(ref.value)
        : readFileArtifact(root, config, ref),
  };
}
