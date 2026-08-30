/**
 * `internal/agent/decision-log-segments` — the decision log's segment layer:
 * segment naming, cold-start discovery, and opening the next segment
 * (ADR-0061, V7 slice 2).
 *
 * Private to `core/agent`; never re-exported through a public barrel. Split
 * out of `internal/agent/decision-log-writer.ts` so that module keeps only the
 * append itself, the rotation decision, and the options boundary — the two
 * concerns had grown past what one file can hold under
 * `check:file-budget`'s ratchet.
 *
 * Everything here is a free function over an explicit `directory`: the layer
 * holds no state at all. That is the module's actual contract — no index file
 * is kept and nothing is carried across processes, so a freshly spawned
 * process and a long-lived one always re-derive the same active segment from
 * a directory listing plus one `stat`.
 *
 * A `stat` that fails is never read as "the file is absent" unless it says
 * `ENOENT`. Every other failure propagates, because a byte count silently
 * restarting at zero is exactly the defect class this layer exists to
 * prevent: it would leave `maxSegmentBytes` unenforced on a file that is
 * already full.
 */

import type { Stats } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

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
export interface ActiveSegment {
  /** The absolute path of the segment file. */
  readonly path: string;
  /** The UTC date prefix the segment is stamped with. */
  readonly datePrefix: string;
  /** The segment's sequence number within its date. */
  readonly sequence: number;
  /** Bytes written so far, seeded from the file when one already exists. */
  size: number;
  /** When the segment came into being, for the age ceiling. */
  createdAtMs: number;
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

/**
 * `true` for a filesystem error meaning "there is nothing at that path".
 *
 * Only `ENOENT` is treated as "absent"; every other failure (`EACCES`,
 * `ELOOP`, `ENOTDIR`, …) is re-thrown by its caller and surfaces as a write
 * failure. A blanket `catch` here would reintroduce exactly the defect class
 * this module is audited for — a byte count silently restarting at zero
 * because a `stat` failed for a reason that had nothing to do with absence.
 */
function isFileNotFound(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

/**
 * Builds a fresh, empty in-memory segment record. The file itself is created
 * by the first `appendFile` call against it.
 */
function newSegment(
  directory: string,
  datePrefix: string,
  sequence: number,
): ActiveSegment {
  return {
    path: path.join(directory, segmentFileName(datePrefix, sequence)),
    datePrefix,
    sequence,
    size: 0,
    createdAtMs: Date.now(),
  };
}

/**
 * The in-memory record of a segment that already exists on disk, read from
 * one `stat`, or `undefined` when nothing is at that path yet.
 *
 * Shared by cold-start discovery and rotation so both derive a segment's byte
 * count and age from the same single source — the file itself.
 *
 * A discovered segment's age is taken from `birthtimeMs`, falling back to
 * `mtimeMs` on a filesystem that reports no birth time (it reports `0`). That
 * fallback is a known, accepted approximation, in the same register as the
 * `O_APPEND`/NFS caveat on the writer: `mtimeMs` is the time of the last
 * *write*, so on such a filesystem a continuously appended segment keeps
 * resetting its own measured age and may never reach `maxSegmentAgeMs`. The
 * byte ceiling and the date rollover both still bound it. Carrying an
 * in-memory creation time to paper over this is deliberately NOT done: it
 * would be state that a freshly spawned process cannot reconstruct, and
 * cold-start agreement between processes is the stronger guarantee.
 */
async function adoptExistingSegment(
  directory: string,
  datePrefix: string,
  sequence: number,
): Promise<ActiveSegment | undefined> {
  const segmentPath = path.join(
    directory,
    segmentFileName(datePrefix, sequence),
  );
  let stats: Stats;
  try {
    stats = await stat(segmentPath);
  } catch (cause) {
    if (isFileNotFound(cause)) {
      return undefined;
    }
    throw cause;
  }
  return {
    path: segmentPath,
    datePrefix,
    sequence,
    size: stats.size,
    createdAtMs: stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs,
  };
}

/** Today's UTC date prefix, `YYYY-MM-DD`. */
export function currentDatePrefix(): string {
  return new Date(Date.now()).toISOString().slice(0, DATE_PREFIX_LENGTH);
}

/**
 * Creates `directory` if needed and derives the active segment from what is
 * already in it: today's highest-sequence segment, adopted with its real size
 * and age, or a fresh sequence-1 record when the directory holds none.
 *
 * Only names this writer would itself have produced, carrying today's date
 * prefix, are candidates — see {@link parseSegmentName}. A foreign file (or
 * yesterday's segment, however high its sequence) is left untouched.
 */
export async function discoverActiveSegment(
  directory: string,
): Promise<ActiveSegment> {
  await mkdir(directory, { recursive: true });
  const datePrefix = currentDatePrefix();
  const names = await readdir(directory);

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
    return newSegment(directory, datePrefix, 1);
  }
  return (
    (await adoptExistingSegment(directory, best.datePrefix, best.sequence)) ??
    newSegment(directory, best.datePrefix, best.sequence)
  );
}

/**
 * Seals `prior` (by no longer writing to it) and opens the next segment,
 * **adopting** the computed file when it already exists.
 *
 * The computed name is not always free. A clock stepping back across UTC
 * midnight recomputes yesterday's name, and a sibling process (or an earlier
 * run of this one) may already have created and filled the very segment this
 * rotation is about to open. Building the record from the name alone —
 * `size: 0`, a fresh `createdAtMs` — would restart byte accounting from zero
 * on a non-empty file, so `maxSegmentBytes` would go silently unenforced for
 * a whole ceiling's worth of writes. Adopting the file's real size instead
 * keeps the ceiling honest: the adopted segment overshoots by at most the one
 * line already in flight, and the write after it rotates again. Rotation
 * still never truncates or prunes what is already there.
 */
export async function nextSegment(
  directory: string,
  prior: ActiveSegment,
): Promise<ActiveSegment> {
  const datePrefix = currentDatePrefix();
  const sequence = datePrefix === prior.datePrefix ? prior.sequence + 1 : 1;
  return (
    (await adoptExistingSegment(directory, datePrefix, sequence)) ??
    newSegment(directory, datePrefix, sequence)
  );
}
