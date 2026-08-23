import { AWS, Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "./config.js";
import { getCorrelationId, hooks } from "./hooks.js";
import { runCloudwatchLogsAnalysis } from "./steps/run-cloudwatch-logs-analysis.js";

// Composition root ONLY (ADR-0022): construct the script, wire config/hooks,
// and run the step. Any conditional, loop, or I/O beyond wiring belongs in a
// steps/ module — reviewers reject business logic here.
//
// `run`'s main function takes no arguments; reach the library through the
// script instance (`script.logger`, `await script.getConfiguration()`,
// `script.aws`, `script.paths`, `script.prompt`) and inject what each step
// needs as parameters. The per-run correlation id is captured by
// `hooks.onBeforeRun` and read back via `getCorrelationId()`.
const script = new Core.M3LScript({
  metadata: { name: "cloudwatch-logs-analysis", version: "0.0.0" },
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

    // Unlike every other AWS script in the fleet, `script.aws` being
    // `undefined` is a legitimate state here rather than a wiring bug:
    // `aws.profile` is declared (so the facade CAN be provisioned) but not
    // `required: true`, because `validate`/`explain`/`convert` must stay
    // runnable with no credentials at all. The `analyze` handler is the one
    // that insists on a client, and it fails loud when it has none.
    const aws = script.aws;

    await runCloudwatchLogsAnalysis({
      config,
      paths: script.paths,
      logger: script.logger,
      prompt: script.prompt,
      correlationId: getCorrelationId(),
      client:
        aws === undefined
          ? undefined
          : new AWS.M3LLogsInsightsClient(aws.clients.cloudWatchLogs),
      signal: script.signal,
    });
  },
  { dryRun },
);
