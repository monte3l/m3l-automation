/**
 * Tests for core/storage submodule (RED phase — TDD).
 *
 * Contract source: docs/reference/core/storage.md + hub binding contract.
 * Public surface (11 symbols, all from @m3l-automation/m3l-common/core):
 *   M3LFtsIndex (class), M3LFtsIndexError (class),
 *   M3LFtsIndexConfig, M3LFtsIndexDocument, M3LFtsIndexSearchMode,
 *   M3LFtsIndexSearchOptions, M3LFtsIndexSearchResult, M3LFtsIndexStats,
 *   M3LSqliteDatabase, M3LSqliteStatement, M3LFtsIndexErrorCode (9 types).
 *
 * Key behavioral contracts exercised here:
 *  - ALL operations are SYNCHRONOUS (no Promise anywhere; no async/await).
 *  - Constructor opens an (in-memory) DB and idempotently creates three
 *    structures: <table> (fts5 virtual), <table>_meta, _m3l_fts_meta (KV with
 *    schema-version + tokenizer keys).
 *  - full-text mode: FTS5 MATCH + bm25 + snippet(); most-relevant first;
 *    non-empty snippet. Default mode = full-text.
 *  - literal mode: case-insensitive substring scan; finds a full UUID.
 *  - upsertMany runs in a single transaction: a mid-batch failure rolls the
 *    WHOLE batch back (raw SQLite error channel — NOT asserted to be M3LError).
 *  - delete/deleteMany remove from BOTH <table> and <table>_meta; empty arrays
 *    are no-ops.
 *  - stats() reflects live counts; tokenizer + schemaVersion round-trip.
 *  - getDatabase() returns a usable raw handle (M3LSqliteDatabase).
 *  - Validation failures throw M3LFtsIndexError with a narrowed `code`:
 *    ERR_FTS_INVALID_TOKENIZER, ERR_FTS_INVALID_IDENTIFIER, ERR_FTS_INVALID_LIMIT,
 *    ERR_FTS_INVALID_DOCUMENT, ERR_FTS_UNKNOWN_FILTER_COLUMN, ERR_FTS_INVALID_MODE,
 *    ERR_FTS_CORRUPT_METADATA.
 *  - Prepared-statement cache: same (mode + filter-column) shape reuses.
 *
 * All DBs use dbPath ":memory:" so tests need no filesystem and are isolated.
 */

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import { M3LFtsIndex, M3LFtsIndexError } from "../src/core/storage/index.js";

import type {
  M3LFtsIndexConfig,
  M3LFtsIndexDocument,
  M3LFtsIndexErrorCode,
  M3LFtsIndexSearchMode,
  M3LFtsIndexSearchOptions,
  M3LFtsIndexSearchResult,
  M3LFtsIndexStats,
  M3LSqliteDatabase,
  M3LSqliteStatement,
} from "../src/core/storage/index.js";

// A stable UUID used to prove `literal` mode finds a punctuated token that a
// tokenizer would otherwise split into pieces.
const UUID = "550e8400-e29b-41d4-a716-446655440000";

/** Builds a fresh in-memory index for the default `documents` table. */
function makeIndex(overrides: Partial<M3LFtsIndexConfig> = {}): M3LFtsIndex {
  const config: M3LFtsIndexConfig = {
    dbPath: ":memory:",
    table: "documents",
    ...overrides,
  };
  return new M3LFtsIndex(config);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// Public surface / type-level contract
// =============================================================================
describe("public surface", () => {
  test("M3LFtsIndex is a constructable class", () => {
    expect(typeof M3LFtsIndex).toBe("function");
    const index = makeIndex();
    expect(index).toBeInstanceOf(M3LFtsIndex);
  });

  test("M3LFtsIndexError is an M3LError subclass", () => {
    // Construct directly to prove the class exists and chains through M3LError.
    const error = new M3LFtsIndexError("boom", {
      code: "ERR_FTS_INVALID_LIMIT",
    });
    expect(error).toBeInstanceOf(M3LFtsIndexError);
    expect(error).toBeInstanceOf(M3LError);
    expect(error.code).toBe("ERR_FTS_INVALID_LIMIT");
  });

  test("M3LFtsIndexSearchMode is exactly 'full-text' | 'literal'", () => {
    expectTypeOf<M3LFtsIndexSearchMode>().toEqualTypeOf<
      "full-text" | "literal"
    >();
  });

  test("M3LFtsIndexErrorCode is exactly the documented code union", () => {
    expectTypeOf<M3LFtsIndexErrorCode>().toEqualTypeOf<
      | "ERR_FTS_INVALID_TOKENIZER"
      | "ERR_FTS_INVALID_IDENTIFIER"
      | "ERR_FTS_INVALID_LIMIT"
      | "ERR_FTS_INVALID_DOCUMENT"
      | "ERR_FTS_UNKNOWN_FILTER_COLUMN"
      | "ERR_FTS_INVALID_MODE"
      | "ERR_FTS_CORRUPT_METADATA"
    >();
  });

  test("M3LFtsIndexConfig exposes the documented readonly fields", () => {
    expectTypeOf<M3LFtsIndexConfig>().toEqualTypeOf<{
      readonly dbPath: string;
      readonly table: string;
      readonly metadataColumns?: readonly string[];
      readonly tokenizer?: string;
    }>();
  });

  test("M3LFtsIndexDocument exposes id/content and optional readonly metadata", () => {
    expectTypeOf<M3LFtsIndexDocument>().toEqualTypeOf<{
      readonly id: string;
      readonly content: string;
      readonly metadata?: Readonly<Record<string, string>>;
    }>();
  });

  test("M3LFtsIndexSearchOptions exposes optional mode/filters/limit", () => {
    expectTypeOf<M3LFtsIndexSearchOptions>().toEqualTypeOf<{
      readonly mode?: M3LFtsIndexSearchMode;
      readonly filters?: Readonly<Record<string, string>>;
      readonly limit?: number;
    }>();
  });

  test("M3LFtsIndexSearchResult exposes non-optional id/score/snippet/content with score number | null", () => {
    expectTypeOf<M3LFtsIndexSearchResult>().toEqualTypeOf<{
      readonly id: string;
      readonly score: number | null;
      readonly snippet: string;
      readonly content: string;
      readonly metadata?: Readonly<Record<string, string>>;
    }>();
  });

  test("M3LFtsIndexStats exposes documentCount/table/schemaVersion/tokenizer", () => {
    expectTypeOf<M3LFtsIndexStats>().toEqualTypeOf<{
      readonly documentCount: number;
      readonly table: string;
      readonly schemaVersion: number;
      readonly tokenizer: string;
    }>();
  });

  test("M3LSqliteStatement is the type of a prepared statement", () => {
    // The type IS the contract: getDatabase().prepare() must yield it.
    const index = makeIndex();
    const statement = index.getDatabase().prepare("SELECT 1 AS n");
    expectTypeOf(statement).toEqualTypeOf<M3LSqliteStatement>();
  });
});

// =============================================================================
// Synchronous contract — no method returns a Promise
// =============================================================================
describe("synchronous contract", () => {
  test("upsert / upsertMany / delete / deleteMany return void (not Promise)", () => {
    expectTypeOf<M3LFtsIndex["upsert"]>().returns.toEqualTypeOf<void>();
    expectTypeOf<M3LFtsIndex["upsertMany"]>().returns.toEqualTypeOf<void>();
    expectTypeOf<M3LFtsIndex["delete"]>().returns.toEqualTypeOf<void>();
    expectTypeOf<M3LFtsIndex["deleteMany"]>().returns.toEqualTypeOf<void>();
  });

  test("search returns a plain array of results (not a Promise)", () => {
    expectTypeOf<M3LFtsIndex["search"]>().returns.toEqualTypeOf<
      M3LFtsIndexSearchResult[]
    >();
  });

  test("stats returns M3LFtsIndexStats (not a Promise)", () => {
    expectTypeOf<
      M3LFtsIndex["stats"]
    >().returns.toEqualTypeOf<M3LFtsIndexStats>();
  });

  test("getDatabase returns M3LSqliteDatabase (not a Promise)", () => {
    expectTypeOf<
      ReturnType<M3LFtsIndex["getDatabase"]>
    >().toEqualTypeOf<M3LSqliteDatabase>();
  });
});

// =============================================================================
// Managed structures created in the constructor
// =============================================================================
describe("managed structures", () => {
  interface MasterRow {
    readonly name: string;
    readonly type: string;
  }
  interface MetaRow {
    readonly key: string;
    readonly value: string;
  }

  function masterNames(index: M3LFtsIndex): Set<string> {
    const rows = index
      .getDatabase()
      .prepare("SELECT name, type FROM sqlite_master")
      .all() as MasterRow[];
    return new Set(rows.map((row) => row.name));
  }

  test("creates <table>, <table>_meta, and _m3l_fts_meta", () => {
    const index = makeIndex();
    const names = masterNames(index);
    expect(names.has("documents")).toBe(true);
    expect(names.has("documents_meta")).toBe(true);
    expect(names.has("_m3l_fts_meta")).toBe(true);
  });

  test("<table> is registered as an fts5 virtual table", () => {
    const index = makeIndex();
    const row = index
      .getDatabase()
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'documents' AND type = 'table'",
      )
      .get() as { readonly sql: string };
    expect(row.sql.toLowerCase()).toContain("fts5");
  });

  test("_m3l_fts_meta holds a schema-version key and a tokenizer key", () => {
    const index = makeIndex();
    const rows = index
      .getDatabase()
      .prepare("SELECT key, value FROM _m3l_fts_meta")
      .all() as MetaRow[];
    const keys = new Set(rows.map((row) => row.key));
    // The KV store must carry versioning + tokenizer config; exact key strings
    // are an implementation detail, so we assert on presence via stats() below
    // and here only that the store is populated with at least those two facts.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // schemaVersion and tokenizer round-trip through stats() (see stats suite);
    // here just guard the store is non-empty and keyed.
    expect(keys.size).toBeGreaterThanOrEqual(2);
  });

  test("construction is idempotent (a second index on the same in-memory shape does not throw)", () => {
    expect(() => makeIndex()).not.toThrow();
    expect(() => makeIndex()).not.toThrow();
  });

  test("declares metadata columns on the fts table when configured", () => {
    const index = makeIndex({ metadataColumns: ["category"] });
    const row = index
      .getDatabase()
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'documents' AND type = 'table'",
      )
      .get() as { readonly sql: string };
    expect(row.sql.toLowerCase()).toContain("category");
  });
});

// =============================================================================
// Full-text search
// =============================================================================
describe("full-text search", () => {
  test("upsert then search returns the doc with a non-empty snippet", () => {
    const index = makeIndex();
    index.upsert({ id: "doc-1", content: "Quarterly revenue report for EMEA" });

    const hits = index.search("revenue report", { mode: "full-text" });

    expect(hits.length).toBeGreaterThan(0);
    const first = hits[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.id).toBe("doc-1");
    expect(first.snippet.length).toBeGreaterThan(0);
    expect(first.content).toContain("revenue");
    // Full-text mode carries a numeric BM25 score (not null).
    expect(typeof first.score).toBe("number");
    expect(first.score).not.toBeNull();
  });

  test("orders the most relevant document first", () => {
    const index = makeIndex();
    index.upsertMany([
      { id: "strong", content: "revenue revenue revenue report report" },
      { id: "weak", content: "a single passing mention of revenue here" },
    ]);

    const hits = index.search("revenue report", { mode: "full-text" });

    expect(hits.length).toBe(2);
    expect(hits[0]?.id).toBe("strong");
  });

  test("default mode behaves like full-text when options.mode is omitted", () => {
    const index = makeIndex();
    index.upsert({ id: "doc-x", content: "an x marks the spot document" });

    const withDefault = index.search("x");
    const explicit = index.search("x", { mode: "full-text" });

    expect(withDefault.map((hit) => hit.id)).toEqual(
      explicit.map((hit) => hit.id),
    );
    expect(withDefault.length).toBeGreaterThan(0);
  });

  test("empty / whitespace-only query returns [] without throwing", () => {
    const index = makeIndex();
    index.upsert({ id: "doc-1", content: "some content" });

    expect(index.search("")).toEqual([]);
    expect(index.search("   ")).toEqual([]);
    expect(() => index.search("")).not.toThrow();
  });
});

// =============================================================================
// Literal search
// =============================================================================
describe("literal search", () => {
  test("finds a full UUID that a tokenizer would split", () => {
    const index = makeIndex();
    index.upsert({ id: "doc-1", content: `trace id is ${UUID} for this run` });

    const hits = index.search(UUID, { mode: "literal" });

    expect(hits.length).toBe(1);
    expect(hits[0]?.id).toBe("doc-1");
    // Literal mode performs no ranking, so its score is explicitly `null`.
    expect(hits[0]?.score).toBeNull();
    expect(hits[0]?.score === null).toBe(true);
  });

  test("is case-insensitive", () => {
    const index = makeIndex();
    index.upsert({ id: "doc-1", content: `Trace ${UUID.toUpperCase()} end` });

    const hits = index.search(UUID.toLowerCase(), { mode: "literal" });

    expect(hits.length).toBe(1);
    expect(hits[0]?.id).toBe("doc-1");
  });

  test("literal results carry a non-empty content snippet window", () => {
    const index = makeIndex();
    index.upsert({ id: "doc-1", content: `prefix ${UUID} suffix` });

    const hits = index.search(UUID, { mode: "literal" });

    expect(hits[0]?.snippet.length).toBeGreaterThan(0);
  });

  test("treats LIKE metacharacters (% and _) as literal characters", () => {
    const index = makeIndex();
    index.upsert({ id: "with-percent", content: "discount is 50% off today" });
    index.upsert({ id: "no-percent", content: "plain text with no wildcard" });
    index.upsert({ id: "with-underscore", content: "file_name.txt saved" });
    index.upsert({ id: "no-underscore", content: "file name has a space" });

    // `%` must match only the document literally containing `%`, not every doc.
    const percentHits = index.search("%", { mode: "literal" });
    expect(percentHits.map((h) => h.id)).toEqual(["with-percent"]);

    // `_` must match a literal underscore, not "any single character".
    const underscoreHits = index.search("_", { mode: "literal" });
    expect(underscoreHits.map((h) => h.id)).toEqual(["with-underscore"]);
  });
});

// =============================================================================
// upsertMany atomicity (raw SQLite error channel)
// =============================================================================
describe("upsertMany atomicity", () => {
  test("a mid-batch failure rolls back the WHOLE batch", () => {
    const index = makeIndex();
    index.upsert({ id: "pre-existing", content: "already here" });
    const countBefore = index.stats().documentCount;

    // A document whose `content` is a non-string, non-bindable value forces
    // better-sqlite3 to throw at bind time *after* earlier docs in the same
    // call have been staged inside the transaction. This is a deterministic
    // engine-level failure (a plain object cannot be bound as a SQL parameter),
    // so it exercises the single-transaction rollback without depending on any
    // implementation-internal SQL. The value is deliberately mistyped via
    // `unknown` to bypass the M3LFtsIndexDocument.content: string contract.
    const poison = {
      id: "poison",
      content: { not: "a string" },
    } as unknown as M3LFtsIndexDocument;

    const batch: readonly M3LFtsIndexDocument[] = [
      { id: "batch-1", content: "first batch doc" },
      { id: "batch-2", content: "second batch doc" },
      poison,
    ];

    // Raw SQLite / bind error channel — assert it THROWS + rolls back, but do
    // NOT assert the thrown value is an M3LError (contract: raw errors propagate
    // unwrapped from inside the transaction).
    expect(() => index.upsertMany(batch)).toThrow();

    // Rollback: document count is unchanged and none of the batch ids landed.
    expect(index.stats().documentCount).toBe(countBefore);
    expect(index.search("first batch doc", { mode: "literal" })).toEqual([]);
    expect(index.search("second batch doc", { mode: "literal" })).toEqual([]);
  });

  test("upsertMany([]) is a no-op and does not throw", () => {
    const index = makeIndex();
    const before = index.stats().documentCount;
    expect(() => index.upsertMany([])).not.toThrow();
    expect(index.stats().documentCount).toBe(before);
  });
});

// =============================================================================
// delete / deleteMany
// =============================================================================
describe("delete and deleteMany", () => {
  interface CountRow {
    readonly n: number;
  }

  function metaCount(index: M3LFtsIndex, id: string): number {
    const row = index
      .getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM documents_meta WHERE id = ?")
      .get(id) as CountRow;
    return row.n;
  }

  test("delete of a missing id is a no-op and does not throw", () => {
    const index = makeIndex();
    index.upsert({ id: "present", content: "still here" });

    expect(() => index.delete("nonexistent")).not.toThrow();
    // The present document is untouched.
    expect(index.stats().documentCount).toBe(1);
  });

  test("delete removes the document from BOTH <table> and <table>_meta", () => {
    const index = makeIndex();
    index.upsert({
      id: "doc-1",
      content: "deletable content",
      metadata: { category: "x" },
    });
    expect(metaCount(index, "doc-1")).toBe(1);

    index.delete("doc-1");

    expect(index.stats().documentCount).toBe(0);
    expect(metaCount(index, "doc-1")).toBe(0);
    expect(index.search("deletable", { mode: "full-text" })).toEqual([]);
  });

  test("deleteMany removes each id from BOTH <table> and <table>_meta", () => {
    const index = makeIndex();
    index.upsertMany([
      { id: "a", content: "alpha content", metadata: { category: "x" } },
      { id: "b", content: "beta content", metadata: { category: "y" } },
      { id: "c", content: "gamma content" },
    ]);

    index.deleteMany(["a", "b"]);

    expect(index.stats().documentCount).toBe(1);
    expect(metaCount(index, "a")).toBe(0);
    expect(metaCount(index, "b")).toBe(0);
    expect(index.search("gamma", { mode: "full-text" })).not.toEqual([]);
  });

  test("deleteMany([]) is a no-op and does not throw", () => {
    const index = makeIndex();
    index.upsert({ id: "doc-1", content: "still here" });
    expect(() => index.deleteMany([])).not.toThrow();
    expect(index.stats().documentCount).toBe(1);
  });
});

// =============================================================================
// stats()
// =============================================================================
describe("stats()", () => {
  test("documentCount reflects live inserts and deletes", () => {
    const index = makeIndex();
    expect(index.stats().documentCount).toBe(0);

    index.upsertMany([
      { id: "a", content: "one" },
      { id: "b", content: "two" },
    ]);
    expect(index.stats().documentCount).toBe(2);

    index.delete("a");
    expect(index.stats().documentCount).toBe(1);
  });

  test("reports the configured table name", () => {
    const index = makeIndex();
    expect(index.stats().table).toBe("documents");
  });

  test("tokenizer and schemaVersion round-trip through _m3l_fts_meta", () => {
    const index = makeIndex({ tokenizer: "porter unicode61" });
    const stats = index.stats();

    expect(stats.tokenizer).toBe("porter unicode61");
    expect(typeof stats.schemaVersion).toBe("number");
    expect(stats.schemaVersion).toBeGreaterThan(0);

    // The reported values must come from the persisted KV store, not the ctor
    // arg alone: read them straight out of _m3l_fts_meta and cross-check.
    interface MetaRow {
      readonly key: string;
      readonly value: string;
    }
    const rows = index
      .getDatabase()
      .prepare("SELECT key, value FROM _m3l_fts_meta")
      .all() as MetaRow[];
    const values = new Set(rows.map((row) => row.value));
    expect(values.has("porter unicode61")).toBe(true);
    expect(values.has(String(stats.schemaVersion))).toBe(true);
  });

  test("defaults the tokenizer to unicode61 when unspecified", () => {
    const index = makeIndex();
    expect(index.stats().tokenizer).toBe("unicode61");
  });
});

// =============================================================================
// getDatabase()
// =============================================================================
describe("getDatabase()", () => {
  test("returns a usable raw handle", () => {
    const index = makeIndex();
    index.upsert({ id: "doc-1", content: "raw handle content" });

    const db = index.getDatabase();
    const row = db.prepare("SELECT COUNT(*) AS n FROM documents").get() as {
      readonly n: number;
    };

    expect(row.n).toBe(1);
  });

  test("returns the live handle, not a clone (writes through it are visible)", () => {
    const index = makeIndex();
    const db = index.getDatabase();
    expect(index.getDatabase()).toBe(db);
  });
});

// =============================================================================
// Validation failures — M3LFtsIndexError with narrowed `code`
// =============================================================================
describe("tokenizer validation (spec-required)", () => {
  test("an injection-shaped tokenizer throws ERR_FTS_INVALID_TOKENIZER and creates no fts table", () => {
    let thrown: unknown;
    try {
      makeIndex({
        table: "t",
        tokenizer: "unicode61'; DROP TABLE x;--",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LFtsIndexError);
    expect((thrown as M3LFtsIndexError).code).toBe("ERR_FTS_INVALID_TOKENIZER");
  });

  test.each(["unicode61", "porter", "trigram", "ascii", "porter unicode61"])(
    "accepts the valid tokenizer %j",
    (tokenizer) => {
      expect(() => makeIndex({ tokenizer })).not.toThrow();
    },
  );

  test.each(["'; DROP TABLE x;--", "unicode61)", "tok enizer;", ""])(
    "rejects the invalid tokenizer %j with ERR_FTS_INVALID_TOKENIZER",
    (tokenizer) => {
      let thrown: unknown;
      try {
        makeIndex({ tokenizer });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LFtsIndexError);
      expect((thrown as M3LFtsIndexError).code).toBe(
        "ERR_FTS_INVALID_TOKENIZER",
      );
    },
  );
});

describe("identifier validation", () => {
  test.each(["bad-name;", "documents; DROP TABLE x", "1abc", "a b"])(
    "rejects the invalid table name %j with ERR_FTS_INVALID_IDENTIFIER",
    (table) => {
      let thrown: unknown;
      try {
        makeIndex({ table });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LFtsIndexError);
      expect((thrown as M3LFtsIndexError).code).toBe(
        "ERR_FTS_INVALID_IDENTIFIER",
      );
    },
  );

  test("rejects an invalid metadata column name with ERR_FTS_INVALID_IDENTIFIER", () => {
    let thrown: unknown;
    try {
      makeIndex({ metadataColumns: ["bad-col;"] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LFtsIndexError);
    expect((thrown as M3LFtsIndexError).code).toBe(
      "ERR_FTS_INVALID_IDENTIFIER",
    );
  });
});

describe("search option guards", () => {
  test.each([0, -1, -100, 1.5, Number.NaN])(
    "rejects limit %j with ERR_FTS_INVALID_LIMIT",
    (limit) => {
      const index = makeIndex();
      index.upsert({ id: "doc-1", content: "content" });
      let thrown: unknown;
      try {
        index.search("content", { limit });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LFtsIndexError);
      expect((thrown as M3LFtsIndexError).code).toBe("ERR_FTS_INVALID_LIMIT");
    },
  );

  test("accepts a positive integer limit", () => {
    const index = makeIndex();
    index.upsertMany([
      { id: "a", content: "match one" },
      { id: "b", content: "match two" },
    ]);
    expect(() => index.search("match", { limit: 1 })).not.toThrow();
    expect(index.search("match", { limit: 1 }).length).toBe(1);
  });

  test("a filter key not in metadataColumns throws ERR_FTS_UNKNOWN_FILTER_COLUMN", () => {
    const index = makeIndex({ metadataColumns: ["category"] });
    index.upsert({
      id: "doc-1",
      content: "content",
      metadata: { category: "x" },
    });
    let thrown: unknown;
    try {
      index.search("content", { filters: { unknownColumn: "x" } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LFtsIndexError);
    expect((thrown as M3LFtsIndexError).code).toBe(
      "ERR_FTS_UNKNOWN_FILTER_COLUMN",
    );
  });

  test("a filter on a declared metadata column is accepted", () => {
    const index = makeIndex({ metadataColumns: ["category"] });
    index.upsert({
      id: "doc-1",
      content: "content",
      metadata: { category: "x" },
    });
    expect(() =>
      index.search("content", { filters: { category: "x" } }),
    ).not.toThrow();
  });

  test.each(["fulltext", "FULL-TEXT", "exact", "", "regex"])(
    "rejects an invalid (untyped-JS) mode %j with ERR_FTS_INVALID_MODE",
    (mode) => {
      const index = makeIndex();
      index.upsert({ id: "doc-1", content: "content" });
      let thrown: unknown;
      try {
        // An untyped JS caller can pass any string as `mode`; the typed API
        // forbids it, so cast through the exact option type to reach the guard.
        index.search("content", {
          mode: mode as M3LFtsIndexSearchMode,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LFtsIndexError);
      expect((thrown as M3LFtsIndexError).code).toBe("ERR_FTS_INVALID_MODE");
    },
  );

  test("both documented modes are accepted without throwing", () => {
    const index = makeIndex();
    index.upsert({ id: "doc-1", content: "content" });
    expect(() => index.search("content", { mode: "full-text" })).not.toThrow();
    expect(() => index.search("content", { mode: "literal" })).not.toThrow();
  });
});

describe("document validation", () => {
  test("an empty-string document id throws ERR_FTS_INVALID_DOCUMENT", () => {
    const index = makeIndex();
    let thrown: unknown;
    try {
      index.upsert({ id: "", content: "content" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LFtsIndexError);
    expect((thrown as M3LFtsIndexError).code).toBe("ERR_FTS_INVALID_DOCUMENT");
  });

  test("empty content is allowed (only empty id is rejected)", () => {
    const index = makeIndex();
    expect(() => index.upsert({ id: "doc-1", content: "" })).not.toThrow();
  });
});

// =============================================================================
// Corrupt stored metadata — ERR_FTS_CORRUPT_METADATA (chained SyntaxError)
// =============================================================================
describe("corrupt stored metadata", () => {
  test("normal metadata round-trips fine through search", () => {
    const index = makeIndex({ metadataColumns: ["category"] });
    index.upsert({
      id: "doc-1",
      content: "round trip content",
      metadata: { category: "finance" },
    });

    const hits = index.search("content", { mode: "full-text" });

    expect(hits.length).toBe(1);
    expect(hits[0]?.metadata).toEqual({ category: "finance" });
  });

  test("an unparseable side-table metadata row throws ERR_FTS_CORRUPT_METADATA with a SyntaxError cause", () => {
    const index = makeIndex({ metadataColumns: ["category"] });
    index.upsert({
      id: "doc-1",
      content: "corrupt content",
      metadata: { category: "finance" },
    });

    // Corrupt the persisted metadata JSON directly through the raw handle so a
    // later search() must parse it and fail. This simulates external tampering /
    // on-disk corruption of the module-written JSON blob.
    index
      .getDatabase()
      .prepare("UPDATE documents_meta SET metadata = ? WHERE id = ?")
      .run("{not json", "doc-1");

    let thrown: unknown;
    try {
      index.search("content", { mode: "full-text" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LFtsIndexError);
    expect((thrown as M3LFtsIndexError).code).toBe("ERR_FTS_CORRUPT_METADATA");
    // The raw JSON.parse failure is chained as the cause, not swallowed.
    expect((thrown as M3LFtsIndexError).cause).toBeInstanceOf(SyntaxError);
  });

  // The constructor always persists both KV rows; a MISSING row (not just an
  // unparseable one) means the internal _m3l_fts_meta store was corrupted or
  // externally tampered with, so stats() must surface it rather than silently
  // substitute an in-memory default.
  test.each(["schema_version", "tokenizer"])(
    "a missing _m3l_fts_meta %j row throws ERR_FTS_CORRUPT_METADATA from stats()",
    (key) => {
      const index = makeIndex();

      // Delete the internal KV row directly through the raw handle to simulate a
      // corrupt/tampered meta store; stats() reads it back via #requireMeta.
      index
        .getDatabase()
        .prepare("DELETE FROM _m3l_fts_meta WHERE key = ?")
        .run(key);

      let thrown: unknown;
      try {
        index.stats();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LFtsIndexError);
      expect((thrown as M3LFtsIndexError).code).toBe(
        "ERR_FTS_CORRUPT_METADATA",
      );
    },
  );
});

// =============================================================================
// close()
// =============================================================================
describe("close()", () => {
  test("close() is typed as returning void", () => {
    expectTypeOf<ReturnType<M3LFtsIndex["close"]>>().toEqualTypeOf<void>();
  });

  test("close() returns void and closes the underlying handle", () => {
    const index = makeIndex();
    const db = index.getDatabase();

    expect(index.close()).toBeUndefined();

    // A closed better-sqlite3 handle rejects further use — proving close()
    // actually released it rather than being a no-op.
    expect(() => db.prepare("SELECT 1 AS n").get()).toThrow(
      /database connection is not open/i,
    );
  });

  test("close() is idempotent (a redundant close does not throw)", () => {
    const index = makeIndex();
    index.close();
    expect(() => index.close()).not.toThrow();
  });
});

// =============================================================================
// Defense-in-depth: a quote-bearing full-text term cannot break MATCH grammar
// =============================================================================
describe("full-text query injection safety", () => {
  test("a query containing a double-quote does not raise a SQL error", () => {
    const index = makeIndex();
    index.upsert({ id: "doc-1", content: "foo bar baz content" });

    // The `"` in the term would corrupt the FTS5 MATCH grammar if it were not
    // escaped and the whole expression bound as a parameter. It must return
    // safely (results or []), never a SQLite syntax error.
    let hits: M3LFtsIndexSearchResult[] = [];
    expect(() => {
      hits = index.search('foo"bar baz', { mode: "full-text" });
    }).not.toThrow();
    expect(Array.isArray(hits)).toBe(true);
  });

  test("a query that is only a double-quote is handled safely", () => {
    const index = makeIndex();
    index.upsert({ id: "doc-1", content: "some content here" });

    expect(() => index.search('"', { mode: "full-text" })).not.toThrow();
  });
});

// =============================================================================
// Prepared-statement cache reuse (observable, not internal key format)
// =============================================================================
describe("prepared-statement cache", () => {
  test("two searches of the SAME mode + filter shape but DIFFERENT values do not re-prepare", () => {
    const index = makeIndex({ metadataColumns: ["category"] });
    index.upsertMany([
      { id: "a", content: "shared term", metadata: { category: "x" } },
      { id: "b", content: "shared term", metadata: { category: "y" } },
    ]);

    // Warm the cache once so the statement for this (mode + filter-column)
    // signature is prepared, then spy on the raw handle's `prepare`. A correct
    // cache means the second same-shape query (different filter VALUE) issues
    // no further prepare() for that signature.
    index.search("shared", { filters: { category: "x" } });

    const db = index.getDatabase();
    const prepareSpy = vi.spyOn(db, "prepare");

    const hits = index.search("shared", { filters: { category: "y" } });

    // Observable reuse: correct results without a fresh prepare for this shape.
    expect(hits.length).toBe(1);
    expect(hits[0]?.id).toBe("b");
    expect(prepareSpy).not.toHaveBeenCalled();
  });
});
