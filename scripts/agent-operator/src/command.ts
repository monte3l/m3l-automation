import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "./config.js";
import { hooks } from "./hooks.js";
import { runAgentOperator } from "./steps/run-agent-operator.js";

// The ADR-0054 command-module seam: a SECOND, additive entry point that lets a
// host (`m3l` today, an agent runtime later) invoke this script in-process
// instead of spawning `dist/main.js` and reading an integer off a dead child.
//
// U7 unified the two composition sites: `main.ts` now delegates to
// `commandModule.execute` rather than composing its own independent
// `M3LScript`. Full record: `docs/reference/core/cli-contract.md`
// § What U7 shipped.

/**
 * Reads this package's own `description` from `package.json` at runtime
 * rather than embedding `Policy-gated agent that operates and health-checks the m3l fleet` as a TS string literal directly:
 * `--purpose` is free-form prose up to 200 characters, and prettier breaks a
 * long string-valued object property onto its own line (unlike a JSON string,
 * which it never reflows regardless of length) — so a literal embedding here
 * would make `command.ts` fail `pnpm format:check` for any purpose long
 * enough to push the line past 80 columns, which `packages/m3l-cli/src/scaffold/generate.ts`
 * has no `prettier` dependency to fix at scaffold time (ADR-0053 U9).
 * `package.json`'s own `"description": "Policy-gated agent that operates and health-checks the m3l fleet"` is already proven
 * stable for every length, so this reads the same value from there instead.
 */
function scriptDescription(): string {
  const packageJsonPath = fileURLToPath(
    new URL("../package.json", import.meta.url),
  );
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    readonly description: string;
  };
  return manifest.description;
}

/**
 * The run body — the same wiring `main.ts` passes to `Core.runScript` via
 * `execute`. Kept as its own function so `execute` stays well inside
 * `max-lines-per-function` as the script grows.
 */
async function runMain(script: Core.M3LScript): Promise<void> {
  // Resolve the declared config (CLI + preset + env + defaults) and inject
  // what the step needs as a single options object — never reach for
  // `process.env` or a global. This script declares
  // `Core.AWS_PROFILE_PARAM_NAME`, so `script.aws`/`script.awsTarget` are
  // provisioned before this point too — but PR 1 is offline (no Bedrock
  // client), so neither is threaded here: only what `runAgentOperator`
  // actually consumes is passed, never a dead "assert AWS is provisioned"
  // guard for a value this slice never reads.
  const config = await script.getConfiguration();
  await runAgentOperator({
    config,
    logger: script.logger,
    paths: script.paths,
    signal: script.signal,
    // Bound from `script.reportRecovery` (never the whole `script` object)
    // so a future per-action absorbed failure demotes this run's outcome to
    // `"partial"` instead of a silent `"success"`.
    reportRecovery: script.reportRecovery.bind(script),
  });
}

/**
 * The ADR-0054 command-module descriptor for `agent-operator`:
 * Policy-gated agent that operates and health-checks the m3l fleet
 *
 * Annotated (`: Core.M3LCommandModule`) rather than `satisfies`:
 * `tsconfig.build.json` sets `isolatedDeclarations`, which rejects an
 * exported `satisfies` expression it cannot emit a declaration for.
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
  name: "agent-operator",
  version: "0.0.0",
  description: scriptDescription(),
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
