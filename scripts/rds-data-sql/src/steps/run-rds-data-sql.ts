/**
 * `steps/run-rds-data-sql` — composes the pipeline: preflight the secret,
 * then dispatch on `operation` to the matching read/write step, then map
 * `load`'s partial failure onto a thrown error.
 *
 * The only module that knows operation dispatch order. Business logic lives
 * here — never in `main.ts`. Per-operation dependency bags are built
 * upstream by `build-operation-deps.ts`; this module only routes to the
 * matching `run*` step and reacts to its result — see
 * `docs/reference/scripts/rds-data-sql.md`'s `run-rds-data-sql` row.
 */

import { Core, type AWS } from "@m3l-automation/m3l-common";

import { preflightSecret } from "./preflight-secret.js";
import { runExecute, type RunExecuteDeps } from "./run-execute.js";
import { runLoad, type RunLoadDeps } from "./run-load.js";
import { runMigrate, type RunMigrateDeps } from "./run-migrate.js";
import { runQuery, type RunQueryDeps } from "./run-query.js";

/** The `Core.M3LError` code {@link runRdsDataSql} throws with when `load` finishes with any row rejected to `failed.jsonl`. */
const PARTIAL_FAILURE_CODE = "ERR_RDS_DATA_SQL_PARTIAL_FAILURE";

/** The `Core.M3LError` code {@link runRdsDataSql} throws with when `deps.operation`'s matching deps bag was not supplied — a composition bug, never a user-facing config error. */
const MISSING_OPERATION_DEPS_CODE = "ERR_RDS_DATA_SQL_MISSING_OPERATION_DEPS";

/**
 * The narrow secret-preflight port {@link runRdsDataSql} depends on — the
 * one method it forwards to {@link preflightSecret}, kept structural
 * (rather than the full `AWS.M3LSecretsManagerOperations` class) so a plain
 * test double satisfies it without constructing the real class.
 */
interface RunRdsDataSqlSecretsManagerPort {
  /** Fetches metadata for the secret identified by `secretId`. */
  describeSecret(secretId: string): Promise<unknown>;
}

/**
 * Injected dependencies for {@link runRdsDataSql}. Only one of
 * `query`/`load`/`execute`/`migrate` is read, matching `operation` — the
 * caller (`main.ts`, via `build-operation-deps.ts`) builds exactly that one
 * bag. Each is typed as an opaque `Record<string, unknown>` here rather than
 * its concrete `Run*Deps` shape: this module's own job is routing, never
 * constructing or validating a step's dependencies.
 */
export interface RunRdsDataSqlDeps {
  /** Which of the four operations this run performs. */
  readonly operation: "query" | "load" | "execute" | "migrate";
  /** The secret-preflight port; see {@link RunRdsDataSqlSecretsManagerPort}. */
  readonly secretsManager: RunRdsDataSqlSecretsManagerPort;
  /** The Secrets Manager ARN preflight-validated before any operation runs. */
  readonly secretArn: string;
  /** The run's correlated logger. */
  readonly logger: Core.M3LLogger;
  /** `runQuery`'s deps bag; read only when `operation` is `"query"`. */
  readonly query?: Record<string, unknown>;
  /** `runLoad`'s deps bag; read only when `operation` is `"load"`. */
  readonly load?: Record<string, unknown>;
  /** `runExecute`'s deps bag; read only when `operation` is `"execute"`. */
  readonly execute?: Record<string, unknown>;
  /** `runMigrate`'s deps bag; read only when `operation` is `"migrate"`. */
  readonly migrate?: Record<string, unknown>;
}

/**
 * Narrows an opaque deps bag to `T`, at the one intentional decoupling
 * boundary between this composition-root module (which only routes) and the
 * concrete `run*` step it dispatches to (which requires its own typed deps).
 *
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_MISSING_OPERATION_DEPS"`
 *   when `bag` is `undefined`.
 */
function requireDeps<T>(
  bag: Record<string, unknown> | undefined,
  operation: string,
): T {
  if (bag === undefined) {
    throw new Core.M3LError(
      `runRdsDataSql: no deps bag was supplied for operation '${operation}'`,
      { code: MISSING_OPERATION_DEPS_CODE },
    );
  }
  return bag as unknown as T;
}

/**
 * Dispatches to the matching `run*` step for `deps.operation`, logs a run
 * summary, and maps `load`'s partial failure onto a thrown error — split out
 * of {@link runRdsDataSql} to keep its own complexity low.
 *
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_PARTIAL_FAILURE"`
 *   when `operation` is `"load"` and its resolved summary has `failed > 0`.
 * @throws Whatever the dispatched step throws, unchanged, for every other
 *   operation.
 */
async function dispatchOperation(deps: RunRdsDataSqlDeps): Promise<void> {
  switch (deps.operation) {
    case "query": {
      const result = await runQuery(
        requireDeps<RunQueryDeps>(deps.query, "query"),
      );
      deps.logger.step(
        `rds-data-sql query complete: rowsRead=${String(result.rowsRead)}`,
      );
      return;
    }
    case "load": {
      const result = await runLoad(requireDeps<RunLoadDeps>(deps.load, "load"));
      deps.logger.step(
        `rds-data-sql load complete: inserted=${String(result.inserted)}, failed=${String(result.failed)}`,
      );
      if (result.failed > 0) {
        throw new Core.M3LError(
          `load finished with ${String(result.failed)} row(s) rejected to failed.jsonl`,
          { code: PARTIAL_FAILURE_CODE },
        );
      }
      return;
    }
    case "execute": {
      const result = await runExecute(
        requireDeps<RunExecuteDeps>(deps.execute, "execute"),
      );
      deps.logger.step(
        `rds-data-sql execute complete: rowsAffected=${String(result.rowsAffected)}`,
      );
      return;
    }
    case "migrate": {
      const result = await runMigrate(
        requireDeps<RunMigrateDeps>(deps.migrate, "migrate"),
      );
      deps.logger.step(
        `rds-data-sql migrate complete: applied=${result.applied.join(", ")}`,
      );
      return;
    }
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: MISSING_OPERATION_DEPS_CODE,
      });
    }
  }
}

/**
 * Runs `rds-data-sql`'s pipeline: preflight-validates `deps.secretArn`, then
 * dispatches on `deps.operation` to the matching step, then maps `load`'s
 * partial failure onto a thrown error.
 *
 * @param deps - See {@link RunRdsDataSqlDeps}.
 * @throws Whatever `preflightSecret` throws, unchanged — no operation step
 *   runs when preflight fails.
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_PARTIAL_FAILURE"`
 *   when `operation` is `"load"` and its resolved summary has `failed > 0`.
 * @throws Whatever the dispatched step throws, unchanged, for every other
 *   operation.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { runRdsDataSql } from "./run-rds-data-sql.js";
 *
 * async function run(
 *   deps: Parameters<typeof runRdsDataSql>[0],
 * ): Promise<void> {
 *   try {
 *     await runRdsDataSql(deps);
 *   } catch (error) {
 *     if (error instanceof Core.M3LError) {
 *       deps.logger.error(error.message, { code: error.code });
 *     }
 *     throw error;
 *   }
 * }
 * ```
 */
export async function runRdsDataSql(deps: RunRdsDataSqlDeps): Promise<void> {
  await preflightSecret({
    // The composition-root contract narrows `secretsManager` to the one
    // method this step forwards; `preflightSecret` itself requires the full
    // concrete class (a nominal type, since it carries a private field), so
    // this cast crosses that intentional structural/nominal boundary — the
    // same pattern `preflight-secret.test.ts`'s `createFakeSecretsManager`
    // already uses for the same reason.
    secretsManager:
      deps.secretsManager as unknown as AWS.M3LSecretsManagerOperations,
    secretArn: deps.secretArn,
  });

  await dispatchOperation(deps);
}
