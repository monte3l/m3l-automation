/**
 * `steps/run-execute` — runs `sql`/`sql.file` once (bound to a
 * `parameters.file`-sourced parameter set, if set), reporting rows affected.
 *
 * Business logic lives here — never in `main.ts`. Anything other than a
 * plain `SELECT` is gated behind {@link Core.confirmDestructive} before it
 * runs, per `docs/reference/scripts/rds-data-sql.md`'s `run-execute` row.
 */

import { Core, type AWS } from "@m3l-automation/m3l-common";

/** The `Core.M3LError` code {@link Core.confirmDestructive} throws with when the operator declines. */
const ABORTED_CODE = "ERR_RDS_DATA_SQL_ABORTED";

/**
 * A leading `--…` line comment or `/*…*\/` block comment, matched to strip
 * repeatedly ahead of {@link firstKeyword}'s classification. Only ever tested
 * against a string already `.trimStart()`-ed, so no leading-whitespace
 * alternative is needed here.
 */
const LEADING_LINE_COMMENT = "--";
const LEADING_BLOCK_COMMENT_OPEN = "/*";
const LEADING_BLOCK_COMMENT_CLOSE = "*/";

/** Matches a SQL keyword token (letters/digits/underscore, not starting with a digit) at the start of a string. */
const KEYWORD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;

/** The keyword token that, alone, exempts a statement from the destructive-op gate. */
const SELECT_KEYWORD = "SELECT";

/** Injected dependencies for {@link runExecute}. */
export interface RunExecuteDeps {
  /** The provisioned RDS Data API operations wrapper (only `executeStatement` is used). */
  readonly rdsData: Pick<AWS.M3LRDSDataOperations, "executeStatement">;
  /** The Aurora cluster/instance ARN. */
  readonly resourceArn: string;
  /** The Secrets Manager ARN holding the database credentials. */
  readonly secretArn: string;
  /** The target database name, when set. */
  readonly database?: string;
  /** The target schema name, when set. */
  readonly schema?: string;
  /** The statement to run (already resolved from `sql`/`sql.file`). */
  readonly sql: string;
  /** Named parameters bound to `sql` (resolved from `parameters.file`, or `[]`). */
  readonly parameters: readonly AWS.M3LRDSDataParameter[];
  /** Bypasses the interactive destructive-op confirmation when `true`. */
  readonly yes: boolean;
  /** The prompt facade used by {@link Core.confirmDestructive} to ask for confirmation. */
  readonly prompt: Core.M3LPrompt;
  /** The logger used by {@link Core.confirmDestructive} to record a bypass warning. */
  readonly logger: Core.M3LLogger;
}

/** The outcome of {@link runExecute}. */
export interface RunExecuteResult {
  /** The number of rows inserted/updated/deleted by the statement (`0` for a `SELECT`). */
  readonly rowsAffected: number;
}

/**
 * Strips a leading `--…`-to-EOL comment or a leading `/*…*\/` block comment
 * from `sql`, repeating until neither remains, after first stripping leading
 * whitespace. String-first (`startsWith`/`indexOf`), no regex.
 *
 * @param sql - The raw statement text.
 * @returns `sql` with its leading whitespace/comment run removed.
 */
function stripLeadingCommentary(sql: string): string {
  let remainder = sql.trimStart();
  for (;;) {
    if (remainder.startsWith(LEADING_LINE_COMMENT)) {
      const newlineIndex = remainder.indexOf("\n");
      remainder = newlineIndex === -1 ? "" : remainder.slice(newlineIndex + 1);
      remainder = remainder.trimStart();
      continue;
    }
    if (remainder.startsWith(LEADING_BLOCK_COMMENT_OPEN)) {
      const closeIndex = remainder.indexOf(LEADING_BLOCK_COMMENT_CLOSE);
      remainder =
        closeIndex === -1
          ? ""
          : remainder.slice(closeIndex + LEADING_BLOCK_COMMENT_CLOSE.length);
      remainder = remainder.trimStart();
      continue;
    }
    return remainder;
  }
}

/**
 * The statement's first keyword token (e.g. `SELECT`, `WITH`, `UPDATE`),
 * uppercased, after stripping leading whitespace/comments. `""` when no
 * keyword-shaped token is found (an empty or comment-only statement).
 */
function firstKeyword(sql: string): string {
  const normalized = stripLeadingCommentary(sql);
  const match = KEYWORD_PATTERN.exec(normalized);
  return match === null ? "" : match[0].toUpperCase();
}

/**
 * Whether `sql`'s first keyword token is `SELECT`. This is a **convenience
 * gate, not a security control** — a side-effecting function called from
 * inside a `SELECT` is not detected, and a `WITH ... AS (...) SELECT ...`
 * CTE's first token is `WITH`, so it is **not** treated as a `SELECT` and is
 * still routed through {@link Core.confirmDestructive}.
 *
 * @param sql - The statement to classify.
 * @returns `true` when the statement's first keyword is `SELECT`.
 */
function isPlainSelect(sql: string): boolean {
  return firstKeyword(sql) === SELECT_KEYWORD;
}

/**
 * Runs `deps.sql` once, gating anything other than a plain `SELECT` behind
 * {@link Core.confirmDestructive}.
 *
 * @param deps - See {@link RunExecuteDeps}.
 * @returns The number of rows affected.
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_ABORTED"` when the
 *   statement is not a plain `SELECT` and the operator declines confirmation
 *   (or a rejection from `deps.prompt.confirm` propagates unchanged) — in
 *   either case `deps.rdsData.executeStatement` is never called.
 *
 * @example
 * ```ts
 * import { Core, type AWS } from "@m3l-automation/m3l-common";
 * import { runExecute } from "./run-execute.js";
 *
 * async function run(
 *   rdsData: Pick<AWS.M3LRDSDataOperations, "executeStatement">,
 *   prompt: Core.M3LPrompt,
 *   logger: Core.M3LLogger,
 * ): Promise<void> {
 *   const { rowsAffected } = await runExecute({
 *     rdsData,
 *     resourceArn: "arn:aws:rds:us-east-1:123456789012:cluster:my-cluster",
 *     secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret",
 *     sql: "DELETE FROM stale_rows WHERE created_at < :cutoff",
 *     parameters: [
 *       { name: "cutoff", value: { kind: "string", value: "2026-01-01" } },
 *     ],
 *     yes: false,
 *     prompt,
 *     logger,
 *   });
 *   logger.step(`rows affected: ${String(rowsAffected)}`);
 * }
 * ```
 */
export async function runExecute(
  deps: RunExecuteDeps,
): Promise<RunExecuteResult> {
  if (!isPlainSelect(deps.sql)) {
    await Core.confirmDestructive({
      prompt: deps.prompt,
      logger: deps.logger,
      // Never pass the full statement text here: it can carry a secret
      // value (e.g. `ALTER ROLE ... WITH PASSWORD ...`) that
      // `Core.confirmDestructive` surfaces in a bypass-warning log line and
      // in the thrown-on-decline error message — either of which
      // `Core.runScript` can persist into an on-disk run report.
      description: `run ${firstKeyword(deps.sql)} statement (${String(deps.sql.length)} chars)`,
      yes: deps.yes,
      code: ABORTED_CODE,
    });
  }

  const result = await deps.rdsData.executeStatement({
    resourceArn: deps.resourceArn,
    secretArn: deps.secretArn,
    sql: deps.sql,
    ...(deps.database !== undefined && { database: deps.database }),
    ...(deps.schema !== undefined && { schema: deps.schema }),
    parameters: deps.parameters,
  });

  return { rowsAffected: result.numberOfRecordsUpdated };
}
