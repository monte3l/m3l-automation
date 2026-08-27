/**
 * Tests for src/store/meta-repository.ts — `M3LConsoleMetaRepository`
 * (X3 console persistence, PR B, ADR-0069, #551).
 *
 * `M3LConsoleMetaRepository` is a set of functions over the
 * {@link M3LStoreQueryExecutor} port, never a class holding a
 * `DatabaseSync` — so every test here builds its own executor directly over
 * a real `:memory:` `node:sqlite` database, the same way
 * `tests/store-open.test.ts` does, rather than importing `store/store.ts`
 * or `store/executor.ts` (this file's `perFile` v8 coverage must bind only
 * to `store/meta-repository.ts`, `store/migrations/registry.ts`, and
 * `store/types.ts`/`errors/console-error.ts` for types — never to a
 * sibling slice).
 *
 * `store/migrations/runner.ts` (the migration runner) now exists, landed by
 * a concurrent slice in this same PR — but this file still does not import
 * it: doing so would re-bind this file's `perFile` v8 coverage across the
 * `store/` slice split (see this header's own coverage note above). It runs
 * `CONSOLE_MIGRATIONS`' own DDL `statements` directly against a real
 * database (exactly what the runner does at open time) and hand-inserts the
 * `console_schema_migrations` audit rows the runner would otherwise write —
 * a faithful, real-database fixture that stays within this file's own
 * slice rather than reaching into the runner's.
 *
 * One exception to the "no sibling-slice import" rule: the
 * "runMetaOperation — an already-classified failure" `describe` block below
 * imports `openConsoleStore` from `store/store.ts`. `runMetaOperation`'s
 * `cause instanceof M3LConsoleError` guard has two arms — re-throw unchanged
 * (already classified) vs. classify-and-wrap (not yet classified) — and this
 * file's own raw, non-classifying executor (`createRawExecutor`, below) can
 * only ever exercise the SECOND arm: a closed `:memory:` database always
 * throws `node:sqlite`'s raw, untyped `ERR_INVALID_STATE`. The FIRST arm only
 * fires when the executor underneath has already classified the failure
 * itself — which is exactly what `store/executor.ts` (wired in by
 * `openConsoleStore`) does in production. Reaching that arm therefore
 * requires the real `openConsoleStore` → `store/executor.ts` path; see
 * `docs/adr/0069-console-embedded-persistence.md` for why `meta-repository.ts`
 * has no class/`DatabaseSync` of its own to fake this with. This is a
 * deliberate, narrow exception, not a precedent for importing `store.ts`
 * elsewhere in this file.
 */
import { DatabaseSync } from "node:sqlite";

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createConsoleMetaRepository } from "../src/store/meta-repository.js";
import type {
  M3LConsoleMetaRepository,
  M3LConsoleStoreIdentity,
  M3LMigrationHistoryEntry,
} from "../src/store/meta-repository.js";
import { CONSOLE_MIGRATIONS } from "../src/store/migrations/registry.js";
// See the file header comment: this single import is a deliberate, narrow
// exception to this file's "raw executor only" discipline — it is the only
// way to reach `runMetaOperation`'s already-classified-error guard arm.
import { openConsoleStore } from "../src/store/store.js";
import type { M3LMigration } from "../src/store/migrations/registry.js";
import type {
  M3LStoreParameters,
  M3LStoreQueryExecutor,
  M3LStoreReadOptions,
  M3LStoreRow,
} from "../src/store/types.js";

/**
 * The allow-listed context keys `store/failures.ts`'s `storeError` ever
 * forwards. Mirrored here (not imported — `store/failures.ts` is a sibling
 * slice) so this file can assert the leak-discipline contract without
 * re-binding coverage to it.
 */
const ALLOWED_STORE_ERROR_CONTEXT_KEYS: readonly string[] = [
  "location",
  "schemaVersion",
  "version",
  "name",
  "sqliteCode",
  "sqlitePrimaryCode",
];

/**
 * A minimal structural view of `node:sqlite`'s own `StatementSync`, typed
 * with `readonly unknown[]` rest parameters so this file's hand-rolled
 * executor can forward whatever {@link M3LStoreParameters} shape a caller
 * supplies without fighting `StatementSync`'s overloaded, non-`unknown`
 * parameter types. The single cast in {@link prepareRaw} is the one place
 * that bridges the two.
 */
interface RawStatementPort {
  all(...parameters: readonly unknown[]): Record<string, unknown>[];
  get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
  run(...parameters: readonly unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
}

function prepareRaw(database: DatabaseSync, sql: string): RawStatementPort {
  return database.prepare(sql);
}

/** Splits {@link M3LStoreParameters} into a statement's call arguments, exactly as `store/executor.ts` does. */
function toStatementArguments(
  parameters: M3LStoreParameters | undefined,
): readonly unknown[] {
  if (parameters === undefined) return [];
  return Array.isArray(parameters) ? parameters : [parameters];
}

/**
 * Builds a real {@link M3LStoreQueryExecutor} directly over a `node:sqlite`
 * `DatabaseSync` — no `store/executor.ts` import, so this file's coverage
 * stays bound to its own slice. A closed `database` naturally makes every
 * method below throw the real `ERR_INVALID_STATE` node:sqlite raises; no
 * fake is needed for that path.
 */
function createRawExecutor(database: DatabaseSync): M3LStoreQueryExecutor {
  return {
    all(
      sql: string,
      parameters?: M3LStoreParameters,
      _options?: M3LStoreReadOptions,
    ): readonly M3LStoreRow[] {
      const statement = prepareRaw(database, sql);
      const rows = statement.all(...toStatementArguments(parameters));
      return rows.map((row) => ({ ...row })) as readonly M3LStoreRow[];
    },
    get(
      sql: string,
      parameters?: M3LStoreParameters,
      _options?: M3LStoreReadOptions,
    ): M3LStoreRow | undefined {
      const statement = prepareRaw(database, sql);
      const row = statement.get(...toStatementArguments(parameters));
      return row === undefined ? undefined : ({ ...row } as M3LStoreRow);
    },
    run(sql: string, parameters?: M3LStoreParameters) {
      const statement = prepareRaw(database, sql);
      const result = statement.run(...toStatementArguments(parameters));
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      };
    },
    script(sql: string): void {
      database.exec(sql);
    },
  };
}

/** Applies every `CONSOLE_MIGRATIONS` DDL statement to a fresh `:memory:` database — the real registry, run directly rather than through `store/migrations/runner.ts` (which now exists), to keep this file's coverage bound to its own slice. */
function createMigratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const migration of CONSOLE_MIGRATIONS) {
    for (const statement of migration.statements) {
      database.exec(statement);
    }
  }
  return database;
}

/** Hand-inserts one `console_schema_migrations` audit row — what `store/migrations/runner.ts` writes at open time. */
function insertHistoryRow(
  database: DatabaseSync,
  migration: M3LMigration,
  appliedAtMs: number,
  nodeVersion: string,
): void {
  database
    .prepare(
      "INSERT INTO console_schema_migrations (version, name, applied_at_ms, node_version, sql_digest) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      migration.version,
      migration.name,
      appliedAtMs,
      nodeVersion,
      `digest-${String(migration.version)}`,
    );
}

/**
 * Seeds the full `console_schema_migrations` audit trail, one row per
 * `CONSOLE_MIGRATIONS` entry, inserted in **reverse** registry order — so a
 * `history()` that merely returns rows in *insertion* order (rather than
 * ordering explicitly) cannot coincidentally pass the oldest-first
 * assertion by matching insertion order to version order.
 */
function seedHistoryReversed(database: DatabaseSync): void {
  const baseMs = 1_700_000_000_000;
  const reversed = [...CONSOLE_MIGRATIONS].reverse();
  reversed.forEach((migration, index) => {
    // Deliberately does NOT correlate applied_at_ms with insertion order
    // either — index 0 here is the highest version, and gets the smallest
    // offset, so neither "insertion order" nor "applied_at_ms ascending
    // matches insertion order" can be mistaken for "ordered by version".
    insertHistoryRow(
      database,
      migration,
      baseMs + (reversed.length - index) * 1000,
      process.version,
    );
  });
}

function createRepository(database: DatabaseSync): M3LConsoleMetaRepository {
  return createConsoleMetaRepository(createRawExecutor(database));
}

/** Runs `run`, capturing whatever it throws synchronously as a single `unknown` value. */
function captureFailure(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

function readMetaValue(database: DatabaseSync, key: string): unknown {
  const row = prepareRaw(
    database,
    "SELECT value FROM console_meta WHERE key = ?",
  ).get(key);
  return row?.["value"];
}

function countMetaRows(database: DatabaseSync): number {
  const row = prepareRaw(
    database,
    "SELECT COUNT(*) AS count FROM console_meta",
  ).get();
  return Number(row?.["count"] ?? 0);
}

/** Asserts `context` carries only allow-listed keys — never `sql`, bound parameters, or similar leakage. */
function assertSafeErrorContext(context: Record<string, unknown>): void {
  const keys = Object.keys(context);
  expect(keys).not.toContain("sql");
  expect(keys).not.toContain("parameters");
  expect(keys).not.toContain("expandedSQL");
  expect(keys).not.toContain("boundValues");
  for (const key of keys) {
    expect(ALLOWED_STORE_ERROR_CONTEXT_KEYS).toContain(key);
  }
}

describe("createConsoleMetaRepository — describe()", () => {
  test("mints a non-empty store.id and a plausible epoch-millisecond store.created.at.ms on a fresh store", () => {
    const database = createMigratedDatabase();
    seedHistoryReversed(database);
    const repository = createRepository(database);

    const identity = repository.describe();

    expect(typeof identity.id).toBe("string");
    expect(identity.id.length).toBeGreaterThan(0);
    expect(Number.isInteger(identity.createdAtMs)).toBe(true);
    // "plausible epoch ms": after 2020-01-01 and not further in the future
    // than "now" plus a minute of slack for clock skew.
    expect(identity.createdAtMs).toBeGreaterThan(1_577_836_800_000);
    expect(identity.createdAtMs).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  test("persists the minted identity under the documented keys in console_meta", () => {
    const database = createMigratedDatabase();
    seedHistoryReversed(database);
    const repository = createRepository(database);

    const identity = repository.describe();

    expect(readMetaValue(database, "store.id")).toBe(identity.id);
    expect(String(readMetaValue(database, "store.created.at.ms"))).toBe(
      String(identity.createdAtMs),
    );
  });

  test("reuses the minted identity across a second repository instance over the same database, leaving the persisted row unchanged", () => {
    const database = createMigratedDatabase();
    seedHistoryReversed(database);

    const first = createRepository(database);
    const minted = first.describe();
    const persistedIdAfterFirst = readMetaValue(database, "store.id");
    const persistedCreatedAtAfterFirst = readMetaValue(
      database,
      "store.created.at.ms",
    );

    // A fresh repository instance over the SAME database — a per-instance
    // memo on `first` would pass a weaker test that only called `describe()`
    // twice on one instance; re-minting on every "boot" (a new instance)
    // would still pass THAT weaker test while failing this one.
    const second = createRepository(database);
    const reused = second.describe();

    expect(reused.id).toBe(minted.id);
    expect(reused.createdAtMs).toBe(minted.createdAtMs);
    expect(readMetaValue(database, "store.id")).toBe(persistedIdAfterFirst);
    expect(readMetaValue(database, "store.created.at.ms")).toBe(
      persistedCreatedAtAfterFirst,
    );
    // Reusing must never grow the table — one row per key, not a new row
    // per boot.
    expect(countMetaRows(database)).toBe(2);
  });

  test("mints a different id for a different store", () => {
    const databaseA = createMigratedDatabase();
    seedHistoryReversed(databaseA);
    const databaseB = createMigratedDatabase();
    seedHistoryReversed(databaseB);

    const identityA = createRepository(databaseA).describe();
    const identityB = createRepository(databaseB).describe();

    expect(identityA.id).not.toBe(identityB.id);
  });
});

describe("createConsoleMetaRepository — describe() after an interrupted mint", () => {
  // `meta-repository.ts:172-173` issues `insertIfAbsent(store.id, ...)` then
  // `insertIfAbsent(store.created.at.ms, ...)` as two separate, un-transacted
  // statements. A crash (or SQLITE_BUSY) between them persists an id with no
  // creation timestamp; the next boot's `describeStore` then mints
  // `store.created.at.ms` from a fresh `Date.now()`, permanently reporting a
  // creation time that is NOT when `store.id` was actually minted — breaking
  // the "minted once and reused forever" property documented at
  // `meta-repository.ts:52`.
  //
  // This test pins "detect and surface" as the required fix, not "invent a
  // plausible-looking timestamp": once `store.created.at.ms` is genuinely
  // lost, no value this repository could compute is the real mint time, so
  // manufacturing one is worse than a loud failure — the same philosophy
  // `store.ts`'s `readSchemaVersion` already applies (refusing to collapse
  // an unreadable value to a falsely-safe `0`) and this repository's own
  // `describeStore` already applies to its own "impossible" branch just
  // below (throwing rather than fabricating an identity). An "atomic write"
  // fix (wrapping both inserts in one statement/transaction) is also a
  // legitimate way to prevent the partial state from ever being observed,
  // but it does not by itself say what `describe()` should do if it EVER
  // encounters this partial state (e.g. from data migrated in some other
  // way) — so this test's expectation is the one the implementer should
  // match: surface a loud failure here.
  test("throws rather than inventing a later store.created.at.ms when only store.id was ever persisted", () => {
    const database = createMigratedDatabase();
    seedHistoryReversed(database);
    const repository = createRepository(database);

    // Simulate the interrupted mint directly: only `store.id` was ever
    // written, `store.created.at.ms` is entirely absent.
    prepareRaw(
      database,
      "INSERT INTO console_meta (key, value) VALUES (?, ?)",
    ).run("store.id", "pre-existing-id");

    const thrown = captureFailure(() => repository.describe());

    expect(thrown).toBeInstanceOf(M3LConsoleError);
  });
});

describe("createConsoleMetaRepository — a non-numeric store.created.at.ms", () => {
  // `meta-repository.ts:189`'s `Number(createdAtMsText)` is unvalidated, so
  // a non-numeric `console_meta` value silently produces `createdAtMs: NaN`
  // — unlike the adjacent missing-row guard a few lines above, which throws
  // rather than returning a fabricated identity.
  test("describe() throws rather than returning createdAtMs: NaN", () => {
    const database = createMigratedDatabase();
    seedHistoryReversed(database);
    const repository = createRepository(database);

    prepareRaw(
      database,
      "INSERT INTO console_meta (key, value) VALUES (?, ?)",
    ).run("store.id", "pre-existing-id");
    prepareRaw(
      database,
      "INSERT INTO console_meta (key, value) VALUES (?, ?)",
    ).run("store.created.at.ms", "not-a-number");

    const thrown = captureFailure(() => repository.describe());

    expect(thrown).toBeInstanceOf(M3LConsoleError);
  });
});

describe("createConsoleMetaRepository — history()", () => {
  test("returns one entry per applied migration, oldest first", () => {
    const database = createMigratedDatabase();
    seedHistoryReversed(database);
    const repository = createRepository(database);

    const history = repository.history();

    expect(history).toHaveLength(CONSOLE_MIGRATIONS.length);
    history.forEach((entry: M3LMigrationHistoryEntry, index: number): void => {
      if (index === 0) return;
      const previous = history[index - 1];
      if (previous === undefined) {
        throw new Error("expected a previous history entry");
      }
      expect(previous.version).toBeLessThan(entry.version);
    });
  });

  test("each entry exposes its version, name, and the recorded node version", () => {
    const database = createMigratedDatabase();
    seedHistoryReversed(database);
    const repository = createRepository(database);

    const history = repository.history();
    const [firstEntry, secondEntry] = history;
    if (firstEntry === undefined || secondEntry === undefined) {
      throw new Error("expected two history entries");
    }

    expect(firstEntry.version).toBe(1);
    expect(firstEntry.name).toBe("create_console_schema_migrations");
    expect(firstEntry.nodeVersion).toBe(process.version);

    expect(secondEntry.version).toBe(2);
    expect(secondEntry.name).toBe("create_console_meta");
    expect(secondEntry.nodeVersion).toBe(process.version);
  });

  test("returns exactly the two rows for a store migrated to v2, unaffected by console_meta's own rows", () => {
    const database = createMigratedDatabase();
    seedHistoryReversed(database);
    const repository = createRepository(database);

    // describe() writes two rows into console_meta — a history() that ever
    // reads the wrong table (or joins the two) would inflate this count.
    repository.describe();

    const history = repository.history();

    expect(history).toHaveLength(2);
  });
});

describe("createConsoleMetaRepository — a closed database", () => {
  test("describe() surfaces ERR_CONSOLE_STORE_CLOSED (via ERR_INVALID_STATE), with no SQL or bound values in context", () => {
    const database = createMigratedDatabase();
    seedHistoryReversed(database);
    const repository = createRepository(database);
    database.close();

    let thrown: unknown;
    try {
      repository.describe();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_CLOSED");
    assertSafeErrorContext((thrown as M3LConsoleError).context);
  });

  test("history() surfaces ERR_CONSOLE_STORE_CLOSED (via ERR_INVALID_STATE), with no SQL or bound values in context", () => {
    const database = createMigratedDatabase();
    seedHistoryReversed(database);
    const repository = createRepository(database);
    database.close();

    let thrown: unknown;
    try {
      repository.history();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_CLOSED");
    assertSafeErrorContext((thrown as M3LConsoleError).context);
  });
});

describe("runMetaOperation — an already-classified failure passes through unchanged", () => {
  // Companion to "createConsoleMetaRepository — a closed database" above.
  // That block's raw fake executor can only ever throw node:sqlite's raw
  // `ERR_INVALID_STATE` — an UNCLASSIFIED value — which exercises
  // `runMetaOperation`'s `false` arm (classify-and-wrap). The real
  // `openConsoleStore` wires `createConsoleMetaRepository` over
  // `store/executor.ts`'s executor, which already classifies every failure
  // into an `M3LConsoleError` before `meta-repository.ts` ever sees it —
  // this block reaches THAT path, exercising the `true` arm (re-throw an
  // already-typed `M3LConsoleError` unchanged). The `true` arm is the
  // common, production case; the `false` arm above is the one that needs a
  // deliberately non-classifying executor to reach at all. Keep both: they
  // are not redundant, they cover opposite arms of the same guard.
  //
  // The discriminator that matters: a downgraded/re-classified error would
  // read `ERR_CONSOLE_STORE_QUERY_FAILED` (classifyStoreFailure has no
  // branch for an object whose own `code` is already
  // `"ERR_CONSOLE_STORE_CLOSED"`, so it falls through to `"unknown"`, which
  // `store/failures.ts` maps to `_QUERY_FAILED` for the `"query"` phase).
  // Asserting `ERR_CONSOLE_STORE_CLOSED` — not `_QUERY_FAILED` — is what
  // proves the guard actually fired instead of silently re-wrapping.

  test("describe() on a real, already-closed store surfaces ERR_CONSOLE_STORE_CLOSED, not ERR_CONSOLE_STORE_QUERY_FAILED", () => {
    const store = openConsoleStore({ location: ":memory:" });
    store.close();

    let thrown: unknown;
    try {
      store.meta.describe();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_CLOSED");
  });

  test("history() on a real, already-closed store surfaces ERR_CONSOLE_STORE_CLOSED, not ERR_CONSOLE_STORE_QUERY_FAILED", () => {
    const store = openConsoleStore({ location: ":memory:" });
    store.close();

    let thrown: unknown;
    try {
      store.meta.history();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_STORE_CLOSED");
  });
});

describe("createConsoleMetaRepository — type contract", () => {
  test("is a function over M3LStoreQueryExecutor, never a class holding a DatabaseSync", () => {
    expectTypeOf(createConsoleMetaRepository)
      .parameter(0)
      .toMatchTypeOf<M3LStoreQueryExecutor>();
    expectTypeOf(
      createConsoleMetaRepository,
    ).returns.toMatchTypeOf<M3LConsoleMetaRepository>();
  });

  test("M3LConsoleMetaRepository exposes exactly describe() and history()", () => {
    expectTypeOf<M3LConsoleMetaRepository>().toHaveProperty("describe");
    expectTypeOf<M3LConsoleMetaRepository>().toHaveProperty("history");
    expectTypeOf<
      M3LConsoleMetaRepository["describe"]
    >().returns.toEqualTypeOf<M3LConsoleStoreIdentity>();
    expectTypeOf<M3LConsoleMetaRepository["history"]>().returns.toEqualTypeOf<
      readonly M3LMigrationHistoryEntry[]
    >();
  });
});
