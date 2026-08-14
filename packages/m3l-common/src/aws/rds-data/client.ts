/**
 * `aws/rds-data/client` — {@link M3LRDSDataOperations}, a typed wrapper over
 * a raw `RDSDataClient` so callers never import
 * `@aws-sdk/client-rds-data` command classes directly. See
 * `docs/reference/aws/rds-data.md` for the full contract, and ADR-0031 for
 * why this module exists as an AWS-SDK-only route back into fleet scope for
 * Aurora PostgreSQL (via the RDS Data API), never the raw `pg` driver.
 *
 * `ExecuteStatement` is synchronous — unlike `aws/athena`, there is no
 * async-query-then-poll shape here, so this module never imports
 * `M3LPoller`. Every SDK send still goes through a per-instance
 * {@link M3LRetryRunner} combining `M3LPollingPolicies.awsThrottling()` with
 * a module-local classifier recognizing `DatabaseResumingException` — the
 * Aurora-Serverless-v1 paused-cluster case AWS recommends retrying.
 *
 * @packageDocumentation
 */

import type {
  ColumnMetadata,
  Field,
  RDSDataClient,
  SqlParameter,
} from "@aws-sdk/client-rds-data";
import {
  BatchExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";

import {
  combineClassifiers,
  M3LPollingPolicies,
  M3LRetryRunner,
} from "../../core/polling/index.js";
import type { M3LRetryClassifier } from "../../core/polling/index.js";

import {
  M3LRDSDataOperationError,
  M3LRDSDataResultTooLargeError,
} from "./error.js";
import type {
  M3LRDSDataBatchInput,
  M3LRDSDataBatchResult,
  M3LRDSDataBeginTransactionInput,
  M3LRDSDataColumn,
  M3LRDSDataParameter,
  M3LRDSDataRow,
  M3LRDSDataStatementInput,
  M3LRDSDataStatementResult,
  M3LRDSDataTransaction,
  M3LRDSDataValue,
} from "./types.js";

/**
 * Recognizes the SDK's `DatabaseResumingException` (Aurora Serverless v1's
 * paused-cluster condition) by `error.name`, mapping it to `"retriable"`.
 * Everything else is `"unknown"`, so this composes cleanly with
 * `M3LPollingPolicies.awsThrottling()`'s classifier via
 * {@link combineClassifiers}. Scoped locally to this module — never edited
 * into the shared `awsThrottlingClassifier` other AWS wrappers use.
 *
 * @param error - The thrown value (any shape).
 * @returns `"retriable"` for a `DatabaseResumingException`, otherwise `"unknown"`.
 */
const databaseResumingClassifier: M3LRetryClassifier = (
  error: unknown,
): "retriable" | "unknown" => {
  if (typeof error !== "object" || error === null) return "unknown";
  const name = (error as { readonly name?: unknown }).name;
  return name === "DatabaseResumingException" ? "retriable" : "unknown";
};

/**
 * The maximum number of characters of a caller-supplied (malformed) `kind`
 * string embedded in {@link mapValueToField}'s unmapped-kind error message.
 * Longer input is truncated with a trailing `"…"` indicator.
 */
const MAX_KIND_DESCRIPTION_LENGTH = 100;

/**
 * Sanitizes an untrusted `kind` string before it is embedded in a thrown
 * error's message: caps its length to {@link MAX_KIND_DESCRIPTION_LENGTH}
 * characters (truncating with a trailing `"…"` indicator when longer) and
 * strips ASCII control characters (code points below `0x20`, plus `0x7f`) —
 * a caller-controlled `kind` could otherwise smuggle ANSI escape sequences
 * or embedded newlines into logs/reports that later render the message.
 * String-first and non-backtracking: a single flat character class, no
 * nesting or alternation.
 *
 * @param kind - The raw, caller-influenced `kind` value.
 * @returns A bounded, control-character-free description safe to embed in
 *   an error message.
 */
function sanitizeKindDescription(kind: string): string {
  const truncated =
    kind.length > MAX_KIND_DESCRIPTION_LENGTH
      ? `${kind.slice(0, MAX_KIND_DESCRIPTION_LENGTH)}…`
      : kind;
  // Single flat character class over ASCII control code points — not a
  // backtracking-prone pattern, so the rule's blanket ban is overbroad here.
  // eslint-disable-next-line no-control-regex
  return truncated.replace(/[\x00-\x1f\x7f]/gu, "");
}

/**
 * Translates a {@link M3LRDSDataValue} into the SDK's `Field` union — the
 * reverse of {@link mapField}, used to build a `SqlParameter`'s `value`.
 *
 * @param value - The plain, library-owned parameter value.
 * @returns The equivalent SDK `Field`.
 */
function mapValueToField(value: M3LRDSDataValue): Field {
  switch (value.kind) {
    case "null":
      return { isNull: true };
    case "string":
      return { stringValue: value.value };
    case "long":
      return { longValue: value.value };
    case "double":
      return { doubleValue: value.value };
    case "boolean":
      return { booleanValue: value.value };
    case "blob":
      return { blobValue: value.value };
    default: {
      const exhaustive: never = value;
      // This branch is reachable only via a type-system bypass (an `as` cast
      // supplying a shape outside the M3LRDSDataValue union). Name only the
      // encountered `kind` (or its `typeof`, if `kind` itself is missing or
      // non-string) — never `JSON.stringify` the whole value, which would
      // serialize an arbitrary caller-supplied payload straight into the
      // error message. Mirrors `mapField`'s sibling default-case handling
      // below, which names only the location and the member's kind.
      const malformed = exhaustive as { readonly kind?: unknown };
      const kindDescription =
        typeof malformed.kind === "string"
          ? sanitizeKindDescription(malformed.kind)
          : `typeof ${typeof malformed.kind}`;
      throw new M3LRDSDataOperationError(
        `unmapped M3LRDSDataValue kind: ${kindDescription}`,
      );
    }
  }
}

/**
 * Translates a {@link M3LRDSDataParameter} into the SDK's `SqlParameter`
 * shape, used to build `ExecuteStatement`/`BatchExecuteStatement` command
 * input. `typeHint` is included only when the caller supplied one
 * (`exactOptionalPropertyTypes`-safe).
 *
 * @param parameter - The plain, library-owned SQL parameter.
 * @returns The equivalent SDK `SqlParameter`.
 */
function buildSqlParameter(parameter: M3LRDSDataParameter): SqlParameter {
  return {
    name: parameter.name,
    value: mapValueToField(parameter.value),
    ...(parameter.typeHint !== undefined && {
      typeHint: parameter.typeHint,
    }),
  };
}

/**
 * Translates one SDK `Field` into a {@link M3LRDSDataValue}. A `Field` whose
 * `isNull` is `true` maps to the `"null"` kind; a `Field` whose `isNull` is
 * `false` is a representable wire value and must NOT short-circuit to null —
 * it falls through to whichever other member (`stringValue`/`longValue`/
 * `doubleValue`/`booleanValue`/`blobValue`) is actually present.
 * `arrayValue` and `$unknown` are unmapped: mapping either to the `"null"`
 * kind would silently corrupt data for a caller writing results out, so both
 * throw {@link M3LRDSDataOperationError} naming `location` (a row/column
 * index or a `generatedFields` index) and the encountered member's kind —
 * never the value itself.
 *
 * @param field - The raw SDK `Field`.
 * @param location - A human-readable position (e.g. `"row 0, column 1"`),
 *   included in the thrown error's message for an unmapped member.
 * @returns The equivalent {@link M3LRDSDataValue}.
 * @throws {@link M3LRDSDataOperationError} when `field` carries an
 *   `arrayValue` or an unrecognized (`$unknown`) member.
 */
function mapField(field: Field, location: string): M3LRDSDataValue {
  if (field.isNull === true) return { kind: "null" };
  if (field.stringValue !== undefined) {
    return { kind: "string", value: field.stringValue };
  }
  if (field.longValue !== undefined) {
    return { kind: "long", value: field.longValue };
  }
  if (field.doubleValue !== undefined) {
    return { kind: "double", value: field.doubleValue };
  }
  if (field.booleanValue !== undefined) {
    return { kind: "boolean", value: field.booleanValue };
  }
  if (field.blobValue !== undefined) {
    return { kind: "blob", value: field.blobValue };
  }
  if (field.arrayValue !== undefined) {
    throw new M3LRDSDataOperationError(
      `unmapped Field member "arrayValue" at ${location}`,
    );
  }
  throw new M3LRDSDataOperationError(
    `unmapped Field member "$unknown" at ${location}`,
  );
}

/**
 * Builds an `ExecuteStatementCommand`'s input from a
 * {@link M3LRDSDataStatementInput} — split out of
 * {@link M3LRDSDataOperations.executeStatement} to keep its cyclomatic
 * complexity low. `database`/`schema`/`parameters`/`transactionId` are
 * included only when the caller supplied them; `includeResultMetadata` is
 * always `true` (without it, the SDK never returns `columnMetadata`).
 *
 * @param input - The caller's statement input.
 * @returns The SDK `ExecuteStatementCommand` input shape.
 */
function buildExecuteStatementInput(input: M3LRDSDataStatementInput): {
  readonly resourceArn: string;
  readonly secretArn: string;
  readonly sql: string;
  readonly database?: string;
  readonly schema?: string;
  readonly parameters?: SqlParameter[];
  readonly transactionId?: string;
  readonly includeResultMetadata: true;
} {
  return {
    resourceArn: input.resourceArn,
    secretArn: input.secretArn,
    sql: input.sql,
    ...(input.database !== undefined && { database: input.database }),
    ...(input.schema !== undefined && { schema: input.schema }),
    ...(input.parameters !== undefined && {
      parameters: input.parameters.map(buildSqlParameter),
    }),
    ...(input.transactionId !== undefined && {
      transactionId: input.transactionId,
    }),
    includeResultMetadata: true,
  };
}

/**
 * Maps an `ExecuteStatement` SDK rejection to the right typed error — split
 * out of {@link M3LRDSDataOperations.executeStatement} to keep its
 * cyclomatic complexity low. `UnsupportedResultException` (an oversized
 * result, an unsupported data type, or a multidimensional array — the SDK
 * gives no way to tell which) maps to
 * {@link M3LRDSDataResultTooLargeError}; every other rejection maps to
 * {@link M3LRDSDataOperationError}.
 *
 * @param cause - The raw SDK `.send()` rejection.
 * @param resourceArn - The target cluster's ARN, named (never a parameter
 *   value) in the thrown error's message.
 * @throws {@link M3LRDSDataResultTooLargeError} or
 *   {@link M3LRDSDataOperationError}, always.
 */
function throwExecuteStatementError(
  cause: unknown,
  resourceArn: string,
): never {
  if (cause instanceof Error && cause.name === "UnsupportedResultException") {
    throw new M3LRDSDataResultTooLargeError(
      `executeStatement: ExecuteStatement rejected with an oversized result, an unsupported data type, or a multidimensional array for resourceArn=${resourceArn}`,
      { cause },
    );
  }
  throw new M3LRDSDataOperationError(
    `executeStatement: ExecuteStatement failed for resourceArn=${resourceArn}`,
    { cause },
  );
}

/** Maps one SDK result-set row (`Field[]`) into a {@link M3LRDSDataRow}. */
function mapRow(fields: readonly Field[], rowIndex: number): M3LRDSDataRow {
  return fields.map((field, columnIndex) =>
    mapField(field, `row ${rowIndex}, column ${columnIndex}`),
  );
}

/** Maps a flat `Field[]` (e.g. `generatedFields`) into `M3LRDSDataValue[]`. */
function mapFieldList(
  fields: readonly Field[],
  label: string,
): readonly M3LRDSDataValue[] {
  return fields.map((field, index) => mapField(field, `${label}[${index}]`));
}

/**
 * Translates an SDK `ColumnMetadata` into a {@link M3LRDSDataColumn}.
 * `name`/`typeName`/`label` default to `""` when the SDK omits them.
 * `nullable` is the SDK's JDBC-style `number | undefined` (`0` for not
 * nullable, `1` for nullable, `2` for nullable-unknown). This maps `1` to
 * `true` and `0` to `false`; any other value (including `2` or an absent
 * field) omits the `nullable` key entirely (never `undefined`, per
 * `exactOptionalPropertyTypes`).
 *
 * @param column - The raw SDK `ColumnMetadata`.
 * @returns The equivalent {@link M3LRDSDataColumn}.
 */
function mapColumn(column: ColumnMetadata): M3LRDSDataColumn {
  const nullable =
    column.nullable === 1 ? true : column.nullable === 0 ? false : undefined;
  return {
    name: column.name ?? "",
    typeName: column.typeName ?? "",
    label: column.label ?? "",
    ...(nullable !== undefined && { nullable }),
  };
}

/**
 * The maximum number of links {@link attachRollbackFailure} follows down
 * `fnError`'s own `.cause` chain while searching for an open (`undefined`)
 * `.cause` slot to attach `rollbackError` to. Matches the bound the test
 * file's own `causeChain()` helper walks, so a well-formed chain is always
 * fully explored while a pathological (e.g. cyclic) one cannot loop forever.
 */
const MAX_CAUSE_CHAIN_WALK = 10;

/**
 * Attaches `rollbackError` to the first open `.cause` slot found by walking
 * `fnError`'s own `.cause` chain, so both `fn`'s failure and the rollback's
 * failure stay reachable from the error `withTransaction` ultimately
 * surfaces. Checks `fnError.cause` itself first; when that is already taken,
 * follows `.cause` links up to {@link MAX_CAUSE_CHAIN_WALK} levels deep. An
 * already-set `.cause` at any level is never overwritten.
 *
 * Every read of `.cause` (the open-slot check and the chain-walk step) and
 * the write are performed inside one `try`/`catch` per link, so a `.cause`
 * accessor whose getter or setter throws (or a `Proxy` whose `get`/`set`
 * trap throws) can never let a raw error escape this helper and mask
 * `withTransaction`'s intended thrown error — that link is treated as
 * failed and the walk stops there rather than continuing past a link whose
 * `.cause` state is now unknown. After an assignment that doesn't throw,
 * the value is read back and compared against `rollbackError`; a `.cause`
 * setter that silently no-ops (accepts the assignment without storing it)
 * therefore does not get reported as a success. On either kind of failure
 * at a link, the walk stops at that link rather than searching deeper,
 * since a link that failed to read or verify its own `.cause` cannot be
 * trusted to report the true state of any slot beyond it.
 *
 * Returns `false` — never throws — when attachment did not happen, whether
 * because `fnError` isn't an `Error`, no open slot was found within the
 * bound, a read or write at some link threw, or a write's read-back did not
 * match `rollbackError`.
 * See {@link M3LRDSDataOperations.withTransaction}'s TSDoc for how the
 * caller branches on this return value.
 *
 * @param fnError - The error thrown by `fn`, mutated in place when an open,
 *   writable slot is found.
 * @param rollbackError - The rollback's own failure to chain onto `fnError`.
 * @returns `true` when `rollbackError` was successfully attached and
 *   verified somewhere in `fnError`'s chain, `false` otherwise.
 */
function attachRollbackFailure(
  fnError: unknown,
  rollbackError: unknown,
): boolean {
  let link: Error | undefined = fnError instanceof Error ? fnError : undefined;
  for (
    let depth = 0;
    link !== undefined && depth < MAX_CAUSE_CHAIN_WALK;
    depth += 1
  ) {
    try {
      if (link.cause !== undefined) {
        link = link.cause instanceof Error ? link.cause : undefined;
        continue;
      }
      link.cause = rollbackError;
      return link.cause === rollbackError;
    } catch {
      // A read or write at this link threw (frozen/sealed/non-extensible
      // error, an accessor-only `.cause`, or a getter/setter that itself
      // throws). This link's `.cause` state is now unknown/untrustworthy,
      // so stop here rather than attempting to walk past it.
      return false;
    }
  }
  return false;
}

/**
 * Typed operations over Amazon RDS Data API (`@aws-sdk/client-rds-data`),
 * for Data-API-enabled Aurora clusters only. Takes an already-provisioned
 * `RDSDataClient` via constructor injection — this class never
 * self-constructs a client from a profile/region.
 *
 * @example
 * ```ts
 * import { M3LRDSDataOperations } from "@m3l-automation/m3l-common/aws";
 *
 * const rdsData = new M3LRDSDataOperations(script.aws.clients.rdsData);
 * const result = await rdsData.executeStatement({
 *   resourceArn: clusterArn,
 *   secretArn,
 *   sql: "SELECT id, name FROM users WHERE active = :active",
 *   parameters: [{ name: "active", value: { kind: "boolean", value: true } }],
 * });
 * ```
 */
export class M3LRDSDataOperations {
  readonly #client: RDSDataClient;
  readonly #runner: M3LRetryRunner;

  /**
   * Creates a new `M3LRDSDataOperations`.
   *
   * @param client - An already-provisioned `RDSDataClient`, typically
   *   `script.aws.clients.rdsData` or `script.aws.services.rdsDataOperations`.
   */
  constructor(client: RDSDataClient) {
    this.#client = client;
    const throttling = M3LPollingPolicies.awsThrottling();
    this.#runner = new M3LRetryRunner({
      ...throttling,
      classifier: combineClassifiers(
        throttling.classifier,
        databaseResumingClassifier,
      ),
    });
  }

  /**
   * Runs one SQL statement and returns its typed result set.
   *
   * @param input - The statement, its parameters, and the target cluster.
   * @returns The mapped rows, columns, and update count.
   * @throws {@link M3LRDSDataOperationError} when the request fails after
   *   retries, or when a returned `Field` carries an unmapped
   *   `arrayValue`/`$unknown` member.
   * @throws {@link M3LRDSDataResultTooLargeError} when the SDK rejects with
   *   `UnsupportedResultException` — an oversized result, an unsupported
   *   data type, or a multidimensional array (the SDK gives no way to tell
   *   which).
   */
  async executeStatement(
    input: M3LRDSDataStatementInput,
  ): Promise<M3LRDSDataStatementResult> {
    const command = new ExecuteStatementCommand(
      buildExecuteStatementInput(input),
    );

    let response;
    try {
      response = await this.#runner.run(() => this.#client.send(command));
    } catch (cause) {
      throwExecuteStatementError(cause, input.resourceArn);
    }

    const rows = (response.records ?? []).map((row, rowIndex) =>
      mapRow(row, rowIndex),
    );
    const columns = (response.columnMetadata ?? []).map(mapColumn);
    const generatedFields = mapFieldList(
      response.generatedFields ?? [],
      "generatedFields",
    );

    return {
      rows,
      columns,
      numberOfRecordsUpdated: response.numberOfRecordsUpdated ?? 0,
      generatedFields,
    };
  }

  /**
   * Runs one SQL statement once per entry in `input.parameterSets`.
   *
   * @param input - The statement, its parameter sets, and the target cluster.
   * @returns One update result per parameter set, in order.
   * @throws {@link M3LRDSDataOperationError} when the request fails after
   *   retries, or when a returned `Field` carries an unmapped
   *   `arrayValue`/`$unknown` member. A `BatchExecuteStatement` rejection
   *   never maps to {@link M3LRDSDataResultTooLargeError} — that mapping is
   *   `executeStatement`-only.
   */
  async batchExecuteStatement(
    input: M3LRDSDataBatchInput,
  ): Promise<M3LRDSDataBatchResult> {
    const command = new BatchExecuteStatementCommand({
      resourceArn: input.resourceArn,
      secretArn: input.secretArn,
      sql: input.sql,
      ...(input.database !== undefined && { database: input.database }),
      ...(input.schema !== undefined && { schema: input.schema }),
      parameterSets: input.parameterSets.map((parameterSet) =>
        parameterSet.map(buildSqlParameter),
      ),
      ...(input.transactionId !== undefined && {
        transactionId: input.transactionId,
      }),
    });

    let response;
    try {
      response = await this.#runner.run(() => this.#client.send(command));
    } catch (cause) {
      throw new M3LRDSDataOperationError(
        `batchExecuteStatement: BatchExecuteStatement failed for resourceArn=${input.resourceArn}`,
        { cause },
      );
    }

    const updateResults = (response.updateResults ?? []).map(
      (updateResult, index) => ({
        generatedFields: mapFieldList(
          updateResult.generatedFields ?? [],
          `updateResults[${index}].generatedFields`,
        ),
      }),
    );

    return { updateResults };
  }

  /**
   * Starts a SQL transaction.
   *
   * @param input - The target cluster/secret/database/schema.
   * @returns A {@link M3LRDSDataTransaction} to pass to `executeStatement`
   *   (via `transactionId`), `commitTransaction`, or `rollbackTransaction`.
   * @throws {@link M3LRDSDataOperationError} when the request fails after
   *   retries, or when a successful response carries no `transactionId`.
   */
  async beginTransaction(
    input: M3LRDSDataBeginTransactionInput,
  ): Promise<M3LRDSDataTransaction> {
    const command = new BeginTransactionCommand({
      resourceArn: input.resourceArn,
      secretArn: input.secretArn,
      ...(input.database !== undefined && { database: input.database }),
      ...(input.schema !== undefined && { schema: input.schema }),
    });

    let response;
    try {
      response = await this.#runner.run(() => this.#client.send(command));
    } catch (cause) {
      throw new M3LRDSDataOperationError(
        `beginTransaction: BeginTransaction failed for resourceArn=${input.resourceArn}`,
        { cause },
      );
    }

    if (response.transactionId === undefined) {
      throw new M3LRDSDataOperationError(
        `beginTransaction: BeginTransaction response carried no transactionId for resourceArn=${input.resourceArn}`,
      );
    }

    return { transactionId: response.transactionId };
  }

  /**
   * Commits an in-flight transaction.
   *
   * @param resourceArn - The cluster's Amazon Resource Name (ARN).
   * @param secretArn - The Secrets Manager ARN of the secret granting DB
   *   access.
   * @param transaction - The transaction to commit.
   * @throws {@link M3LRDSDataOperationError} when the request fails after
   *   retries.
   */
  async commitTransaction(
    resourceArn: string,
    secretArn: string,
    transaction: M3LRDSDataTransaction,
  ): Promise<void> {
    try {
      await this.#runner.run(() =>
        this.#client.send(
          new CommitTransactionCommand({
            resourceArn,
            secretArn,
            transactionId: transaction.transactionId,
          }),
        ),
      );
    } catch (cause) {
      throw new M3LRDSDataOperationError(
        `commitTransaction: CommitTransaction failed for resourceArn=${resourceArn}, transactionId=${transaction.transactionId}`,
        { cause },
      );
    }
  }

  /**
   * Rolls back an in-flight transaction.
   *
   * @param resourceArn - The cluster's Amazon Resource Name (ARN).
   * @param secretArn - The Secrets Manager ARN of the secret granting DB
   *   access.
   * @param transaction - The transaction to roll back.
   * @throws {@link M3LRDSDataOperationError} when the request fails after
   *   retries.
   */
  async rollbackTransaction(
    resourceArn: string,
    secretArn: string,
    transaction: M3LRDSDataTransaction,
  ): Promise<void> {
    try {
      await this.#runner.run(() =>
        this.#client.send(
          new RollbackTransactionCommand({
            resourceArn,
            secretArn,
            transactionId: transaction.transactionId,
          }),
        ),
      );
    } catch (cause) {
      throw new M3LRDSDataOperationError(
        `rollbackTransaction: RollbackTransaction failed for resourceArn=${resourceArn}, transactionId=${transaction.transactionId}`,
        { cause },
      );
    }
  }

  /**
   * Runs `fn` inside a begin/commit transaction, rolling back on any throw.
   *
   * When `fn` throws and the rollback succeeds, `fn`'s original error
   * propagates unchanged (identity preserved, so `instanceof` checks against
   * it still work). When `fn` throws AND the rollback also fails, the
   * rollback failure is never swallowed and this always throws a new
   * {@link M3LRDSDataOperationError} — but which errors it chains depends on
   * whether {@link attachRollbackFailure} could annotate `fn`'s own error
   * object:
   *
   * - **Attachment succeeds** (`fn`'s error is an `Error`, and an open
   *   (`undefined`) `.cause` slot exists somewhere in its own `.cause` chain
   *   — starting at `fn`'s error itself, then its `.cause`, then that
   *   `.cause`'s own `.cause`, and so on for up to 10 links, never
   *   clobbering an already-set `.cause`): the thrown error's `cause` is
   *   `fn`'s own error object, which in turn chains the rollback failure at
   *   the slot found. Both errors stay reachable by walking the surfaced
   *   error's cause chain, and `fn`'s error retains its original identity.
   * - **Attachment fails** (`fn`'s error isn't an `Error`, no open slot
   *   exists within the 10-link bound, or the `.cause` assignment itself
   *   throws — e.g. a frozen/sealed/non-extensible error, or an
   *   accessor-only `.cause`): the thrown error's `cause` is the rollback
   *   failure directly, and its message additionally notes that `fn`'s own
   *   error object could not be annotated. `fn`'s error object identity is
   *   not preserved in this fallback path, but the rollback failure is
   *   always reachable.
   *
   * @param input - The target cluster/secret/database/schema.
   * @param fn - Receives the started transaction's id; its return value
   *   becomes `withTransaction`'s resolved value on commit.
   * @throws {@link M3LRDSDataOperationError} when begin/commit fails, or when
   *   `fn` fails and the rollback also fails — chaining either `fn`'s own
   *   error (itself chaining the rollback failure) when annotation
   *   succeeded, or the rollback failure directly when it did not.
   * @throws `fn`'s own thrown error, unchanged, when `fn` fails and the
   *   rollback succeeds.
   */
  async withTransaction<T>(
    input: M3LRDSDataBeginTransactionInput,
    fn: (transactionId: string) => Promise<T>,
  ): Promise<T> {
    const { transactionId } = await this.beginTransaction(input);

    let result: T;
    try {
      result = await fn(transactionId);
    } catch (fnError) {
      try {
        await this.rollbackTransaction(input.resourceArn, input.secretArn, {
          transactionId,
        });
      } catch (rollbackError) {
        const attached = attachRollbackFailure(fnError, rollbackError);
        if (attached) {
          throw new M3LRDSDataOperationError(
            `withTransaction: fn failed and rollback also failed for resourceArn=${input.resourceArn}, transactionId=${transactionId}`,
            { cause: fnError },
          );
        }
        throw new M3LRDSDataOperationError(
          `withTransaction: fn failed and rollback also failed for resourceArn=${input.resourceArn}, transactionId=${transactionId} (fn's own error object could not be annotated with the rollback failure)`,
          { cause: rollbackError },
        );
      }
      throw fnError;
    }

    await this.commitTransaction(input.resourceArn, input.secretArn, {
      transactionId,
    });
    return result;
  }
}
