import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "./config.js";
import { getCorrelationId, hooks } from "./hooks.js";
import { runDynamodbCrud } from "./steps/run-dynamodb-crud.js";

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
 * hoisted into `execute`: it throws `ERR_DYNAMO_CRUD_NO_CORRELATION_ID` until
 * `hooks.onBeforeRun` (stage 6) has fired, and `execute`'s own body runs
 * before stage 1.
 */
async function runMain(script: Core.M3LScript): Promise<void> {
  const config = await script.getConfiguration();
  const paths = script.paths;

  // This script always declares `aws.profile` (config.ts), so `script.aws`
  // is provisioned once configuration resolves; a still-`undefined` facade
  // here is a wiring bug, not a runtime condition — fail loud with a typed
  // error rather than a non-null assertion.
  const aws = script.aws;
  if (aws === undefined) {
    throw new Core.M3LError(
      "dynamodb-crud: script.aws was not provisioned despite declaring 'aws.profile'",
      { code: "ERR_DYNAMO_CRUD_CONFIG" },
    );
  }

  // A provisioned script.aws always resolves script.awsTarget alongside it
  // (M3LScript derives one from the other); a still-`undefined` value here
  // is a wiring bug, not a runtime condition — fail loud rather than a
  // non-null assertion.
  const awsTarget = script.awsTarget;
  if (awsTarget === undefined) {
    throw new Core.M3LError(
      "dynamodb-crud: script.awsTarget was not resolved despite a provisioned script.aws",
      { code: "ERR_DYNAMO_CRUD_CONFIG" },
    );
  }

  // A partial batch failure (items left `failed > 0` after retry) is not
  // fatal: `runDynamodbCrud` reports each unprocessed item via
  // `reportRecovery` (bound from `script.reportRecovery`, never the whole
  // `script` object), which demotes this run to `{ status: "partial" }`
  // instead of throwing. Any other failure propagates out through
  // `Core.runScript` and is captured by `Core.captureRunFailures`' onError.
  //
  // `signal: script.signal` is the SCRIPT's own cancellation signal — it is
  // now derived from `context.signal` too, since `execute` bridges
  // `context.signal` into `M3LScriptOptions.host.signal` below. An abort
  // raised through this one still classifies correctly, because
  // `Core.deriveCommandOutcome` maps it to `"interrupted"`.
  await runDynamodbCrud({
    config,
    paths,
    logger: script.logger,
    correlationId: getCorrelationId(),
    dynamoDBDocument: aws.clients.dynamoDBDocument,
    dynamoDB: aws.clients.dynamoDB,
    prompt: script.prompt,
    reportRecovery: script.reportRecovery.bind(script),
    signal: script.signal,
    awsTarget,
  });
}

/**
 * The ADR-0054 command-module descriptor for `dynamodb-crud`.
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
  name: "dynamodb-crud",
  version: "0.0.0",
  description:
    "CRUD, batch, and streaming operations against a DynamoDB table with checkpoint resume and destructive-op confirmation",
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
    // No `validate:` — dynamodb-crud declares no `configValidators` today.
    // Adding one means wiring it in BOTH composition sites.
    const signal = context.signal;
    const script = new Core.M3LScript({
      metadata: { name: commandModule.name, version: commandModule.version },
      config: { params: configParameters },
      hooks: capture.hooks,
      logger: context.logger,
      ...(signal !== undefined ? { host: { signal } } : {}),
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
