/**
 * `internal/agent/decision-log-writer` — the append-only segmented writer
 * behind `core/agent`'s public `M3LAgentDecisionLog` class (ADR-0061, V7
 * slice 2).
 *
 * Private to `core/agent`; never re-exported through a public barrel. This
 * module owns the rotation decision, the append itself, and the constructor's
 * options validation, so `core/agent/decision-log.ts` stays a thin, documented
 * wrapper holding no validation logic of its own. The segment layer beneath it
 * — naming, cold-start discovery, and opening the next segment — lives in
 * `./decision-log-segments.js`, and the entry's structural proof and detached
 * projection in `./decision-log-projection.js`.
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
 * Two limitations are accepted rather than fixed, in the same register as the
 * `O_APPEND`/NFS caveat on {@link AgentDecisionLogWriter.append} and the
 * `birthtimeMs` one in `./decision-log-segments.js`:
 *
 * - a `maxSegmentBytes` below `M3L_AGENT_MAX_LOG_ENTRY_BYTES` yields one
 *   entry per segment — every write finds the ceiling already crossed and
 *   rotates. That is left legal on purpose: rotation has to stay testable at
 *   sizes a test can reach in a handful of writes, and a floor tied to the
 *   line ceiling would forbid exactly those. The behaviour is correct, just
 *   wasteful, and never loses or truncates a record.
 * - `createdAtMs` on a freshly opened segment is read from the wall clock, so
 *   a clock that steps **forward** and then back can leave a segment stamped
 *   in the future, making `maxSegmentAgeMs` unreachable for it. The size
 *   ceiling and the UTC-date rollover both still bound that segment, so it
 *   cannot grow without limit or outlive its day.
 */

import { constants } from "node:fs";
import { appendFile } from "node:fs/promises";

import { serializeAgentDecisionLogEntry } from "../../core/agent/decision-log-entry.js";
import { M3LAgentDecisionLogWriteError } from "../../core/agent/M3LAgentDecisionLogWriteError.js";
import type { M3LAgentDecisionLogEntry } from "../../core/agent/decision-log-types.js";
import { M3L_AGENT_MAX_LOG_ENTRY_BYTES } from "../../core/agent/decision-log-types.js";
import { M3LError } from "../../core/errors/index.js";
import { isNumber, isPlainObject } from "../../core/utils/guards.js";
import { projectAgentDecisionLogEntry } from "./decision-log-projection.js";
import type { ActiveSegment } from "./decision-log-segments.js";
import {
  currentDatePrefix,
  discoverActiveSegment,
  nextSegment,
} from "./decision-log-segments.js";
import { assertAllowedKeys, isNonBlankString } from "./validation.js";

/**
 * `O_NOFOLLOW` where the platform has it. Typed `number | undefined` rather
 * than trusting `@types/node`'s unconditional `number`: the flag is POSIX-only
 * and Node genuinely reports it as `undefined` on Windows, where a numeric
 * `NaN` flag would make every append fail.
 */
const O_NOFOLLOW: number | undefined = constants.O_NOFOLLOW;

/**
 * The open flags for one append: the three the `"a"` shorthand stands for —
 * append, create, write-only — plus `O_NOFOLLOW`, so a segment path that has
 * been replaced by a symlink is **refused** rather than followed.
 *
 * Without it, anyone who can create a file in the log directory can redirect
 * (or silently sink) the audit trail by planting the next segment name as a
 * symlink — the append would resolve it and write outside the directory. With
 * it, `open` fails `ELOOP` and the write is reported as the loud failure it
 * is. On a platform without the flag (Windows) the value falls back to the
 * plain `"a"` trio and this defence simply does not apply.
 */
const APPEND_FLAGS: number =
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_WRONLY |
  (O_NOFOLLOW ?? 0);

/** The only own keys `M3LAgentDecisionLogOptions` may carry. */
const WRITER_OPTIONS_KEYS: ReadonlySet<string> = new Set([
  "directory",
  "maxSegmentBytes",
  "maxSegmentAgeMs",
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
 *   blank/non-string `directory`, or a `maxSegmentBytes` / `maxSegmentAgeMs`
 *   that is not a finite positive integer.
 */
export function validateAgentDecisionLogOptions(
  options: unknown,
): AgentDecisionLogWriterOverrides {
  if (options === undefined) {
    return {
      directory: undefined,
      maxSegmentBytes: undefined,
      maxSegmentAgeMs: undefined,
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
  };
}

/**
 * Proves `entry` structurally, rebuilds it as this library's own detached
 * copy, and renders the exact line the filesystem will receive:
 * `JSON.stringify(projection) + "\n"`.
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
 * @throws {@link M3LAgentDecisionLogWriteError} when the rendered line
 *   exceeds `M3L_AGENT_MAX_LOG_ENTRY_BYTES`. The ceiling governs the LINE,
 *   not the serialization alone: the newline is part of what one `write()`
 *   must carry atomically, so an entry serializing to exactly the ceiling is
 *   one byte too large.
 */
function renderLogLine(entry: M3LAgentDecisionLogEntry): string {
  const projection = projectAgentDecisionLogEntry(entry, invalidArgument);
  // Typed `unknown` on purpose: the declared return type is `string`, and the
  // whole point of this check is that a return type is not a runtime proof.
  const json: unknown = serializeAgentDecisionLogEntry(projection);
  if (typeof json !== "string") {
    throw invalidArgument("entry", "not-json-serializable");
  }
  const line = `${json}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > M3L_AGENT_MAX_LOG_ENTRY_BYTES) {
    throw new M3LAgentDecisionLogWriteError(
      "agent decision log: serialized entry exceeds the maximum line size",
      {
        context: {
          lineBytes,
          maxLineBytes: M3L_AGENT_MAX_LOG_ENTRY_BYTES,
        },
      },
    );
  }
  return line;
}

/**
 * The append-only segmented writer's guts: the byte/age/date rotation
 * decision and one `appendFile` call per entry, over the stateless segment
 * layer in `./decision-log-segments.js`.
 *
 * No index file is kept and no state is carried across processes — a fresh
 * instance always re-derives the active segment from a directory listing
 * plus one `stat`, so a long-lived process and a freshly spawned one agree.
 * Rotation only ever seals the active segment (by simply no longer writing
 * to it) and opens a new one; it never prunes or truncates a segment in
 * place.
 *
 * Concurrent `write()` calls on one instance are serialized onto a tail
 * promise: each append awaits the previous one's completion. Without that,
 * two in-flight calls each resolve the active segment independently and each
 * add only their own line to `size`, so the last assignment wins and
 * byte-ceiling rotation fires a whole batch late.
 */
export class AgentDecisionLogWriter {
  private readonly directory: string;
  private readonly maxSegmentBytes: number;
  private readonly maxSegmentAgeMs: number;
  private active: ActiveSegment | undefined;
  /**
   * The tail of the serialized append chain. Always settles fulfilled — a
   * rejected append is reported to its own caller only, and must not poison
   * the chain for every subsequent one.
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(
    directory: string,
    maxSegmentBytes: number,
    maxSegmentAgeMs: number,
  ) {
    this.directory = directory;
    this.maxSegmentBytes = maxSegmentBytes;
    this.maxSegmentAgeMs = maxSegmentAgeMs;
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
    const line = renderLogLine(entry);
    const appended = this.tail.then(async () => {
      await this.append(line);
    });
    // Swallow only for the chain's own bookkeeping: `appended` is awaited
    // below, so the rejection is still reported to this caller.
    this.tail = appended.then(
      () => undefined,
      () => undefined,
    );
    await appended;
  }

  /** Resolves the target segment, rotating if needed, and appends `line`. */
  private async append(line: string): Promise<void> {
    try {
      const current = await this.resolveActiveSegment();
      const segment = this.shouldRotate(current)
        ? await nextSegment(this.directory, current)
        : current;

      // O_APPEND: seeking to the end and writing are one atomic step from
      // the kernel's point of view on a local filesystem, so two writers
      // interleave whole lines rather than corrupting one another. This does
      // not hold across NFS, and does not cover a write() larger than the
      // pipe/write buffer — which is exactly why `renderLogLine`'s ceiling
      // check runs before any of this.
      await appendFile(segment.path, line, {
        encoding: "utf8",
        flag: APPEND_FLAGS,
      });
      segment.size += Buffer.byteLength(line, "utf8");
      this.active = segment;
    } catch (cause) {
      // Drop the cached segment. `this.active` is assigned before an append
      // is known to have succeeded, and `mkdir` runs only on the
      // `this.active === undefined` branch of `resolveActiveSegment` — so a
      // log directory removed under a long-lived writer would wedge every
      // later write on this instance for the rest of the process, while a
      // freshly constructed writer recreated it and carried on. Clearing it
      // makes the next write cold-start: mkdir, then re-discover.
      this.active = undefined;
      // Already typed — re-throw unchanged rather than double-wrapping.
      if (cause instanceof M3LError) {
        throw cause;
      }
      // No `context`: everything worth naming here is the directory path,
      // which is caller input. The chained `cause` is Node's own error and
      // carries the operational detail — see this module's header.
      throw new M3LAgentDecisionLogWriteError(
        "agent decision log: failed to append an entry",
        { cause },
      );
    }
  }

  /**
   * Whether `segment` has already crossed any rotation ceiling: its size, its
   * age, or the UTC date it is stamped with.
   *
   * The date check is what makes the module's "a freshly spawned process and
   * a long-lived one always agree" guarantee true. Cold-start discovery only
   * ever considers candidates carrying today's prefix, so without this a
   * long-lived process crossing midnight under both other ceilings would
   * keep appending to yesterday's segment while a process spawned one second
   * later opened today's.
   */
  private shouldRotate(segment: ActiveSegment): boolean {
    return (
      segment.datePrefix !== currentDatePrefix() ||
      segment.size >= this.maxSegmentBytes ||
      Date.now() - segment.createdAtMs >= this.maxSegmentAgeMs
    );
  }

  /**
   * Returns the writer's in-memory active segment, discovering it from the
   * directory (cold-start) on this instance's first call — including creating
   * the directory. Every later call on this instance reuses the cached
   * record, until an append fails and clears it.
   */
  private async resolveActiveSegment(): Promise<ActiveSegment> {
    if (this.active === undefined) {
      this.active = await discoverActiveSegment(this.directory);
    }
    return this.active;
  }
}
