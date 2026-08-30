/**
 * `internal/agent/decision-log-writer` — the append-only segmented writer
 * behind `core/agent`'s public `M3LAgentDecisionLog` class (ADR-0061, V7
 * slice 2).
 *
 * Private to `core/agent`; never re-exported through a public barrel. All
 * filesystem access — directory creation, cold-start segment discovery, the
 * rotation decision, and the append itself — lives here so
 * `core/agent/decision-log.ts` stays a thin, documented wrapper, together
 * with the constructor's own options validation (so the public class holds
 * no validation logic of its own).
 *
 * Two error vocabularies meet here and are kept apart deliberately:
 *
 * - a **caller-side** violation — a malformed options bag, a non-object
 *   entry, an entry `JSON.stringify` cannot serialize at all — throws a bare
 *   `M3LError` with `code: "ERR_INVALID_ARGUMENT"`, matching the house
 *   pattern in `aws/s3/uri.ts` and `internal/logging/levels.ts`;
 * - a failure of the **append itself**, including a well-formed entry that is
 *   simply larger than one atomic write can durably carry, throws
 *   `M3LAgentDecisionLogWriteError` (`ERR_AGENT_DECISION_LOG_WRITE`).
 *
 * No error message or `context` built here ever carries a value read out of
 * the caller's input: they name the field and the violation kind only. A
 * directory path can carry tenant or customer identifiers, and an entry
 * carries identity and reason text.
 */

import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { serializeAgentDecisionLogEntry } from "../../core/agent/decision-log-entry.js";
import { M3LAgentDecisionLogWriteError } from "../../core/agent/M3LAgentDecisionLogWriteError.js";
import type { M3LAgentDecisionLogEntry } from "../../core/agent/decision-log-types.js";
import { M3L_AGENT_MAX_LOG_ENTRY_BYTES } from "../../core/agent/decision-log-types.js";
import { M3LError } from "../../core/errors/index.js";
import { isNumber, isPlainObject } from "../../core/utils/guards.js";
import { assertAllowedKeys, isNonBlankString } from "./validation.js";

/** One segment file name's parsed parts: its UTC date prefix and sequence. */
interface ParsedSegmentName {
  readonly datePrefix: string;
  readonly sequence: number;
}

/** Matches this writer's own segment naming, `<YYYY-MM-DD>-<NNNN>.jsonl`. */
const SEGMENT_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2})-(\d{4,})\.jsonl$/;

/** The length of the `YYYY-MM-DD` date prefix within an ISO-8601 timestamp. */
const DATE_PREFIX_LENGTH = 10;

/** The zero-padded width of a segment's sequence number in its file name. */
const SEQUENCE_WIDTH = 4;

/** The only own keys `M3LAgentDecisionLogOptions` may carry. */
const WRITER_OPTIONS_KEYS: ReadonlySet<string> = new Set([
  "directory",
  "maxSegmentBytes",
  "maxSegmentAgeMs",
]);

/** The writer's in-memory record of the currently active segment. */
interface ActiveSegment {
  readonly path: string;
  readonly datePrefix: string;
  readonly sequence: number;
  size: number;
  createdAtMs: number;
}

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

/** Renders a segment file name from its date prefix and sequence number. */
function segmentFileName(datePrefix: string, sequence: number): string {
  return `${datePrefix}-${String(sequence).padStart(SEQUENCE_WIDTH, "0")}.jsonl`;
}

/**
 * Parses one directory entry name, or `undefined` if it isn't a name this
 * writer would itself have produced.
 *
 * The round-trip check is load-bearing, not belt-and-braces. The pattern
 * accepts `\d{4,}` while {@link segmentFileName} re-pads to width four, so
 * `2026-01-01-00005.jsonl` would parse to sequence 5 and be rebuilt as
 * `-0005.jsonl` — a path that does not exist, whose `stat` ENOENTs and turns
 * every subsequent write into that directory into a wrapped write error.
 * Only zero-padding *wider* than four is lossy: a genuinely wide sequence
 * such as `10000` round-trips, because `padStart(4)` is a no-op above four
 * digits. Of the two legal repairs (round-trip the foreign name faithfully,
 * or decline it), declining is chosen: a name this writer cannot itself
 * render was written by something else, and adopting another producer's
 * file as our active segment is the more surprising of the two.
 */
function parseSegmentName(name: string): ParsedSegmentName | undefined {
  const match = SEGMENT_NAME_PATTERN.exec(name);
  if (match === null) {
    return undefined;
  }
  const [, datePrefix, sequenceText] = match;
  if (datePrefix === undefined || sequenceText === undefined) {
    return undefined;
  }
  const sequence = Number.parseInt(sequenceText, 10);
  if (segmentFileName(datePrefix, sequence) !== name) {
    return undefined;
  }
  return { datePrefix, sequence };
}

/** Today's UTC date prefix, `YYYY-MM-DD`. */
function currentDatePrefix(): string {
  return new Date(Date.now()).toISOString().slice(0, DATE_PREFIX_LENGTH);
}

/**
 * Validates `entry` and renders the exact line the filesystem will receive:
 * `JSON.stringify(entry) + "\n"`.
 *
 * The serialization runs here, ahead of (and outside) the writer's own
 * append guard, because an entry that cannot be serialized is a caller
 * error, not a write failure: wrapping it in
 * {@link M3LAgentDecisionLogWriteError} would tell an operator the
 * filesystem is unhealthy when the argument was.
 *
 * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when `entry`
 *   is not a plain object, or holds a circular reference or a `BigInt` —
 *   values `JSON.stringify` throws on. The plain-object guard also rules out
 *   the inputs (`undefined`, a function, a symbol) for which
 *   `JSON.stringify` returns `undefined` rather than throwing, which would
 *   otherwise reach `Buffer.byteLength` as a raw Node `ERR_INVALID_ARG_TYPE`.
 * @throws {@link M3LAgentDecisionLogWriteError} when the rendered line
 *   exceeds `M3L_AGENT_MAX_LOG_ENTRY_BYTES`. The ceiling governs the LINE,
 *   not the serialization alone: the newline is part of what one `write()`
 *   must carry atomically, so an entry serializing to exactly the ceiling is
 *   one byte too large.
 */
function renderLogLine(entry: M3LAgentDecisionLogEntry): string {
  if (!isPlainObject(entry)) {
    throw invalidArgument("entry", "not-an-object");
  }
  let json: string;
  try {
    json = serializeAgentDecisionLogEntry(entry);
  } catch (cause) {
    throw new M3LError(
      'agent decision log: "entry" is invalid (not-json-serializable)',
      {
        code: "ERR_INVALID_ARGUMENT",
        context: { field: "entry", violation: "not-json-serializable" },
        cause,
      },
    );
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
 * The append-only segmented writer's guts: cold-start discovery, the
 * byte/age/date rotation decision, and one `appendFile` call per entry.
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
   * Appends one entry as a single `JSON.stringify(entry) + "\n"` line,
   * rotating the active segment first when any ceiling is already crossed.
   * Validates and renders the line before touching the filesystem at all, so
   * a rejected entry leaves nothing behind.
   *
   * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when `entry`
   *   is not a plain object, or cannot be serialized at all (a circular
   *   reference, a `BigInt`) — a caller-side violation, not a write failure.
   * @throws {@link M3LAgentDecisionLogWriteError} when the rendered line
   *   exceeds `M3L_AGENT_MAX_LOG_ENTRY_BYTES` — well-formed, but larger than
   *   this writer can durably append in one atomic write — or when the
   *   append itself fails for any reason. The underlying cause is always
   *   chained; neither message nor `context` ever carries caller data.
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
        ? this.openNewSegment(current)
        : current;

      // O_APPEND: seeking to the end and writing are one atomic step from
      // the kernel's point of view on a local filesystem, so two writers
      // interleave whole lines rather than corrupting one another. This does
      // not hold across NFS, and does not cover a write() larger than the
      // pipe/write buffer — which is exactly why `renderLogLine`'s ceiling
      // check runs before any of this.
      await appendFile(segment.path, line, { encoding: "utf8", flag: "a" });
      segment.size += Buffer.byteLength(line, "utf8");
      this.active = segment;
    } catch (cause) {
      // Already typed — re-throw unchanged rather than double-wrapping.
      if (cause instanceof M3LError) {
        throw cause;
      }
      throw new M3LAgentDecisionLogWriteError(
        "agent decision log: failed to append an entry",
        { context: { directory: this.directory }, cause },
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
   * directory (cold-start) on this instance's first call.
   *
   * A discovered segment's age is taken from `birthtimeMs`, falling back to
   * `mtimeMs` on a filesystem that reports no birth time (it reports `0`).
   * That fallback is a known, accepted approximation, in the same register
   * as the O_APPEND/NFS caveat above: `mtimeMs` is the time of the last
   * *write*, so on such a filesystem a continuously appended segment keeps
   * resetting its own measured age and may never reach `maxSegmentAgeMs`.
   * The byte ceiling and the date rollover both still bound it. Carrying an
   * in-memory creation time to paper over this is deliberately NOT done: it
   * would be state that a freshly spawned process cannot reconstruct, and
   * cold-start agreement between processes is the stronger guarantee.
   */
  private async resolveActiveSegment(): Promise<ActiveSegment> {
    if (this.active !== undefined) {
      return this.active;
    }
    await mkdir(this.directory, { recursive: true });
    const datePrefix = currentDatePrefix();
    const names = await readdir(this.directory);

    let best: ParsedSegmentName | undefined;
    for (const name of names) {
      const parsed = parseSegmentName(name);
      if (
        parsed !== undefined &&
        parsed.datePrefix === datePrefix &&
        (best === undefined || parsed.sequence > best.sequence)
      ) {
        best = parsed;
      }
    }

    if (best === undefined) {
      this.active = this.newSegment(datePrefix, 1);
      return this.active;
    }

    const segmentPath = path.join(
      this.directory,
      segmentFileName(best.datePrefix, best.sequence),
    );
    const stats = await stat(segmentPath);
    this.active = {
      path: segmentPath,
      datePrefix: best.datePrefix,
      sequence: best.sequence,
      size: stats.size,
      createdAtMs: stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs,
    };
    return this.active;
  }

  /** Seals `prior` (by no longer writing to it) and opens the next segment. */
  private openNewSegment(prior: ActiveSegment): ActiveSegment {
    const datePrefix = currentDatePrefix();
    const sequence = datePrefix === prior.datePrefix ? prior.sequence + 1 : 1;
    return this.newSegment(datePrefix, sequence);
  }

  /**
   * Builds a fresh, empty in-memory segment record. The file itself is
   * created by the first `appendFile` call against it.
   */
  private newSegment(datePrefix: string, sequence: number): ActiveSegment {
    return {
      path: path.join(this.directory, segmentFileName(datePrefix, sequence)),
      datePrefix,
      sequence,
      size: 0,
      createdAtMs: Date.now(),
    };
  }
}
