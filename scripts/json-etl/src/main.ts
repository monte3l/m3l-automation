import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "./config.js";
import { getCorrelationId, hooks } from "./hooks.js";
import { resolvePresetOption } from "./steps/resolve-preset.js";
import { runJsonEtl } from "./steps/run-json-etl.js";

// Composition root ONLY (ADR-0022): construct the script, wire config/hooks,
// and run the step. Any conditional, loop, or I/O beyond wiring belongs in a
// steps/ module — reviewers reject business logic here.
//
// `run`'s main function takes no arguments; reach the library through the
// script instance (`script.logger`, `await script.getConfiguration()`,
// `script.aws`, `script.paths`) and inject what each step needs as
// parameters. The per-run correlation id is captured by `hooks.onBeforeRun`
// (mainFn itself receives no `ctx`) and read back via `getCorrelationId()`.
const script = new Core.M3LScript({
  metadata: { name: "json-etl", version: "0.0.0" },
  config: { params: configParameters },
  hooks,
  ...resolvePresetOption(),
});

await script.run(async () => {
  const config = await script.getConfiguration();
  const paths = script.paths;
  await runJsonEtl({
    config,
    paths,
    logger: script.logger,
    correlationId: getCorrelationId(),
  });
});
