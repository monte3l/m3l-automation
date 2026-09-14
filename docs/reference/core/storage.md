# `storage` — Full-text Search & Append-only Streams

The `storage` module provides two embedded, zero-network persistence primitives: `M3LFtsIndex`, a full-text search index backed by SQLite's FTS5 extension, and `M3LAppendOnlyStream`, a segmented append-only JSONL stream for audit trails.

## Overview

`M3LFtsIndex` wraps `better-sqlite3` (a native, synchronous SQLite binding) and exposes an FTS5 virtual table for in-process search. It is appropriate for searching over **thousands to low-millions of documents** without standing up an external search service.

`M3LAppendOnlyStream` is the append-only half. It writes one JSON line per entry into date-stamped, rotating segment files. It and `M3LAgentDecisionLog` (ADR-0061) are siblings rather than layers: both are built on the same library-internal append-only writer, and neither is implemented in terms of the other's public API. It is deliberately loud — an entry it cannot append raises rather than being dropped, because the caller of an audit write is usually a caller that must then be refused.

Two search modes cover distinct needs: a `full-text` mode using FTS5 `MATCH` with BM25 ranking and snippet extraction, and a `literal` mode that performs a case-insensitive substring scan for tokens with punctuation (such as UUIDs) that a tokenizer would otherwise split. For anything the typed API does not cover, `getDatabase()` exposes the raw database handle.

## Public API

Exported from `@monte3l/m3l-common/core` (`storage` subpath):

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

| Symbol                               | Kind   | Purpose                                                                                                                                                                                                                                     |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `M3LAppendOnlyStream`                | class  | Segmented append-only JSONL stream with byte/age/date rotation.                                                                                                                                                                             |
| `M3LAppendOnlyStreamOptions`         | type   | Constructor options (directory, the three optional ceilings, and an optional `onSealFailed` handler).                                                                                                                                       |
| `M3LAppendOnlySealFailure`           | type   | The payload reported to `onSealFailed`: the segment that could not be sealed (or `undefined` for a manifest-level failure) and the typed error.                                                                                             |
| `M3LAppendOnlyStreamManifestError`   | class  | Thrown when the `manifest.jsonl` sidecar itself cannot be read or appended to. Distinct from the read and write classes: the trail is neither corrupt nor unwritable, only unprovable.                                                      |
| `M3LAppendOnlyStreamIntegrityError`  | class  | Thrown when a sealed segment's bytes contradict what the manifest sealed -- a `sha256`, `entryCount` or `byteLength` disagreement. Distinct from the manifest class: the sidecar is readable and the segment is present, but they disagree. |
| `M3L_APPEND_ONLY_MANIFEST_NAME`      | const  | The sidecar's file name, `manifest.jsonl`. Deliberately not date-named, so an `rm 2026-09-*` archival glob cannot delete the proof along with the segments.                                                                                 |
| `M3LAppendOnlyStream.flush`          | method | Waits for every append and manifest seal already in flight to settle, so the directory is safe to remove, archive or measure.                                                                                                               |
| `M3LAppendOnlyEntry`                 | type   | One entry: a read-only map of `M3LAppendOnlyValue`.                                                                                                                                                                                         |
| `M3LAppendOnlyValue`                 | type   | The closed value union an entry field may carry.                                                                                                                                                                                            |
| `M3LAppendOnlyStreamError`           | class  | Thrown when an append fails or the rendered line exceeds the ceiling.                                                                                                                                                                       |
| `M3L_APPEND_ONLY_MAX_SEGMENT_BYTES`  | const  | Default segment size ceiling, 8 MiB.                                                                                                                                                                                                        |
| `M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS` | const  | Default segment age ceiling, 24 h.                                                                                                                                                                                                          |
| `M3L_APPEND_ONLY_MAX_LINE_BYTES`     | const  | Default per-line ceiling, 64 KiB.                                                                                                                                                                                                           |
| `M3LAppendOnlyStream.read`           | method | Reads every entry back, across every date-stamped segment, in append order (X7 slice 4a).                                                                                                                                                   |
| `M3LAppendOnlyReadOptions`           | type   | Options for `read()` — optional `onTruncatedTail` and `onArchivedSegment` callbacks; unknown keys are rejected. There is deliberately no option governing digest verification: it is unconditional.                                         |
| `M3LAppendOnlyTruncatedSegment`      | type   | The payload reported to `onTruncatedTail`: byte length and segment position.                                                                                                                                                                |
| `M3LAppendOnlyStreamReadError`       | class  | Thrown when a read fails: a malformed/oversized line, a missing sequence, an intolerable torn tail, a planted link/FIFO, or a segment I/O failure — including a failed close.                                                               |
| `M3LAppendOnlyStream.listSegments`   | method | Inventories the segment files on disk — name, date, sequence, byte length, mtime — without reading or deleting any of them (X8 slice 5a-ii).                                                                                                |
| `M3LAppendOnlySegmentListing`        | type   | What `listSegments()` returns: the `segments` array plus a `skipped` count of segment-named entries it refused to inventory.                                                                                                                |
| `M3LAppendOnlySegment`               | type   | One segment as `listSegments()` reports it: `name`, `datePrefix`, `sequence`, `byteLength`, `modifiedAtMs`. Carries no path.                                                                                                                |
| `M3LAppendOnlyStream.verify`         | method | Re-digests every segment the `manifest.jsonl` sidecar makes a claim about and reports what it finds. Never throws on a finding (X8b slice 4b).                                                                                              |
| `M3LAppendOnlyVerification`          | type   | What `verify()` returns: `verdicts`, `failures`, per-status `totals`, a `skipped` count, and the `unprovenBefore` boundary.                                                                                                                 |
| `M3LAppendOnlySegmentVerdict`        | type   | One segment's finding, as a union discriminated on `status` — so narrowing yields the claim and the observation, and an illegal pairing will not compile.                                                                                   |
| `M3LAppendOnlyVerificationStatus`    | type   | The five findings a segment can receive: `sealed`, `unsealed`, `archived`, `mismatched`, `legacy`.                                                                                                                                          |
| `M3LAppendOnlySealedSegment`         | type   | One segment's sealed claim as the manifest states it: the measurement, plus `segment` and the `at` it was stamped.                                                                                                                          |
| `M3LAppendOnlySegmentMeasurement`    | type   | The three numbers a seal records and a verification recomputes: `entryCount`, `byteLength`, plain `sha256`.                                                                                                                                 |
| `M3LAppendOnlyVerificationFailure`   | type   | Something `verify()` could not check at all — kept separate from the verdicts so a broken filesystem never reads as tampering.                                                                                                              |

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
import { Core } from "@monte3l/m3l-common";

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
import { Core } from "@monte3l/m3l-common";

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
import { Core } from "@monte3l/m3l-common";

const index = new Core.M3LFtsIndex({
  dbPath: "./data/search.sqlite",
  table: "documents",
});

const db = index.getDatabase(); // raw better-sqlite3 handle
const row = db.prepare("SELECT COUNT(*) AS n FROM documents").get();
```

### Append-only stream

```ts
import { M3LAppendOnlyStream } from "@monte3l/m3l-common/core";

const stream = new M3LAppendOnlyStream({ directory: "/var/lib/m3l/audit" });
await stream.append({
  atMs: Date.now(),
  action: "run.launch",
  operator: "ada",
});
```

Segments are named `<YYYY-MM-DD>-<NNNN>.jsonl` in UTC, sequence zero-padded to four digits. The active segment is re-derived on every cold start from a directory listing plus one `stat`, so a freshly spawned process and a long-lived one always agree — no state crosses a process boundary.

The directory also holds one `manifest.jsonl` sidecar, which the writer seals each rotated-away segment into. It is deliberately **not** an index: it is never consulted to decide where to append, it carries no in-memory state across processes, and it is not a segment — `manifest.jsonl` does not match the segment-name pattern, so it is invisible to segment discovery and never appears in `listSegments()`.

Rotation seals the active segment (by no longer writing to it) and opens the next; it never prunes or truncates. It fires when the segment's **current** size has already reached `maxSegmentBytes`, when its age has reached `maxSegmentAgeMs`, or when its UTC date prefix is no longer today's. Because the ceiling is compared against the current size rather than the size the incoming line would produce, a segment may end one line beyond it.

### Reading an append-only stream

```ts
import {
  M3LAppendOnlyStream,
  M3LAppendOnlyStreamReadError,
} from "@monte3l/m3l-common/core";

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

`read(options?)` returns an `AsyncIterable<M3LAppendOnlyEntry>` that walks every segment in `(date, sequence)` ascending order -- every date the stream has ever rotated through, not just today's -- and yields lines in file order within each segment, reproducing append order exactly **over a trail whose segments are all sealed and unrenamed** -- the scope matters, and "Limitations" below says why. Every **sealed** segment's bytes are verified against the manifest's claim as they stream, at no extra I/O, and a disagreement throws `M3LAppendOnlyStreamIntegrityError`. Two timing limits come with that and are contract, not oversight: a digest completes only at a segment's END, so the caller has already consumed that segment's entries when it throws -- buffer the read, or call `verify()` first, if that matters -- and a caller who abandons the iteration never finishes the digest, so the segment it stopped inside is not verified -- nor is any **later** segment, which was never opened. A partial read of a long trail is therefore verified only as far as it got, which is much weaker than it looks. A byte-length overrun is the exception, refused mid-segment before the excess entries are yielded. See "Limitations" below for what tampering `read()` still cannot detect. It observes every entry whose `append()` has already resolved, since the writer keeps no buffer of its own.

Every line is parsed and then proven through the exact same `projectAppendOnlyEntry` the writer serializes through, so read and write share one definition of "a value this stream can hold." A line the writer could never have produced -- a bare array or scalar, an own `__proto__`/`constructor`/`prototype` key, a non-finite number, `-0` (which does not round-trip through JSON), or a structure nested past the depth cap -- throws `M3LAppendOnlyStreamReadError` rather than being handed back as though it were genuine: a segment holding one was tampered with or hand-edited, and an audit trail that quietly reads back bytes it could not have written is not an audit trail. This is never skipped and there is no callback escape for it.

A **torn tail** -- a trailing fragment with no terminating newline, left by a process that died mid-append -- is tolerated only on the stream's **last** segment, and only if `onTruncatedTail` is supplied; it is then invoked once with `{ byteLength, segmentIndex, segmentCount }` and the fragment is dropped. With no callback, the same last-segment fragment throws instead -- there is no silent path, so a caller that wants to tolerate a lost final record has to write that decision down explicitly. The identical fragment in a **mid-stream** segment is a different situation entirely: the writer only ever rotates after a complete line, so a fragment there is data loss, not a normal torn tail, and it **always throws**, callback or not.

A **sealed segment that is no longer on disk** -- the shape whole-date archival leaves behind -- is the read path's other tolerated finding, and it is gated the same way round: tolerated only if `onArchivedSegment` is supplied, which is then invoked with the manifest's full claim (`{ segment, at, entryCount, byteLength, sha256 }`), and throwing `M3LAppendOnlyStreamManifestError` otherwise. Carrying the `sha256` is what makes the tolerance provable rather than polite -- an operator can reproduce those 64 hex characters against the archived copy with `sha256sum` and nothing else. Unlike `onTruncatedTail`, which fires in read order, this check is **eager**: every archival finding is resolved before the first entry is yielded, so a caller with no handler learns the trail is incomplete before it has consumed anything. The scan needs only the manifest and the directory listing, never a segment's bytes, so there is no reason to make a caller read a partial trail first.

A manifest that **exists and cannot be read** is fatal to `read()`, even when every segment is present and intact: a malformed line, two disagreeing seals for one segment, a `formatVersion` above the reader's, or an `EACCES` all throw `M3LAppendOnlyStreamManifestError`. Reading on without the sidecar's claims would let one corrupt byte disable archival detection for the whole trail, which is the opposite of what a tamper-evidence mechanism is for. An **absent** manifest is a different case and not a finding at all: a trail that never sealed anything is legitimate, and from inside the directory that is indistinguishable from a trail whose manifest was deleted, so `read()` behaves exactly as it did before this option existed. That blind spot is recorded below rather than closed here. `read()` can also throw `M3LAppendOnlyStreamIntegrityError`, which is a different finding entirely: the sidecar was readable and the segment was present, and their disagreement is what the throw reports.

The `options` bag is validated at the boundary before any segment is opened: a non-object bag, an unknown own key, and a truthy non-callable `onTruncatedTail` or `onArchivedSegment` each throw `M3LError` (`ERR_INVALID_ARGUMENT`) synchronously, at the `read()` call rather than on first iteration. Only a **truthy** non-function is rejected; a falsy one (`null`, `0`) degrades to the no-handler path for either callback, and since that path is the throwing one in both cases, the safe direction is what a mistake defaults to. Unknown keys are rejected rather than ignored because the likeliest one -- `read({ directory })` -- would otherwise read the constructor's directory while the caller believed they had redirected the read. The reported `field` is always `"options"`, never the offending key, which is caller input.

A missing directory yields nothing rather than throwing -- a rebuild against a stream nothing has ever been appended to is a normal, empty case. Each opened segment is checked on the descriptor itself, mirroring the writer's own append-time guard: `O_NOFOLLOW` refuses a path replaced by a **symlink**, `O_NONBLOCK` plus an `fstat` refuses a path replaced by a **FIFO** (or any other non-regular file) rather than blocking `open()` forever, and the same `fstat`'s `nlink === 1` check refuses a **hardlink** planted at a segment name -- a hardlink lets a lower-privilege actor nominate a file it cannot read for a higher-privilege reader to read and republish into the audit index, so it is refused here too, not treated as harmless. Segments are read through `handle.read(...)` in chunks bounded by `maxLineBytes`, never `readFile`/`createReadStream`, so a tampered segment holding one arbitrarily large unterminated line is abandoned after a small, bounded multiple of `maxLineBytes` rather than buffered into memory whole. A line's bytes are decoded as strict UTF-8 (`TextDecoder` with `fatal: true`); an invalid byte throws rather than being silently repaired to U+FFFD, since two distinct on-disk byte sequences must never collapse into one accepted entry.

#### Limitations: what gap detection proves, and what it does not

`read()` rejects a gap in `(datePrefix, sequence)` within one date -- a missing sequence number, or a segment present on disk but truncated all the way to zero bytes before its date's numbering could roll past it -- because the writer always starts a date at sequence 1 and increments by exactly one on every rotation, so any other shape is unaccounted-for data, not a normal stream. This catches **whole-segment deletion** and **zero-truncation** of a segment that is not the stream's last for its date. Since ADR-0102's sealed-segment manifest the check no longer runs on discovery alone: `read()` reads the sidecar first and then walks the **union** of the segments actually on disk and the sealed segments the manifest claims but which are no longer there, so a hole an archived segment accounts for is not a gap, while a hole nothing accounts for throws exactly as it always did.

It is explicitly **not** proof that a stream is complete, and **line-boundary truncation inside a segment** (a segment cut off partway through, at a line boundary, so every remaining line still parses cleanly) is now detected for a **sealed** segment and only for a sealed one -- the seal is exactly the per-segment entry count and digest that detecting it requires, and the writer format change it needed is what ADR-0102 shipped. The still-active segment is never sealed by construction, so truncation inside it remains undetectable. Two further gaps are worth stating plainly, and the first has narrowed. Deleting a date's own **last** segment leaves the survivors perfectly contiguous from 1, so the sequence walk by itself cannot see it -- but the manifest can, and does, whenever that segment had been **sealed**, which is every rotated-away-from segment including the last one of any past date. What stays invisible is an **unsealed** last segment: the one the writer is still appending to is never sealed by construction, so the newest segment of the current date remains unprovable. The check can also still false-positive if a caller prunes an old segment out-of-band mid-date. An attacker with write access to the stream directory can also renumber the remaining segments to close a gap before `read()` ever sees it -- but only into names the manifest does not claim, since a renumbered file whose new name carries a seal is measured against that seal and refused -- subject to the same end-of-segment timing as any other mismatch, so the refusal arrives after that segment's entries. Gap detection raises the bar against accidental and casual tampering; it is not a completeness proof.

### Listing an append-only stream's segments

```ts
import { M3LAppendOnlyStream } from "@monte3l/m3l-common/core";

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

**`skipped` counts what this stream should have been able to account for and could not**, and a non-zero value means the directory is not what this writer left behind. Two things land there. A per-entry `lstat` that fails `ENOENT` — an entry that vanished between the listing and its own `lstat` — and an entry that is **not a regular file**: a symlink, a directory, or a FIFO planted at a segment-shaped name. The link case is a deliberate refusal rather than an oversight. `lstat` does not follow a symlink, so a link planted at the next segment name cannot report its _target's_ size and mtime through this inventory; that would both corrupt the byte total and disclose the size of a file outside the stream directory entirely. This mirrors the `O_NOFOLLOW` refusal the writer and `read()` already apply, and the directory is created `0o700` precisely to keep the planting precondition out of reach. A **hardlink** at a segment name is refused on the same terms. It is a second directory entry for an existing inode, so it is a genuine regular file and passes the check above — but `lstat` also reports `nlink`, and a segment this writer created has exactly one link. `nlink !== 1` therefore raises `skipped` too, matching the refusal the writer and `read()` already apply. Without it, a hardlink to a large file outside the stream directory would fold that file's size into the byte total and publish its `modifiedAtMs`, which is precisely the disclosure the symlink refusal closes.

Two limits are worth stating rather than glossing. The check cannot say **which** of two links is "ours": a segment this writer legitimately created, which something later hardlinked elsewhere, also reports `nlink === 2` and is therefore skipped. That under-reports a real segment, and it is the deliberate direction — `read()` refuses such a segment outright, so the trail is already compromised, and `skipped` means "this directory is not what this writer left behind". The check is also not TOCTOU-free the way the writer's is: the writer tests `nlink` on the descriptor it then writes through, whereas an inventory that opens nothing tests a path that could change immediately afterwards. It raises the bar; it is not a proof.

Any **other** per-entry `lstat` failure (`EACCES`, `EIO`, …) still propagates as `M3LAppendOnlyStreamReadError` rather than becoming a skip: `skipped` means "this entry is not something this writer left behind", not "something went wrong reading the directory", and collapsing the two would let a genuinely broken filesystem read as tampering. Note that a **symlink loop** is no longer among them. Under the previous `stat`-based implementation it surfaced as `ELOOP` and rejected the whole call; `lstat` never resolves the link, so the loop is never entered and both of its entries are simply non-regular files — they raise `skipped` like any other planted link. That is a deliberate consequence of the `lstat` change, not an oversight.

**It deliberately does not check continuity.** `read()` rejects a gap in `(datePrefix, sequence)` within a date; `listSegments()` reports whatever is there, gap and all. The divergence is the point: an inventory that refuses to run against a damaged trail is unavailable exactly when an operator needs it most, and gap detection belongs on the path that hands entries back and must not vouch for a trail it cannot prove. Use `read()` when you need the guarantee; use `listSegments()` when you need to see the damage — that is also why a planted link raises `skipped` rather than throwing.

### Verifying a sealed trail

```ts
import { M3LAppendOnlyStream } from "@monte3l/m3l-common/core";

const stream = new M3LAppendOnlyStream({ directory: "/var/lib/m3l/audit" });
const report = await stream.verify();

// A positive finding. Necessary, NOT sufficient -- see below.
if (report.totals.mismatched > 0 || report.failures.length > 0) {
  // escalate
}

// The absence of evidence is its own finding. Compare against what you
// expect this trail to hold, from a record kept OUTSIDE the directory.
if (report.unprovenBefore === undefined || report.skipped > 0) {
  // the manifest is gone or unreadable, or the directory holds
  // segment-named entries this writer did not leave behind
}

for (const verdict of report.verdicts) {
  if (verdict.status === "archived") {
    // sha256sum the archive copy and compare against verdict.sealed.sha256
    console.log(verdict.segment, verdict.sealed.sha256);
  }
}
```

`verify()` is `listSegments()`'s evidentiary half. It re-digests every segment the sidecar makes a claim about, without parsing a line or handing back a single entry, and returns a report rather than throwing. That posture is the whole point: it is what an operator reaches for once `read()` has already started throwing, and a verification that itself throws on a damaged trail is unavailable exactly when the damage is why it was called. It is also the only in-library way to re-verify an archive.

**No single field on the report is an alarm, and treating one as an alarm is the mistake this section exists to prevent.** `verify()` reasons from evidence inside the stream directory, and the attacker this primitive is bounded against — anyone who can write that directory, since `0o700` is the only thing in the way — can remove evidence as easily as they can alter it. Both moves are one `rm`. Tamper with a sealed segment and it reports `mismatched`; then delete that segment and the same trail reports `archived`, because a sealed segment that is not on disk is exactly what an honest archival looks like. Delete `manifest.jsonl` instead and every segment reports `unsealed`, because a trail that never sealed anything is exactly what that looks like too. A check on `totals.mismatched` alone returns clean in both cases, and so does a check on `totals.mismatched` plus `failures.length`.

What closes the gap is the one thing the directory cannot supply: an expectation held elsewhere. `unprovenBefore` reading `undefined` where it previously read a segment name or `null` is the manifest-deletion signal — and if `failures` is non-empty at the same time, the manifest was unreadable rather than absent, which is a different incident. `skipped` above zero means the directory holds segment-named entries this writer did not leave behind. An `archived` verdict is only as good as your knowledge of which dates you actually archived, which is why the verdict carries the full `sha256`: it lets you prove the archive copy is the real bytes, and nothing in the library can prove the archival was authorised. ADR-0102 records this as a deliberate limit rather than a gap to engineer away — closing it needs state outside the directory, which this primitive does not have.

Each segment receives one of five verdicts. `sealed` means the manifest claims it and re-digesting reproduces all three numbers. `mismatched` means the claim and the bytes disagree, and the verdict carries both so an operator can see which number moved. `archived` means the manifest claims it and it is not on disk — the library cannot tell a deliberate archival from a deletion, which is exactly why the verdict carries the full claim including `sha256`: that is what makes the archive copy checkable off-host with nothing but `sha256sum`. `unsealed` means no claim exists, the normal state of the segment currently being appended to. `legacy` means the segment sits at or before the baseline's stated boundary and carries no seal — bytes written before sealing was in force, which a digest taken now cannot vouch for.

**A seal outranks the baseline.** `legacy` requires _both_ that a segment falls at or before the boundary _and_ that the manifest states no seal for it. The order is deliberate and load-bearing: the manifest reader accepts a later `baseline` record as replacing an earlier one, and refuses only a non-segment-shaped `upTo` or one dated later than today. Classifying on the boundary first would mean one well-formed appended line naming the newest segment could reclassify every genuine seal behind it as `legacy` and silently switch off every mismatch check. A tamper detector that one appended line disables detects nothing.

**`unprovenBefore` is three-valued and the three must not be collapsed.** A segment name is the baseline's stated boundary. `null` is the baseline's positive assertion that sealing has been in force since the stream's first segment. `undefined` means the manifest states no baseline at all — either nothing was ever sealed, or the manifest was deleted, which is the silent downgrade noted below and the only way it becomes visible after the fact.

**`failures` is not a sixth verdict.** None of the five can express "unknown", and folding, say, an `EACCES` on a sealed segment into `mismatched` would let a broken filesystem read as tampering — the same conflation `skipped` already refuses to make for the inventory. A per-segment failure carries that segment's name and an `M3LAppendOnlyStreamReadError`; a manifest-level or directory-level one carries `undefined` and an `M3LAppendOnlyStreamManifestError`. A manifest that cannot be read yields **no verdicts at all** rather than a directory's worth of `unsealed`, because "the claims could not be read" is not "no claim exists". One malformed line appended anywhere in the sidecar has that effect, so a report naming no segment at all, with a single failure, is itself a finding: the trail is disputed and the sidecar can no longer say which segment.

Every segment `verify()` **considered** appears in `verdicts` or in `failures`, never both and never neither. That invariant partitions what was checked; it is not a completeness guarantee over the directory.

**`skipped` is not a third disjoint bucket, and adding the three together double-counts.** It is `listSegments()`' own count, reported verbatim — which is what makes the two comparable — and it rises for any segment-shaped entry the inventory refuses as not-a-regular-file. Whether that entry also appears in `failures` depends on something the inventory cannot see: if the manifest makes no claim about that name, it is invisible to the claimed-segment path and `skipped` is the only place it surfaces; if the manifest _does_ claim it, the claimed-segment path `lstat`s it independently and reports a failure naming it, so the one entry is counted in both. Reconcile by name, never by summing.

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
- **One error vocabulary boundary, split in four.** `M3LAppendOnlyStreamError` (`ERR_APPEND_ONLY_STREAM_WRITE`) means the trail is **unwritable** -- a filesystem or ceiling failure on `append()`. `M3LAppendOnlyStreamReadError` (`ERR_APPEND_ONLY_STREAM_READ`) means the trail is **corrupt** -- a malformed or oversized line, an intolerable torn tail, or a segment I/O failure on `read()`. `M3LAppendOnlyStreamManifestError` (`ERR_APPEND_ONLY_STREAM_MANIFEST`) means the trail is **unprovable** -- the sidecar that records what each sealed segment held could not be read or appended to, or it claims a segment the directory no longer holds, while the entries still present are intact. `M3LAppendOnlyStreamIntegrityError` (`ERR_APPEND_ONLY_STREAM_INTEGRITY`) means the trail is **disproven** -- the sidecar is readable and the segment is present, and they contradict each other. These are deliberately four distinct classes rather than one shared code: "my audit trail is unwritable" (a 503, retry elsewhere), "my audit trail is corrupt" (an operator page), "my audit trail can no longer be proven" (a compliance escalation, but not an outage) and "my audit trail has been altered" (an incident) are not the same event, and `instanceof` is how a caller tells them apart without parsing a message string. The last distinction is the reason the integrity class exists at all rather than reusing the manifest code: a date archived by ADR-0070's own procedure and a segment whose bytes were edited are both "the manifest and the directory disagree", but only one of them is expected housekeeping, and a caller must not have to read a message string to tell which it is holding.
- **How each class reaches a caller.** The manifest class is what both owners' sealers build their failures through, so on the write side it surfaces only via `onSealFailed` -- sealing is best-effort and never throws out of the `append()` it follows. It is **also** raised directly by `read()`, for a sealed segment that is no longer on disk with no `onArchivedSegment` handler supplied, and for a manifest that exists and cannot be read; and by `verify()` for a manifest- or directory-level failure. The integrity class is raised by `read()`'s inline digest check alone — never by `append()`, and never by `verify()`, which reports a disagreement as a `"mismatched"` verdict instead of throwing.
- **A torn tail is tolerable only on the last segment.** A trailing fragment with no terminating newline reflects a process that died mid-append. On the stream's LAST segment (in `(date, sequence)` order), supplying `onTruncatedTail` tolerates it -- the callback fires once and the fragment is dropped; with no callback, the default is to throw, so there is no silent path. The identical fragment in any earlier, mid-stream segment is data loss rather than a torn tail -- the writer only ever rotates after a complete line -- and it always throws, callback or not.
- **A corrupt line throws rather than being skipped.** `read()` proves every line through the exact same `projectAppendOnlyEntry` the writer serializes through, so read and write share one definition of what the stream can hold. A line the writer could never have produced (a bare array or scalar, `-0`, a dangerous key, a too-deep structure, invalid UTF-8) means the file was tampered with or hand-edited; an audit trail that quietly reads back bytes it could not have written is not an audit trail, so this is never skipped and carries no callback escape.
- **A segment that cannot be closed is reported, not swallowed.** After a segment has been read to completion, its handle is closed inside the read itself and a failure there throws `M3LAppendOnlyStreamReadError` with the underlying error chained as `cause` -- the segment was read faithfully, so there is no other outcome for the failure to displace, and reporting a clean read over a descriptor the OS never released would be a lie. On the two non-success paths the close is best-effort instead: with a read failure already in flight the close failure is **chained deeper onto that error's `cause` chain** rather than replacing it, and on a consumer's early `break` -- a normal, successful way to stop reading -- it stays silent. Code walking `cause` on a read error should therefore expect more than one link.
- **Nothing here ever reclaims space, and `listSegments()` is the reason that is now visible.** The stream seals and rotates; it has no prune, no truncate, and no retention window, so a long-lived trail grows without bound. `listSegments()` is a read-only inventory (`lstat` per entry, no segment opened) so a caller can measure that footprint and decide. It is not a step toward pruning: because `read()` rejects a gap in a date's sequence numbers, deleting one segment out of the middle of a date makes every later read of that stream throw rather than freeing anything. Archiving whole dates is what the sequence check tolerates.
- **Whole-date archival is now provable, not merely tolerated.** The writer seals each segment it rotates away from into a directory-wide `manifest.jsonl` sidecar — one line per segment carrying its entry count, byte length and plain sha256 of the file's raw bytes. Plain, so `sha256sum <archived-segment>` reproduces the sealed digest: that reproducibility is the point, and is why an archive copy can be re-verified with nothing but coreutils. The sidecar is one non-date-named file, so the `rm 2026-09-*` an operator runs to archive a date cannot delete the proof along with the segments — a per-segment sidecar would have shared the date prefix and been swept up by the same glob.
- **Sealing is best-effort, and that asymmetry is deliberate.** A seal that cannot be written never fails the `append()` it follows: a seal is metadata about bytes that are already durably appended, and failing the append would discard a new auditable record to protect a proof about an older one. The loudness relocates to the optional `onSealFailed` handler, which receives an `M3LAppendOnlySealFailure`. Receiving one means a seal was _attempted and failed_ — not that a segment is merely unsealed yet. A truthy non-function there is rejected at construction with `ERR_INVALID_ARGUMENT`; a falsy one degrades to "no handler", so the safe direction is the default.
- **`append()` resolving does not mean the directory is quiescent — that is what `flush()` is for.** The seal runs on the writer's internal serialized chain rather than inside the promise `append()` awaits, so the entry is durable when `append()` resolves but a `manifest.jsonl` write may still be in flight. Removing or archiving the directory at that moment can race it, surfacing as `ENOTEMPTY` on a recursive remove — an in-flight seal recreates the sidecar part-way through the removal. `flush()` drains what was in flight when it was called; it is a point-in-time drain, not a barrier, so a concurrent `append()` is not covered. It never rejects: append failures reach their own caller and seal failures reach `onSealFailed`. Calling it is never required for the trail's correctness — a process that exits without flushing loses at most a seal, which the cold-start sweep recovers.
- **`verify()` reports; it does not refuse.** It re-digests what the sidecar claims and returns per-segment verdicts, per-status totals, an `unprovenBefore` boundary, and a separate `failures` list for whatever it could not check at all. It never throws on a finding — only on caller misuse, a ceiling that is not a positive integer, which it rejects before opening anything. Verification costs one bounded sequential re-read per _claimed_ segment and nothing at all for an unsealed one: there is no claim to check it against, so reading it would buy no evidence.
- **Deleting the manifest silently downgrades a sealed trail.** Nothing outside the directory records that sealing was ever in force, so a removed manifest is re-initialized on the next writer's cold start with a baseline that classifies the existing segments as unproven rather than tampered-with. That is bounded only by the directory's `0o700` mode — exactly like the segment-renumbering hazard above. Closing it would need state outside the directory, which this primitive deliberately does not have. `verify()`'s `unprovenBefore` is what makes the downgrade visible after the fact: it reads `undefined` where it previously read a segment name or `null`.
- **The inventory refuses a planted link, like the other two paths — and says so rather than throwing.** All three of write, `read()`, and `listSegments()` decline to treat a non-regular file at a segment name as a segment; the first two by `O_NOFOLLOW` on the open, the third by using `lstat` and requiring a regular file. Without that, a symlink planted at the next segment name would report its target's size and mtime, disclosing a file outside the stream directory and corrupting any byte total computed from the result. Where write and read raise, the inventory increments `skipped` instead, because its whole purpose is to remain usable against a damaged directory. A **hardlink** is refused too, on `lstat`'s own `nlink !== 1` — the same test the other two apply, just on a path rather than on a descriptor, so it is not TOCTOU-free the way theirs is, and it cannot tell which of two links is the one this writer created.
- **A read mirrors the writer's own link refusal, plus a FIFO refusal of its own.** `read()` applies the same `O_NOFOLLOW`/symlink and `fstat`-based `nlink === 1`/hardlink checks the writer applies at append time -- a hardlinked segment is refused, not treated as harmless, because it lets a lower-privilege actor nominate unreadable content for a higher-privilege reader to republish. The same `fstat` also refuses any non-regular file (a planted FIFO in particular) rather than letting `open()` block forever; see "Limitations" above for what gap detection between segments does and does not prove.

## See also

- [`text`](./text.md) — extract text from files before indexing it.
- [`json`](./json.md) — JSON field extraction for building document metadata.
- [`files`](./files.md) — filesystem helpers for locating source documents.
- [Capability index](../../guides/capability-index.md) — map of dependencies to the modules that use them.
- [Architecture overview](../../m3l-common-architecture.md) — authoritative spec.
