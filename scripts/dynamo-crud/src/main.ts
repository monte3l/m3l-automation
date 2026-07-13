import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "./config.js";
import { getCorrelationId, hooks } from "./hooks.js";
import { runDynamoCrud } from "./steps/run-dynamo-crud.js";

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
  metadata: { name: "dynamo-crud", version: "0.0.0" },
  config: { params: configParameters },
  hooks,
});

await script.run(async () => {
  const config = await script.getConfiguration();
  const paths = script.paths;

  // This script always declares `aws.profile` (config.ts), so `script.aws`
  // is provisioned once configuration resolves; a still-`undefined` facade
  // here is a wiring bug, not a runtime condition — fail loud with a typed
  // error rather than a non-null assertion.
  const aws = script.aws;
  if (aws === undefined) {
    throw new Core.M3LError(
      "dynamo-crud: script.aws was not provisioned despite declaring 'aws.profile'",
      { code: "ERR_DYNAMO_CRUD_CONFIG" },
    );
  }

  // Any failure (including a partial batch failure left `failed > 0`, which
  // `runDynamoCrud` itself turns into an `ERR_DYNAMO_CRUD_FAILED_ITEMS`
  // throw) propagates out through `M3LScript.run` unchanged — that decision
  // is `runDynamoCrud`'s to make, not this composition root's.
  await runDynamoCrud({
    config,
    paths,
    logger: script.logger,
    correlationId: getCorrelationId(),
    dynamoDBDocument: aws.clients.dynamoDBDocument,
    dynamoDB: aws.clients.dynamoDB,
    confirm: (message) => script.prompt.confirm(message),
  });
});
