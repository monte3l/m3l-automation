/**
 * `core/storage/M3LFtsIndex` — an embedded, synchronous full-text search index
 * backed by SQLite's FTS5 extension via `better-sqlite3`.
 *
 * @packageDocumentation
 */

// eslint-disable-next-line import-x/no-named-as-default -- better-sqlite3's default export IS the Database constructor; it also carries a same-named type export, so the collision warning is a false positive here.
import Database from "better-sqlite3";

import { M3LFtsIndexError } from "./M3LFtsIndexError.js";

import type {
  M3LFtsIndexConfig,
  M3LFtsIndexDocument,
  M3LFtsIndexSearchOptions,
  M3LFtsIndexSearchResult,
  M3LFtsIndexStats,
  M3LSqliteDatabase,
  M3LSqliteStatement,
} from "./types.js";

/** The default FTS5 tokenizer when {@link M3LFtsIndexConfig.tokenizer} is omitted. */
const DEFAULT_TOKENIZER = "unicode61";

/** The schema version persisted in the internal KV store. */
const SCHEMA_VERSION = 1;

/** KV key under which the schema version is stored. */
const KEY_SCHEMA_VERSION = "schema_version";

/** KV key under which the tokenizer directive is stored. */
const KEY_TOKENIZER = "tokenizer";

/**
 * A tokenizer token: letters, digits, and underscore only. FTS5 built-in
 * tokenizer names (`unicode61`, `porter`, `ascii`, `trigram`) all match.
 */
const TOKENIZER_TOKEN_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * Number of characters of surrounding context to include on each side of a
 * literal-mode match when building its `snippet` window (full-text mode uses
 * FTS5's own `snippet()` instead).
 */
const LITERAL_SNIPPET_CONTEXT_CHARS = 16;

/**
 * A bare SQL identifier: must start with a letter or underscore, then letters,
 * digits, or underscores. Rejects leading-digit names (e.g. `1abc`).
 */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Shape of a raw row read back from the managed metadata side table.
 */
interface MetaSideRow {
  readonly metadata: string | null;
}

/**
 * Shape of the single-column count row returned by the `stats()` document
 * count query.
 */
interface CountRow {
  readonly n: number;
}

/**
 * An embedded full-text search index over an FTS5 virtual table.
 *
 * All operations are **synchronous** (`better-sqlite3` is a synchronous
 * binding). The constructor opens the database, validates the tokenizer and
 * identifiers, and idempotently creates three structures: the FTS5 virtual
 * table, a per-document metadata side table (`<table>_meta`), and an internal
 * key/value store (`_m3l_fts_meta`) holding the schema version and tokenizer.
 *
 * @example
 * ```ts
 * import { M3LFtsIndex } from "@m3l-automation/m3l-common/core";
 *
 * const index = new M3LFtsIndex({ dbPath: ":memory:", table: "documents" });
 *
 * index.upsertMany([
 *   { id: "doc-1", content: "Quarterly revenue report for EMEA" },
 *   { id: "doc-2", content: "Onboarding checklist for automation scripts" },
 * ]);
 *
 * const hits = index.search("revenue report", { mode: "full-text" });
 * for (const hit of hits) {
 *   // hit.id, hit.score, hit.snippet, hit.content
 * }
 * ```
 */
export class M3LFtsIndex {
  readonly #db: M3LSqliteDatabase;
  readonly #table: string;
  readonly #metaTable: string;
  readonly #metadataColumns: readonly string[];
  readonly #tokenizer: string;

  /**
   * Prepared-statement cache keyed by the SQL text itself. Every internal
   * `prepare` goes through {@link M3LFtsIndex.#prepare}, so a given statement
   * shape (including a `(mode + sorted filter columns)` search signature) is
   * compiled at most once and reused thereafter.
   */
  readonly #statements = new Map<string, M3LSqliteStatement>();

  /**
   * Opens the backing database and creates the managed structures.
   *
   * @param config - Index configuration. The `tokenizer`, `table`, and each
   *   `metadataColumns` entry are validated as bare identifiers before any DDL
   *   runs; an invalid value throws {@link M3LFtsIndexError} and creates no
   *   table.
   * @throws {@link M3LFtsIndexError} with code `"ERR_FTS_INVALID_TOKENIZER"`
   *   or `"ERR_FTS_INVALID_IDENTIFIER"` for invalid configuration.
   */
  constructor(config: M3LFtsIndexConfig) {
    const tokenizer = config.tokenizer ?? DEFAULT_TOKENIZER;
    this.#validateTokenizer(tokenizer);
    this.#validateIdentifier(config.table, "table");
    const metadataColumns = config.metadataColumns ?? [];
    for (const column of metadataColumns) {
      this.#validateIdentifier(column, "metadata column");
    }

    this.#table = config.table;
    this.#metaTable = `${config.table}_meta`;
    this.#metadataColumns = [...metadataColumns];
    this.#tokenizer = tokenizer;
    this.#db = new Database(config.dbPath);

    this.#createStructures();
  }

  /**
   * Validates a tokenizer directive: one or more whitespace-separated tokens,
   * each a bare identifier. Runs before any DDL.
   */
  #validateTokenizer(tokenizer: string): void {
    const tokens = tokenizer.trim().split(/\s+/).filter(Boolean);
    const valid =
      tokens.length > 0 &&
      tokens.every((token) => TOKENIZER_TOKEN_PATTERN.test(token));
    if (!valid) {
      throw new M3LFtsIndexError("invalid FTS5 tokenizer directive", {
        code: "ERR_FTS_INVALID_TOKENIZER",
      });
    }
  }

  /** Validates a bare SQL identifier (table name or metadata column). */
  #validateIdentifier(identifier: string, kind: string): void {
    if (!IDENTIFIER_PATTERN.test(identifier)) {
      throw new M3LFtsIndexError(`invalid ${kind} identifier`, {
        code: "ERR_FTS_INVALID_IDENTIFIER",
      });
    }
  }

  /** Idempotently creates the FTS5 table, meta side table, and KV store. */
  #createStructures(): void {
    const columns = ["id UNINDEXED", "content", ...this.#metadataColumns];
    this.#db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.#table} USING fts5(` +
        `${columns.join(", ")}, tokenize='${this.#tokenizer}')`,
    );
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#metaTable} (` +
        `id TEXT PRIMARY KEY, metadata TEXT)`,
    );
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS _m3l_fts_meta (key TEXT PRIMARY KEY, value TEXT)",
    );

    const setMeta = this.#db.prepare(
      "INSERT INTO _m3l_fts_meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    setMeta.run(KEY_SCHEMA_VERSION, String(SCHEMA_VERSION));
    setMeta.run(KEY_TOKENIZER, this.#tokenizer);
  }

  /**
   * Adds or replaces a single document.
   *
   * @param document - The document to index. An empty-string `id` throws
   *   {@link M3LFtsIndexError} (`"ERR_FTS_INVALID_DOCUMENT"`); empty `content`
   *   is allowed.
   * @throws {@link M3LFtsIndexError} for an empty-string id.
   */
  upsert(document: M3LFtsIndexDocument): void {
    this.#validateDocument(document);
    this.#writeDocument(document);
  }

  /**
   * Adds or replaces many documents inside a single transaction. A mid-batch
   * failure rolls the whole batch back. An empty array is a no-op.
   *
   * @param documents - The documents to index.
   * @throws {@link M3LFtsIndexError} for any empty-string id (before the
   *   transaction opens). Raw SQLite errors during the transaction propagate
   *   unwrapped after the batch has rolled back.
   */
  upsertMany(documents: readonly M3LFtsIndexDocument[]): void {
    if (documents.length === 0) return;
    for (const document of documents) {
      this.#validateDocument(document);
    }
    const run = this.#db.transaction(
      (batch: readonly M3LFtsIndexDocument[]) => {
        for (const document of batch) {
          this.#writeDocument(document);
        }
      },
    );
    run(documents);
  }

  /**
   * Removes a single document from both the FTS5 table and the metadata side
   * table. A missing id is a no-op.
   *
   * @param id - The document id to remove.
   */
  delete(id: string): void {
    this.#deleteDocument(id);
  }

  /**
   * Removes many documents inside a single transaction. An empty array is a
   * no-op.
   *
   * @param ids - The document ids to remove.
   */
  deleteMany(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const run = this.#db.transaction((batch: readonly string[]) => {
      for (const id of batch) {
        this.#deleteDocument(id);
      }
    });
    run(ids);
  }

  /**
   * Searches the index.
   *
   * In `"full-text"` mode (the default) results are ranked by BM25 (most
   * relevant first) with a highlighted `snippet` and a numeric `score`. In
   * `"literal"` mode the query is matched as a case-insensitive substring
   * (bound as a parameter, never concatenated); there is no ranking, so `score`
   * is `null` and `snippet` is set to a content window.
   *
   * @param query - The search text. An empty or whitespace-only query returns
   *   `[]` without throwing.
   * @param options - Optional per-query {@link M3LFtsIndexSearchOptions}.
   * @returns The ranked matches.
   * @throws {@link M3LFtsIndexError} for an invalid `mode`
   *   (`"ERR_FTS_INVALID_MODE"`), a non-positive/non-integer `limit`
   *   (`"ERR_FTS_INVALID_LIMIT"`), or an unknown filter column
   *   (`"ERR_FTS_UNKNOWN_FILTER_COLUMN"`).
   */
  search(
    query: string,
    options?: M3LFtsIndexSearchOptions,
  ): M3LFtsIndexSearchResult[] {
    const mode = this.#validateMode(options?.mode);
    const filters = options?.filters ?? {};
    this.#validateLimit(options?.limit);
    const filterColumns = this.#validateFilters(filters);

    if (query.trim().length === 0) return [];

    return this.#dispatchSearch(
      mode,
      query,
      filterColumns,
      filters,
      options?.limit,
    );
  }

  /**
   * Validates and resolves the search mode at the public boundary. An omitted
   * mode defaults to `"full-text"`. An untyped JS caller passing anything other
   * than a known mode throws {@link M3LFtsIndexError} (`"ERR_FTS_INVALID_MODE"`)
   * before any query runs.
   */
  #validateMode(
    mode: M3LFtsIndexSearchOptions["mode"],
  ): NonNullable<M3LFtsIndexSearchOptions["mode"]> {
    if (mode === undefined) return "full-text";
    if (mode !== "full-text" && mode !== "literal") {
      throw new M3LFtsIndexError("invalid search mode", {
        code: "ERR_FTS_INVALID_MODE",
        context: { mode },
      });
    }
    return mode;
  }

  /** Routes a validated, non-empty query to the mode-specific search. */
  #dispatchSearch(
    mode: NonNullable<M3LFtsIndexSearchOptions["mode"]>,
    query: string,
    filterColumns: readonly string[],
    filters: Readonly<Record<string, string>>,
    limit: number | undefined,
  ): M3LFtsIndexSearchResult[] {
    switch (mode) {
      case "full-text":
        return this.#searchFullText(query, filterColumns, filters, limit);
      case "literal":
        return this.#searchLiteral(query, filterColumns, filters, limit);
      default: {
        const exhaustive: never = mode;
        throw new M3LFtsIndexError(`unhandled search mode`, {
          code: "ERR_FTS_INVALID_MODE",
          context: { mode: String(exhaustive) },
        });
      }
    }
  }

  /**
   * Returns the raw, live `better-sqlite3` handle for queries the typed API
   * does not express. Not a clone — writes through it are visible to the index.
   *
   * @returns The backing {@link M3LSqliteDatabase}.
   */
  getDatabase(): M3LSqliteDatabase {
    return this.#db;
  }

  /**
   * Closes the underlying `better-sqlite3` handle, releasing the native
   * resource and, for a file-backed index, the file lock. Callers holding a
   * file-backed index should call this when done so the OS handle and lock are
   * freed promptly rather than at garbage-collection time.
   *
   * `better-sqlite3` tolerates a redundant close, so calling this more than
   * once is safe and does not throw.
   *
   * @example
   * ```ts
   * import { M3LFtsIndex } from "@m3l-automation/m3l-common/core";
   *
   * const index = new M3LFtsIndex({ dbPath: "./data/search.sqlite", table: "documents" });
   * try {
   *   index.upsert({ id: "doc-1", content: "quarterly revenue report" });
   * } finally {
   *   index.close();
   * }
   * ```
   */
  close(): void {
    this.#db.close();
  }

  /**
   * Reports live index statistics: current document count, the configured
   * table name, and the schema version and tokenizer persisted in the internal
   * KV store.
   *
   * @returns The current {@link M3LFtsIndexStats}.
   */
  stats(): M3LFtsIndexStats {
    const countRow = this.#prepare(
      `SELECT COUNT(*) AS n FROM ${this.#table}`,
    ).get() as CountRow;
    // The constructor's #createStructures() always persists both KV rows before
    // any stats() call, so a missing value means the KV store was corrupted or
    // externally tampered with — surface it rather than silently substituting
    // the in-memory default.
    return {
      documentCount: countRow.n,
      table: this.#table,
      schemaVersion: Number(this.#requireMeta(KEY_SCHEMA_VERSION)),
      tokenizer: this.#requireMeta(KEY_TOKENIZER),
    };
  }

  /** Reads a value from the internal KV store. */
  #readMeta(key: string): string | undefined {
    const row = this.#prepare(
      "SELECT value FROM _m3l_fts_meta WHERE key = ?",
    ).get(key) as { readonly value: string } | undefined;
    return row?.value;
  }

  /**
   * Reads a KV value that the constructor always persists; a missing row means
   * the internal KV store is corrupt, so throw rather than mask it.
   */
  #requireMeta(key: string): string {
    const value = this.#readMeta(key);
    if (value === undefined) {
      throw new M3LFtsIndexError("internal metadata row is missing", {
        code: "ERR_FTS_CORRUPT_METADATA",
        context: { key },
      });
    }
    return value;
  }

  /** Throws {@link M3LFtsIndexError} for an empty-string document id. */
  #validateDocument(document: M3LFtsIndexDocument): void {
    if (document.id.length === 0) {
      throw new M3LFtsIndexError("document id must be non-empty", {
        code: "ERR_FTS_INVALID_DOCUMENT",
      });
    }
  }

  /** Throws {@link M3LFtsIndexError} for a non-positive/non-integer limit. */
  #validateLimit(limit: number | undefined): void {
    if (limit === undefined) return;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new M3LFtsIndexError("limit must be a positive integer", {
        code: "ERR_FTS_INVALID_LIMIT",
      });
    }
  }

  /**
   * Validates that each filter key is a declared metadata column and returns
   * the filter columns in sorted order (for the prepared-statement cache key).
   */
  #validateFilters(filters: Readonly<Record<string, string>>): string[] {
    const columns = Object.keys(filters);
    for (const column of columns) {
      if (!this.#metadataColumns.includes(column)) {
        throw new M3LFtsIndexError("unknown filter column", {
          code: "ERR_FTS_UNKNOWN_FILTER_COLUMN",
          context: { column },
        });
      }
    }
    return [...columns].sort();
  }

  /** Inserts or replaces a document across the FTS5 and metadata tables. */
  #writeDocument(document: M3LFtsIndexDocument): void {
    const metadata = document.metadata ?? {};
    this.#deleteFromFts(document.id);
    const columns = ["id", "content", ...this.#metadataColumns];
    const placeholders = columns.map(() => "?").join(", ");
    const values: unknown[] = [
      document.id,
      document.content,
      ...this.#metadataColumns.map((column) => metadata[column] ?? ""),
    ];
    this.#prepare(
      `INSERT INTO ${this.#table} (${columns.join(", ")}) VALUES (${placeholders})`,
    ).run(...values);
    this.#prepare(
      `INSERT INTO ${this.#metaTable} (id, metadata) VALUES (?, ?) ` +
        "ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata",
    ).run(document.id, JSON.stringify(metadata));
  }

  /** Removes a document id from the FTS5 table only. */
  #deleteFromFts(id: string): void {
    this.#prepare(`DELETE FROM ${this.#table} WHERE id = ?`).run(id);
  }

  /** Removes a document id from both the FTS5 table and the metadata table. */
  #deleteDocument(id: string): void {
    this.#deleteFromFts(id);
    this.#prepare(`DELETE FROM ${this.#metaTable} WHERE id = ?`).run(id);
  }

  /**
   * Builds the ` AND <col> = @<col>` SQL fragment shared by both search modes.
   * Columns are already identifier-validated at the public boundary, so
   * centralizing the clause here keeps that invariant in a single place.
   */
  #buildFilterClause(filterColumns: readonly string[]): string {
    return filterColumns
      .map((column) => ` AND ${column} = @${column}`)
      .join("");
  }

  /** Full-text (FTS5 MATCH + BM25 + snippet) search. */
  #searchFullText(
    query: string,
    filterColumns: readonly string[],
    filters: Readonly<Record<string, string>>,
    limit: number | undefined,
  ): M3LFtsIndexSearchResult[] {
    const filterClause = this.#buildFilterClause(filterColumns);
    const statement = this.#prepare(
      `SELECT id, content, bm25(${this.#table}) AS score, ` +
        `snippet(${this.#table}, 1, '', '', '…', 16) AS snippet ` +
        `FROM ${this.#table} WHERE ${this.#table} MATCH @__query__` +
        `${filterClause} ORDER BY score LIMIT @__limit__`,
    );
    const params = this.#buildParams(
      this.#toMatchExpression(query),
      filters,
      filterColumns,
      limit,
    );
    const rows = statement.all(params) as ReadonlyArray<{
      readonly id: string;
      readonly content: string;
      readonly score: number;
      readonly snippet: string;
    }>;
    return rows.map((row) =>
      this.#toResult(row.id, row.score, row.snippet, row.content),
    );
  }

  /**
   * Builds an FTS5 `MATCH` expression from a free-text query: each whitespace-
   * separated term is double-quoted (so punctuation is treated literally) and
   * the terms are joined with `OR` so a document matching any term is a hit.
   * The result is bound as a parameter, never concatenated into SQL.
   */
  #toMatchExpression(query: string): string {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  }

  /** Case-insensitive literal substring search (query bound as a parameter). */
  #searchLiteral(
    query: string,
    filterColumns: readonly string[],
    filters: Readonly<Record<string, string>>,
    limit: number | undefined,
  ): M3LFtsIndexSearchResult[] {
    const filterClause = this.#buildFilterClause(filterColumns);
    const statement = this.#prepare(
      `SELECT id, content FROM ${this.#table} ` +
        `WHERE content LIKE '%' || @__query__ || '%' COLLATE NOCASE` +
        `${filterClause} LIMIT @__limit__`,
    );
    const params = this.#buildParams(query, filters, filterColumns, limit);
    const rows = statement.all(params) as ReadonlyArray<{
      readonly id: string;
      readonly content: string;
    }>;
    return rows.map((row) =>
      this.#toResult(
        row.id,
        null,
        this.#literalSnippet(row.content, query),
        row.content,
      ),
    );
  }

  /**
   * Prepares a statement, memoizing it by its SQL text so repeated shapes are
   * compiled once. All internal `prepare` calls route through here.
   */
  #prepare(sql: string): M3LSqliteStatement {
    const cached = this.#statements.get(sql);
    if (cached !== undefined) return cached;
    const statement = this.#db.prepare(sql);
    this.#statements.set(sql, statement);
    return statement;
  }

  /** Builds the bound parameter object for a search statement. */
  #buildParams(
    query: string,
    filters: Readonly<Record<string, string>>,
    filterColumns: readonly string[],
    limit: number | undefined,
  ): Record<string, string | number> {
    const params: Record<string, string | number> = {
      __query__: query,
      __limit__: limit ?? -1,
    };
    for (const column of filterColumns) {
      params[column] = filters[column] ?? "";
    }
    return params;
  }

  /** Extracts a content window around the first case-insensitive match. */
  #literalSnippet(content: string, query: string): string {
    const at = content.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0) return content;
    const start = Math.max(0, at - LITERAL_SNIPPET_CONTEXT_CHARS);
    const end = Math.min(
      content.length,
      at + query.length + LITERAL_SNIPPET_CONTEXT_CHARS,
    );
    return content.slice(start, end);
  }

  /** Assembles a search result, attaching stored metadata when present. */
  #toResult(
    id: string,
    score: number | null,
    snippet: string,
    content: string,
  ): M3LFtsIndexSearchResult {
    const metadata = this.#readDocumentMetadata(id);
    return metadata === undefined
      ? { id, score, snippet, content }
      : { id, score, snippet, content, metadata };
  }

  /** Reads a document's stored metadata, if any non-empty metadata exists. */
  #readDocumentMetadata(
    id: string,
  ): Readonly<Record<string, string>> | undefined {
    const row = this.#prepare(
      `SELECT metadata FROM ${this.#metaTable} WHERE id = ?`,
    ).get(id) as MetaSideRow | undefined;
    if (row?.metadata === null || row?.metadata === undefined) return undefined;
    // The module writes this JSON itself in #writeDocument, so a parse failure
    // means the side-table row is corrupt or was tampered with externally.
    // Surface it as a typed error with the SyntaxError chained as cause, per
    // the library's M3LError-with-cause rule — never a bare SyntaxError.
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(row.metadata) as Record<string, string>;
    } catch (cause) {
      throw new M3LFtsIndexError("stored metadata is not valid JSON", {
        code: "ERR_FTS_CORRUPT_METADATA",
        context: { id },
        cause,
      });
    }
    return Object.keys(parsed).length === 0 ? undefined : parsed;
  }
}
