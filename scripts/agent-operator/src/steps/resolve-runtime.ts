/**
 * `agent-operator/steps/resolve-runtime` — the pure function narrowing a
 * resolved `Core.M3LConfig` (plus the validated policy and the paths port)
 * into `agent-operator`'s typed runtime settings (ADR-0060).
 *
 * @packageDocumentation
 */

import { join } from "node:path";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import {
  AGENT_NAME_DEFAULT,
  CLI_TIMEOUT_MS_DEFAULT,
  DRY_RUN_TIMEOUT_MS_DEFAULT,
  MAX_ITERATIONS_DEFAULT,
  MAX_OUTPUT_BYTES_DEFAULT,
  MAX_OUTPUT_TOKENS_DEFAULT,
  MAX_TOOLS_PER_TURN_DEFAULT,
} from "../config.js";
import { M3LAgentOperatorCliError } from "../lib/errors.js";

/*
 * `M3LConfig` resolves every declared default (from `config.ts`) before any
 * hook runs, so these fallbacks are unreachable through the real `M3LScript`
 * pipeline — they exist purely so `resolveAgentOperatorRuntime` stays
 * unit-testable standalone (a bare `Core.M3LConfig` built without going
 * through the full script lifecycle). The values themselves come from
 * `config.ts` (the single source of truth for every declared default), never
 * a locally hand-copied literal.
 */

/**
 * Matches a `"<modelId>=<inputPer1k>,<outputPer1k>"` entry. Each capture
 * group's quantifier ranges over a character class disjoint from the literal
 * that ends it (`[^=]+=`, `[^,]+,`), so there is no ambiguous split point to
 * backtrack across — structurally ReDoS-safe.
 */
const MODEL_RATE_ENTRY_RE = /^([^=]+)=([^,]+),(.+)$/;

/**
 * `agent-operator`'s fully resolved runtime settings — the typed narrowing of
 * its declared config (`src/config.ts`) plus the loaded policy, ready for the
 * agent loop and the CLI seam to consume without re-reading `Core.M3LConfig`.
 */
export interface AgentOperatorRuntimeSettings {
  /** The primary Bedrock model id. */
  readonly modelId: string;
  /** Fallback model ids to try if `modelId` is unavailable. */
  readonly fallbackModelIds: readonly string[];
  /** Per-model per-1k-token pricing, parsed from `modelRates`. */
  readonly modelRates: ReadonlyMap<string, AWS.M3LBedrockModelRate>;
  /** The agent's display name. */
  readonly agentName: string;
  /**
   * The agent loop iteration ceiling. Never exceeds
   * `policy.budgets.loopIterations` when that budget is declared
   * (ADR-0060: a declared ceiling must not be widenable from argv).
   */
  readonly maxIterations: number;
  /** The per-turn tool-call ceiling. */
  readonly maxToolsPerTurn: number;
  /** The per-turn output token ceiling. */
  readonly maxOutputTokens: number;
  /** The fleet scripts this agent is scoped to discuss/operate. */
  readonly scripts: readonly string[];
  /** Whether `--dry-run` probes are enabled. */
  readonly includeDryRunProbes: boolean;
  /** The scripts `dryRun` may target, per `cli-surface.ts`'s allowlist gate. */
  readonly dryRunAllowlist: readonly string[];
  /** An explicit output file override, when set. */
  readonly output: string | undefined;
  /** An explicit decision-log directory override, when set. */
  readonly decisionLogDir: string | undefined;
  /** Absolute path to the `m3l` CLI entrypoint the CLI seam spawns. */
  readonly cliEntrypoint: string;
  /** Timeout, in milliseconds, for `list`/`doctor`/`inspect` calls. */
  readonly cliTimeoutMs: number;
  /** Timeout, in milliseconds, for `dryRun` calls. */
  readonly dryRunTimeoutMs: number;
  /** Per-stream byte cap on spawned CLI output. */
  readonly maxOutputBytes: number;
}

/**
 * Dependencies for {@link resolveAgentOperatorRuntime}.
 */
export interface ResolveAgentOperatorRuntimeDeps {
  /** The resolved configuration store to read from. */
  readonly config: Core.M3LConfig;
  /** The validated policy, for the `maxIterations` cross-check. */
  readonly policy: Core.M3LAgentPolicy;
  /** The paths port, for the `cliEntrypoint` default. */
  readonly paths: Core.M3LPaths;
}

/**
 * Parses each `"<modelId>=<inputPer1k>,<outputPer1k>"` entry into a
 * `ReadonlyMap`, rejecting malformed, non-finite, or negative rates.
 *
 * @param entries - The raw `modelRates` config entries.
 * @returns A map of model id to its per-1k-token input/output rate.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when an entry does not match the grammar, the captured model id is
 *   missing, blank, or carries leading/trailing whitespace, or either rate
 *   is not a non-negative finite number.
 */
function parseModelRates(
  entries: readonly string[],
): ReadonlyMap<string, AWS.M3LBedrockModelRate> {
  const rates = new Map<string, AWS.M3LBedrockModelRate>();
  for (const entry of entries) {
    const match = MODEL_RATE_ENTRY_RE.exec(entry);
    if (match === null) {
      throw new M3LAgentOperatorCliError(
        "'modelRates' entry must be '<modelId>=<inputPer1k>,<outputPer1k>'",
        "ERR_AGENT_OPERATOR_CONFIG",
      );
    }
    const [, modelId, inputText, outputText] = match;
    if (
      modelId === undefined ||
      modelId.trim() === "" ||
      modelId !== modelId.trim()
    ) {
      throw new M3LAgentOperatorCliError(
        "'modelRates' entry must declare a non-blank model id with no leading or trailing whitespace",
        "ERR_AGENT_OPERATOR_CONFIG",
      );
    }
    const inputPer1kTokens = Number(inputText);
    const outputPer1kTokens = Number(outputText);
    const isValidRate = (rate: number): boolean =>
      Number.isFinite(rate) && rate >= 0;
    if (!isValidRate(inputPer1kTokens) || !isValidRate(outputPer1kTokens)) {
      throw new M3LAgentOperatorCliError(
        "'modelRates' entry rates must be non-negative finite numbers",
        "ERR_AGENT_OPERATOR_CONFIG",
      );
    }
    rates.set(modelId, { inputPer1kTokens, outputPer1kTokens });
  }
  return rates;
}

/**
 * Enforces ADR-0060's cross-check: `maxIterations` must never exceed a
 * declared `policy.budgets.loopIterations` ceiling. Absence of that budget
 * skips the check entirely — it is not compared against an implicit ceiling.
 *
 * @param maxIterations - The resolved `maxIterations` config value.
 * @param policy - The validated policy to compare against.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when a declared ceiling is exceeded.
 */
function assertWithinLoopIterationsBudget(
  maxIterations: number,
  policy: Core.M3LAgentPolicy,
): void {
  const ceiling = policy.budgets?.loopIterations;
  if (ceiling !== undefined && maxIterations > ceiling) {
    throw new M3LAgentOperatorCliError(
      "'maxIterations' must not exceed the policy's declared 'budgets.loopIterations' ceiling",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
}

/**
 * Resolves `cliEntrypoint`: the explicit config value when set, otherwise
 * `<projectRoot>/packages/m3l-cli/bin/m3l.mjs` (the CLI's executable
 * wrapper — `dist/main.js` is import-inert). `M3LPaths.getProjectRoot()`
 * throws `Core.M3LPathResolutionError` in standalone mode; that failure is
 * translated so a caller never has to know about the monorepo-only default.
 *
 * @param accessor - The config accessor to read the explicit override from.
 * @param paths - The paths port.
 * @returns The absolute `m3l` CLI entrypoint path.
 * @throws {@link M3LAgentOperatorCliError} coded
 *   `ERR_AGENT_OPERATOR_CLI_ENTRYPOINT` when no explicit `cliEntrypoint` is
 *   set and `getProjectRoot()` is unavailable.
 */
function resolveCliEntrypoint(
  accessor: Core.M3LConfigAccessor,
  paths: Core.M3LPaths,
): string {
  const explicit = accessor.optionalString("cliEntrypoint");
  if (explicit !== undefined) return explicit;
  try {
    return join(
      paths.getProjectRoot(),
      "packages",
      "m3l-cli",
      "bin",
      "m3l.mjs",
    );
  } catch (cause) {
    if (!(cause instanceof Core.M3LPathResolutionError)) throw cause;
    throw new M3LAgentOperatorCliError(
      "'cliEntrypoint' must be set explicitly outside the monorepo",
      "ERR_AGENT_OPERATOR_CLI_ENTRYPOINT",
      { cause },
    );
  }
}

/**
 * Narrows `deps.config` (plus the loaded policy and paths port) into
 * `agent-operator`'s typed {@link AgentOperatorRuntimeSettings}. Pure aside
 * from `paths.getProjectRoot()`'s filesystem-free path computation — no I/O,
 * no network, no Bedrock call.
 *
 * @param deps - See {@link ResolveAgentOperatorRuntimeDeps}.
 * @returns The resolved runtime settings.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when a config value is malformed, a `modelRates` entry is malformed, or
 *   `maxIterations` exceeds a declared `budgets.loopIterations` ceiling.
 * @throws {@link M3LAgentOperatorCliError} coded
 *   `ERR_AGENT_OPERATOR_CLI_ENTRYPOINT` when `cliEntrypoint` is unset and
 *   `paths.getProjectRoot()` is unavailable (standalone mode).
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { resolveAgentOperatorRuntime } from "./resolve-runtime.js";
 *
 * declare const config: Core.M3LConfig;
 * declare const policy: Core.M3LAgentPolicy;
 *
 * const settings = resolveAgentOperatorRuntime({
 *   config,
 *   policy,
 *   paths: new Core.M3LPaths(),
 * });
 * ```
 */
export function resolveAgentOperatorRuntime(
  deps: ResolveAgentOperatorRuntimeDeps,
): AgentOperatorRuntimeSettings {
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_AGENT_OPERATOR_CONFIG",
  });

  const maxIterations = accessor.numberWithDefault(
    "maxIterations",
    MAX_ITERATIONS_DEFAULT,
  );
  assertWithinLoopIterationsBudget(maxIterations, deps.policy);

  return {
    modelId: accessor.requiredString("modelId", "resolve-runtime"),
    fallbackModelIds: accessor.optionalStringArray("fallbackModelIds") ?? [],
    modelRates: parseModelRates(
      accessor.optionalStringArray("modelRates") ?? [],
    ),
    agentName: accessor.optionalString("agentName") ?? AGENT_NAME_DEFAULT,
    maxIterations,
    maxToolsPerTurn: accessor.numberWithDefault(
      "maxToolsPerTurn",
      MAX_TOOLS_PER_TURN_DEFAULT,
    ),
    maxOutputTokens: accessor.numberWithDefault(
      "maxOutputTokens",
      MAX_OUTPUT_TOKENS_DEFAULT,
    ),
    scripts: accessor.optionalStringArray("scripts") ?? [],
    includeDryRunProbes: accessor.booleanWithDefault(
      "includeDryRunProbes",
      false,
    ),
    dryRunAllowlist: accessor.optionalStringArray("dryRunAllowlist") ?? [],
    output: accessor.optionalString("output"),
    decisionLogDir: accessor.optionalString("decisionLogDir"),
    cliEntrypoint: resolveCliEntrypoint(accessor, deps.paths),
    cliTimeoutMs: accessor.numberWithDefault(
      "cliTimeoutMs",
      CLI_TIMEOUT_MS_DEFAULT,
    ),
    dryRunTimeoutMs: accessor.numberWithDefault(
      "dryRunTimeoutMs",
      DRY_RUN_TIMEOUT_MS_DEFAULT,
    ),
    maxOutputBytes: accessor.numberWithDefault(
      "maxOutputBytes",
      MAX_OUTPUT_BYTES_DEFAULT,
    ),
  };
}
