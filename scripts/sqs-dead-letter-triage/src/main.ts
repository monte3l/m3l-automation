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
// `script.aws`, `script.paths`, `script.prompt`, `script.signal`) and inject
// what each step needs as parameters.
//
// `aws.profile` is declared here (so `M3LScript.provisionAws` always
// provisions `script.aws`) but not `required: true`, because
// `validate`/`explain`/`convert` must stay runnable with no credentials at
// all. `script.aws` is `undefined` below ONLY if provisioning itself failed
// (`M3LAWSProvisioningError`) — an absent/empty `aws.profile` is still a
// valid config that defers to the SDK's default credential chain, not a
// route to `undefined`. `triage` does not pre-flight credentials; it simply
// fails at the first AWS call it makes. The `undefined` guard below is
// defence-in-depth for a genuine provisioning failure, not a documented
// "no AWS configured" branch.
// `dispatchTriage`/`dispatchExecute` are the handlers that insist on a
// client, and fail loud, naming `aws.profile`, when they have none.
// `script.awsTarget` is threaded straight through as-is — it is already
// `M3LDestructiveTarget | undefined`, resolved from the same identity
// `script.aws`'s clients were provisioned with; never construct one by hand.
// `reportRecovery` is bound from `script.reportRecovery` (never the whole
// `script` object) so a per-message `execute --apply` failure demotes this
// run's outcome to `"partial"` instead of a silent `"success"`.
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
    const aws = script.aws;
    await runSqsDeadLetterTriage({
      config,
      logger: script.logger,
      prompt: script.prompt,
      paths: script.paths,
      reader: new Core.M3LInputFileReader({
        paths: script.paths,
        code: PRESET_CODE,
      }),
      sqs: aws === undefined ? undefined : aws.services.sqsOperations,
      dynamo: aws === undefined ? undefined : aws.services.dynamoDBOperations,
      awsTarget: script.awsTarget,
      signal: script.signal,
      reportRecovery: script.reportRecovery.bind(script),
    });
  },
  { dryRun },
);
