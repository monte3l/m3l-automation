import { Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "./config.js";
import { hooks } from "./hooks.js";
import { PRESET_CODE } from "./steps/load-runbook.js";
import { runSqsDeadLetterTriage } from "./steps/run-sqs-dead-letter-triage.js";

// Composition root ONLY (ADR-0022): construct the script, wire config/hooks,
// and run the step. Any conditional, loop, or I/O beyond wiring belongs in a
// steps/ module — reviewers reject business logic here.
//
// `runScript`'s main function takes no arguments; reach the library through
// the script instance (`script.logger`, `await script.getConfiguration()`,
// `script.paths`, `script.prompt`) and inject what each step needs as
// parameters. This slice never declares `aws.profile` — every operation runs
// with no AWS credentials at all, which is what lets `validate` be a CI
// gate.
const script = new Core.M3LScript({
  metadata: { name: "sqs-dead-letter-triage", version: "0.0.0" },
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
    await runSqsDeadLetterTriage({
      config,
      logger: script.logger,
      prompt: script.prompt,
      paths: script.paths,
      reader: new Core.M3LInputFileReader({
        paths: script.paths,
        code: PRESET_CODE,
      }),
    });
  },
  { dryRun },
);
