import { Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "./config.js";
import { hooks } from "./hooks.js";
import { buildOperationDeps } from "./steps/build-operation-deps.js";
import { resolveRdsDataSqlSettings } from "./steps/resolve-settings.js";
import { runRdsDataSql } from "./steps/run-rds-data-sql.js";

// Composition root ONLY (ADR-0022): construct the script, wire config/hooks,
// and run the step. Any conditional, loop, or I/O beyond wiring belongs in a
// steps/ module — reviewers reject business logic here.
//
// `paths` is constructed here (not read back from `script.paths`) because
// `M3LScript`'s hooks are wired at construction time, before `script.paths`
// exists — this is the one authoritative `M3LPaths` instance for the run,
// threaded straight into `buildOperationDeps` below (mirrors
// `athena-query/src/main.ts`).
const paths = new Core.M3LPaths();

const script = new Core.M3LScript({
  metadata: { name: "rds-data-sql", version: "0.0.0" },
  config: { params: configParameters, validate: configValidators },
  hooks,
});

// A --dry-run switch validates environment, configuration, and AWS
// credentials (pipeline stages 1-5) without executing the run — the one
// argv read the composition root is permitted.
const dryRun = process.argv.includes("--dry-run");

await Core.runScript(
  script,
  async () => {
    const config = await script.getConfiguration();
    const settings = resolveRdsDataSqlSettings(config);

    // `script.aws` is `AWSProvider | undefined` at the type level (only
    // provisioned when `aws.profile` is declared) — declaring `aws.profile`
    // in `config.ts` always provisions it here, but the guard is required
    // since the type doesn't guarantee it; never a `!` assertion.
    if (script.aws === undefined) {
      throw new Core.M3LError(
        "script.aws was not provisioned despite a declared 'aws.profile' parameter",
        { code: "ERR_RDS_DATA_SQL_NO_AWS_PROVIDER" },
      );
    }

    // `script.awsTarget` is `M3LDestructiveTarget | undefined` at the type
    // level, but `aws.profile` is declared `required: true` + `nonEmpty`
    // above, so it is always resolved whenever `script.aws` is provisioned —
    // the guard is required since the type doesn't guarantee it, never a `!`
    // assertion.
    const awsTarget = script.awsTarget;
    if (awsTarget === undefined) {
      throw new Core.M3LError(
        "rds-data-sql: script.awsTarget was not resolved despite a provisioned script.aws",
        { code: "ERR_RDS_DATA_SQL_NO_AWS_PROVIDER" },
      );
    }

    const operationDeps = await buildOperationDeps({
      settings,
      rdsData: script.aws.services.rdsDataOperations,
      prompt: script.prompt,
      paths,
      logger: script.logger,
      reportRecovery: script.reportRecovery.bind(script),
      awsTarget,
    });

    await runRdsDataSql({
      operation: settings.operation,
      secretsManager: script.aws.services.secretsManager,
      secretArn: settings.secretArn,
      logger: script.logger,
      // `buildOperationDeps` returns the concrete, per-operation `Run*Deps`
      // shape (`RunQueryDeps`/`RunLoadDeps`/…); `runRdsDataSql`'s own
      // composition-root contract deliberately narrows those to opaque
      // `Record<string, unknown>` bags (it only routes, never constructs or
      // validates a step's dependencies) — this single cast crosses that
      // intentional boundary, exactly once, still keeping every other field
      // above individually type-checked.
      ...(operationDeps as unknown as Record<string, unknown>),
    });
  },
  { dryRun },
);
