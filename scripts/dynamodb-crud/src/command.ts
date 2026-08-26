import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "./config.js";
import { getCorrelationId, hooks } from "./hooks.js";
import { runDynamodbCrud } from "./steps/run-dynamodb-crud.js";

// The ADR-0054 command-module seam: a SECOND, additive entry point that lets a
// host (`m3l` today, an agent runtime later) invoke this script in-process
// instead of spawning `dist/main.js` and reading an integer off a dead child.
//
// `main.ts` is deliberately untouched and does NOT delegate here. Both files
// compose `M3LScript`/`runScript` independently, which is the honest shape at
// U6: building an `M3LCommandContext` in `main.ts` would mean handing
// `execute` a caller-supplied logger, and `M3LScriptOptions.logger` documents
// that such a logger skips `resolveLogLevelFloor()` (internal, unexportable —
// so `--log-level`/`M3L_LOG_LEVEL` would silently stop working) and never
// receives the script's derived `secrets` (so declared secret parameters would
// stop being redacted). U7 unifies the two composition sites behind the
// library seam it has to add anyway; until then `tests/command.test.ts` is the
// anti-drift guard. Full record: `docs/reference/core/cli-contract.md`
// § What U6 shipped.

/**
 * The fallback operator-facing writer for a caller that has no host of its
 * own — `tests/command.test.ts` today, and any local invocation before U7's
 * in-process host ships its real renderer.
 *
 * `colorEnabled: false` is the truthful answer rather than a placeholder:
 * this writer never styles anything, and a script cannot resolve colour
 * anyway (per-stream TTY detection plus `NO_COLOR`/`FORCE_COLOR` needs
 * `process.env`, which the scripts ESLint zone bans). ADR-0054 keeps the real
 * rendering half private to `packages/m3l-cli`.
 */
export const consoleOutput: Core.M3LCommandOutput = {
  colorEnabled: false,
  info(text: string): void {
    process.stdout.write(`${text}\n`);
  },
  error(text: string): void {
    process.stderr.write(`${text}\n`);
  },
  heading(text: string): void {
    process.stdout.write(`${text}\n`);
  },
};

/**
 * Whether `error` is a cooperative-cancellation abort — classified by CODE,
 * never by class, per ADR-0049, so a structurally-equivalent abort raised
 * across a module boundary still classifies.
 *
 * This mirrors `core/script/run-script.ts`'s own private `isAbortError`, and
 * mirroring it is the point: `runScript` uses it to choose `INTERRUPTED` (5),
 * while `mapErrorToExitCode` is *typed* never to return that code. Reporting
 * an abort as `{ status: "failure" }` would therefore map to 1-4 while the
 * spawn path exited 5 — the exact parity break this contract exists to
 * prevent.
 */
function isAbortFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    Core.hasProperty(error, "code") &&
    error.code === "ERR_OPERATION_ABORTED"
  );
}

/**
 * Wraps this script's declared `hooks` with an `onError` that records every
 * pipeline failure into the returned `failures` array.
 *
 * The capture MUST go through `onError` rather than a `try`/`catch` around the
 * `mainFn` body: `mainFn` is stage 7 of the nine-stage pipeline, and stages
 * 1-6, 8 and 9 throw outside it — `config-load` (a missing or invalid
 * parameter, by far the most common real failure) most of all.
 * `M3LScript.runWithErrorHandling` invokes `onError` for EVERY stage's error
 * before re-throwing, and isolates it best-effort, so this capture observes
 * exactly the value `runScript` classifies and can never shadow it.
 *
 * The script's own `onError` (dynamodb-crud declares none today) is still invoked
 * with the same arguments, so composing the capture changes no observable
 * behaviour.
 */
function captureFailures(): {
  readonly hooks: Core.M3LScriptLifecycleHooks;
  readonly failures: readonly unknown[];
} {
  const failures: unknown[] = [];
  return {
    failures,
    hooks: {
      ...hooks,
      onError: (ctx, error) => {
        failures.push(error);
        return hooks.onError?.(ctx, error);
      },
    },
  };
}

/**
 * The run body — the same wiring `main.ts` passes to `Core.runScript`. Kept as
 * its own function so `execute` stays well inside `max-lines-per-function`.
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
  // `Core.runScript` and is captured by `captureFailures`' onError.
  //
  // `signal: script.signal` is the SCRIPT's own cancellation signal, not
  // `context.signal` — the host's signal is inert at U6 (see the header
  // comment). An abort raised through this one still classifies correctly,
  // because `toOutcome` maps it to `"interrupted"`.
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
 * Maps the run's observable end state to an `M3LCommandOutcome`, in
 * `runScript`'s own precedence order — failure/interrupted first, then
 * partial, then dry-run, then success — so
 * `mapCommandOutcomeToExitCode(outcome)` returns exactly the code `runScript`
 * already assigned to `process.exitCode`.
 *
 * `failures.length > 0` rather than a `let captured: unknown`: a thrown
 * `undefined` is representable, and would be indistinguishable from "nothing
 * was captured".
 *
 * `recovered` reports `recoveryTotal`, not `recovery.length` — the recovery
 * buffer is a ring truncated at `M3L_RECOVERY_LIMIT`, so `.length`
 * under-reports. The *predicate* stays `recovery.length > 0` to mirror
 * `run-script.ts` literally.
 *
 * Exported, and taking only the two-property slice of `M3LScript` it actually
 * reads rather than the whole instance, so `tests/command.test.ts` can drive
 * every arm — including the truncated-ring and thrown-`undefined` cases —
 * without constructing a script or reaching AWS. This is the parity-critical
 * function in the file; leaving it private would leave it untested.
 *
 * @param run - The finished run's recovery state (a real `M3LScript` satisfies
 *   this).
 * @param failures - Errors captured by {@link captureFailures}' `onError`.
 * @param dryRun - Whether this invocation performed no real work.
 * @returns The outcome whose mapped exit code equals `runScript`'s own.
 */
export function toOutcome(
  run: Pick<Core.M3LScript, "recovery" | "recoveryTotal">,
  failures: readonly unknown[],
  dryRun: boolean,
): Core.M3LCommandOutcome {
  if (failures.length > 0) {
    const failure = failures[0];
    return isAbortFailure(failure)
      ? { status: "interrupted" }
      : { status: "failure", error: failure };
  }
  if (run.recovery.length > 0) {
    return { status: "partial", recovered: run.recoveryTotal };
  }
  return dryRun ? { status: "dry-run" } : { status: "success" };
}

/**
 * The ADR-0054 command-module descriptor for `dynamodb-crud`.
 *
 * Annotated (`: Core.M3LCommandModule`) rather than `satisfies`:
 * `tsconfig.build.json` sets `isolatedDeclarations`, which rejects an exported
 * `satisfies` expression it cannot emit a declaration for.
 *
 * `TParameters` stays the default `Record<string, never>` — direct parameter
 * binding is U7's job. `M3LScriptOptions` has no seam to inject host-bound
 * values (precedence level 1 is built from `process.argv` inside the loader),
 * so configuration resolves ambiently through the library's own precedence
 * chain, exactly as it does on the spawn path.
 *
 * `context.output`, `context.logger` and `context.signal` are accepted and
 * deliberately NOT forwarded at U6 — see this module's header comment.
 */
export const commandModule: Core.M3LCommandModule = {
  name: "dynamodb-crud",
  version: "0.0.0",
  description:
    "CRUD, batch, and streaming operations against a DynamoDB table with checkpoint resume and destructive-op confirmation",
  configParameters,
  async execute(_parameters, context): Promise<Core.M3LCommandOutcome> {
    const capture = captureFailures();
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
    const script = new Core.M3LScript({
      metadata: { name: commandModule.name, version: commandModule.version },
      config: { params: configParameters },
      hooks: capture.hooks,
    });
    // Never throws, never calls `process.exit`: it installs the process
    // guards, logs the failure, persists the run report, and sets
    // `process.exitCode` — all the composition-root behaviour ADR-0054's
    // parity clause requires of the in-process path.
    await Core.runScript(script, () => runMain(script), {
      dryRun: context.dryRun,
    });
    return toOutcome(script, capture.failures, context.dryRun);
  },
};
