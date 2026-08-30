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

| Symbol                               | Kind  | Purpose                                                               |
| ------------------------------------ | ----- | --------------------------------------------------------------------- |
| `M3LAppendOnlyStream`                | class | Segmented append-only JSONL stream with byte/age/date rotation.       |
| `M3LAppendOnlyStreamOptions`         | type  | Constructor options (directory plus the three optional ceilings).     |
| `M3LAppendOnlyEntry`                 | type  | One entry: a read-only map of `M3LAppendOnlyValue`.                   |
| `M3LAppendOnlyValue`                 | type  | The closed value union an entry field may carry.                      |
| `M3LAppendOnlyStreamError`           | class | Thrown when an append fails or the rendered line exceeds the ceiling. |
| `M3L_APPEND_ONLY_MAX_SEGMENT_BYTES`  | const | Default segment size ceiling, 8 MiB.                                  |
| `M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS` | const | Default segment age ceiling, 24 h.                                    |
| `M3L_APPEND_ONLY_MAX_LINE_BYTES`     | const | Default per-line ceiling, 64 KiB.                                     |

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

## See also

- [`text`](./text.md) — extract text from files before indexing it.
- [`json`](./json.md) — JSON field extraction for building document metadata.
- [`files`](./files.md) — filesystem helpers for locating source documents.
- [Capability index](../../guides/capability-index.md) — map of dependencies to the modules that use them.
- [Architecture overview](../../m3l-common-architecture.md) — authoritative spec.
