import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "./config.js";
import { getCorrelationId, hooks } from "./hooks.js";
import { runS3Objects } from "./steps/run-s3-objects.js";

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
  metadata: { name: "s3-objects", version: "0.0.0" },
  config: { params: configParameters },
  hooks,
});

await script.run(async () => {
  const config = await script.getConfiguration();

  // Declaring `aws.profile` (Core.AWS_PROFILE_PARAM_NAME) in config.ts
  // triggers M3LScript's AWS-provisioning stage before mainFn runs, so
  // `script.aws` is defined here — the undefined branch only guards against
  // a future wiring regression (e.g. the parameter being dropped from
  // config.ts), never an expected runtime path.
  const aws = script.aws;
  if (aws === undefined) {
    throw new Core.M3LError(
      "AWS was not provisioned — declare 'aws.profile' in config.ts to enable script.aws",
      { code: "ERR_S3_OBJECTS_CONFIG" },
    );
  }

  await runS3Objects({
    config,
    paths: script.paths,
    logger: script.logger,
    correlationId: getCorrelationId(),
    s3: aws.clients.s3,
    prompt: script.prompt,
  });
});
