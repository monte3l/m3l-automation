import { Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "./config.js";
import { getCorrelationId, hooks } from "./hooks.js";
import { resolvePresetOption } from "./steps/resolve-preset.js";
import { runJsonEtl } from "./steps/run-json-etl.js";

// The ADR-0054 command-module seam: a SECOND, additive entry point that lets a
// host (`m3l` today, an agent runtime later) invoke this script in-process
// instead of spawning `dist/main.js` and reading an integer off a dead child.
//
// U7 unified the two composition sites: `main.ts` now delegates to
// `commandModule.execute` rather than composing its own independent
// `M3LScript`. Full record: `docs/reference/core/cli-contract.md`
// § What U7 shipped.

/**
 * The run body — the same wiring `main.ts` passes to `Core.runScript` via
 * `execute`. Kept as its own function so `execute` stays well inside
 * `max-lines-per-function`.
 *
 * `getCorrelationId()` is read HERE, inside the `mainFn` closure, never
 * hoisted into `execute`: it throws `ERR_JSON_ETL_NO_CORRELATION_ID` until
 * `hooks.onBeforeRun` (stage 6) has fired, and `execute`'s own body runs
 * before stage 1.
 */
async function runMain(script: Core.M3LScript): Promise<void> {
  const config = await script.getConfiguration();
  const paths = script.paths;
  await runJsonEtl({
    config,
    paths,
    logger: script.logger,
    correlationId: getCorrelationId(),
  });
}

/**
 * The ADR-0054 command-module descriptor for `json-etl`.
 *
 * Annotated (`: Core.M3LCommandModule`) rather than `satisfies`:
 * `tsconfig.build.json` sets `isolatedDeclarations`, which rejects an exported
 * `satisfies` expression it cannot emit a declaration for.
 *
 * `TParameters` stays the default `Record<string, never>`: direct parameter
 * binding is a CLI-side (U7b) concern, not this seam's job.
 * `M3LScriptOptions` now HAS a host seam (`host.signal`, wired below from
 * `context.signal`), and `context.logger` is forwarded straight through —
 * see this seam's own `Core.createCommandLogger`, which is what a host uses
 * to build a logger that still resolves the log-level floor and this
 * script's derived secrets.
 */
export const commandModule: Core.M3LCommandModule = {
  name: "json-etl",
  version: "0.0.0",
  description:
    "JSON and NDJSON file ETL: extract fields, filter records, export to json, jsonl, csv, or html",
  configParameters,
  async execute(_parameters, context): Promise<Core.M3LCommandOutcome> {
    const capture = Core.captureRunFailures(hooks);
    // The descriptor stays the single source of truth for this script's name
    // and version — but only those two fields are handed over. Passing
    // `commandModule` itself typechecks (an `M3LCommandModule` IS structurally
    // an `M3LScriptMetadata`) and is WRONG: `M3LRunReporter` passes
    // `input.script` through verbatim, and it is the one report field NOT run
    // through `sanitizeValue`. The whole descriptor would therefore serialize
    // into `run-report.json` — `description` plus every `M3LConfigParameter`'s
    // name, type, aliases and `defaultValue` — where the spawn path writes
    // only `{ name, version }`. That breaks parity in the very artifact
    // ADR-0054's parity clause is about, and writes a secret parameter's
    // default into an unredacted field.
    //
    // `validate: configValidators` is wired here as well as in `main.ts`:
    // declaring the array proves nothing about enforcement, and a validator
    // wired in one composition site is not wired in the other.
    const signal = context.signal;
    const script = new Core.M3LScript({
      metadata: { name: commandModule.name, version: commandModule.version },
      config: { params: configParameters, validate: configValidators },
      hooks: capture.hooks,
      logger: context.logger,
      ...(signal !== undefined ? { host: { signal } } : {}),
      ...resolvePresetOption(),
    });
    // Never throws, never calls `process.exit`: it installs the process
    // guards, logs the failure, persists the run report, and sets
    // `process.exitCode` — all the composition-root behaviour ADR-0054's
    // parity clause requires of the in-process path.
    await Core.runScript(script, () => runMain(script), {
      dryRun: context.dryRun,
    });
    return Core.deriveCommandOutcome(script, capture.failures, context.dryRun);
  },
};
