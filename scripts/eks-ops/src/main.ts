import { AWS, Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "./config.js";
import { hooks } from "./hooks.js";
import { runEksOps } from "./steps/run-eks-ops.js";

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
  metadata: { name: "eks-ops", version: "0.0.0" },
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
        "eks-ops: script.aws was not provisioned despite declaring 'aws.profile'",
        { code: "ERR_EKS_OPS_CONFIG" },
      );
    }

    await runEksOps({
      config,
      paths: script.paths,
      logger: script.logger,
      operations: new AWS.M3LEKSOperations(aws.clients.eks),
      prompt: script.prompt,
    });
  },
  { dryRun },
);
