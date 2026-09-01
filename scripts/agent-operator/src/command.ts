import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "./config.js";
import { hooks } from "./hooks.js";
import { M3LAgentOperatorCliError } from "./lib/errors.js";
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
 * Narrows a `JSON.parse` result to a plain JSON object — non-null, not an
 * array. Written as a type predicate rather than an `as` cast so the shape is
 * actually checked at runtime instead of merely asserted.
 *
 * @param value - The parsed value to narrow.
 * @returns `true` when `value` is a non-null, non-array object.
 */
function isJsonObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
 *
 * Every failure mode is normalised into `M3LAgentOperatorCliError` coded
 * `ERR_AGENT_OPERATOR_CONFIG`. This runs at module evaluation, i.e. BEFORE
 * `Core.runScript` exists to catch anything, so the typed error reaches a run
 * report and a documented exit code no more than a raw `Error`/`SyntaxError`
 * would — both escape from the same point. What the wrap buys is at the
 * import boundary instead: the throw becomes catchable and `code`-narrowable
 * by the host, which rewraps it as `ERR_CLI_COMMAND_MODULE_IMPORT_FAILED`
 * with this error as `cause` (`runInProcess`). The substantive win is the
 * VALIDATION arm, which closes a genuinely silent failure:
 * `Core.isM3LCommandModule` accepts a missing `description`, so without the
 * check here a loadable descriptor is still built and a host renders the
 * literal text `undefined` in its help output instead of anything failing.
 * The parsed manifest is therefore validated into a fresh typed local rather
 * than asserted with a cast, which would type a missing `description` as
 * `string`. Messages carry no path and no manifest bytes; the chained `cause`
 * carries that detail.
 *
 * @returns The manifest's non-blank `description`.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when the manifest cannot be read or is not JSON (the underlying `Error`
 *   or `SyntaxError` chained as `cause`), when it does not parse to a
 *   non-null, non-array object, or when its own `description` is absent, not
 *   a string, or blank.
 */
function scriptDescription(): string {
  const packageJsonPath = fileURLToPath(
    new URL("../package.json", import.meta.url),
  );
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (cause) {
    throw new M3LAgentOperatorCliError(
      "this script's package.json manifest could not be read or parsed",
      "ERR_AGENT_OPERATOR_CONFIG",
      { cause },
    );
  }
  if (!isJsonObject(manifest)) {
    throw new M3LAgentOperatorCliError(
      "this script's package.json manifest must be a JSON object",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  // `Object.hasOwn`, never `in` or a bare read — but NOT to neutralize a
  // `{"__proto__": …}` payload in the manifest: `JSON.parse` creates
  // `__proto__` as an own DATA property and mutates no prototype, so that
  // payload is already inert (confirmed by probe). The real work is refusing
  // to INHERIT: if anything else in the process has polluted
  // `Object.prototype.description`, `in` or a bare read would let the
  // prototype chain answer for a `description` this package never declared.
  const description = Object.hasOwn(manifest, "description")
    ? manifest["description"]
    : undefined;
  if (typeof description !== "string" || description.trim() === "") {
    throw new M3LAgentOperatorCliError(
      "this script's package.json manifest must declare a non-blank string 'description'",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return description;
}

/**
 * The run body — the same wiring `main.ts` passes to `Core.runScript` via
 * `execute`. Kept as its own function so `execute` stays well inside
 * `max-lines-per-function` as the script grows.
 */
async function runMain(script: Core.M3LScript): Promise<void> {
  // Resolve the declared config (CLI + preset + env + defaults) and inject
  // what the step needs as a single options object — never reach for
  // `process.env` or a global.
  const config = await script.getConfiguration();
  await runAgentOperator({
    config,
    logger: script.logger,
    paths: script.paths,
    signal: script.signal,
    // Bound from `script.reportRecovery` (never the whole `script` object)
    // so an absorbed per-action failure demotes this run's outcome to
    // `"partial"` (exit 6) instead of a silent `"success"` — which is how a
    // detected fleet anomaly reaches a scheduler.
    reportRecovery: script.reportRecovery.bind(script),
    // This script declares `Core.AWS_PROFILE_PARAM_NAME`, so stage 5 has
    // already provisioned `script.aws` by the time this runs. It is passed
    // through rather than asserted here: `explain-policy` never reads it, and
    // a guard at this seam would make a deterministic, offline operation
    // require AWS. `steps/create-invoker` asserts it at the one place a
    // Bedrock client is actually built.
    aws: script.aws,
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
