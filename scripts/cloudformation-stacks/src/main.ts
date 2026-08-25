import { AWS, Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "./config.js";
import { getCorrelationId, hooks } from "./hooks.js";
import { runCloudformationStacks } from "./steps/run-cloudformation-stacks.js";

// Composition root ONLY (ADR-0022): construct the script, wire config/hooks,
// and run the step. Any conditional, loop, or I/O beyond wiring belongs in a
// steps/ module — reviewers reject business logic here.
//
// `runScript`'s main function takes no arguments; reach the library through
// the script instance (`script.logger`, `await script.getConfiguration()`,
// `script.aws`) and inject what each step needs as parameters. Wrapping with
// `Core.runScript` (rather than bare `script.run`) adds process guards, a
// top-level catch with origin-specific `process.exitCode`, and a persisted
// run report; passing `{ dryRun }` runs validation stages 1-5 (env/config/AWS)
// without executing the main function.
const script = new Core.M3LScript({
  metadata: { name: "cloudformation-stacks", version: "0.0.0" },
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
    // Resolve the declared config (CLI + preset + env + defaults) and inject
    // what the step needs as a single options object — never reach for
    // `process.env` or a global.
    const config = await script.getConfiguration();

    // This script always declares `aws.profile` (config.ts), so `script.aws`
    // is provisioned once configuration resolves; a still-`undefined` facade
    // here is a wiring bug, not a runtime condition — fail loud with a typed
    // error rather than a non-null assertion.
    const aws = script.aws;
    if (aws === undefined) {
      throw new Core.M3LError(
        "cloudformation-stacks: script.aws was not provisioned despite declaring 'aws.profile'",
        { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
      );
    }

    // `script.awsTarget` is resolved alongside `script.aws` from the same
    // identity; a provisioned `script.aws` with an `undefined` `awsTarget`
    // is a wiring bug, not a runtime condition — fail loud rather than
    // threading an optional target through the destructive gate.
    const awsTarget = script.awsTarget;
    if (awsTarget === undefined) {
      throw new Core.M3LError(
        "cloudformation-stacks: script.awsTarget was not resolved despite a provisioned script.aws",
        { code: "ERR_CLOUDFORMATION_STACKS_CONFIG" },
      );
    }

    await runCloudformationStacks({
      config,
      paths: script.paths,
      logger: script.logger,
      correlationId: getCorrelationId(),
      operations: new AWS.M3LCloudFormationOperations(
        aws.clients.cloudFormation,
      ),
      prompt: script.prompt,
      signal: script.signal,
      awsTarget,
    });
  },
  { dryRun },
);
