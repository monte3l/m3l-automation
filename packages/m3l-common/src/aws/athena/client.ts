/**
 * `aws/athena/client` — `M3LAthenaClient`, a typed wrapper over Amazon
 * Athena query execution.
 *
 * @packageDocumentation
 */

import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  type AthenaClient,
  type ColumnInfo,
  type Datum,
  type GetQueryExecutionCommandOutput,
  type GetQueryResultsCommandOutput,
  type QueryExecutionStatistics,
  type Row,
} from "@aws-sdk/client-athena";

import { M3LPoller } from "../../core/polling/M3LPoller.js";
import type {
  M3LPollDecision,
  M3LPollerOptions,
} from "../../core/polling/M3LPoller.js";
import { M3LPollingPolicies } from "../../core/polling/M3LPollingPolicies.js";
import { M3LRetryRunner } from "../../core/polling/M3LRetryRunner.js";

import {
  M3LAthenaQueryFailedError,
  M3LAthenaStartQueryError,
} from "./errors.js";
import type {
  AthenaQueryResult,
  AthenaRow,
  StartAthenaQueryInput,
} from "./types.js";

/** Optional overrides for {@link M3LAthenaClient.awaitResults} / `.runQuery`. */
export interface AthenaAwaitOptions {
  /**
   * Overrides the default poller built from
   * `Core.M3LPollingPolicies.athenaQuery()`. Callers build this via a
   * `M3LPollingPolicies` factory and pass it opaquely — the option type
   * itself is not part of the public barrel.
   */
  readonly pollerOptions?: M3LPollerOptions;
}

/**
 * Typed wrapper over Amazon Athena query execution
 * (`StartQueryExecution`/`GetQueryExecution`/`GetQueryResults`), so consumer
 * scripts never need to import `@aws-sdk/client-athena` directly (ADR-0029).
 *
 * Wraps an already-provisioned `AthenaClient` — obtain one from
 * `script.aws.athena` (the library's credential/client-construction seam)
 * and inject it here; this class never constructs its own client from a
 * profile/region.
 *
 * @example
 * ```ts
 * import { M3LAthenaClient } from "@m3l-automation/m3l-common/aws";
 *
 * const athena = new M3LAthenaClient(script.aws.athena);
 * const result = await athena.runQuery({
 *   queryString: "SELECT * FROM my_table LIMIT 10",
 *   database: "my_database",
 *   outputLocation: "s3://my-athena-results-bucket/",
 * });
 * console.log(result.rows);
 * ```
 */
export class M3LAthenaClient {
  readonly #client: AthenaClient;

  /**
   * Creates a new `M3LAthenaClient`.
   *
   * @param client - An already-provisioned `AthenaClient`, typically
   *   `script.aws.athena`.
   */
  constructor(client: AthenaClient) {
    this.#client = client;
  }

  /**
   * Submits an Athena query and returns its `QueryExecutionId`. Wraps
   * `StartQueryExecutionCommand`, retried under AWS throttling via
   * `awsThrottling()` — so a caller (e.g. a resumable script) can checkpoint
   * the id before polling.
   *
   * @param input - The query definition (SQL text, optional
   *   database/catalog/output-location/workgroup/execution parameters).
   * @returns The AWS-assigned `QueryExecutionId`.
   * @throws {@link M3LAthenaStartQueryError} When the `StartQueryExecution`
   *   SDK call itself fails (after any throttling retries are exhausted; the
   *   original error is chained via `cause`), or when the response carries no
   *   `QueryExecutionId`.
   */
  async startQuery(input: StartAthenaQueryInput): Promise<string> {
    const runner = new M3LRetryRunner(M3LPollingPolicies.awsThrottling());
    let response;
    try {
      response = await runner.run(() =>
        this.#client.send(
          new StartQueryExecutionCommand({
            QueryString: input.queryString,
            ...((input.database !== undefined ||
              input.catalog !== undefined) && {
              QueryExecutionContext: {
                ...(input.database !== undefined && {
                  Database: input.database,
                }),
                ...(input.catalog !== undefined && {
                  Catalog: input.catalog,
                }),
              },
            }),
            ...(input.outputLocation !== undefined && {
              ResultConfiguration: { OutputLocation: input.outputLocation },
            }),
            ...(input.workGroup !== undefined && {
              WorkGroup: input.workGroup,
            }),
            ...(input.executionParameters !== undefined && {
              ExecutionParameters: [...input.executionParameters],
            }),
          }),
        ),
      );
    } catch (cause) {
      throw new M3LAthenaStartQueryError("StartQueryExecution failed", {
        queryString: input.queryString,
        cause,
      });
    }

    if (!response.QueryExecutionId) {
      throw new M3LAthenaStartQueryError(
        "StartQueryExecution response carried no QueryExecutionId",
        { queryString: input.queryString },
      );
    }
    return response.QueryExecutionId;
  }

  /**
   * Sends `GetQueryExecutionCommand`, retried under AWS throttling. Isolated
   * from {@link awaitResults}'s poll check so that arrow function stays
   * within the project's cyclomatic-complexity budget.
   *
   * @param queryExecutionId - The AWS-assigned query execution identifier to
   *   poll.
   * @throws {@link M3LAthenaQueryFailedError} (`status: "UNKNOWN"`) when the
   *   send itself fails after any throttling retries are exhausted.
   */
  async #fetchQueryExecution(
    queryExecutionId: string,
  ): Promise<GetQueryExecutionCommandOutput> {
    try {
      return await new M3LRetryRunner(M3LPollingPolicies.awsThrottling()).run(
        () =>
          this.#client.send(
            new GetQueryExecutionCommand({
              QueryExecutionId: queryExecutionId,
            }),
          ),
      );
    } catch (cause) {
      throw new M3LAthenaQueryFailedError(
        `GetQueryExecution failed for query ${queryExecutionId}`,
        { queryExecutionId, status: "UNKNOWN", cause },
      );
    }
  }

  /**
   * Sends one `GetQueryResultsCommand` page, retried under AWS throttling.
   *
   * @param queryExecutionId - The AWS-assigned query execution identifier.
   * @param nextToken - The pagination token from the previous page, when
   *   fetching a page after the first.
   * @throws {@link M3LAthenaQueryFailedError} (`status: "UNKNOWN"`) when the
   *   send itself fails after any throttling retries are exhausted.
   */
  async #fetchQueryResultsPage(
    queryExecutionId: string,
    nextToken?: string,
  ): Promise<GetQueryResultsCommandOutput> {
    try {
      return await new M3LRetryRunner(M3LPollingPolicies.awsThrottling()).run(
        () =>
          this.#client.send(
            new GetQueryResultsCommand({
              QueryExecutionId: queryExecutionId,
              ...(nextToken !== undefined && { NextToken: nextToken }),
            }),
          ),
      );
    } catch (cause) {
      throw new M3LAthenaQueryFailedError(
        `GetQueryResults failed for query ${queryExecutionId}`,
        { queryExecutionId, status: "UNKNOWN", cause },
      );
    }
  }

  /**
   * Runs the {@link M3LPoller} check for `awaitResults`: fetches
   * `GetQueryExecution`, and maps its `Status.State` onto a poll decision.
   * Isolated so `awaitResults` itself stays within the project's
   * complexity/line budget.
   *
   * @param queryExecutionId - The AWS-assigned query execution identifier.
   * @returns `"continue"` while `QUEUED`/`RUNNING`; the response on `SUCCEEDED`.
   * @throws {@link M3LAthenaQueryFailedError} When the query reaches a
   *   terminal non-`SUCCEEDED` status (`FAILED`/`CANCELLED`/missing state).
   */
  async #checkQueryExecution(
    queryExecutionId: string,
  ): Promise<M3LPollDecision<GetQueryExecutionCommandOutput>> {
    const result = await this.#fetchQueryExecution(queryExecutionId);
    const state = result.QueryExecution?.Status?.State;
    switch (state) {
      case "QUEUED":
      case "RUNNING":
        return { type: "continue" };
      case "SUCCEEDED":
        return { type: "success", value: result };
      case "FAILED":
      case "CANCELLED":
      case undefined: {
        const status = state ?? "UNKNOWN";
        throw new M3LAthenaQueryFailedError(
          `Athena query reached terminal status ${status}`,
          { queryExecutionId, status },
        );
      }
    }
  }

  /**
   * Maps a `GetQueryResults` page's `ResultSetMetadata.ColumnInfo` onto
   * {@link AthenaQueryResult}'s `columns` shape.
   *
   * @param columnInfo - The raw `ColumnInfo[]`, when present.
   * @returns The normalized column schema.
   */
  #mapColumns(columnInfo: readonly ColumnInfo[]): AthenaQueryResult["columns"] {
    return columnInfo.map((column) => ({
      name: column.Name ?? "",
      type: column.Type ?? "",
    }));
  }

  /**
   * Strips the header row from a `GetQueryResults` page's `Rows`, but only
   * on the first page (for `SELECT`/DML queries, AWS returns the column
   * header as `Rows[0]` on the first page only).
   *
   * @param rows - The page's raw `Rows`.
   * @param isFirstPage - Whether this is the first `GetQueryResults` page.
   * @returns The data rows, header-free.
   */
  #stripHeaderRow(rows: readonly Row[], isFirstPage: boolean): readonly Row[] {
    return isFirstPage && rows.length > 0 ? rows.slice(1) : rows;
  }

  /**
   * Fetches every `GetQueryResults` page for a `SUCCEEDED` query and returns
   * the normalized columns/rows. The header row (the first `Row` of the
   * first page only, for `SELECT`/DML queries) is stripped; every row is
   * keyed by `columns[].name` via positional mapping, not by trusting the
   * header text — so pagination never re-includes it.
   *
   * @param queryExecutionId - The AWS-assigned query execution identifier.
   * @returns The normalized column schema and every accumulated row.
   */
  async #collectResults(
    queryExecutionId: string,
  ): Promise<Pick<AthenaQueryResult, "columns" | "rows">> {
    const rows: AthenaRow[] = [];
    let columns: AthenaQueryResult["columns"] = [];
    let nextToken: string | undefined;
    let isFirstPage = true;
    do {
      const page = await this.#fetchQueryResultsPage(
        queryExecutionId,
        nextToken,
      );
      if (isFirstPage) {
        columns = this.#mapColumns(
          page.ResultSet?.ResultSetMetadata?.ColumnInfo ?? [],
        );
      }

      const dataRows = this.#stripHeaderRow(
        page.ResultSet?.Rows ?? [],
        isFirstPage,
      );
      for (const row of dataRows) {
        rows.push(this.#normalizeRow(row.Data ?? [], columns));
      }

      nextToken = page.NextToken;
      isFirstPage = false;
    } while (nextToken !== undefined);

    return { columns, rows };
  }

  /**
   * Positionally maps one `Row.Data[]` onto `columns[].name`, normalizing a
   * missing `VarCharValue` to `""`.
   *
   * @param data - The row's raw `Datum[]`.
   * @param columns - The result's column schema, in column order.
   * @returns The normalized row.
   */
  #normalizeRow(
    data: readonly Datum[],
    columns: AthenaQueryResult["columns"],
  ): AthenaRow {
    const row: Record<string, string> = {};
    for (const [index, column] of columns.entries()) {
      row[column.name] = data[index]?.VarCharValue ?? "";
    }
    return row;
  }

  /**
   * Maps AWS `QueryExecutionStatistics` onto the camelCase
   * {@link AthenaQueryStatistics} shape, when present.
   *
   * @param statistics - The raw `QueryExecution.Statistics`, when present.
   * @returns The normalized statistics, or `undefined` when AWS returned none.
   */
  #mapStatistics(
    statistics: QueryExecutionStatistics | undefined,
  ): AthenaQueryResult["statistics"] {
    if (statistics === undefined) return undefined;
    return {
      ...(statistics.DataScannedInBytes !== undefined && {
        dataScannedInBytes: statistics.DataScannedInBytes,
      }),
      ...(statistics.TotalExecutionTimeInMillis !== undefined && {
        totalExecutionTimeInMillis: statistics.TotalExecutionTimeInMillis,
      }),
      ...(statistics.EngineExecutionTimeInMillis !== undefined && {
        engineExecutionTimeInMillis: statistics.EngineExecutionTimeInMillis,
      }),
    };
  }

  /**
   * Polls an Athena query to completion via `GetQueryExecution`, then fetches
   * every `GetQueryResults` page and returns the normalized result.
   * Standalone-usable with a previously-obtained `QueryExecutionId` (the
   * resume/re-attach case — no fresh `StartQueryExecution` is issued).
   *
   * @param queryExecutionId - The AWS-assigned query execution identifier to
   *   poll.
   * @param options - Optional poller override.
   * @returns The normalized query result once the query reaches `SUCCEEDED`.
   * @throws {@link M3LAthenaQueryFailedError} When the query reaches a
   *   terminal non-`SUCCEEDED` status, or when the `GetQueryExecution`/
   *   `GetQueryResults` SDK call itself fails (after any throttling retries
   *   are exhausted; reported with `status: "UNKNOWN"` and the original error
   *   chained via `cause`).
   * @throws A plain `M3LError` with `code === "ERR_POLL_EXHAUSTED"` when the
   *   poll attempt bound is reached while the query is still queued/running.
   */
  async awaitResults(
    queryExecutionId: string,
    options?: AthenaAwaitOptions,
  ): Promise<AthenaQueryResult> {
    const poller = new M3LPoller(
      options?.pollerOptions ?? M3LPollingPolicies.athenaQuery(),
    );

    const execution = await poller.poll<GetQueryExecutionCommandOutput>(() =>
      this.#checkQueryExecution(queryExecutionId),
    );
    const { columns, rows } = await this.#collectResults(queryExecutionId);
    const statistics = this.#mapStatistics(
      execution.QueryExecution?.Statistics,
    );

    return {
      queryExecutionId,
      status: "SUCCEEDED",
      columns,
      rows,
      ...(statistics !== undefined && { statistics }),
    };
  }

  /**
   * Convenience combination of {@link startQuery} + {@link awaitResults} for
   * the common non-resumable case (submit and wait for one query).
   *
   * @param input - The query definition.
   * @param options - Optional poller override.
   * @returns The normalized query result once the query reaches `SUCCEEDED`.
   */
  async runQuery(
    input: StartAthenaQueryInput,
    options?: AthenaAwaitOptions,
  ): Promise<AthenaQueryResult> {
    const queryExecutionId = await this.startQuery(input);
    return this.awaitResults(queryExecutionId, options);
  }
}
