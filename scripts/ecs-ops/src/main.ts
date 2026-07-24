import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "./config.js";
import { hooks } from "./hooks.js";
import { runEcsOps } from "./steps/run-ecs-ops.js";

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
  metadata: { name: "ecs-ops", version: "0.0.0" },
  config: { params: configParameters },
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
    // `process.env` or a global. Add `script.aws` / `M3LPaths` dirs here too
    // when the step needs them.
    const config = await script.getConfiguration();
    await runEcsOps({ logger: script.logger, config });
  },
  { dryRun },
);
