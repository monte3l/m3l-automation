import { AWS, Core } from "@m3l-automation/m3l-common";

import { configParameters } from "./config.js";
import { buildHooks } from "./hooks.js";
import { runCloudwatchLogsInsights } from "./steps/run-cloudwatch-logs-insights.js";

// Composition root ONLY (ADR-0022): construct the script, wire config/hooks,
// and run the step. Any conditional, loop, or I/O beyond wiring belongs in a
// steps/ module — reviewers reject business logic here.
//
// `run`'s main function takes no arguments; reach the library through the
// script instance (`script.logger`, `await script.getConfiguration()`,
// `script.aws`, `script.paths`) and inject what each step needs as
// parameters.
//
// `paths` is constructed here (not read back from `script.paths`) because
// `M3LScript`'s hooks are wired at construction time, before `script.paths`
// exists — this is the one authoritative `M3LPaths` instance for the run,
// threaded into both `buildHooks` and `runCloudwatchLogsInsights` below.
const paths = new Core.M3LPaths();

const script = new Core.M3LScript({
  metadata: { name: "cloudwatch-logs-insights", version: "0.0.0" },
  config: { params: configParameters },
  hooks: buildHooks(paths),
});

// A --dry-run switch validates environment, configuration, and AWS
// credentials (pipeline stages 1-5) without executing the run — the one
// argv read the composition root is permitted.
const dryRun = process.argv.includes("--dry-run");

await Core.runScript(
  script,
  async () => {
    const config = await script.getConfiguration();

    // `script.aws` is `AWSProvider | undefined` at the type level (only
    // provisioned when `aws.profile` is declared) — declaring `aws.profile`
    // in `config.ts` always provisions it here, but the guard is required
    // since the type doesn't guarantee it; never a `!` assertion.
    if (script.aws === undefined) {
      throw new Core.M3LError(
        "script.aws was not provisioned despite a declared 'aws.profile' parameter",
        { code: "ERR_LOGS_INSIGHTS_NO_AWS_PROVIDER" },
      );
    }

    const client = new AWS.M3LLogsInsightsClient(
      script.aws.clients.cloudWatchLogs,
    );

    await runCloudwatchLogsInsights({
      config,
      logger: script.logger,
      client,
      paths,
    });
  },
  { dryRun },
);
