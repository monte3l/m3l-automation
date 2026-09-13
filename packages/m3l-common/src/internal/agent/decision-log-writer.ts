/**
 * `internal/agent/decision-log-writer` — the `core/agent` half of the
 * append-only segmented writer behind the public `M3LAgentDecisionLog` class
 * (ADR-0061, V7 slice 2).
 *
 * Private to `core/agent`; never re-exported through a public barrel. This
 * module owns everything about the decision log that is agent-specific: the
 * constructor's options validation, the entry's structural proof and detached
 * projection (via `./decision-log-projection.js`), and the error vocabulary
 * the log raises. The append itself — segment rotation, the atomic
 * `O_APPEND`/`O_NOFOLLOW` write, and the serialized append chain — lives in
 * the generic `internal/storage/append-only-writer.js`, which this module
 * drives through a rendering function and an error port so a second audit
 * artifact does not fork a second copy of that security-critical code. So
 * `core/agent/decision-log.ts` stays a thin, documented wrapper holding no
 * validation logic of its own.
 *
 * Two error vocabularies meet here and are kept apart deliberately:
 *
 * - a **caller-side** violation — a malformed options bag, or an entry that
 *   is not structurally an `M3LAgentDecisionLogEntry` — throws a bare
 *   `M3LError` with `code: "ERR_INVALID_ARGUMENT"`, matching the house
 *   pattern in `aws/s3/uri.ts` and `internal/logging/levels.ts`;
 * - a failure of the **append itself**, including a well-formed entry that is
 *   simply larger than one atomic write can durably carry and a segment path
 *   that turns out to be a symlink, throws
 *   `M3LAgentDecisionLogWriteError` (`ERR_AGENT_DECISION_LOG_WRITE`).
 *
 * No error message, and no `context` built here, ever carries a value read
 * out of the caller's input: they name the field and the violation kind only.
 * A directory path can carry tenant or customer identifiers, and an entry
 * carries identity and reason text. The one path by which a caller-supplied
 * string can still be reached from an error raised here is a **chained
 * filesystem `cause`** — Node's own `ENOENT`/`EACCES`/`ELOOP` errors quote
 * the path they failed on. That cause is deliberately kept: it is the only
 * diagnostic an operator has for a broken log directory, it is Node's error
 * rather than one composed here, and it is reached only by code that walks
 * `error.cause` explicitly.
 *
 * Two limitations are accepted rather than fixed — a `maxSegmentBytes` below
 * `M3L_AGENT_MAX_LOG_ENTRY_BYTES` yielding one entry per segment, and a
 * segment's wall-clock `createdAtMs` — both documented where they live, in
 * `internal/storage/append-only-writer.js`'s header.
 */

import { serializeAgentDecisionLogEntry } from "../../core/agent/decision-log-entry.js";
import { M3LAgentDecisionLogWriteError } from "../../core/agent/M3LAgentDecisionLogWriteError.js";
import type { M3LAgentDecisionLogEntry } from "../../core/agent/decision-log-types.js";
import { M3L_AGENT_MAX_LOG_ENTRY_BYTES } from "../../core/agent/decision-log-types.js";
import { M3LError } from "../../core/errors/index.js";
import type { M3LAppendOnlySealFailure } from "../../core/storage/append-only-manifest-types.js";
import { isNumber, isPlainObject } from "../../core/utils/guards.js";
import { DEFAULT_MAX_MANIFEST_BYTES } from "../storage/append-only-manifest.js";
import { readOnSealFailed } from "../storage/append-only-options.js";
import { AppendOnlySealer } from "../storage/append-only-sealer.js";
import type { AppendOnlyWriterErrors } from "../storage/append-only-writer.js";
import { AppendOnlyWriter } from "../storage/append-only-writer.js";
import { projectAgentDecisionLogEntry } from "./decision-log-projection.js";
import { assertAllowedKeys, isNonBlankString } from "./validation.js";

/** The only own keys `M3LAgentDecisionLogOptions` may carry. */
const WRITER_OPTIONS_KEYS: ReadonlySet<string> = new Set([
  "directory",
  "maxSegmentBytes",
  "maxSegmentAgeMs",
  "onSealFailed",
]);

/**
 * Builds the caller-side boundary error: a bare {@link M3LError} carrying
 * `code: "ERR_INVALID_ARGUMENT"` (already classified `origin: "caller"` in
 * the error catalog). `context` names the field and the violation kind plus
 * structural locators only — never a value read out of the caller's input.
 */
function invalidArgument(
  field: string,
  violation: string,
  detail?: Readonly<Record<string, unknown>>,
): M3LError {
  return new M3LError(
    `agent decision log: "${field}" is invalid (${violation})`,
    {
      code: "ERR_INVALID_ARGUMENT",
      context: { field, violation, ...detail },
    },
  );
}

/**
 * Reads the optional `directory` override. Presence is `Object.hasOwn`, so a
 * non-own `"__proto__"` resolves as absent; a present-but-blank or
 * non-string value is malformed input, not "absent", and throws.
 */
function readOptionalDirectory(
  bag: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!Object.hasOwn(bag, "directory")) {
    return undefined;
  }
  const value = bag["directory"];
  if (!isNonBlankString(value)) {
    throw invalidArgument("directory", "not-a-non-blank-string");
  }
  return value;
}

/**
 * Reads one optional rotation ceiling. A ceiling is a count — of bytes or of
 * milliseconds — so only a finite positive integer is meaningful: `0` and a
 * negative would rotate on (or before) every write, and `NaN`/`Infinity`/a
 * fractional value would make the comparison in `shouldRotate` silently
 * never fire.
 */
function readOptionalPositiveInteger(
  bag: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  if (!Object.hasOwn(bag, key)) {
    return undefined;
  }
  const value = bag[key];
  if (!isNumber(value) || !Number.isInteger(value) || value <= 0) {
    throw invalidArgument(key, "not-a-positive-integer");
  }
  return value;
}

/**
 * The validated constructor overrides. Each field is still optional: an
 * absent one means "use the documented default", which the public class
 * resolves (it owns the default directory and the two ceiling constants).
 */
export interface AgentDecisionLogWriterOverrides {
  /** The validated `directory` override, or `undefined` when absent. */
  readonly directory: string | undefined;
  /** The validated `maxSegmentBytes` override, or `undefined` when absent. */
  readonly maxSegmentBytes: number | undefined;
  /** The validated `maxSegmentAgeMs` override, or `undefined` when absent. */
  readonly maxSegmentAgeMs: number | undefined;
  /** The validated `onSealFailed` override, or `undefined` when absent. */
  readonly onSealFailed:
    ((failure: M3LAppendOnlySealFailure) => void) | undefined;
}

/**
 * Validates `M3LAgentDecisionLog`'s options bag at the public boundary.
 *
 * An omitted bag is legal (every field has a default), but `null` is not: it
 * is a caller mistake that `options?.directory` would silently read as
 * "absent". Unknown keys are rejected rather than ignored, following this
 * namespace's allowlist precedent (`validateAgentPolicy`,
 * `buildAgentDecisionLogEntry`) — an unrecognised key in a bag like this one
 * is overwhelmingly a typo'd known one, and silently ignoring it would leave
 * a caller who wrote `maxSegmentByte` believing they had raised a ceiling.
 *
 * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when the bag
 *   is not a plain object, carries an unknown or dangerous key, has a
 *   blank/non-string `directory`, a `maxSegmentBytes` / `maxSegmentAgeMs`
 *   that is not a finite positive integer, or a truthy non-function
 *   `onSealFailed`.
 */
export function validateAgentDecisionLogOptions(
  options: unknown,
): AgentDecisionLogWriterOverrides {
  if (options === undefined) {
    return {
      directory: undefined,
      maxSegmentBytes: undefined,
      maxSegmentAgeMs: undefined,
      onSealFailed: undefined,
    };
  }
  if (!isPlainObject(options)) {
    throw invalidArgument("options", "not-an-object");
  }
  assertAllowedKeys(options, WRITER_OPTIONS_KEYS, "options", invalidArgument);
  return {
    directory: readOptionalDirectory(options),
    maxSegmentBytes: readOptionalPositiveInteger(options, "maxSegmentBytes"),
    maxSegmentAgeMs: readOptionalPositiveInteger(options, "maxSegmentAgeMs"),
    // The truthy-non-function / falsy-degrades polarity this validates —
    // and why it must not be tightened — is documented once, on the shared
    // {@link "../storage/append-only-options.js".readOnSealFailed}.
    onSealFailed: readOnSealFailed(options, invalidArgument),
  };
}
/**
 * The decision log's half of the generic writer's error port: it turns the
 * two failures `AppendOnlyWriter` can report into this module's own
 * {@link M3LAgentDecisionLogWriteError}, with the exact message and
 * `context` `core/agent`'s public surface documents.
 *
 * Only byte counts and a chained `cause` cross this boundary, so neither
 * error can carry a value read out of the caller's input — see this module's
 * header.
 */
const AGENT_DECISION_LOG_ERRORS: AppendOnlyWriterErrors = {
  oversize(lineBytes: number, maxLineBytes: number): M3LError {
    return new M3LAgentDecisionLogWriteError(
      "agent decision log: serialized entry exceeds the maximum line size",
      { context: { lineBytes, maxLineBytes } },
    );
  },
  appendFailed(cause: unknown): M3LError {
    // No `context`: everything worth naming here is the directory path,
    // which is caller input. The chained `cause` is Node's own error and
    // carries the operational detail — see this module's header.
    return new M3LAgentDecisionLogWriteError(
      "agent decision log: failed to append an entry",
      { cause },
    );
  },
};

/**
 * Proves `entry` structurally, rebuilds it as this library's own detached
 * copy, and renders the JSON text of the line the filesystem will receive.
 * The trailing newline is **not** added here: `AppendOnlyWriter` appends it,
 * so the line ceiling is measured over exactly the bytes one atomic write
 * must carry.
 *
 * What is serialized is **never the caller's object**. `JSON.stringify`
 * dispatches an inherited `toJSON`, and returns `undefined` — without
 * throwing — for one that yields `undefined`, so serializing the argument
 * directly would let a gadget on `Object.prototype` either forge the
 * persisted record or launder the text `undefined` into the log as a line no
 * reader can parse. `projectAgentDecisionLogEntry` closes both by rebuilding
 * every node with a null prototype; see that module's header. The `typeof`
 * check below is the belt to that projection's braces — the projection is
 * provably serializable, so nothing should be able to make `stringify` yield
 * a non-string here, and if something does the line is never written.
 *
 * The validation and serialization run here, ahead of (and outside) the
 * writer's own append guard, because an entry that cannot be serialized is a
 * caller error, not a write failure: wrapping it in
 * {@link M3LAgentDecisionLogWriteError} would tell an operator the
 * filesystem is unhealthy when the argument was.
 *
 * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when `entry`
 *   is not a plain object, carries an unknown or dangerous own key, or holds
 *   a field of the wrong shape — which also rules out every value
 *   `JSON.stringify` throws on (a circular reference, a `BigInt`) and every
 *   value it returns `undefined` for, since neither can survive the
 *   projection.
 */
function renderLogLine(entry: M3LAgentDecisionLogEntry): string {
  const projection = projectAgentDecisionLogEntry(entry, invalidArgument);
  // Typed `unknown` on purpose: the declared return type is `string`, and the
  // whole point of this check is that a return type is not a runtime proof.
  const json: unknown = serializeAgentDecisionLogEntry(projection);
  if (typeof json !== "string") {
    throw invalidArgument("entry", "not-json-serializable");
  }
  return json;
}

/**
 * Constructor options for {@link AgentDecisionLogWriter}.
 *
 * An object rather than four positional parameters. Three of the four
 * values are `string, number, number, function` — a fourth positional
 * `onSealFailed` would put `maxSegmentBytes` and `maxSegmentAgeMs` next to
 * each other as two bare numbers, and a call site transposing them would
 * still typecheck. The rotation ceilings are exactly the pair where a
 * silent transposition produces a plausible-looking but wrong trail (a
 * byte ceiling doing duty as an age ceiling and vice versa), so the two are
 * named on an object precisely to make that swap impossible to typo into
 * existence.
 */
export interface AgentDecisionLogWriterOptions {
  /** The directory the segments (and the manifest sidecar) live in. */
  readonly directory: string;
  /** Rotate once the active segment has reached this many bytes. */
  readonly maxSegmentBytes: number;
  /** Rotate once the active segment has been open this many milliseconds. */
  readonly maxSegmentAgeMs: number;
  /**
   * Told about every seal that could not be written to the manifest
   * sidecar. Optional: sealing is best-effort by design (see this class's
   * own TSDoc), and the sealer never depends on a handler being there to
   * absorb a failure.
   */
  readonly onSealFailed?: (failure: M3LAppendOnlySealFailure) => void;
}

/**
 * The decision log's writer: the agent-specific rendering and error
 * vocabulary bound to one generic {@link AppendOnlyWriter}, which owns the
 * rotation decision, the atomic append, and the serialized append chain. A
 * directory-wide `manifest.jsonl` sidecar is sealed on rotation by
 * {@link "../storage/append-only-sealer.js".AppendOnlySealer}, giving the
 * decision log the same tamper-evidence proof
 * {@link "../../core/storage/M3LAppendOnlyStream.js".M3LAppendOnlyStream}
 * carries — recording each sealed segment's entry count, byte length and
 * plain sha256.
 *
 * Three things stay true even with the manifest in the picture, and they
 * must not be read as in tension with each other:
 * - the manifest is never consulted to decide where to append — a fresh
 *   instance still re-derives the active segment from a directory listing
 *   plus one `stat`, so a long-lived process and a freshly spawned one
 *   still agree;
 * - the manifest carries no in-memory state across processes either;
 * - the manifest is not a segment, so it is invisible to segment discovery.
 *
 * Rotation only ever seals the active segment (by simply no longer writing
 * to it) and opens a new one; it never prunes or truncates a segment in
 * place.
 *
 * **A failed APPEND stays loud; a failed SEAL does not, and that is a
 * deliberate asymmetry, not a weakening of the append rule.** A seal is
 * metadata about bytes that are already durably appended — failing a new
 * entry's append to protect a proof about an *older* one would discard a
 * new auditable record in order to defend an old one. So sealing is
 * best-effort: a seal failure is reported only through the optional
 * `onSealFailed` handler, never by throwing out of `write()`, and never at
 * the cost of the append it follows.
 */
export class AgentDecisionLogWriter {
  private readonly writer: AppendOnlyWriter<M3LAgentDecisionLogEntry>;

  constructor(options: AgentDecisionLogWriterOptions) {
    const sealer = new AppendOnlySealer({
      directory: options.directory,
      maxSegmentBytes: options.maxSegmentBytes,
      maxLineBytes: M3L_AGENT_MAX_LOG_ENTRY_BYTES,
      maxManifestBytes: DEFAULT_MAX_MANIFEST_BYTES,
      // Known limitation: this single `AppendOnlyReadFailure` builder serves
      // BOTH the sealer's manifest reads and its manifest appends, so the
      // class name never discriminates direction. For this owner it is the
      // READ side that is misnamed — a failed manifest read (e.g.
      // `append-only-manifest.ts`'s baseline/listing reads) still surfaces as
      // a "Write" error. The `cause` and `message` carry the accurate
      // operational detail regardless, so nothing but the class name is
      // wrong. X8b4 introduces a dedicated `M3LAppendOnlyStreamManifestError`
      // (code `ERR_APPEND_ONLY_STREAM_MANIFEST`) that actually resolves this.
      buildError: (message, errorOptions) =>
        new M3LAgentDecisionLogWriteError(message, errorOptions),
      // Conditional spread, not a direct assignment: `exactOptionalPropertyTypes`
      // forbids setting an optional property to a value typed `T | undefined`.
      ...(options.onSealFailed !== undefined && {
        onSealFailed: options.onSealFailed,
      }),
    });
    this.writer = new AppendOnlyWriter<M3LAgentDecisionLogEntry>({
      directory: options.directory,
      maxSegmentBytes: options.maxSegmentBytes,
      maxSegmentAgeMs: options.maxSegmentAgeMs,
      maxLineBytes: M3L_AGENT_MAX_LOG_ENTRY_BYTES,
      renderEntry: renderLogLine,
      errors: AGENT_DECISION_LOG_ERRORS,
      sealer,
    });
  }

  /**
   * Appends one entry as a single JSON line, rotating the active segment
   * first when any ceiling is already crossed. Validates the entry, rebuilds
   * it as this library's own detached copy, and renders the line before
   * touching the filesystem at all, so a rejected entry leaves nothing
   * behind — and what reaches disk is the projection, never the caller's
   * object (see {@link renderLogLine}).
   *
   * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when `entry`
   *   is not structurally a decision-log entry — a caller-side violation, not
   *   a write failure.
   * @throws {@link M3LAgentDecisionLogWriteError} when the rendered line
   *   exceeds `M3L_AGENT_MAX_LOG_ENTRY_BYTES` — well-formed, but larger than
   *   this writer can durably append in one atomic write — or when the
   *   append itself fails for any reason, including a segment path that has
   *   been replaced by a symlink. The underlying cause is always chained;
   *   neither message nor `context` ever carries caller data.
   */
  async write(entry: M3LAgentDecisionLogEntry): Promise<void> {
    await this.writer.write(entry);
  }

  /**
   * Drains the underlying {@link AppendOnlyWriter}'s serialized append
   * chain as it stands at the moment of the call. One-line delegation —
   * see {@link AppendOnlyWriter.flush} for the full guarantee (a
   * point-in-time drain, never rejects).
   */
  async flush(): Promise<void> {
    await this.writer.flush();
  }
}
