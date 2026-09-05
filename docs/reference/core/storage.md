# `storage` — Full-text Search & Append-only Streams

The `storage` module provides two embedded, zero-network persistence primitives: `M3LFtsIndex`, a full-text search index backed by SQLite's FTS5 extension, and `M3LAppendOnlyStream`, a segmented append-only JSONL stream for audit trails.

## Overview

`M3LFtsIndex` wraps `better-sqlite3` (a native, synchronous SQLite binding) and exposes an FTS5 virtual table for in-process search. It is appropriate for searching over **thousands to low-millions of documents** without standing up an external search service.

`M3LAppendOnlyStream` is the append-only half. It writes one JSON line per entry into date-stamped, rotating segment files. It and `M3LAgentDecisionLog` (ADR-0061) are siblings rather than layers: both are built on the same library-internal append-only writer, and neither is implemented in terms of the other's public API. It is deliberately loud — an entry it cannot append raises rather than being dropped, because the caller of an audit write is usually a caller that must then be refused.

Two search modes cover distinct needs: a `full-text` mode using FTS5 `MATCH` with BM25 ranking and snippet extraction, and a `literal` mode that performs a case-insensitive substring scan for tokens with punctuation (such as UUIDs) that a tokenizer would otherwise split. For anything the typed API does not cover, `getDatabase()` exposes the raw database handle.

## Public API

Exported from `@m3l-automation/m3l-common/core` (`storage` subpath):

| Symbol                     | Kind  | Purpose                                                        |
| -------------------------- | ----- | -------------------------------------------------------------- |
| `M3LFtsIndex`              | class | The full-text index over an FTS5 virtual table.                |
| `M3LFtsIndexConfig`        | type  | Configuration (table name, metadata columns, tokenizer, etc.). |
| `M3LFtsIndexDocument`      | type  | A document to index (`id`, content, metadata).                 |
| `M3LFtsIndexSearchMode`    | type  | `'full-text'` or `'literal'`.                                  |
| `M3LFtsIndexSearchOptions` | type  | Per-query options (mode, filters, limits).                     |
| `M3LFtsIndexSearchResult`  | type  | A single ranked match, including snippet.                      |
| `M3LFtsIndexStats`         | type  | Index statistics.                                              |
| `M3LSqliteDatabase`        | type  | Type of the raw database handle from `getDatabase()`.          |
| `M3LSqliteStatement`       | type  | Type of a prepared statement.                                  |
| `M3LFtsIndexError`         | class | Thrown when caller config or search input fails validation.    |
| `M3LFtsIndexErrorCode`     | type  | Machine-readable code union carried by `M3LFtsIndexError`.     |

| Symbol                               | Kind   | Purpose                                                                                                                                                                       |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `M3LAppendOnlyStream`                | class  | Segmented append-only JSONL stream with byte/age/date rotation.                                                                                                               |
| `M3LAppendOnlyStreamOptions`         | type   | Constructor options (directory plus the three optional ceilings).                                                                                                             |
| `M3LAppendOnlyEntry`                 | type   | One entry: a read-only map of `M3LAppendOnlyValue`.                                                                                                                           |
| `M3LAppendOnlyValue`                 | type   | The closed value union an entry field may carry.                                                                                                                              |
| `M3LAppendOnlyStreamError`           | class  | Thrown when an append fails or the rendered line exceeds the ceiling.                                                                                                         |
| `M3L_APPEND_ONLY_MAX_SEGMENT_BYTES`  | const  | Default segment size ceiling, 8 MiB.                                                                                                                                          |
| `M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS` | const  | Default segment age ceiling, 24 h.                                                                                                                                            |
| `M3L_APPEND_ONLY_MAX_LINE_BYTES`     | const  | Default per-line ceiling, 64 KiB.                                                                                                                                             |
| `M3LAppendOnlyStream.read`           | method | Reads every entry back, across every date-stamped segment, in append order (X7 slice 4a).                                                                                     |
| `M3LAppendOnlyReadOptions`           | type   | Options for `read()` — an optional `onTruncatedTail` callback; unknown keys are rejected.                                                                                     |
| `M3LAppendOnlyTruncatedSegment`      | type   | The payload reported to `onTruncatedTail`: byte length and segment position.                                                                                                  |
| `M3LAppendOnlyStreamReadError`       | class  | Thrown when a read fails: a malformed/oversized line, a missing sequence, an intolerable torn tail, a planted link/FIFO, or a segment I/O failure — including a failed close. |
| `M3LAppendOnlyStream.listSegments`   | method | Inventories the segment files on disk — name, date, sequence, byte length, mtime — without reading or deleting any of them (X8 slice 5a-ii).                                  |
| `M3LAppendOnlySegmentListing`        | type   | What `listSegments()` returns: the `segments` array plus a `skipped` count of segment-named entries it refused to inventory.                                                  |
| `M3LAppendOnlySegment`               | type   | One segment as `listSegments()` reports it: `name`, `datePrefix`, `sequence`, `byteLength`, `modifiedAtMs`. Carries no path.                                                  |

### Schema

`M3LFtsIndex` creates and manages three structures:

- **`<fts_table>`** — the FTS5 virtual table, with columns `id UNINDEXED`, `content`, plus any declared metadata columns.
- **`<fts_table>_meta`** — a side table holding per-document metadata, keyed by `id`.
- **`_m3l_fts_meta(key, value)`** — an internal key/value store for schema versioning and tokenizer configuration.

### Write operations

- `upsert(document)` — add or update a single document.
- `upsertMany(documents)` — add or update many documents; wrapped in a single transaction.
- `delete(id)` — remove one document by id.
- `deleteMany(ids)` — remove many documents by id.

### Lifecycle

- `close()` — close the underlying SQLite handle. Call it when a file-backed index is no longer needed so the native handle and file lock are released; long-lived automation processes that open many indexes should close each one.

### Search modes

| Mode          | Behavior                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `'full-text'` | FTS5 `MATCH` with BM25 ranking and `snippet()` extraction.                                                 |
| `'literal'`   | Case-insensitive substring scan — suited to punctuated tokens (e.g. UUIDs) that the tokenizer would split. |

Prepared statements are cached by mode plus filter-signature tuple, so repeated queries with the same shape do not recompile SQL.

## Usage

```typescript
import { Core } from "@m3l-automation/m3l-common";

const index = new Core.M3LFtsIndex({
  dbPath: "./data/search.sqlite",
  table: "documents",
});

index.upsertMany([
  { id: "doc-1", content: "Quarterly revenue report for EMEA" },
  { id: "doc-2", content: "Onboarding checklist for new automation scripts" },
]);

// Full-text search with BM25 ranking and snippets.
const hits = index.search("revenue report", { mode: "full-text" });
for (const hit of hits) {
  console.log(hit);
}
```

Literal search for a punctuated token:

```typescript
import { Core } from "@m3l-automation/m3l-common";

const index = new Core.M3LFtsIndex({
  dbPath: "./data/search.sqlite",
  table: "documents",
});

const hits = index.search("550e8400-e29b-41d4-a716-446655440000", {
  mode: "literal",
});
```

Escape hatch for custom SQL:

```typescript
import { Core } from "@m3l-automation/m3l-common";

const index = new Core.M3LFtsIndex({
  dbPath: "./data/search.sqlite",
  table: "documents",
});

const db = index.getDatabase(); // raw better-sqlite3 handle
const row = db.prepare("SELECT COUNT(*) AS n FROM documents").get();
```

### Append-only stream

```ts
import { M3LAppendOnlyStream } from "@m3l-automation/m3l-common/core";

const stream = new M3LAppendOnlyStream({ directory: "/var/lib/m3l/audit" });
await stream.append({
  atMs: Date.now(),
  action: "run.launch",
  operator: "ada",
});
```

Segments are named `<YYYY-MM-DD>-<NNNN>.jsonl` in UTC, sequence zero-padded to four digits. The active segment is re-derived on every cold start from a directory listing plus one `stat`, so a freshly spawned process and a long-lived one always agree — no index file is kept and no state crosses a process boundary.

Rotation seals the active segment (by no longer writing to it) and opens the next; it never prunes or truncates. It fires when the segment's **current** size has already reached `maxSegmentBytes`, when its age has reached `maxSegmentAgeMs`, or when its UTC date prefix is no longer today's. Because the ceiling is compared against the current size rather than the size the incoming line would produce, a segment may end one line beyond it.

### Reading an append-only stream

```ts
import {
  M3LAppendOnlyStream,
  M3LAppendOnlyStreamReadError,
} from "@m3l-automation/m3l-common/core";

const stream = new M3LAppendOnlyStream({ directory: "/var/lib/m3l/audit" });
try {
  for await (const entry of stream.read({
    onTruncatedTail: (segment) => {
      console.warn(`dropped ${segment.byteLength} torn trailing bytes`);
    },
  })) {
    console.log(entry);
  }
} catch (error) {
  if (error instanceof M3LAppendOnlyStreamReadError) {
    // the trail is corrupt -- an operator incident, not a caller mistake
    throw error;
  }
  throw error;
}
```

`read(options?)` returns an `AsyncIterable<M3LAppendOnlyEntry>` that walks every segment in `(date, sequence)` ascending order -- every date the stream has ever rotated through, not just today's -- and yields lines in file order within each segment, reproducing append order exactly **over an untampered directory**. See "Limitations" below for what tampering `read()` can and cannot detect. It observes every entry whose `append()` has already resolved, since the writer keeps no buffer of its own.

Every line is parsed and then proven through the exact same `projectAppendOnlyEntry` the writer serializes through, so read and write share one definition of "a value this stream can hold." A line the writer could never have produced -- a bare array or scalar, an own `__proto__`/`constructor`/`prototype` key, a non-finite number, `-0` (which does not round-trip through JSON), or a structure nested past the depth cap -- throws `M3LAppendOnlyStreamReadError` rather than being handed back as though it were genuine: a segment holding one was tampered with or hand-edited, and an audit trail that quietly reads back bytes it could not have written is not an audit trail. This is never skipped and there is no callback escape for it.

A **torn tail** -- a trailing fragment with no terminating newline, left by a process that died mid-append -- is tolerated only on the stream's **last** segment, and only if `onTruncatedTail` is supplied; it is then invoked once with `{ byteLength, segmentIndex, segmentCount }` and the fragment is dropped. With no callback, the same last-segment fragment throws instead -- there is no silent path, so a caller that wants to tolerate a lost final record has to write that decision down explicitly. The identical fragment in a **mid-stream** segment is a different situation entirely: the writer only ever rotates after a complete line, so a fragment there is data loss, not a normal torn tail, and it **always throws**, callback or not.

The `options` bag is validated at the boundary before any segment is opened: a non-object bag, an unknown own key, and a truthy non-callable `onTruncatedTail` each throw `M3LError` (`ERR_INVALID_ARGUMENT`) synchronously, at the `read()` call rather than on first iteration. Unknown keys are rejected rather than ignored because the likeliest one -- `read({ directory })` -- would otherwise read the constructor's directory while the caller believed they had redirected the read. The reported `field` is always `"options"`, never the offending key, which is caller input.

A missing directory yields nothing rather than throwing -- a rebuild against a stream nothing has ever been appended to is a normal, empty case. Each opened segment is checked on the descriptor itself, mirroring the writer's own append-time guard: `O_NOFOLLOW` refuses a path replaced by a **symlink**, `O_NONBLOCK` plus an `fstat` refuses a path replaced by a **FIFO** (or any other non-regular file) rather than blocking `open()` forever, and the same `fstat`'s `nlink === 1` check refuses a **hardlink** planted at a segment name -- a hardlink lets a lower-privilege actor nominate a file it cannot read for a higher-privilege reader to read and republish into the audit index, so it is refused here too, not treated as harmless. Segments are read through `handle.read(...)` in chunks bounded by `maxLineBytes`, never `readFile`/`createReadStream`, so a tampered segment holding one arbitrarily large unterminated line is abandoned after a small, bounded multiple of `maxLineBytes` rather than buffered into memory whole. A line's bytes are decoded as strict UTF-8 (`TextDecoder` with `fatal: true`); an invalid byte throws rather than being silently repaired to U+FFFD, since two distinct on-disk byte sequences must never collapse into one accepted entry.

#### Limitations: what gap detection proves, and what it does not

`read()` rejects a gap in `(datePrefix, sequence)` within one date -- a missing sequence number, or a segment present on disk but truncated all the way to zero bytes before its date's numbering could roll past it -- because the writer always starts a date at sequence 1 and increments by exactly one on every rotation, so any other shape is unaccounted-for data, not a normal stream. This catches **whole-segment deletion** and **zero-truncation** of a segment that is not the stream's last for its date, using only information already gathered during discovery.

It is explicitly **not** proof that a stream is complete, and it does not attempt to detect **line-boundary truncation inside a segment** (a segment cut off partway through, at a line boundary, so every remaining line still parses cleanly) -- that would require a per-segment entry count or a chained digest, which is a writer format change and is out of scope here. Two further gaps are worth stating plainly: this check cannot detect deletion of a date's own **last** segment (the remaining segments are still perfectly contiguous starting at 1), and it can false-positive if a caller ever prunes an old segment out-of-band mid-date. An attacker with write access to the stream directory can also renumber the remaining segments to close a gap before `read()` ever sees it. Gap detection raises the bar against accidental and casual tampering; it is not a completeness proof.

### Listing an append-only stream's segments

```ts
import { M3LAppendOnlyStream } from "@m3l-automation/m3l-common/core";

const stream = new M3LAppendOnlyStream({ directory: "/var/lib/m3l/audit" });
const { segments, skipped } = await stream.listSegments();

const bytes = segments.reduce((total, s) => total + s.byteLength, 0);
console.log(
  `${segments.length} segments, ${bytes} bytes under ${stream.directory}`,
);
if (skipped > 0) {
  // segment-named entries this stream could not vouch for -- investigate
  console.warn(`${skipped} entries skipped`);
}
```

`listSegments()` returns an inventory of what is on disk right now: a `segments` array, oldest `(datePrefix, sequence)` first, of one `M3LAppendOnlySegment` per segment file carrying its `name`, `datePrefix`, `sequence`, `byteLength`, and `modifiedAtMs` — plus a `skipped` count. It is an `lstat` per entry and nothing more: it never opens a segment, never parses a line, and never deletes or truncates anything. It exists so an operator can see an append-only trail's footprint, since this primitive by design never reclaims space itself.

A segment carries **no path**, matching `M3LAppendOnlyTruncatedSegment` — the caller already holds `stream.directory`, and a directory path can carry tenant identifiers. A missing directory yields an empty listing rather than throwing, the same posture `read()` takes: a stream nothing has ever been appended to is a normal, empty case. Only names this stream's own writer would have produced are considered at all, through the exact same parser `read()` uses — a foreign file, or one whose zero-padding this writer could not itself render (`2026-01-01-00005.jsonl`), is ignored outright and is **not** counted in `skipped`, because it was never a segment and counting it would make any directory holding a `README` read as damaged. A `readdir` failure that is not `ENOENT` throws `M3LAppendOnlyStreamReadError` with the underlying error chained as `cause`.

**`skipped` counts what this stream should have been able to account for and could not**, and a non-zero value means the directory is not what this writer left behind. Two things land there. A per-entry `lstat` that fails `ENOENT` — an entry that vanished between the listing and its own `lstat` — and an entry that is **not a regular file**: a symlink, a directory, or a FIFO planted at a segment-shaped name. The link case is a deliberate refusal rather than an oversight. `lstat` does not follow a symlink, so a link planted at the next segment name cannot report its _target's_ size and mtime through this inventory; that would both corrupt the byte total and disclose the size of a file outside the stream directory entirely. This mirrors the `O_NOFOLLOW` refusal the writer and `read()` already apply, and the directory is created `0o700` precisely to keep the planting precondition out of reach. Being honest about its limit: `lstat` distinguishes a symlink, but a **hardlink** at a segment name is indistinguishable from the real file by any `stat` — the writer's defence there is an `nlink` check on the opened descriptor, which an inventory that never opens a file cannot reproduce.

Any **other** per-entry `lstat` failure (`EACCES`, `EIO`, …) still propagates as `M3LAppendOnlyStreamReadError` rather than becoming a skip: `skipped` means "this entry is not something this writer left behind", not "something went wrong reading the directory", and collapsing the two would let a genuinely broken filesystem read as tampering. Note that a **symlink loop** is no longer among them. Under the previous `stat`-based implementation it surfaced as `ELOOP` and rejected the whole call; `lstat` never resolves the link, so the loop is never entered and both of its entries are simply non-regular files — they raise `skipped` like any other planted link. That is a deliberate consequence of the `lstat` change, not an oversight.

**It deliberately does not check continuity.** `read()` rejects a gap in `(datePrefix, sequence)` within a date; `listSegments()` reports whatever is there, gap and all. The divergence is the point: an inventory that refuses to run against a damaged trail is unavailable exactly when an operator needs it most, and gap detection belongs on the path that hands entries back and must not vouch for a trail it cannot prove. Use `read()` when you need the guarantee; use `listSegments()` when you need to see the damage — that is also why a planted link raises `skipped` rather than throwing.

## Notes & behavior

- **Synchronous.** `better-sqlite3` is synchronous; index operations do not return promises.
- **Tokenizer validation.** The tokenizer string is validated before use to prevent SQLite injection.
- **Typed validation errors.** Caller-supplied configuration and search input that fails validation at the public boundary throws an `M3LFtsIndexError` (a typed `M3LError` subclass) carrying a machine-readable `M3LFtsIndexErrorCode` — e.g. an invalid tokenizer, a non-identifier table name or metadata column, a non-positive `limit`, an empty document `id`, a filter on an undeclared column, or an unsupported search `mode`. A corrupt persisted-metadata row surfaces the same way, with the underlying parse error chained as `cause`. Raw SQLite/engine errors (a bad `dbPath`, disk failure, corruption, or a mid-batch constraint failure inside `upsertMany`) are **not** wrapped — they propagate unchanged so callers can react to them directly.
- **Batch in transactions.** `upsertMany` runs inside a transaction for atomicity and throughput.
- **Scale.** Designed for in-process search over thousands to low-millions of documents; for larger or distributed workloads, use a dedicated search service.
- **`getDatabase()`** returns the raw `better-sqlite3` handle (`M3LSqliteDatabase`) for queries the typed API does not express; prepared statements have type `M3LSqliteStatement`.

### `M3LAppendOnlyStream`

- **Atomic whole-line appends.** Each entry is written with `O_APPEND | O_CREAT | O_WRONLY`, so concurrent writers interleave whole lines rather than corrupting one another. This does not hold across NFS, and does not cover a write larger than the pipe buffer — which is why the line ceiling is enforced _before_ any filesystem call.
- **Planted-link refusal.** A segment is opened with `O_NOFOLLOW` where the platform has it, so a path replaced by a **symlink** is refused (`ELOOP`). `O_NOFOLLOW` does nothing about a **hardlink**, so the open is followed by an `fstat` on the returned handle and a `nlink === 1` check — a hardlink planted at a segment name is refused too, and the record never lands in the attacker's file. The check is deliberately on the descriptor the write then goes through, never a path-based `stat`, which would be a TOCTOU race. What it buys is narrow and worth stating: it refuses an _already planted_ link, and cannot stop someone hardlinking a segment this writer has already created. On Windows, where Node reports `O_NOFOLLOW` as absent, the symlink half of this defence does not apply.
- **Restrictive modes.** The stream directory is created `0o700` and each segment `0o600`. The process umask can only remove bits from those, never add them.
- **Not crash-durable.** `append()` resolves when the write reaches the page cache, not the platter — no `fsync` is issued per entry. A host crash between the resolve and writeback loses the record after `append()` reported success. A consumer that must not lose a record to a host crash needs a flush at its own artifact boundary.
- **Entries are re-projected before serialization.** What reaches disk is never the caller's object: every node is rebuilt with a null prototype — objects and arrays alike — so an inherited `toJSON` gadget can neither forge the persisted record nor launder `undefined` into the stream as a line no reader can parse. Own `__proto__` / `constructor` / `prototype` keys, non-finite numbers, `-0` (which JSON carries back out as `+0`, so it would not round-trip), `bigint`, functions, symbols, `undefined`, and structures nested past 512 levels (which is also what bounds a circular reference) are rejected as `ERR_INVALID_ARGUMENT` before any write.
- **Serialized appends.** Concurrent `append()` calls on one instance are chained onto a tail promise, so byte accounting stays exact and rotation fires on time rather than a whole batch late. A rejected append is reported to its own caller only and never poisons the chain.
- **Loud, typed failures.** An append that fails, or a rendered line exceeding `maxLineBytes`, throws `M3LAppendOnlyStreamError` (`ERR_APPEND_ONLY_STREAM_WRITE`). Neither its message nor its `context` ever carries caller data — a directory path can carry tenant identifiers and an entry carries payload — but the underlying filesystem error is always chained as `cause`, since it is the only diagnostic an operator has.
- **Cache drop on failure.** A failed append clears the cached active segment, so the next call cold-starts (`mkdir`, then re-discover). A log directory removed under a long-lived writer therefore recovers instead of wedging every later write.
- **Read and write share one error vocabulary boundary, split in two.** `M3LAppendOnlyStreamError` (`ERR_APPEND_ONLY_STREAM_WRITE`) means the trail is **unwritable** -- a filesystem or ceiling failure on `append()`. `M3LAppendOnlyStreamReadError` (`ERR_APPEND_ONLY_STREAM_READ`) means the trail is **corrupt** -- a malformed or oversized line, an intolerable torn tail, or a segment I/O failure on `read()`. These are deliberately two distinct classes rather than one shared code: "my audit trail is unwritable" (a 503, retry elsewhere) and "my audit trail is corrupt" (an operator page) are not the same incident, and `instanceof` is how a caller tells them apart without parsing a message string.
- **A torn tail is tolerable only on the last segment.** A trailing fragment with no terminating newline reflects a process that died mid-append. On the stream's LAST segment (in `(date, sequence)` order), supplying `onTruncatedTail` tolerates it -- the callback fires once and the fragment is dropped; with no callback, the default is to throw, so there is no silent path. The identical fragment in any earlier, mid-stream segment is data loss rather than a torn tail -- the writer only ever rotates after a complete line -- and it always throws, callback or not.
- **A corrupt line throws rather than being skipped.** `read()` proves every line through the exact same `projectAppendOnlyEntry` the writer serializes through, so read and write share one definition of what the stream can hold. A line the writer could never have produced (a bare array or scalar, `-0`, a dangerous key, a too-deep structure, invalid UTF-8) means the file was tampered with or hand-edited; an audit trail that quietly reads back bytes it could not have written is not an audit trail, so this is never skipped and carries no callback escape.
- **A segment that cannot be closed is reported, not swallowed.** After a segment has been read to completion, its handle is closed inside the read itself and a failure there throws `M3LAppendOnlyStreamReadError` with the underlying error chained as `cause` -- the segment was read faithfully, so there is no other outcome for the failure to displace, and reporting a clean read over a descriptor the OS never released would be a lie. On the two non-success paths the close is best-effort instead: with a read failure already in flight the close failure is **chained deeper onto that error's `cause` chain** rather than replacing it, and on a consumer's early `break` -- a normal, successful way to stop reading -- it stays silent. Code walking `cause` on a read error should therefore expect more than one link.
- **Nothing here ever reclaims space, and `listSegments()` is the reason that is now visible.** The stream seals and rotates; it has no prune, no truncate, and no retention window, so a long-lived trail grows without bound. `listSegments()` is a read-only inventory (`lstat` per entry, no segment opened) so a caller can measure that footprint and decide. It is not a step toward pruning: because `read()` rejects a gap in a date's sequence numbers, deleting one segment out of the middle of a date makes every later read of that stream throw rather than freeing anything. Archiving whole dates is what the sequence check tolerates.
- **The inventory refuses a planted link, like the other two paths — and says so rather than throwing.** All three of write, `read()`, and `listSegments()` decline to treat a non-regular file at a segment name as a segment; the first two by `O_NOFOLLOW` on the open, the third by using `lstat` and requiring a regular file. Without that, a symlink planted at the next segment name would report its target's size and mtime, disclosing a file outside the stream directory and corrupting any byte total computed from the result. Where write and read raise, the inventory increments `skipped` instead, because its whole purpose is to remain usable against a damaged directory. A **hardlink** remains indistinguishable here: refusing one needs the `nlink` check on an opened descriptor, and this method opens nothing.
- **A read mirrors the writer's own link refusal, plus a FIFO refusal of its own.** `read()` applies the same `O_NOFOLLOW`/symlink and `fstat`-based `nlink === 1`/hardlink checks the writer applies at append time -- a hardlinked segment is refused, not treated as harmless, because it lets a lower-privilege actor nominate unreadable content for a higher-privilege reader to republish. The same `fstat` also refuses any non-regular file (a planted FIFO in particular) rather than letting `open()` block forever; see "Limitations" above for what gap detection between segments does and does not prove.

## See also

- [`text`](./text.md) — extract text from files before indexing it.
- [`json`](./json.md) — JSON field extraction for building document metadata.
- [`files`](./files.md) — filesystem helpers for locating source documents.
- [Capability index](../../guides/capability-index.md) — map of dependencies to the modules that use them.
- [Architecture overview](../../m3l-common-architecture.md) — authoritative spec.
