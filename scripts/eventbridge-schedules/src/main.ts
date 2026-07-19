import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "./config.js";
import { getCorrelationId, hooks } from "./hooks.js";
import { runEventbridgeSchedules } from "./steps/run-eventbridge-schedules.js";

// Composition root ONLY (ADR-0022): construct the script, wire config/hooks,
// and run the step. Any conditional, loop, or I/O beyond wiring belongs in a
// steps/ module — reviewers reject business logic here.
//
// `run`'s main function takes no arguments; reach the library through the
// script instance (`script.logger`, `await script.getConfiguration()`,
// `script.aws`, `script.paths`, `script.prompt`) and inject what each step
// needs as parameters. The per-run correlation id is captured by
// `hooks.onBeforeRun` (mainFn itself receives no `ctx`) and read back via
// `getCorrelationId()`.
const script = new Core.M3LScript({
  metadata: { name: "eventbridge-schedules", version: "0.0.0" },
  config: { params: configParameters },
  hooks,
});

await script.run(async () => {
  const config = await script.getConfiguration();

  // This script always declares `aws.profile` (config.ts), so `script.aws`
  // is provisioned once configuration resolves; a still-`undefined` facade
  // here is a wiring bug, not a runtime condition — fail loud with a typed
  // error rather than a non-null assertion.
  const aws = script.aws;
  if (aws === undefined) {
    throw new Core.M3LError(
      "eventbridge-schedules: script.aws was not provisioned despite declaring 'aws.profile'",
      { code: "ERR_EVENTBRIDGE_SCHEDULES_CONFIG" },
    );
  }

  await runEventbridgeSchedules({
    config,
    paths: script.paths,
    logger: script.logger,
    correlationId: getCorrelationId(),
    eventBridgeOperations: aws.clients.eventBridgeOperations,
    prompt: script.prompt,
  });
});
