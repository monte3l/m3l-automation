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
 * Matches any Unicode control or format character — the `C` super-category
 * (Cc, Cf, Co, Cs, Cn). Used to reject a model id that embeds one.
 *
 * A rejection, not an allowlist: a legitimate Bedrock model id may be a
 * cross-region inference profile (`us.anthropic.claude-…`) or a full
 * inference-profile ARN
 * (`arn:aws:bedrock:us-east-1:123456789012:inference-profile/…`), so `:`,
 * `/`, `.`, `-`, `_` and digits must all stay legal — an allowlist tight
 * enough to be worth writing would reject ids AWS actually issues.
 *
 * `\p{C}` also reaches what `.trim()` cannot: `trim()` strips the ENDS only
 * and does not treat U+0085 (NEL) or U+202E (RLO) as trimmable at all, so an
 * embedded line feed, NUL, ANSI CSI introducer, DEL, C1 control, or bidi
 * override otherwise survives into a `Map` key and — once the follow-up slice
 * renders model ids — into a log line or a terminal.
 */
const CONTROL_OR_FORMAT_RE = /\p{C}/u;

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
 * Parses one side of a `modelRates` entry's `"<inputPer1k>,<outputPer1k>"`
 * pair. Whitespace padding is rejected rather than tolerated, so both halves
 * of the grammar treat it the same way the model id already does — a bare
 * `Number(...)` accepts `"  3 "` two lines below a rejected `" my-model"`, and
 * silently turns a blank `" "` into a rate of `0`.
 *
 * @param text - The raw rate text captured from the entry.
 * @returns The parsed non-negative finite rate, never negative zero.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when the text is absent, blank, carries leading or trailing whitespace, is
 *   not a non-negative finite number, or parses to negative zero (`"-0"`,
 *   `"-0.0"`) — which `rate < 0` does not catch, since `-0 < 0` is `false`.
 */
function parseModelRateValue(text: string | undefined): number {
  if (text === undefined || text.trim() === "" || text !== text.trim()) {
    throw new M3LAgentOperatorCliError(
      "'modelRates' entry rates must be non-blank with no leading or trailing whitespace",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  const rate = Number(text);
  // `Object.is(rate, -0)` carries the guard the comparison cannot: `-0 < 0` is
  // `false`, so `"-0"`/`"-0.0"` would otherwise pass a check whose own message
  // promises "non-negative". Rejected outright rather than normalised to `+0`,
  // so an operator sees the typo instead of a silently rewritten rate.
  if (!Number.isFinite(rate) || rate < 0 || Object.is(rate, -0)) {
    throw new M3LAgentOperatorCliError(
      "'modelRates' entry rates must be non-negative finite numbers, and must not be negative zero",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return rate;
}

/**
 * Parses each `"<modelId>=<inputPer1k>,<outputPer1k>"` entry into a
 * `ReadonlyMap`, rejecting malformed, non-finite, or negative rates.
 *
 * @param entries - The raw `modelRates` config entries.
 * @returns A map of model id to its per-1k-token input/output rate.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when an entry does not match the grammar, the captured model id is
 *   missing, blank, carries leading/trailing whitespace, embeds a Unicode
 *   control or format character (`\p{C}` — a line feed, NUL, ANSI escape,
 *   DEL, C1 control, or bidi override), or repeats a model id an earlier entry
 *   already declared, or either rate is blank, whitespace-padded, negative
 *   zero, or not a non-negative finite number.
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
    // The trim check above only reaches the ENDS of the id, and the grammar's
    // `[^=]+` capture admits every other character — so a control or format
    // character sitting in the MIDDLE would become a `Map` key untouched. The
    // follow-up slice logs and renders model ids, at which point an embedded
    // line feed is log-line injection and a CSI sequence is terminal
    // injection; closing it before the first consumer exists is cheaper than
    // auditing every future render site. The id stays out of the message —
    // echoing it would re-emit the very bytes being rejected.
    if (CONTROL_OR_FORMAT_RE.test(modelId)) {
      throw new M3LAgentOperatorCliError(
        "'modelRates' entry model id must not contain control or format characters",
        "ERR_AGENT_OPERATOR_CONFIG",
      );
    }
    // A duplicate is rejected, never merged: `Map.set` would drop the
    // operator's earlier declaration without a word and bill the run at the
    // later entry's rate. The id itself stays out of the message — it is
    // config-supplied text, like every other value in this module.
    if (rates.has(modelId)) {
      throw new M3LAgentOperatorCliError(
        "'modelRates' must not declare the same model id more than once",
        "ERR_AGENT_OPERATOR_CONFIG",
      );
    }
    const inputPer1kTokens = parseModelRateValue(inputText);
    const outputPer1kTokens = parseModelRateValue(outputText);
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
