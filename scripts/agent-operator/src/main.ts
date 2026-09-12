import { Core } from "@m3l-automation/m3l-common";

import { commandModule } from "./command.js";
import { configParameters } from "./config.js";

// Composition root ONLY (ADR-0022): delegate to the ADR-0054 command-module
// descriptor rather than composing a second, independent M3LScript. U7
// (docs/reference/core/cli-contract.md § "What U7 shipped") retired the
// prior two-composition-site shape once the library gained a seam for a
// host-supplied logger (`Core.createCommandLogger`) that still carries the
// resolved `--log-level`/`M3L_LOG_LEVEL` floor and this script's own derived
// secrets — the thing a raw `M3LScriptOptions.logger` would have skipped.
const output = Core.createCommandOutput();
const logger = Core.createCommandLogger({
  handlers: [new Core.M3LConsoleLoggerHandler()],
  configParameters,
});

// A --dry-run switch validates environment, configuration, and AWS
// credentials (pipeline stages 1-5) without executing the run — the one
// argv read this composition root is permitted.
const dryRun = process.argv.includes("--dry-run");

const outcome = await commandModule.execute(
  {},
  { output, logger, signal: undefined, dryRun },
);
// `Core.runScript` inside `execute` already assigned `process.exitCode`;
// this makes the mapping explicit rather than relying on that side effect —
// the same mapping a future in-process CLI host applies to the same outcome.
process.exitCode = Core.mapCommandOutcomeToExitCode(outcome);
