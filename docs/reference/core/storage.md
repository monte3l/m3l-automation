# `storage` — Full-text Search Index

The `storage` module provides `M3LFtsIndex`, an embedded, zero-network full-text search index backed by SQLite's FTS5 extension.

## Overview

`M3LFtsIndex` wraps `better-sqlite3` (a native, synchronous SQLite binding) and exposes an FTS5 virtual table for in-process search. It is appropriate for searching over **thousands to low-millions of documents** without standing up an external search service.

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

## Notes & behavior

- **Synchronous.** `better-sqlite3` is synchronous; index operations do not return promises.
- **Tokenizer validation.** The tokenizer string is validated before use to prevent SQLite injection.
- **Typed validation errors.** Caller-supplied configuration and search input that fails validation at the public boundary throws an `M3LFtsIndexError` (a typed `M3LError` subclass) carrying a machine-readable `M3LFtsIndexErrorCode` — e.g. an invalid tokenizer, a non-identifier table name or metadata column, a non-positive `limit`, an empty document `id`, a filter on an undeclared column, or an unsupported search `mode`. A corrupt persisted-metadata row surfaces the same way, with the underlying parse error chained as `cause`. Raw SQLite/engine errors (a bad `dbPath`, disk failure, corruption, or a mid-batch constraint failure inside `upsertMany`) are **not** wrapped — they propagate unchanged so callers can react to them directly.
- **Batch in transactions.** `upsertMany` runs inside a transaction for atomicity and throughput.
- **Scale.** Designed for in-process search over thousands to low-millions of documents; for larger or distributed workloads, use a dedicated search service.
- **`getDatabase()`** returns the raw `better-sqlite3` handle (`M3LSqliteDatabase`) for queries the typed API does not express; prepared statements have type `M3LSqliteStatement`.

## See also

- [`text`](./text.md) — extract text from files before indexing it.
- [`json`](./json.md) — JSON field extraction for building document metadata.
- [`files`](./files.md) — filesystem helpers for locating source documents.
- [Capability index](../../guides/capability-index.md) — map of dependencies to the modules that use them.
- [Architecture overview](../../m3l-common-architecture.md) — authoritative spec.
