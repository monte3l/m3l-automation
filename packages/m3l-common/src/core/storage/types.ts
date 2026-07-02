/**
 * `core/storage` — public type surface for {@link M3LFtsIndex}.
 *
 * These types describe the configuration, documents, search options/results,
 * and statistics of the FTS5-backed full-text index, plus the two aliases for
 * the raw `better-sqlite3` handle and prepared statement exposed via
 * {@link M3LFtsIndex.getDatabase}.
 *
 * @packageDocumentation
 */

import type BetterSqlite3 from "better-sqlite3";

/**
 * The two supported search strategies.
 *
 * - `"full-text"` — FTS5 `MATCH` with BM25 ranking and `snippet()` extraction.
 * - `"literal"` — a case-insensitive substring scan, suited to punctuated
 *   tokens (e.g. UUIDs) that a tokenizer would otherwise split apart.
 *
 * @example
 * ```ts
 * const mode: M3LFtsIndexSearchMode = "literal";
 * ```
 */
export type M3LFtsIndexSearchMode = "full-text" | "literal";

/**
 * Configuration for constructing an {@link M3LFtsIndex}.
 *
 * @example
 * ```ts
 * const config: M3LFtsIndexConfig = {
 *   dbPath: "./data/search.sqlite",
 *   table: "documents",
 *   metadataColumns: ["category"],
 *   tokenizer: "porter unicode61",
 * };
 * ```
 */
export interface M3LFtsIndexConfig {
  /**
   * The SQLite database path, or `":memory:"` for an ephemeral in-memory
   * database. Passed verbatim to `better-sqlite3`.
   */
  readonly dbPath: string;
  /**
   * The FTS5 virtual-table name. Validated as a bare SQL identifier
   * (`/^[A-Za-z0-9_]+$/`) before any DDL runs.
   */
  readonly table: string;
  /**
   * Additional indexed metadata columns declared on the FTS5 table. Each name
   * is validated as a bare SQL identifier before any DDL runs. Defaults to no
   * extra columns.
   */
  readonly metadataColumns?: readonly string[];
  /**
   * The FTS5 tokenizer directive (e.g. `"unicode61"`, `"porter unicode61"`).
   * Validated before use to prevent SQL injection. Defaults to `"unicode61"`.
   */
  readonly tokenizer?: string;
}

/**
 * A single document to add to or update in the index.
 *
 * @example
 * ```ts
 * const document: M3LFtsIndexDocument = {
 *   id: "doc-1",
 *   content: "Quarterly revenue report for EMEA",
 *   metadata: { category: "finance" },
 * };
 * ```
 */
export interface M3LFtsIndexDocument {
  /** Stable, non-empty document identifier (the upsert key). */
  readonly id: string;
  /** Free text to index and match against. May be empty. */
  readonly content: string;
  /**
   * Optional per-document metadata. Keys that correspond to declared
   * {@link M3LFtsIndexConfig.metadataColumns} become filterable in searches.
   */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Per-query options for {@link M3LFtsIndex.search}.
 *
 * @example
 * ```ts
 * const options: M3LFtsIndexSearchOptions = {
 *   mode: "full-text",
 *   filters: { category: "finance" },
 *   limit: 10,
 * };
 * ```
 */
export interface M3LFtsIndexSearchOptions {
  /** The search strategy. Defaults to `"full-text"`. */
  readonly mode?: M3LFtsIndexSearchMode;
  /**
   * Equality filters keyed by declared metadata column. Each key must be one
   * of {@link M3LFtsIndexConfig.metadataColumns} or the search throws.
   */
  readonly filters?: Readonly<Record<string, string>>;
  /** Maximum number of results. Must be a positive integer when provided. */
  readonly limit?: number;
}

/**
 * A single ranked search hit.
 *
 * `score` and `snippet` are always present and uniform across modes (a single
 * interface, not a discriminated union): in `"full-text"` mode `score` is the
 * BM25 rank (a number, ascending — most relevant first) and `snippet` is a
 * highlighted excerpt; in `"literal"` mode there is no ranking, so `score` is
 * `null` and `snippet` is the matched content window.
 *
 * @example
 * ```ts
 * const hit: M3LFtsIndexSearchResult = {
 *   id: "doc-1",
 *   score: -1.23,
 *   snippet: "Quarterly <b>revenue</b> report",
 *   content: "Quarterly revenue report for EMEA",
 * };
 * ```
 */
export interface M3LFtsIndexSearchResult {
  /** The matched document id. */
  readonly id: string;
  /**
   * Relevance score: the BM25 rank (a number) for `"full-text"`, or `null`
   * for `"literal"` (which performs no ranking).
   */
  readonly score: number | null;
  /** A snippet excerpt of the matched content. */
  readonly snippet: string;
  /** The full indexed content of the matched document. */
  readonly content: string;
  /** The document's metadata, when any was stored. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Live statistics for an {@link M3LFtsIndex}.
 *
 * @example
 * ```ts
 * const stats: M3LFtsIndexStats = {
 *   documentCount: 42,
 *   table: "documents",
 *   schemaVersion: 1,
 *   tokenizer: "unicode61",
 * };
 * ```
 */
export interface M3LFtsIndexStats {
  /** Number of documents currently indexed. */
  readonly documentCount: number;
  /** The configured FTS5 table name. */
  readonly table: string;
  /** The managed schema version persisted in the internal KV store. */
  readonly schemaVersion: number;
  /** The tokenizer directive persisted in the internal KV store. */
  readonly tokenizer: string;
}

/**
 * The type of the raw `better-sqlite3` database handle returned by
 * {@link M3LFtsIndex.getDatabase}.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const index = new Core.M3LFtsIndex({ dbPath: ":memory:", table: "documents" });
 * const db: Core.M3LSqliteDatabase = index.getDatabase();
 * ```
 */
export type M3LSqliteDatabase = BetterSqlite3.Database;

/**
 * The type of a prepared statement produced by
 * {@link M3LSqliteDatabase.prepare}.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const index = new Core.M3LFtsIndex({ dbPath: ":memory:", table: "documents" });
 * const statement: Core.M3LSqliteStatement = index
 *   .getDatabase()
 *   .prepare("SELECT COUNT(*) AS n FROM documents");
 * ```
 */
export type M3LSqliteStatement = BetterSqlite3.Statement;
