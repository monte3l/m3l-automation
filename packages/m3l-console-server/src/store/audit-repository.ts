/**
 * `store/audit-repository` — `createConsoleAuditRepository`, the
 * {@link M3LConsoleAuditRepository} built over `console_human_actions`
 * (`store/migrations/registry.ts`'s v6, X7 human-action audit index, slice
 * 4b).
 *
 * `console_human_actions` is an INDEX over the JSONL audit trail, never the
 * record of truth — it carries only the queryable dimensions, never
 * `parameterNames`, `parameterRefs`, or `detail`, which live in the stream
 * only. This repository's `deleteAll` + `insertAll` are the two halves of a
 * truncate-and-reinsert rebuild; reading the JSONL stream itself is NOT this
 * repository's job — `boot/audit-rebuild.ts` drives it (X7c), from outside
 * the `store` zone, which may not import `audit/`.
 *
 * Exactly `store/runs-repository.ts`'s shape: a repository is a plain
 * FUNCTION over the injected {@link M3LStoreQueryExecutor} port, never a
 * class holding a `DatabaseSync` — equally usable against a transaction's
 * executor and the top-level store.
 *
 * **`src/store/**` sits in the `store` eslint zone, asserted at exactly
 * `["store", "errors"]` by `bin/check-eslint-zones.mjs`** — so this file
 * cannot import from `src/audit/`. The `M3LHumanActionIndex*` union types,
 * declared in `audit-repository-types.ts` (split out purely for the
 * per-file byte budget, ADR-0072 — see that file's own
 * `@packageDocumentation`), deliberately duplicate `audit/record.ts`'s own
 * `M3LHumanAction*` types rather than importing them, exactly as
 * `runs-repository.ts` declares
 * `M3LRunInsert`/`M3LRunRecord` without importing from `src/runs/`. Do not
 * "deduplicate" this by adding an import — the zone gate will reject it.
 *
 * **`insertAll` opens no transaction of its own.** It is a plain loop over
 * one-row inserts, so a failure partway through a batch leaves the
 * already-inserted rows persisted rather than rolling them back. The caller
 * supplies a transaction executor (an `M3LStoreTransaction`) when it wants
 * atomicity — exactly why every operation here takes an
 * {@link M3LStoreQueryExecutor} as a parameter rather than holding one as a
 * field.
 *
 * @packageDocumentation
 */
import { M3LConsoleError } from "../errors/console-error.js";

import { classifyStoreFailure, storeError } from "./failures.js";
import type {
  M3LConsoleAuditRepository,
  M3LHumanActionIndexInput,
  M3LHumanActionIndexKind,
  M3LHumanActionIndexOutcome,
  M3LHumanActionIndexPosture,
  M3LHumanActionIndexQuery,
  M3LHumanActionIndexRecord,
  M3LHumanActionIndexTargetKind,
} from "./audit-repository-types.js";
import type {
  M3LStoreOutputValue,
  M3LStoreQueryExecutor,
  M3LStoreRow,
} from "./types.js";

export type {
  M3LConsoleAuditRepository,
  M3LHumanActionIndexInput,
  M3LHumanActionIndexKind,
  M3LHumanActionIndexOutcome,
  M3LHumanActionIndexPosture,
  M3LHumanActionIndexQuery,
  M3LHumanActionIndexRecord,
  M3LHumanActionIndexTargetKind,
} from "./audit-repository-types.js";

/**
 * One raw `console_human_actions` column value, as reading it off an
 * {@link M3LStoreRow} yields it. Includes `| undefined` on top of
 * `store/types.ts`'s own exported output-value shape
 * ({@link M3LStoreOutputValue}): `noUncheckedIndexedAccess` widens every
 * index-signature read (`row["col"]`) this way, even for a column the
 * `CHECK` constraints guarantee is always present — the `toRequired*`
 * helpers below turn that TS-only possibility into a thrown
 * `M3LConsoleError` rather than a silently wrong value.
 */
type AuditColumnValue = M3LStoreOutputValue | undefined;

/**
 * Runs `operation`, classifying any thrown value into an
 * {@link M3LConsoleError} — mirrors `runs-repository.ts`'s own
 * `runRunsOperation`. An already-typed `M3LConsoleError` (e.g. raised by
 * this module's own validation, or by a production
 * `M3LStoreQueryExecutor` that classifies its own failures) is re-thrown
 * unchanged rather than double-wrapped.
 */
function runAuditOperation<T>(operation: () => T, message: string): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof M3LConsoleError) throw cause;
    throw storeError(classifyStoreFailure(cause), "query", message, cause);
  }
}

/** Throws when a `NOT NULL` column reads back as SQL `NULL` (or, per {@link AuditColumnValue}, TS-only `undefined`) — a `CHECK`-guaranteed invariant broken. */
function requireColumn(
  value: AuditColumnValue,
): string | number | bigint | Uint8Array {
  if (value === null || value === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_STORE_QUERY_FAILED",
      "console_human_actions row is missing a value for a NOT NULL column",
    );
  }
  return value;
}

/** Narrows a raw column value to a required (non-`NULL`) number, tolerating a `bigint` read. */
function toRequiredNumber(value: AuditColumnValue): number {
  return Number(requireColumn(value));
}

/** Narrows a raw column value to a required (non-`NULL`) string. */
function toRequiredString(value: AuditColumnValue): string {
  return String(requireColumn(value));
}

/** Narrows a raw column value to an optional string, mapping SQL `NULL` to `undefined`. */
function toOptionalString(value: AuditColumnValue): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

/**
 * The closed {@link M3LHumanActionIndexKind} vocabulary, as an exhaustive
 * key table `Object.hasOwn` can check membership against. Declared as
 * `Readonly<Record<M3LHumanActionIndexKind, true>>` — checked AGAINST the
 * union, never derived FROM an array — so a missing or extra member is a
 * compile error here rather than a silent runtime gap (deleting
 * `"session.reopen"` from this object, unlike from a plain array, fails
 * `tsc`).
 */
const HUMAN_ACTION_INDEX_KINDS: Readonly<
  Record<M3LHumanActionIndexKind, true>
> = {
  "run.launch": true,
  "run.cancel": true,
  "session.create": true,
  "session.step.add": true,
  "session.decision.raise": true,
  "session.decision.answer": true,
  "session.binding.select": true,
  "session.close": true,
  "session.reopen": true,
  "view.run.report": true,
  "view.run.stream": true,
  "view.session.artifact": true,
};

/** The closed {@link M3LHumanActionIndexTargetKind} vocabulary, exactly like {@link HUMAN_ACTION_INDEX_KINDS}. */
const HUMAN_ACTION_INDEX_TARGET_KINDS: Readonly<
  Record<M3LHumanActionIndexTargetKind, true>
> = {
  script: true,
  run: true,
  session: true,
  step: true,
  artifact: true,
};

/** The closed {@link M3LHumanActionIndexPosture} vocabulary, exactly like {@link HUMAN_ACTION_INDEX_KINDS}. */
const HUMAN_ACTION_INDEX_POSTURES: Readonly<
  Record<M3LHumanActionIndexPosture, true>
> = {
  auto: true,
  confirmed: true,
  escalated: true,
};

/** The closed {@link M3LHumanActionIndexOutcome} vocabulary, exactly like {@link HUMAN_ACTION_INDEX_KINDS}. */
const HUMAN_ACTION_INDEX_OUTCOMES: Readonly<
  Record<M3LHumanActionIndexOutcome, true>
> = {
  allowed: true,
  denied: true,
  rejected: true,
  failed: true,
  served: true,
};

/** Narrows a raw `action` column value to {@link M3LHumanActionIndexKind}, throwing a typed error rather than silently coercing an unrecognized value — the `CHECK` constraint should make this unreachable, but a reader must not trust that invariant blindly. */
function toHumanActionIndexKind(
  value: AuditColumnValue,
): M3LHumanActionIndexKind {
  const raw = toRequiredString(value);
  if (Object.hasOwn(HUMAN_ACTION_INDEX_KINDS, raw)) {
    return raw as M3LHumanActionIndexKind;
  }
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_human_actions row has an unrecognized action value",
  );
}

/** Narrows a raw `target_kind` column value to {@link M3LHumanActionIndexTargetKind}, exactly like {@link toHumanActionIndexKind}. */
function toHumanActionIndexTargetKind(
  value: AuditColumnValue,
): M3LHumanActionIndexTargetKind {
  const raw = toRequiredString(value);
  if (Object.hasOwn(HUMAN_ACTION_INDEX_TARGET_KINDS, raw)) {
    return raw as M3LHumanActionIndexTargetKind;
  }
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_human_actions row has an unrecognized target_kind value",
  );
}

/** Narrows a raw `posture` column value to {@link M3LHumanActionIndexPosture}, exactly like {@link toHumanActionIndexKind}. */
function toHumanActionIndexPosture(
  value: AuditColumnValue,
): M3LHumanActionIndexPosture {
  const raw = toRequiredString(value);
  if (Object.hasOwn(HUMAN_ACTION_INDEX_POSTURES, raw)) {
    return raw as M3LHumanActionIndexPosture;
  }
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_human_actions row has an unrecognized posture value",
  );
}

/** Narrows a raw `outcome` column value to {@link M3LHumanActionIndexOutcome}, exactly like {@link toHumanActionIndexKind}. */
function toHumanActionIndexOutcome(
  value: AuditColumnValue,
): M3LHumanActionIndexOutcome {
  const raw = toRequiredString(value);
  if (Object.hasOwn(HUMAN_ACTION_INDEX_OUTCOMES, raw)) {
    return raw as M3LHumanActionIndexOutcome;
  }
  throw new M3LConsoleError(
    "ERR_CONSOLE_STORE_QUERY_FAILED",
    "console_human_actions row has an unrecognized outcome value",
  );
}

/** Projects one raw `console_human_actions` row into a {@link M3LHumanActionIndexRecord}. */
function toHumanActionIndexRecord(row: M3LStoreRow): M3LHumanActionIndexRecord {
  return {
    id: toRequiredNumber(row["id"]),
    atMs: toRequiredNumber(row["at_ms"]),
    operator: toRequiredString(row["operator"]),
    operatorEmailDeclared:
      toRequiredNumber(row["operator_email_declared"]) === 1,
    correlationId: toRequiredString(row["correlation_id"]),
    action: toHumanActionIndexKind(row["action"]),
    targetKind: toHumanActionIndexTargetKind(row["target_kind"]),
    targetId: toRequiredString(row["target_id"]),
    scriptName: toOptionalString(row["script_name"]),
    posture: toHumanActionIndexPosture(row["posture"]),
    outcome: toHumanActionIndexOutcome(row["outcome"]),
  };
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `atMs` is a safe integer. The
 * column is `INTEGER` in a `STRICT` table, so a non-integer float would be a
 * SQLite type error surfacing as `ERR_CONSOLE_STORE_QUERY_FAILED` — the
 * wrong classification for a caller fault, so this is checked before
 * binding.
 */
function requireValidAtMs(atMs: number): number {
  if (!Number.isSafeInteger(atMs)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "atMs must be a safe integer",
    );
  }
  return atMs;
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `input`'s `targetKind`/`scriptName`
 * pairing is legal — the runtime half of F1's fix. {@link M3LHumanActionIndexInput}'s
 * discriminated union already makes the illegal pairing unrepresentable on
 * the typed path, but that protects nothing at a cast boundary (an `as`
 * through `unknown`, or a later slice's JSONL-rebuild path reconstructing
 * inputs from untyped bytes) — without this guard, an illegal pairing that
 * reaches `executor.run` is caught only by the database's own trailing
 * `CHECK`, which surfaces as `ERR_CONSOLE_STORE_QUERY_FAILED`: the wrong
 * classification for a caller fault.
 *
 * The `candidate` re-widening below is deliberate, not redundant: the
 * discriminated union tells `tsc` this state is already impossible, so
 * without it the compiler narrows the non-`"script"` branch's `scriptName`
 * check to `never` (there is genuinely no legal, TYPE-CHECKED value that
 * reaches it). But this function's entire reason to exist is the caller who
 * bypassed the type checker — a cast, or bytes off the JSONL rebuild path —
 * so the check must run against a view the checker has not "proven" safe.
 * Do not remove this cast as dead code; it guards exactly the input the
 * type system cannot see.
 */
function requireValidTarget(
  input: M3LHumanActionIndexInput,
): M3LHumanActionIndexInput {
  const candidate = input as {
    readonly targetKind: string;
    readonly scriptName?: unknown;
  };
  if (candidate.targetKind === "script") {
    if (candidate.scriptName === undefined) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_BAD_REQUEST",
        'scriptName is required when targetKind is "script"',
      );
    }
    return input;
  }
  if (candidate.scriptName !== undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `scriptName must be undefined when targetKind is "${candidate.targetKind}"`,
    );
  }
  return input;
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `value` is a non-empty string —
 * F5's fix. `TEXT NOT NULL` is satisfied by `''`, so without this guard an
 * empty `operator`/`correlationId`/`targetId` inserts successfully and
 * becomes permanently un-attributable / un-queryable by the very index the
 * empty value lives in.
 */
function requireNonEmptyString(value: string, label: string): string {
  if (value.length === 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `${label} must not be empty`,
    );
  }
  return value;
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `limit` is a non-negative integer.
 * See `store/runs-repository.ts`'s own `requireValidLimit` for why: SQLite
 * treats a negative `LIMIT` as unbounded, so binding an unvalidated `limit`
 * straight into `LIMIT ?` would silently contradict this query's own
 * "no unbounded default" guarantee.
 */
function requireValidLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "list query limit must be a non-negative integer",
    );
  }
  return limit;
}

/** Throws `ERR_CONSOLE_BAD_REQUEST` unless `value` is a safe integer — used for `fromMs`/`toMs`, each named in the thrown message for a precise diagnostic. */
function requireValidRangeBound(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `${label} must be a safe integer`,
    );
  }
  return value;
}

/** Validates every constrained field of `query`, throwing `ERR_CONSOLE_BAD_REQUEST` on the first violation. */
function requireValidQuery(
  query: M3LHumanActionIndexQuery,
): M3LHumanActionIndexQuery {
  requireValidLimit(query.limit);
  if (query.fromMs !== undefined)
    requireValidRangeBound(query.fromMs, "fromMs");
  if (query.toMs !== undefined) requireValidRangeBound(query.toMs, "toMs");
  if (
    query.fromMs !== undefined &&
    query.toMs !== undefined &&
    query.fromMs > query.toMs
  ) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "fromMs must not be greater than toMs",
    );
  }
  return query;
}

/** The `WHERE` clause + bound parameters `listRows` adds for `query`'s optional filters. `fromMs`/`toMs` bind as an INCLUSIVE range — see {@link M3LHumanActionIndexQuery}'s own TSDoc for why. */
function buildAuditListFilter(query: M3LHumanActionIndexQuery): {
  readonly clause: string;
  readonly parameters: readonly (string | number)[];
} {
  const clauses: string[] = [];
  const parameters: (string | number)[] = [];
  if (query.correlationId !== undefined) {
    clauses.push("correlation_id = ?");
    parameters.push(query.correlationId);
  }
  if (query.operator !== undefined) {
    clauses.push("operator = ?");
    parameters.push(query.operator);
  }
  if (query.fromMs !== undefined) {
    clauses.push("at_ms >= ?");
    parameters.push(query.fromMs);
  }
  if (query.toMs !== undefined) {
    clauses.push("at_ms <= ?");
    parameters.push(query.toMs);
  }
  const clause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return { clause, parameters };
}

/** Inserts one `console_human_actions` row, after F1/F5's caller-fault guards. */
function insertHumanActionIndexRow(
  executor: M3LStoreQueryExecutor,
  input: M3LHumanActionIndexInput,
): void {
  const atMs = requireValidAtMs(input.atMs);
  const target = requireValidTarget(input);
  const operator = requireNonEmptyString(target.operator, "operator");
  const correlationId = requireNonEmptyString(
    target.correlationId,
    "correlationId",
  );
  const targetId = requireNonEmptyString(target.targetId, "targetId");
  executor.run(
    `INSERT INTO console_human_actions (
      at_ms, operator, operator_email_declared, correlation_id, action,
      target_kind, target_id, script_name, posture, outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      atMs,
      operator,
      target.operatorEmailDeclared ? 1 : 0,
      correlationId,
      target.action,
      target.targetKind,
      targetId,
      target.scriptName ?? null,
      target.posture,
      target.outcome,
    ],
  );
}

/**
 * Re-throws a mid-`insertAll` failure with how many rows were successfully
 * inserted before it attached to `context` (F6) — `insertAll` opens no
 * transaction of its own (see this module's own `@packageDocumentation`), so
 * a failure partway through leaves the index truncated to a prefix, and
 * without this a caller debugging that gets only "it failed" and no way to
 * tell how far the batch got. Preserves an already-typed `M3LConsoleError`'s
 * own `code`/`message`/`cause` (e.g. a caller-fault guard's
 * `ERR_CONSOLE_BAD_REQUEST`) rather than reclassifying it; anything else is
 * classified first via {@link classifyStoreFailure}/{@link storeError}.
 */
function attachInsertedCount(cause: unknown, insertedCount: number): never {
  const classified =
    cause instanceof M3LConsoleError
      ? cause
      : storeError(
          classifyStoreFailure(cause),
          "query",
          "console audit repository insertAll failed",
          cause,
        );
  throw new M3LConsoleError(classified.code, classified.message, {
    cause: classified.cause,
    context: { ...classified.context, insertedCount },
  });
}

/** Inserts every row in `inputs`, in order; see this module's own `@packageDocumentation` for why no transaction is opened here. */
function insertAllHumanActionIndexRows(
  executor: M3LStoreQueryExecutor,
  inputs: readonly M3LHumanActionIndexInput[],
): number {
  let insertedCount = 0;
  for (const input of inputs) {
    try {
      insertHumanActionIndexRow(executor, input);
    } catch (cause) {
      attachInsertedCount(cause, insertedCount);
    }
    insertedCount += 1;
  }
  return insertedCount;
}

/** Deletes every `console_human_actions` row. */
function deleteAllHumanActionIndexRows(
  executor: M3LStoreQueryExecutor,
): number {
  const result = executor.run("DELETE FROM console_human_actions");
  return result.changes;
}

/** Lists `console_human_actions` rows matching `query`, most-recent-first. */
function listHumanActionIndexRows(
  executor: M3LStoreQueryExecutor,
  query: M3LHumanActionIndexQuery,
): readonly M3LHumanActionIndexRecord[] {
  const validated = requireValidQuery(query);
  const { clause, parameters } = buildAuditListFilter(validated);
  const rows = executor.all(
    `SELECT * FROM console_human_actions${clause} ORDER BY at_ms DESC, id DESC LIMIT ?`,
    [...parameters, validated.limit],
  );
  return rows.map((row) => toHumanActionIndexRecord(row));
}

/** Reads a `COUNT(*)` result row as a plain number, defaulting to `0`; routes through the same `requireColumn`/`toRequiredNumber` discipline every other reader in this file uses, rather than a bare `Number(...)` that would silently yield `NaN` on an unexpected shape. */
function countHumanActionIndexRows(executor: M3LStoreQueryExecutor): number {
  const row = executor.get(
    "SELECT COUNT(*) AS count FROM console_human_actions",
  );
  return row === undefined ? 0 : toRequiredNumber(row["count"]);
}

/**
 * Builds a {@link M3LConsoleAuditRepository} over `executor`.
 *
 * @param executor - The {@link M3LStoreQueryExecutor} port this repository
 * reads and writes through — the top-level store's own executor, or a
 * transaction's, closed over rather than held as a class field.
 * @returns The {@link M3LConsoleAuditRepository}.
 *
 * @example
 * ```ts
 * import { createStoreExecutor } from "@m3l-automation/m3l-console-server/store/executor";
 * import { openSqliteDatabase } from "@m3l-automation/m3l-console-server/store/sqlite-driver";
 *
 * const database = openSqliteDatabase(":memory:");
 * const repository = createConsoleAuditRepository(createStoreExecutor(database));
 * repository.insert({
 *   atMs: Date.now(),
 *   operator: "alice",
 *   operatorEmailDeclared: true,
 *   correlationId: "corr-1",
 *   action: "run.launch",
 *   targetKind: "script",
 *   targetId: "scripts/example",
 *   scriptName: "scripts/example",
 *   posture: "auto",
 *   outcome: "allowed",
 * });
 * ```
 */
export function createConsoleAuditRepository(
  executor: M3LStoreQueryExecutor,
): M3LConsoleAuditRepository {
  return {
    insert(input: M3LHumanActionIndexInput): void {
      runAuditOperation(
        () => insertHumanActionIndexRow(executor, input),
        "console audit repository insert failed",
      );
    },
    insertAll(inputs: readonly M3LHumanActionIndexInput[]): number {
      return runAuditOperation(
        () => insertAllHumanActionIndexRows(executor, inputs),
        "console audit repository insertAll failed",
      );
    },
    deleteAll(): number {
      return runAuditOperation(
        () => deleteAllHumanActionIndexRows(executor),
        "console audit repository deleteAll failed",
      );
    },
    list(
      query: M3LHumanActionIndexQuery,
    ): readonly M3LHumanActionIndexRecord[] {
      return runAuditOperation(
        () => listHumanActionIndexRows(executor, query),
        "console audit repository list failed",
      );
    },
    count(): number {
      return runAuditOperation(
        () => countHumanActionIndexRows(executor),
        "console audit repository count failed",
      );
    },
  };
}
