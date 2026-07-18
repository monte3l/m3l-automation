/**
 * `aws/athena/client` — `M3LAthenaClient`, a typed wrapper over Amazon
 * Athena query execution.
 *
 * @packageDocumentation
 */

import type { AthenaClient } from "@aws-sdk/client-athena";

import type { M3LPollerOptions } from "../../core/polling/M3LPoller.js";

import {
  M3LAthenaQueryFailedError,
  M3LAthenaStartQueryError,
} from "./errors.js";
import type { AthenaQueryResult, StartAthenaQueryInput } from "./types.js";

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
 * **NOT YET IMPLEMENTED** — this is a scaffolded placeholder (see
 * `docs/reference/aws/athena.md`, the authoritative contract). Every method
 * throws immediately without touching the injected client.
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
  /**
   * Creates a new `M3LAthenaClient`.
   *
   * @param client - An already-provisioned `AthenaClient`, typically
   *   `script.aws.athena`.
   */
  constructor(private readonly client: AthenaClient) {}

  /**
   * Submits an Athena query and returns its `QueryExecutionId`. Intended to
   * wrap `StartQueryExecutionCommand`, retried under AWS throttling via
   * `awsThrottling()` — so a caller (e.g. a resumable script) can checkpoint
   * the id before polling.
   *
   * @param input - The query definition (SQL text, optional
   *   database/catalog/output-location/workgroup/execution parameters).
   * @returns The AWS-assigned `QueryExecutionId`.
   * @throws {@link M3LAthenaStartQueryError} **Not yet implemented** — this
   *   placeholder throws it unconditionally without calling `send`. See
   *   `docs/reference/aws/athena.md`.
   */
  startQuery(input: StartAthenaQueryInput): Promise<string> {
    throw new M3LAthenaStartQueryError(
      `startQuery: not yet implemented (queryString=${input.queryString}) — see docs/reference/aws/athena.md`,
      { queryString: input.queryString },
    );
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
   * @throws {@link M3LAthenaQueryFailedError} **Not yet implemented** — this
   *   placeholder throws it unconditionally without calling `send`. See
   *   `docs/reference/aws/athena.md`.
   */
  awaitResults(
    queryExecutionId: string,
    options?: AthenaAwaitOptions,
  ): Promise<AthenaQueryResult> {
    throw new M3LAthenaQueryFailedError(
      `awaitResults: not yet implemented (queryExecutionId=${queryExecutionId}, options=${JSON.stringify(options)}) — see docs/reference/aws/athena.md`,
      { queryExecutionId, status: "UNKNOWN" },
    );
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
