/**
 * `internal/agent/decision-log-writer` — the append-only segmented writer
 * behind `core/agent`'s public `M3LAgentDecisionLog` class (ADR-0061, V7
 * slice 2).
 *
 * Private to `core/agent`; never re-exported through a public barrel. All
 * filesystem access — directory creation, cold-start segment discovery, the
 * rotation decision, and the append itself — lives here so
 * `core/agent/decision-log.ts` stays a thin, documented wrapper.
 */

import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { serializeAgentDecisionLogEntry } from "../../core/agent/decision-log-entry.js";
import { M3LAgentDecisionLogWriteError } from "../../core/agent/M3LAgentDecisionLogWriteError.js";
import type { M3LAgentDecisionLogEntry } from "../../core/agent/decision-log-types.js";
import { M3L_AGENT_MAX_LOG_ENTRY_BYTES } from "../../core/agent/decision-log-types.js";
import { M3LError } from "../../core/errors/index.js";

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

/** The writer's in-memory record of the currently active segment. */
interface ActiveSegment {
  readonly path: string;
  readonly datePrefix: string;
  readonly sequence: number;
  size: number;
  createdAtMs: number;
}

/** Parses one directory entry name, or `undefined` if it doesn't match. */
function parseSegmentName(name: string): ParsedSegmentName | undefined {
  const match = SEGMENT_NAME_PATTERN.exec(name);
  if (match === null) {
    return undefined;
  }
  const [, datePrefix, sequenceText] = match;
  if (datePrefix === undefined || sequenceText === undefined) {
    return undefined;
  }
  return { datePrefix, sequence: Number.parseInt(sequenceText, 10) };
}

/** Today's UTC date prefix, `YYYY-MM-DD`. */
function currentDatePrefix(): string {
  return new Date(Date.now()).toISOString().slice(0, DATE_PREFIX_LENGTH);
}

/** Renders a segment file name from its date prefix and sequence number. */
function segmentFileName(datePrefix: string, sequence: number): string {
  return `${datePrefix}-${String(sequence).padStart(SEQUENCE_WIDTH, "0")}.jsonl`;
}

/**
 * The append-only segmented writer's guts: cold-start discovery, the
 * byte/age rotation decision, and one `appendFile` call per entry.
 *
 * No index file is kept and no state is carried across processes — a fresh
 * instance always re-derives the active segment from a directory listing
 * plus one `stat`, so a long-lived process and a freshly spawned one agree.
 * Rotation only ever seals the active segment (by simply no longer writing
 * to it) and opens a new one; it never prunes or truncates a segment in
 * place.
 */
export class AgentDecisionLogWriter {
  private readonly directory: string;
  private readonly maxSegmentBytes: number;
  private readonly maxSegmentAgeMs: number;
  private active: ActiveSegment | undefined;

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
   * rotating the active segment first when either ceiling is already
   * crossed. Rejects an oversized entry before touching the filesystem at
   * all.
   *
   * @throws M3LAgentDecisionLogWriteError When the serialized entry exceeds
   *   `M3L_AGENT_MAX_LOG_ENTRY_BYTES`, or the append itself fails for any
   *   reason. The underlying cause is always chained; `context` never
   *   carries caller data.
   */
  async write(entry: M3LAgentDecisionLogEntry): Promise<void> {
    const json = serializeAgentDecisionLogEntry(entry);
    const lineBytes = Buffer.byteLength(json, "utf8");
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

    try {
      const current = await this.resolveActiveSegment();
      const segment = this.shouldRotate(current)
        ? this.openNewSegment(current)
        : current;

      const line = `${json}\n`;
      // O_APPEND: seeking to the end and writing are one atomic step from
      // the kernel's point of view on a local filesystem, so two writers
      // interleave whole lines rather than corrupting one another. This does
      // not hold across NFS, and does not cover a write() larger than the
      // pipe/write buffer — which is exactly why the ceiling check above
      // runs before any of this.
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

  /** Whether `segment` has already crossed either rotation ceiling. */
  private shouldRotate(segment: ActiveSegment): boolean {
    return (
      segment.size >= this.maxSegmentBytes ||
      Date.now() - segment.createdAtMs >= this.maxSegmentAgeMs
    );
  }

  /**
   * Returns the writer's in-memory active segment, discovering it from the
   * directory (cold-start) on this instance's first call.
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
