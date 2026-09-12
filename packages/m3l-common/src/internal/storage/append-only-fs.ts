/**
 * `internal/storage/append-only-fs` — the append-only stream's guarded
 * filesystem primitives: the open flags a file in a stream directory is
 * opened under, the permission modes the directory and a new file in it are
 * created with, and the post-open `fstat` refusals it has to survive before a
 * single byte of it is trusted (ADR-0061, ADR-0102, X8b slice 2).
 *
 * Library-internal; never re-exported through a public barrel. Split out of
 * the append-only reader (`./append-only-reader.js`) to be the single home
 * for these refusals across every consumer of the stream's on-disk layout —
 * the reader, the writer (`./append-only-writer.js`), and the segment layer
 * (`./append-only-segments.js`). The reader and the writer both open through
 * this module, and the segment layer takes both its directory mode
 * ({@link DIRECTORY_MODE}) and its expected link count
 * ({@link SEGMENT_EXPECTED_LINK_COUNT}) from here as well, so one copy of
 * each filesystem policy now serves all three consumers.
 * ADR-0102's sealed-segment manifest sidecar is created under
 * {@link SEGMENT_FILE_MODE} and opens through these same refusals rather than
 * adding a copy of them.
 *
 * The dependency runs one way only: `./append-only-reader.js`,
 * `./append-only-writer.js`, and `./append-only-segments.js` import this
 * module, never the reverse. Nothing here knows what an entry *is*, how a
 * segment is named, or what public error class an owner raises — every
 * failure is reported through the caller's own
 * {@link "./append-only-lines.js".AppendOnlyReadFailure} port.
 *
 * A segment is opened for reading with the same `O_NOFOLLOW` refusal the
 * writer applies through {@link APPEND_FLAGS}, which lives here too, so a
 * segment path replaced by a symlink is refused rather than followed, and the
 * writer's `nlink === 1` hardlink check IS mirrored here, on the same opened
 * descriptor, for a reason specific to the read side: a hardlink lets a
 * lower-privilege actor **nominate** a file whose contents they cannot read
 * themselves, for a higher-privilege reader to read and then republish into
 * the audit index — where the nominating actor can read it. That is a
 * confused-deputy read primitive, not "a file with two names", and skipping
 * the check here would leave it open even though the writer already closes it
 * on the write side.
 *
 * The same `fstat` also refuses anything that opened but is not a plain
 * regular file — a FIFO planted at a segment path, in particular, would
 * otherwise block `open()` in the kernel forever; see
 * {@link SEGMENT_READ_FLAGS}'s `O_NONBLOCK` below for the other half of that
 * fix.
 */

import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";

import type { AppendOnlyReadFailure } from "./append-only-lines.js";

/**
 * `O_NOFOLLOW` where the platform has it, so a path that has been replaced by
 * a symlink is **refused** rather than followed.
 *
 * Typed `number | undefined` rather than trusting `@types/node`'s
 * unconditional `number`: the flag is POSIX-only and Node genuinely reports
 * it as `undefined` on Windows, where a numeric `NaN` flag would make every
 * open fail. `undefined` (never a `NaN` flag) on a platform without it, so
 * the symlink refusal simply does not apply there.
 *
 * `O_NOFOLLOW` covers a **symlink** at the final path component and nothing
 * else; a **hardlink** is a second directory entry for one inode, so `open`
 * succeeds and the flag never fires. That half is closed separately, by the
 * `nlink` check in {@link assertSegmentIsReadable} on the read side and by
 * the one in {@link "./append-only-writer.js".AppendOnlyWriter.append} on the
 * write side.
 *
 * Deliberately NOT exported: every consumer takes it already folded into
 * {@link SEGMENT_READ_FLAGS} or {@link APPEND_FLAGS}, so nothing outside this
 * module imports the bare flag and `knip` rejects an export that has no
 * external importer.
 */
const O_NOFOLLOW: number | undefined = constants.O_NOFOLLOW;

/**
 * `O_NONBLOCK` where the platform has it. Load-bearing for the FIFO refusal
 * below: a plain post-open `fstat` cannot refuse a planted FIFO if `open()`
 * itself never returns. `O_RDONLY` on a FIFO with no writer blocks in the
 * kernel indefinitely; `O_NONBLOCK` makes that same `open()` return
 * immediately instead (Linux/POSIX: opening a FIFO for reading with
 * `O_NONBLOCK` never waits for a writer to appear). It has no effect on a
 * regular file's `open()` or subsequent `read()`s, so every other segment a
 * reader ever opens is unaffected — the `fstat` immediately after open is
 * what actually refuses the FIFO, this flag only makes that `fstat`
 * reachable at all.
 */
const O_NONBLOCK: number | undefined = constants.O_NONBLOCK;

/**
 * Folds a platform-optional open flag into an open mask: the flag itself where
 * the platform defines it, **nothing at all** (`0`, the identity for `|`)
 * where it does not.
 *
 * `node:fs`'s `constants.O_NOFOLLOW` and `constants.O_NONBLOCK` are POSIX-only
 * and Node genuinely reports them as `undefined` on Windows, even though
 * `@types/node` declares both as unconditional `number` — hence the
 * `number | undefined` parameter, which is the correction to that declaration
 * and the whole reason this helper exists rather than a bare fallback at each
 * site. OR-ing an `undefined` flag in directly would produce a `NaN` mask and
 * make every open fail; contributing `0` instead leaves the base mask
 * byte-identical, so the defence that flag provides simply does not apply on
 * that platform.
 *
 * Uses the nullish coalescing operator, **never** a logical-OR fallback: `0`
 * is a legitimate flag value, and `||` would wrongly discard a
 * defined-but-zero flag by treating it as absent. The two operators agree for
 * `undefined` and disagree for `0`, which is exactly the difference the
 * `flagOrZero(0)` case in this module's test suite exists to catch.
 *
 * @example
 * ```ts
 * import { constants } from "node:fs";
 *
 * // On Linux the flag is defined and contributes itself; on Windows it is
 * // `undefined` and the mask is just `O_RDONLY`.
 * const flags = constants.O_RDONLY | flagOrZero(constants.O_NOFOLLOW);
 * ```
 */
export function flagOrZero(flag: number | undefined): number {
  return flag ?? 0;
}

/**
 * Read-only, refusing a symlinked segment path where the platform allows,
 * and never blocking on a planted FIFO/other non-regular file — see
 * {@link O_NOFOLLOW} and {@link O_NONBLOCK} above.
 */
export const SEGMENT_READ_FLAGS: number =
  constants.O_RDONLY | flagOrZero(O_NOFOLLOW) | flagOrZero(O_NONBLOCK);

/**
 * The open flags for one append: the three the `"a"` shorthand stands for —
 * append, create, write-only — plus `O_NOFOLLOW`, so a segment path that has
 * been replaced by a symlink is **refused** rather than followed.
 *
 * Without it, anyone who can create a file in the stream directory can
 * redirect (or silently sink) the audit trail by planting the next segment
 * name as a symlink — the append would resolve it and write outside the
 * directory. With it, `open` fails `ELOOP` and the write is reported as the
 * loud failure it is. On a platform without the flag (Windows) the value
 * falls back to the plain `"a"` trio and this defence simply does not apply.
 *
 * `O_NOFOLLOW` covers a **symlink** at the final path component and nothing
 * else; a **hardlink** is a second directory entry for one inode, so `open`
 * succeeds and the flag never fires. That half is closed separately, by the
 * `nlink` check in {@link "./append-only-writer.js".AppendOnlyWriter.append}.
 */
export const APPEND_FLAGS: number =
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_WRONLY |
  flagOrZero(O_NOFOLLOW);

/**
 * The permission mode the stream directory is **created** with: owner-only
 * read/write/traverse, matching the mode this repo already applies to a
 * console session's artifact directory
 * (`m3l-console-server/src/sessions/artifacts.ts`) for the same class of
 * data. The directory half of one filesystem policy whose file half is
 * {@link SEGMENT_FILE_MODE}.
 *
 * An audit trail left group- or world-readable under a default umask is a
 * disclosure on its own, and it widens the planted-link problem the writer
 * guards: anyone who can create a file in the directory can plant the next
 * segment name. The process umask can only **remove** bits from a mode passed
 * explicitly, never add one, so a stricter umask still wins; a directory that
 * already exists keeps the mode it was created with.
 *
 * Exported for the segment layer
 * ({@link "./append-only-segments.js".discoverActiveSegment}), which is the
 * only place a stream directory is created.
 */
export const DIRECTORY_MODE = 0o700;

/**
 * The permission mode a segment file is **created** with: owner read/write
 * only, matching the mode this repo already applies to a console session's
 * artifacts (`m3l-console-server/src/sessions/artifacts.ts`) for the same
 * class of data.
 *
 * The mode is applied by `open` on creation only, and the process umask can
 * only **remove** bits from it — never add one. A segment that already exists
 * keeps whatever mode it was created with, and a segment a caller has
 * loosened by hand is not tightened back by the `open` this mode is passed
 * to.
 */
export const SEGMENT_FILE_MODE = 0o600;

/**
 * The number of directory entries a segment this stream owns may have.
 *
 * Exactly one. A freshly created segment has one name; a segment adopted on a
 * cold start was created by the stream's own writer and has one too. More than one
 * means somebody else has linked the inode into a second place, which is the
 * hardlink variant of the redirection `O_NOFOLLOW` refuses for symlinks.
 *
 * Exported because both sides of the stream enforce it on the descriptor
 * they are about to use: {@link assertSegmentIsReadable} before a read, and
 * {@link "./append-only-writer.js".AppendOnlyWriter.append} before an append.
 */
export const SEGMENT_EXPECTED_LINK_COUNT = 1;

/**
 * Rejects a segment whose `fstat` reveals it is not a plain, single-link
 * regular file. See `./append-only-reader.js`'s `readSegmentEntries` call
 * site and this module's header for why a FIFO or a hardlink is not safe to
 * read past this point.
 *
 * Extracted from `./append-only-reader.js`'s `readSegmentEntries` solely to
 * keep that generator's cyclomatic complexity bounded — the check itself is
 * unchanged.
 */
export async function assertSegmentIsReadable(
  handle: FileHandle,
  buildError: AppendOnlyReadFailure,
): Promise<void> {
  // See `SEGMENT_READ_FLAGS`/`O_NONBLOCK` above for why this `fstat` is
  // reachable at all for a planted FIFO. `isFile()` refuses any non-regular
  // node (FIFO, device, socket); `nlink` refuses an already-planted
  // hardlink — see this module's header for why a hardlinked segment is
  // NOT harmless to read.
  const stats = await handle.stat();
  if (!stats.isFile() || stats.nlink !== SEGMENT_EXPECTED_LINK_COUNT) {
    throw buildError(
      "append-only stream: a segment path is not a plain, single-link file",
      { context: { isFile: stats.isFile(), nlink: stats.nlink } },
    );
  }
}
