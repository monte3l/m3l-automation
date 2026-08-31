/**
 * Tests for `src/store/audit-repository.ts` — `M3LConsoleAuditRepository`
 * (X7 human-action audit index, slice 4b).
 *
 * `console_human_actions` (`store/migrations/registry.ts`'s v6) is an INDEX
 * over the JSONL audit trail — the queryable dimensions only, never
 * `parameterNames`/`parameterRefs`/`detail`, which live in the stream. This
 * repository does its own truncate-and-reinsert rebuild via `deleteAll` +
 * `insertAll`; the rebuild path itself (reading the JSONL stream) is NOT in
 * this contract.
 *
 * Mirrors `tests/store-runs-repository.test.ts`'s own idiom: a repository is
 * a plain FUNCTION over the injected `M3LStoreQueryExecutor` port, never a
 * class holding a `DatabaseSync`. Every test here builds its own executor
 * directly over a real `:memory:` `node:sqlite` database and applies
 * `CONSOLE_MIGRATIONS`' own DDL `statements` directly (never
 * `store/store.ts`/`store/executor.ts`), so this file's `perFile` v8
 * coverage stays bound to `store/audit-repository.ts`,
 * `store/migrations/registry.ts`, and `store/types.ts`/
 * `errors/console-error.ts` for types — never a sibling slice's
 * implementation.
 *
 * `src/store/**` sits in the `store` eslint zone asserted at exactly
 * `["store", "errors"]` by `bin/check-eslint-zones.mjs` — so
 * `audit-repository.ts` declares its own `M3LHumanActionIndex*` types
 * locally rather than importing them from `src/audit/`, exactly as
 * `runs-repository.ts` declares `M3LRunInsert`/`M3LRunRecord` without
 * importing from `src/runs/`. This file imports those types from
 * `audit-repository.ts` itself, never from `src/audit/`.
 *
 * AMBIGUITY FLAGGED FOR THE HUB: the contract does not state whether
 * `M3LHumanActionIndexQuery.fromMs`/`toMs` are inclusive or exclusive range
 * bounds. This file assumes an inclusive `[fromMs, toMs]` range (the more
 * common convention, and symmetric with `limit` being an explicit,
 * non-defaulted bound) — see the "fromMs/toMs are both inclusive" tests
 * below. If the real contract intends exclusive bounds, those two tests
 * (and only those two) need to flip.
 */
import { DatabaseSync } from "node:sqlite";

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { CONSOLE_MIGRATIONS } from "../src/store/migrations/registry.js";
import { createConsoleAuditRepository } from "../src/store/audit-repository.js";
import type {
  M3LConsoleAuditRepository,
  M3LHumanActionIndexInput,
  M3LHumanActionIndexKind,
  M3LHumanActionIndexOutcome,
  M3LHumanActionIndexPosture,
  M3LHumanActionIndexQuery,
  M3LHumanActionIndexRecord,
  M3LHumanActionIndexTargetKind,
} from "../src/store/audit-repository.js";
import type {
  M3LStoreParameters,
  M3LStoreQueryExecutor,
  M3LStoreReadOptions,
  M3LStoreRow,
} from "../src/store/types.js";
// T1 — a TYPE-ONLY import of audit/record.ts's own union types, used solely
// to gate drift against audit-repository.ts's deliberate duplicate
// declarations (see this file's own header comment, and audit-repository.ts's
// `@packageDocumentation`, for why the duplication exists rather than an
// import). `import type` is fully erased at build time: it adds no runtime
// edge across the `store`/`audit` eslint zone boundary (nothing here
// restricts a TEST importing from `src/audit/`, only `src/store/**`
// importing it), and it cannot perturb this file's own per-file v8 coverage
// attribution to `store/audit-repository.ts` et al.
import type {
  M3LHumanActionKind,
  M3LHumanActionOutcome,
  M3LHumanActionPosture,
  M3LHumanActionTarget,
} from "../src/audit/record.js";

// ---------------------------------------------------------------------------
// Raw executor + migrated-database fixtures — mirrors
// tests/store-runs-repository.test.ts's own helpers, duplicated locally so
// this file's coverage stays bound to its own slice.
// ---------------------------------------------------------------------------

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

function toStatementArguments(
  parameters: M3LStoreParameters | undefined,
): readonly unknown[] {
  if (parameters === undefined) return [];
  return Array.isArray(parameters) ? parameters : [parameters];
}

/** Builds a real {@link M3LStoreQueryExecutor} directly over a `node:sqlite` `DatabaseSync`. */
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

/** Applies every `CONSOLE_MIGRATIONS` DDL statement to a fresh `:memory:` database. */
function createMigratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const migration of CONSOLE_MIGRATIONS) {
    for (const statement of migration.statements) {
      database.exec(statement);
    }
  }
  return database;
}

function createRepository(database: DatabaseSync): M3LConsoleAuditRepository {
  return createConsoleAuditRepository(createRawExecutor(database));
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

/** Reads one raw `console_human_actions` row by `id`, exactly as persisted. */
function readRawRow(
  database: DatabaseSync,
  id: number,
): Record<string, unknown> | undefined {
  const row = prepareRaw(
    database,
    "SELECT * FROM console_human_actions WHERE id = ?",
  ).get(id);
  return row === undefined ? undefined : { ...row };
}

/**
 * A minimal stub {@link M3LStoreQueryExecutor} for probing failure paths
 * that a real `:memory:` database cannot easily produce (a projection
 * failure — a STRICT table's own CHECK constraints make an on-disk bogus
 * `posture` value unreachable, so it must be injected here instead) or that
 * would otherwise require asserting on `node:sqlite` internals. Any method
 * not overridden throws, so an unexpected call surfaces loudly rather than
 * silently returning a wrong default.
 */
function createStubExecutor(
  overrides: Partial<M3LStoreQueryExecutor>,
): M3LStoreQueryExecutor {
  const unimplemented = (method: string) => () => {
    throw new Error(`stub executor: ${method} not implemented in this test`);
  };
  return {
    all: overrides.all ?? unimplemented("all"),
    get: overrides.get ?? unimplemented("get"),
    run: overrides.run ?? unimplemented("run"),
    script: overrides.script ?? unimplemented("script"),
  };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

// F1(a) turns M3LHumanActionIndexInput into a discriminated union on
// `targetKind`, so a single `Partial<M3LHumanActionIndexInput>` overrides bag
// (as this file used pre-fix) can no longer describe "any field, on either
// arm" — that permissiveness is exactly the representable-illegal-pairing
// hazard F1 closes. `insertInput`/`nonScriptInsertInput` below each build one
// arm outright and only accept overrides to the fields common to BOTH arms
// (never `targetKind`/`scriptName`, and `targetId` is common in name only —
// each function fixes its own arm's shape around it), so every override call
// site in this file keeps compiling unchanged while the two illegal-pairing
// combinations become reachable only through T4's explicit, commented cast.
type HumanActionIndexCommonOverrides = Partial<
  Pick<
    M3LHumanActionIndexInput,
    | "atMs"
    | "operator"
    | "operatorEmailDeclared"
    | "correlationId"
    | "action"
    | "posture"
    | "outcome"
  >
> & { readonly targetId?: string };

/** A fully valid `script`-target input — the CHECK pairing's "script" arm: `scriptName` is required. */
function insertInput(
  overrides: HumanActionIndexCommonOverrides = {},
): M3LHumanActionIndexInput {
  return {
    atMs: 1_000,
    operator: "alice",
    operatorEmailDeclared: true,
    correlationId: "corr-1",
    action: "run.launch",
    targetKind: "script",
    targetId: "scripts/example",
    scriptName: "scripts/example",
    posture: "auto",
    outcome: "allowed",
    ...overrides,
  };
}

/** A fully valid non-script-target input — `scriptName` is `undefined`, matching the CHECK pairing's other arm. */
function nonScriptInsertInput(
  overrides: HumanActionIndexCommonOverrides = {},
): M3LHumanActionIndexInput {
  return {
    atMs: 1_000,
    operator: "alice",
    operatorEmailDeclared: true,
    correlationId: "corr-1",
    action: "run.cancel",
    targetKind: "run",
    targetId: "run-1",
    scriptName: undefined,
    posture: "confirmed",
    outcome: "allowed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// insert + list — round trip
// ---------------------------------------------------------------------------

describe("createConsoleAuditRepository — insert + list round trip", () => {
  test("list() after insert() returns the record with every field preserved, including operatorEmailDeclared true and a defined scriptName", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.insert(insertInput());
    const [record] = repository.list({ limit: 10 });

    expect(record).toEqual({
      id: expect.any(Number) as number,
      atMs: 1_000,
      operator: "alice",
      operatorEmailDeclared: true,
      correlationId: "corr-1",
      action: "run.launch",
      targetKind: "script",
      targetId: "scripts/example",
      scriptName: "scripts/example",
      posture: "auto",
      outcome: "allowed",
    });
  });

  test("a non-script target's scriptName round-trips as undefined, stored as SQL NULL — operatorEmailDeclared false round-trips as boolean false", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.insert(
      nonScriptInsertInput({
        operatorEmailDeclared: false,
        correlationId: "corr-non-script",
      }),
    );
    const [record] = repository.list({ limit: 10 });

    expect(record?.scriptName).toBeUndefined();
    expect(record?.operatorEmailDeclared).toBe(false);
    const raw = readRawRow(database, record?.id ?? -1);
    expect(raw?.["script_name"]).toBeNull();
    expect(raw?.["operator_email_declared"]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// list — ordering
// ---------------------------------------------------------------------------

describe("createConsoleAuditRepository — list() ordering", () => {
  test("orders by at_ms DESC — a later-timestamped row comes first regardless of insert order", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.insert(insertInput({ atMs: 1_000, correlationId: "corr-a" }));
    repository.insert(insertInput({ atMs: 2_000, correlationId: "corr-b" }));

    const records = repository.list({ limit: 10 });

    expect(records.map((record) => record.correlationId)).toEqual([
      "corr-b",
      "corr-a",
    ]);
  });

  test("breaks a tie on equal at_ms by id DESC — most recently inserted first", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    repository.insert(
      insertInput({ atMs: 5_000, correlationId: "corr-first" }),
    );
    repository.insert(
      insertInput({ atMs: 5_000, correlationId: "corr-second" }),
    );

    const records = repository.list({ limit: 10 });

    expect(records.map((record) => record.correlationId)).toEqual([
      "corr-second",
      "corr-first",
    ]);
    expect(records[0]?.id).toBeGreaterThan(records[1]?.id ?? Number.NaN);
  });
});

// ---------------------------------------------------------------------------
// list — filters
// ---------------------------------------------------------------------------

describe("createConsoleAuditRepository — list() filters", () => {
  function seedFilterFixture(repository: M3LConsoleAuditRepository): void {
    repository.insert(
      insertInput({
        atMs: 1_000,
        operator: "alice",
        correlationId: "corr-alice-early",
      }),
    );
    repository.insert(
      insertInput({
        atMs: 2_000,
        operator: "alice",
        correlationId: "corr-alice-late",
      }),
    );
    repository.insert(
      insertInput({
        atMs: 3_000,
        operator: "bob",
        correlationId: "corr-bob",
      }),
    );
  }

  test("correlationId filters to exactly the matching row", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedFilterFixture(repository);

    const records = repository.list({
      correlationId: "corr-bob",
      limit: 10,
    });

    expect(records.map((record) => record.correlationId)).toEqual(["corr-bob"]);
  });

  test("operator filters to exactly that operator's rows, most recent first", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedFilterFixture(repository);

    const records = repository.list({ operator: "alice", limit: 10 });

    expect(records.map((record) => record.correlationId)).toEqual([
      "corr-alice-late",
      "corr-alice-early",
    ]);
  });

  test("fromMs and toMs are both inclusive — a row exactly at either bound is included", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedFilterFixture(repository);

    const records = repository.list({ fromMs: 1_000, toMs: 2_000, limit: 10 });

    expect(records.map((record) => record.correlationId).sort()).toEqual(
      ["corr-alice-early", "corr-alice-late"].sort(),
    );
  });

  test("operator and fromMs/toMs compose with AND, narrowing further than either alone", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedFilterFixture(repository);

    const records = repository.list({
      operator: "alice",
      fromMs: 1_500,
      toMs: 3_000,
      limit: 10,
    });

    expect(records.map((record) => record.correlationId)).toEqual([
      "corr-alice-late",
    ]);
  });

  test("limit truncates the result set", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    seedFilterFixture(repository);

    const records = repository.list({ limit: 2 });

    expect(records).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// deleteAll / count / insertAll
// ---------------------------------------------------------------------------

describe("createConsoleAuditRepository — deleteAll, count, insertAll", () => {
  test("deleteAll returns the number of rows deleted, and count() is 0 afterward", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);
    repository.insert(insertInput({ correlationId: "corr-1" }));
    repository.insert(insertInput({ correlationId: "corr-2" }));

    const deleted = repository.deleteAll();

    expect(deleted).toBe(2);
    expect(repository.count()).toBe(0);
  });

  test("count() reflects the current row total", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    expect(repository.count()).toBe(0);
    repository.insert(insertInput());
    expect(repository.count()).toBe(1);
  });

  test("insertAll returns the number of rows inserted", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const inserted = repository.insertAll([
      insertInput({ correlationId: "corr-1" }),
      insertInput({ correlationId: "corr-2" }),
      insertInput({ correlationId: "corr-3" }),
    ]);

    expect(inserted).toBe(3);
    expect(repository.count()).toBe(3);
  });

  // insertAll's own TSDoc says it does NOT open a transaction — the caller
  // supplies one when it wants atomicity. Observably, that means a bad row
  // partway through the batch leaves the earlier, already-inserted rows in
  // place rather than rolling them back — the opposite of what an implicit
  // transaction would do. This is the only way to observe "no transaction"
  // from outside the repository; asserting the absence of a BEGIN/COMMIT
  // call is not possible against this file's raw executor.
  test("a bad row partway through insertAll leaves the earlier rows persisted — insertAll opens no implicit transaction", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.insertAll([
        insertInput({ correlationId: "corr-good-1" }),
        insertInput({ atMs: 1.5, correlationId: "corr-bad" }),
        insertInput({ correlationId: "corr-good-2" }),
      ]),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect(repository.count()).toBe(1);
    expect(repository.list({ limit: 10 })[0]?.correlationId).toBe(
      "corr-good-1",
    );
  });
});

// ---------------------------------------------------------------------------
// insert / insertAll — atMs validation
// ---------------------------------------------------------------------------

describe("createConsoleAuditRepository — atMs validation", () => {
  const invalidAtMsValues: readonly [string, number][] = [
    ["a non-integer", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ];

  test.each(invalidAtMsValues)(
    "insert() rejects %s atMs with ERR_CONSOLE_BAD_REQUEST before binding",
    (_label, atMs) => {
      const database = createMigratedDatabase();
      const repository = createRepository(database);

      const thrown = captureFailure(() =>
        repository.insert(insertInput({ atMs })),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(repository.count()).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// list — limit / fromMs / toMs validation
// ---------------------------------------------------------------------------

describe("createConsoleAuditRepository — list() query validation", () => {
  test("rejects a negative limit with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() => repository.list({ limit: -1 }));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("rejects a non-integer limit with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() => repository.list({ limit: 1.5 }));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("rejects a non-safe-integer fromMs with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.list({ fromMs: Number.POSITIVE_INFINITY, limit: 10 }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("rejects a non-safe-integer toMs with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.list({ toMs: 1.5, limit: 10 }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("rejects fromMs > toMs with ERR_CONSOLE_BAD_REQUEST", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.list({ fromMs: 2_000, toMs: 1_000, limit: 10 }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// list — row projection failure (an unrecognized column value)
// ---------------------------------------------------------------------------

describe("createConsoleAuditRepository — list() row projection failure", () => {
  // A STRICT table's own CHECK constraints make an on-disk bogus `posture`
  // value unreachable through a real database — this is exactly why the
  // contract calls for a stubbed executor here rather than raw SQL: the
  // thing under test is the repository's OWN defensive projection code
  // (`toRequiredString`-style narrowing), not the database.
  test("an unrecognized posture value in a returned row throws ERR_CONSOLE_STORE_QUERY_FAILED", () => {
    const bogusRow: M3LStoreRow = {
      id: 1,
      at_ms: 1_000,
      operator: "alice",
      operator_email_declared: 1,
      correlation_id: "corr-1",
      action: "run.launch",
      target_kind: "script",
      target_id: "scripts/example",
      script_name: "scripts/example",
      posture: "bogus-posture",
      outcome: "allowed",
    };
    const executor = createStubExecutor({ all: () => [bogusRow] });
    const repository = createConsoleAuditRepository(executor);

    const thrown = captureFailure(() => repository.list({ limit: 10 }));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
  });
});

// ---------------------------------------------------------------------------
// failure classification — an unclassified executor failure is wrapped, an
// already-typed M3LConsoleError passes through unchanged
// ---------------------------------------------------------------------------

describe("createConsoleAuditRepository — failure classification", () => {
  test("a generic executor failure is wrapped as ERR_CONSOLE_STORE_QUERY_FAILED with the original error chained as cause", () => {
    const originalError = new Error("simulated executor failure");
    const executor = createStubExecutor({
      run: () => {
        throw originalError;
      },
    });
    const repository = createConsoleAuditRepository(executor);

    const thrown = captureFailure(() => repository.insert(insertInput()));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
    expect((thrown as M3LConsoleError).cause).toBe(originalError);
  });

  test("an M3LConsoleError thrown by the executor is re-thrown unchanged, not double-wrapped", () => {
    const originalError = new M3LConsoleError(
      "ERR_CONSOLE_STORE_BUSY",
      "simulated busy failure",
    );
    const executor = createStubExecutor({
      run: () => {
        throw originalError;
      },
    });
    const repository = createConsoleAuditRepository(executor);

    const thrown = captureFailure(() => repository.insert(insertInput()));

    expect(thrown).toBe(originalError);
  });
});

// ---------------------------------------------------------------------------
// T4 — F1's runtime target-pairing guard, and F5's non-empty-string guards.
// Each case must classify as ERR_CONSOLE_BAD_REQUEST, specifically NOT
// ERR_CONSOLE_STORE_QUERY_FAILED — that classification, not merely "it
// threw", is the entire point of both fixes: pre-fix, the same illegal
// pairing reaches the database's own CHECK constraint and comes back
// misclassified as a 500-shaped store failure (F1's whole motivation).
// ---------------------------------------------------------------------------

describe("createConsoleAuditRepository — F1 target-pairing guard (requireValidTarget)", () => {
  test("insert() rejects a 'script' target with no scriptName as ERR_CONSOLE_BAD_REQUEST, not ERR_CONSOLE_STORE_QUERY_FAILED", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    // F1(a) makes `{ targetKind: "script", scriptName: undefined }`
    // unrepresentable on the typed path — the discriminated union requires
    // `scriptName: string` on that arm. The double cast below simulates the
    // cast-boundary caller `requireValidTarget` (F1(b)) exists to guard:
    // untyped bytes reaching `insert` past the type system, e.g. a later
    // slice's JSONL-rebuild path.
    const illegalInput = {
      ...insertInput(),
      scriptName: undefined,
    } as unknown as M3LHumanActionIndexInput;

    const thrown = captureFailure(() => repository.insert(illegalInput));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).code).not.toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
    expect(repository.count()).toBe(0);
  });

  test("insert() rejects a non-'script' target carrying scriptName as ERR_CONSOLE_BAD_REQUEST, not ERR_CONSOLE_STORE_QUERY_FAILED", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    // Same cast-boundary simulation as above, the other illegal direction:
    // `targetKind: "run"` paired with a defined `scriptName`.
    const illegalInput = {
      ...nonScriptInsertInput(),
      scriptName: "scripts/example",
    } as unknown as M3LHumanActionIndexInput;

    const thrown = captureFailure(() => repository.insert(illegalInput));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).code).not.toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
    expect(repository.count()).toBe(0);
  });
});

describe("createConsoleAuditRepository — F5 non-empty-string guards (requireNonEmptyString)", () => {
  // An operator/correlationId/targetId of "" satisfies `TEXT NOT NULL`, so
  // without this guard the row inserts successfully and becomes permanently
  // un-attributable / un-queryable by the very index the empty value lives
  // in. Each case is checked against ERR_CONSOLE_STORE_QUERY_FAILED too, for
  // the same reason as the target-pairing guard above: a caller fault must
  // never surface as a store failure.
  test("insert() rejects an empty-string operator as ERR_CONSOLE_BAD_REQUEST, not ERR_CONSOLE_STORE_QUERY_FAILED", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.insert(insertInput({ operator: "" })),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).code).not.toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
    expect(repository.count()).toBe(0);
  });

  test("insert() rejects an empty-string correlationId as ERR_CONSOLE_BAD_REQUEST, not ERR_CONSOLE_STORE_QUERY_FAILED", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.insert(insertInput({ correlationId: "" })),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).code).not.toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
    expect(repository.count()).toBe(0);
  });

  test("insert() rejects an empty-string targetId as ERR_CONSOLE_BAD_REQUEST, not ERR_CONSOLE_STORE_QUERY_FAILED", () => {
    const database = createMigratedDatabase();
    const repository = createRepository(database);

    const thrown = captureFailure(() =>
      repository.insert(insertInput({ targetId: "" })),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).code).not.toBe(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
    );
    expect(repository.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("type-level contract", () => {
  // T2 — F4 drops `M3LHumanActionIndexRecord extends M3LHumanActionIndexInput`
  // (an interface cannot extend F1's discriminated-union Input). Record stays
  // flat (`scriptName: string | undefined` for every targetKind, per its own
  // TSDoc), so it can no longer satisfy either arm of Input's union — its
  // `targetKind` is the whole M3LHumanActionIndexTargetKind union, not
  // narrowed to "script" or its Exclude complement, and satisfying a union
  // member requires narrowing to exactly one. Asserted with `.not.toExtend`
  // rather than the deprecated, one-directional `toMatchTypeOf` this test
  // used pre-fix: the concrete hazard removed is
  // `repository.insertAll(repository.list(q))` silently compiling and
  // re-inserting every row with a fresh rowid — no legitimate caller
  // round-trips read into write. A future re-coupling that makes Record
  // assignable to Input again fails this assertion.
  test("M3LHumanActionIndexRecord is NOT assignable to M3LHumanActionIndexInput (F4) — a numeric id is still present", () => {
    expectTypeOf<M3LHumanActionIndexRecord>().not.toExtend<M3LHumanActionIndexInput>();
    expectTypeOf<M3LHumanActionIndexRecord["id"]>().toEqualTypeOf<number>();
  });

  test("scriptName is string | undefined — never null — on both the input and query shapes", () => {
    expectTypeOf<M3LHumanActionIndexInput["scriptName"]>().toEqualTypeOf<
      string | undefined
    >();
  });

  test("M3LHumanActionIndexQuery.limit is a required number; every filter is optional", () => {
    expectTypeOf<M3LHumanActionIndexQuery["limit"]>().toEqualTypeOf<number>();
    expectTypeOf<M3LHumanActionIndexQuery["correlationId"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<M3LHumanActionIndexQuery["operator"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<M3LHumanActionIndexQuery["fromMs"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<M3LHumanActionIndexQuery["toMs"]>().toEqualTypeOf<
      number | undefined
    >();
  });
});

// ---------------------------------------------------------------------------
// T1 — gate the deliberate audit-repository.ts / audit/record.ts duplication.
// audit-repository.ts's own `@packageDocumentation` explains WHY these four
// union types are hand-duplicated rather than imported (the `store` eslint
// zone forbids importing `src/audit/`); nothing on the src side catches the
// two copies drifting apart. `toEqualTypeOf` is bidirectional, so this fires
// on a ninth member added to EITHER side alone (e.g. F3's motivating example:
// deleting "session.reopen" from one array without touching the other type).
// This is a real gate, not decoration: `tsconfig.json` includes
// `tests/**/*.ts`, and `typecheck` (`tsc -p tsconfig.json`) runs in the
// pre-push cadence and in CI.
// ---------------------------------------------------------------------------

describe("type-level contract — gated against audit/record.ts (T1 drift gate)", () => {
  test("M3LHumanActionIndexKind stays identical to M3LHumanActionKind", () => {
    expectTypeOf<M3LHumanActionIndexKind>().toEqualTypeOf<M3LHumanActionKind>();
  });

  test("M3LHumanActionIndexPosture stays identical to M3LHumanActionPosture", () => {
    expectTypeOf<M3LHumanActionIndexPosture>().toEqualTypeOf<M3LHumanActionPosture>();
  });

  test("M3LHumanActionIndexOutcome stays identical to M3LHumanActionOutcome", () => {
    expectTypeOf<M3LHumanActionIndexOutcome>().toEqualTypeOf<M3LHumanActionOutcome>();
  });

  test("M3LHumanActionIndexTargetKind stays identical to M3LHumanActionTarget['kind']", () => {
    expectTypeOf<M3LHumanActionIndexTargetKind>().toEqualTypeOf<
      M3LHumanActionTarget["kind"]
    >();
  });
});
