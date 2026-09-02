/**
 * `run/in-process` — the ADR-0054/U7 in-process command host. Resolves a
 * script's opted-in `dist/command.js` seam, invokes its `execute` directly
 * inside this process (instead of spawning `dist/main.js` as a child), and
 * maps the resolved outcome to a process exit code.
 *
 * @packageDocumentation
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../cli/errors.js";
import type { M3LCliOutput } from "../cli/output.js";

/** Injectable overrides {@link loadCommandModule} and {@link runInProcess} accept in place of the real dynamic `import()`. */
export interface M3LCliInProcessImportOptions {
  /**
   * The module importer to use; defaults to a dynamic `import()` against the
   * resolved `dist/command.js`'s `file://` URL. Tests inject a stub here —
   * mirrors {@link M3LCliSpawnOptions.spawnImpl} in `run/spawn.ts`, the
   * spawn-path sibling's own injectable-implementation seam.
   */
  readonly importModule?: (url: string) => Promise<unknown>;
}

/**
 * Reads `candidate.configParameters` once and redefines it as a static data
 * property on the very same object — defusing a non-idempotent getter (a
 * hostile or buggy `dist/command.js` export) *before* {@link Core.isM3LCommandModule}'s
 * own validation reads it, and before any later consumer (e.g. the logger
 * `runInProcess` builds from the same module) can observe a second, different
 * answer.
 *
 * Returns `false` — meaning "do not trust this candidate at all" — only when
 * a write was ATTEMPTED, did not throw, but a read-back proves the value was
 * not actually stored (a hostile `Proxy` whose `defineProperty` trap lies,
 * returning `true` without persisting anything via `Reflect.defineProperty`).
 * A non-throwing write is not proof the value was stored — verify by reading
 * it back, per this repo's rule for mutating a property on an object you
 * don't own.
 *
 * Returns `true` in every other case, including: `candidate` isn't a plain
 * object (nothing to pin — {@link Core.isM3LCommandModule} rejects non-objects
 * itself), and the property write threw or the getter itself threw (tolerated
 * as the pre-existing, not newly introduced, TOCTOU window for that narrower
 * edge case — {@link Core.isM3LCommandModule} already handles a throwing
 * read without crashing).
 *
 * @param candidate - The value under validation — typically a foreign
 *   `dist/`'s `commandModule` export, not yet known to be well-shaped.
 * @returns `false` when the candidate must be rejected outright (a lying
 *   write proves it cannot be trusted); `true` otherwise.
 */
function freezeConfigParametersSnapshot(candidate: unknown): boolean {
  if (candidate === null || typeof candidate !== "object") {
    return true;
  }
  try {
    const configParameters = (candidate as Record<string, unknown>)[
      "configParameters"
    ];
    Object.defineProperty(candidate, "configParameters", {
      value: configParameters,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    return (
      (candidate as Record<string, unknown>)["configParameters"] ===
      configParameters
    );
  } catch {
    return true;
  }
}

/**
 * The default {@link M3LCliInProcessImportOptions.importModule} implementation
 * — a plain dynamic `import()`. Extracted as its own named function (rather
 * than an inline arrow inside {@link loadCommandModule}) so it can be unit
 * tested directly against a `data:` URL (a real dynamic import with zero
 * filesystem access — `import("data:text/javascript,...")` is a standard,
 * stable ESM feature, not an experimental one, on this repo's Node 24 floor)
 * instead of only being exercised indirectly through a fabricated,
 * nonexistent file path.
 *
 * @param url - The module specifier to import — a `file://` URL in
 *   production use (via {@link loadCommandModule}), any valid ESM specifier
 *   in tests.
 * @returns The imported module's namespace object.
 *
 * @example
 * ```ts
 * const mod = await defaultImportModule("data:text/javascript,export const x = 1;");
 * ```
 */
export function defaultImportModule(url: string): Promise<unknown> {
  return import(url);
}

/**
 * Resolves `<scriptDirectory>/dist/command.js` and returns its exported
 * `commandModule`, or `undefined` when the script has not adopted the
 * ADR-0054 in-process seam.
 *
 * `undefined` covers two distinct, deliberately-collapsed cases: the entry
 * point does not exist at all (the common case — most fleet scripts have not
 * opted in), and the entry point exists but its `commandModule` export fails
 * {@link Core.isM3LCommandModule}'s structural check (a malformed adoption).
 * Neither throws. A genuine import failure (a syntax error in the compiled
 * output, a missing transitive dependency) is a third, distinct case and
 * **propagates unwrapped** — the caller decides how to present it.
 *
 * @param scriptDirectory - The script's root directory.
 * @param options - Optional `importModule` override for testing.
 * @returns The script's exported `commandModule`, or `undefined` when absent
 *   or structurally invalid.
 *
 * @example
 * ```ts
 * const commandModule = await loadCommandModule("/repo/scripts/json-etl");
 * // undefined when the script hasn't adopted ADR-0054's command-module seam
 * ```
 */
export async function loadCommandModule(
  scriptDirectory: string,
  options: M3LCliInProcessImportOptions = {},
): Promise<Core.M3LCommandModule<object> | undefined> {
  const entryPoint = join(scriptDirectory, "dist", "command.js");
  if (!existsSync(entryPoint)) {
    return undefined;
  }

  const importModule = options.importModule ?? defaultImportModule;
  const imported = await importModule(pathToFileURL(entryPoint).href);
  const candidate = (imported as Record<string, unknown>)["commandModule"];
  if (!freezeConfigParametersSnapshot(candidate)) {
    return undefined;
  }
  return Core.isM3LCommandModule(candidate) ? candidate : undefined;
}

/** The options {@link runInProcess} accepts. */
export interface M3LCliInProcessOptions {
  /** The operator-facing writer, forwarded straight through to `context.output`. */
  readonly output: M3LCliOutput;
  /** The already-parsed/translated parameter values, forwarded verbatim as `execute`'s first argument. */
  readonly parameterValues: Readonly<Record<string, unknown>>;
  /** Forwarded verbatim as `context.dryRun`. */
  readonly dryRun: boolean;
  /**
   * Forwarded verbatim as `context.signal` — `undefined` when the caller
   * has no cancellation signal to propagate. Required (not optional) per the
   * `exactOptionalPropertyTypes`-safe required-holding-`undefined` convention
   * that {@link Core.M3LCommandContext.signal} itself documents: callers must
   * be explicit about whether they hold a signal, preventing accidental
   * omission from silently disabling cancellation.
   *
   * U11: wired by `commands/dynamic.ts`'s in-process dispatch path, which
   * now creates a `createCancellationScope` scope and passes its signal here.
   */
  readonly signal: AbortSignal | undefined;
}

/**
 * Returns `true` when `error` is a cooperative-cancellation abort, identified
 * by `error.code === "ERR_OPERATION_ABORTED"` (ADR-0049) rather than by class,
 * so a structurally-equivalent abort produced across a module boundary
 * classifies correctly without relying on prototype-chain identity.
 *
 * Mirrors `core/script/run-script.ts:156` (`isAbortError`) and its use at
 * `:327`. Neither is publicly exported from that module, so the predicate is
 * duplicated here with this citation — any change to the upstream predicate
 * should be mirrored here.
 */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_OPERATION_ABORTED"
  );
}

/**
 * Loads a script's in-process command module, invokes its `execute`, and
 * resolves the exit code its outcome maps to (ADR-0054, U7).
 *
 * `context.signal` is forwarded verbatim from `options.signal` — `undefined`
 * when the caller has no live abort signal, or a real {@link AbortSignal}
 * when cooperative cancellation is active (U11, ADR-0049). The in-process
 * dispatch path in `commands/dynamic.ts` creates a cancellation scope and
 * passes its signal here so the hosted command module can observe Ctrl-C.
 *
 * @param scriptDirectory - The script's root directory.
 * @param options - The output sink, parameter values, and `dryRun` flag to
 *   run the command with.
 * @param importOptions - Optional `importModule` override for testing,
 *   forwarded to {@link loadCommandModule}.
 * @returns The exit code {@link Core.mapCommandOutcomeToExitCode} resolves
 *   for the outcome `execute` produced.
 * @throws {@link M3LCliError} coded `ERR_CLI_COMMAND_MODULE_INVALID` when the
 *   script has no adopted command module (no `cause` chained — there was
 *   nothing to import in the first place).
 * @throws {@link M3LCliError} coded `ERR_CLI_COMMAND_MODULE_IMPORT_FAILED`
 *   when importing the script's command module fails (the underlying
 *   failure chained as `cause`).
 * @throws {@link M3LCliError} coded `ERR_CLI_IN_PROCESS_FAILED` when
 *   `execute` itself throws (the thrown value chained as `cause`), or
 *   resolves a value that fails {@link Core.isM3LCommandOutcome}.
 *
 * @example
 * ```ts
 * const exitCode = await runInProcess("/repo/scripts/json-etl", {
 *   output,
 *   parameterValues: { region: "us-east-1" },
 *   dryRun: false,
 * });
 * ```
 */
export async function runInProcess(
  scriptDirectory: string,
  options: M3LCliInProcessOptions,
  importOptions: M3LCliInProcessImportOptions = {},
): Promise<number> {
  let commandModule: Core.M3LCommandModule<object> | undefined;
  try {
    commandModule = await loadCommandModule(scriptDirectory, importOptions);
  } catch (cause) {
    throw new M3LCliError(
      "ERR_CLI_COMMAND_MODULE_IMPORT_FAILED",
      `script at '${scriptDirectory}' failed to import its in-process command module`,
      { cause },
    );
  }

  if (commandModule === undefined) {
    throw new M3LCliError(
      "ERR_CLI_COMMAND_MODULE_INVALID",
      `script at '${scriptDirectory}' has no in-process command module — run 'pnpm build' to compile dist/command.js, or drop --in-process to spawn instead`,
    );
  }

  // Snapshot once: Core.isM3LCommandModule already read configParameters once
  // as part of its own validation guard inside loadCommandModule. Re-reading
  // the live property here would let a non-idempotent getter answer honestly
  // to the validation guard and dishonestly (e.g. dropping a declared
  // `secret: true` parameter) to the logger construction below, silently
  // disabling redaction (TOCTOU security fix).
  const configParameters = commandModule.configParameters;

  const logger = Core.createCommandLogger({
    handlers: [new Core.M3LConsoleLoggerHandler()],
    configParameters,
  });

  let outcome: unknown;
  try {
    outcome = await commandModule.execute(options.parameterValues, {
      output: options.output,
      logger,
      signal: options.signal,
      dryRun: options.dryRun,
    });
  } catch (cause) {
    // Abort-shaped throws resolve to INTERRUPTED rather than failing — the
    // command module observed the AbortSignal and exited cooperatively.
    // Classification is code-based (ADR-0049): `error.code ===
    // "ERR_OPERATION_ABORTED"` so a structurally-equivalent abort produced
    // across a module boundary still classifies correctly without relying on
    // prototype-chain identity. Mirrors core/script/run-script.ts:156
    // (`isAbortError`) and its use at :327; neither is exported, so the
    // predicate is duplicated locally with a citation.
    if (isAbortError(cause)) {
      return Core.M3L_EXIT_CODES.INTERRUPTED;
    }
    throw new M3LCliError(
      "ERR_CLI_IN_PROCESS_FAILED",
      `script at '${scriptDirectory}' failed while running in-process`,
      { cause },
    );
  }

  if (!Core.isM3LCommandOutcome(outcome)) {
    throw new M3LCliError(
      "ERR_CLI_IN_PROCESS_FAILED",
      `script at '${scriptDirectory}' resolved a malformed outcome from its in-process command module`,
    );
  }

  return Core.mapCommandOutcomeToExitCode(outcome);
}
