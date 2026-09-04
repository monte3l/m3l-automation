/**
 * `agent-operator/steps/resolve-runtime` — the pure function narrowing a
 * resolved `Core.M3LConfig` (plus the validated policy and the paths port)
 * into `agent-operator`'s typed runtime settings (ADR-0060).
 *
 * @packageDocumentation
 */

import { isAbsolute, join } from "node:path";

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
import {
  AGENT_OPERATOR_PATH_SEPARATOR_RE,
  AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX,
  hasPresetPathControlOrFormatCharacter,
  isAllowedPresetName,
  isUnpaddedNonBlankPresetPath,
  isWellFormedPresetPathShape,
} from "../lib/preset-names.js";

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
 *
 * Scoped to model ids. The same rule for a `presetAllowlist` PATH lives in
 * `lib/preset-names.ts` as `hasPresetPathControlOrFormatCharacter`, because
 * that one is shared with `lib/cli-surface.ts`'s use-site re-check and the two
 * sites must reject the same set; a model id has no second site to agree with.
 */
const CONTROL_OR_FORMAT_RE = /\p{C}/u;

/**
 * Matches a `"<name>=<path>"` `presetAllowlist` entry. Mirrors
 * {@link MODEL_RATE_ENTRY_RE}'s shape: `[^=]+` ranges over a class disjoint
 * from the `=` that ends it, so there is no ambiguous split point to
 * backtrack across — structurally ReDoS-safe.
 *
 * `(.+)` rather than `(.*)` is load-bearing, and so is `([^=]+)` rather than
 * `([^=]*)`: together they make BOTH half-empty forms (`"report="` and
 * `"=data/config/presets/report.yaml"`) grammar misses, reported before any
 * blank-half check can run. That is the more useful message for an operator
 * who simply left a half out, and it keeps one entry-regex shape across both
 * parsers in this module.
 *
 * The `s` (dotAll) flag is what routes a path with an embedded line feed or
 * carriage return to the control-character rejection instead of this grammar
 * one. Without it `.` excludes the line terminators, so `"…/rep\nort.yaml"`
 * would be reported as a missing path — a message that describes the wrong
 * problem, and one that would go on describing the wrong problem if the
 * control check were ever the only thing standing between those bytes and an
 * argv token. `[^=]` on the name side already admits them, which is why only
 * the path half needed the flag.
 */
const PRESET_ALLOWLIST_ENTRY_RE = /^([^=]+)=(.+)$/s;

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
  /**
   * The presets `run` may target, keyed by allowed preset name and valued by
   * the workspace-RELATIVE path declared in the config — the reviewable form
   * that shows up in a diff. `lib/cli-surface.ts` joins it onto
   * `workspaceRoot` at argv-build time, because `m3l run` spawns its child
   * with `cwd: scripts/<name>/` and a relative `--preset=` token would
   * resolve under the script directory instead of the workspace.
   */
  readonly presetAllowlist: ReadonlyMap<string, string>;
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

// The three `presetAllowlist` entry validators below share one convention:
// each returns the value it validated, unchanged. Two of them already did;
// making the third match is worth the redundant-looking `return` because a
// mixed set reads as if the returning ones normalise something and the `void`
// one does not — none of them normalise anything, which is the whole point of
// rejecting padding instead of trimming it. It also matches the
// `assertUsable*` helpers in `lib/cli-surface.ts`: every validator in this
// script's chain is an expression that yields the value it vouched for, so a
// call site names the validated value rather than reusing the raw input.
/**
 * Validates one `presetAllowlist` entry's path: workspace-relative, free of
 * any `..` segment, and inside the workspace presets directory named by
 * {@link AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX}.
 *
 * That boundary lives in `lib/preset-names.ts`, shared with
 * `lib/cli-surface.ts`'s use-site re-check so the two cannot drift into
 * accepting different sets — as do the separator pattern this helper splits
 * on and the shape rules {@link assertWellFormedEntryPresetPath} applies,
 * which a review found the use site was NOT applying when only the directory
 * constant was shared. Its TSDoc there carries the rationale this block
 * used to hold: why the directory is a local copy of the CLI preset store's
 * own value rather than an import (ADR-0029), how the drift guard in
 * `tests/steps/resolve-runtime.test.ts` pins the copy to upstream, and what
 * that guard does not cover.
 *
 * The `..` ban is stricter than "where does it land" — `presets/sub/../x.yaml`
 * normalises back inside the presets directory and is still rejected. The
 * reason is reviewability, not reachability: someone reading the config diff
 * must be able to see the target directory in the declared string without
 * normalising it in their head, and a symlinked `sub/` would make the
 * reviewed string and the resolved path genuinely disagree — so a
 * normalise-then-compare rule would be checking a different path than the one
 * the spawned child opens.
 *
 * The prefix comparison carries the trailing separator, which is why the
 * shared constant is the trailing-separator form: without it, a bare
 * `startsWith("data/config/presets")` also accepts
 * `data/config/presetsevil/report.yaml` — a different directory that merely
 * shares the prefix as text.
 *
 * @param presetPath - The entry's captured path, already known well-formed
 *   by {@link assertWellFormedEntryPresetPath}.
 * @returns The validated path, still exactly as declared.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when the path is absolute, carries a `..` segment, or does not sit inside
 *   the workspace presets directory.
 */
function assertPresetPathWithinPresetsDirectory(presetPath: string): string {
  // Absolute is rejected BEFORE containment, so an absolute path that happens
  // to name the presets directory (`/data/config/presets/report.yaml`) still
  // reports the rule it actually broke. Only the relative form is declarable:
  // `m3l run` resolves `--preset=` against the spawned child's own cwd, so
  // the join onto `workspaceRoot` has to happen at argv-build time.
  if (isAbsolute(presetPath)) {
    throw new M3LAgentOperatorCliError(
      "'presetAllowlist' entry paths must be workspace-relative, not absolute",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  if (
    presetPath.split(AGENT_OPERATOR_PATH_SEPARATOR_RE).includes("..") ||
    !presetPath.startsWith(AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX) ||
    // The prefix and nothing else names the directory itself, not a file in
    // it — `--preset=<a directory>` is never a preset the CLI can load.
    presetPath.length === AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX.length
  ) {
    throw new M3LAgentOperatorCliError(
      "'presetAllowlist' entry paths must stay within the workspace presets directory",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return presetPath;
}

/**
 * Validates one `presetAllowlist` entry's preset name, returning it unchanged
 * on success.
 *
 * Padding is rejected, never trimmed, for the reason a `modelRates` model id
 * already is: a trimmed key and an untrimmed declaration drift apart
 * silently, and a `run` lookup for `"report"` then misses a grant the
 * operator believes they wrote. That check runs BEFORE the allowed-name one
 * even though `/^[a-z0-9-]+$/` would reject the whitespace too — "you left
 * whitespace in" is the actionable message.
 *
 * No separate control/format check is needed here:
 * `isAllowedPresetName`'s pattern is a strict anchored allowlist that already
 * excludes every `\p{C}` codepoint, so a second check could never fire.
 *
 * @param name - The entry's captured name. Typed optional only because an
 *   {@link PRESET_ALLOWLIST_ENTRY_RE} capture indexes as `string | undefined`;
 *   that arm is unreachable by construction for the same reason as
 *   {@link assertWellFormedEntryPresetPath}'s, and is kept for the same
 *   reason.
 * @returns The validated preset name.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when the name is absent, blank, whitespace-padded, or not an allowed
 *   preset name.
 */
function assertAllowedEntryPresetName(name: string | undefined): string {
  if (name === undefined || name.trim() === "" || name !== name.trim()) {
    throw new M3LAgentOperatorCliError(
      "'presetAllowlist' entry must declare a non-blank preset name with no leading or trailing whitespace",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  if (!isAllowedPresetName(name)) {
    throw new M3LAgentOperatorCliError(
      "'presetAllowlist' entry name must be an allowed preset name",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return name;
}

/**
 * Validates one `presetAllowlist` entry's path against all three of its
 * shape rules — present and non-blank, free of leading or trailing
 * whitespace, and free of Unicode control or format characters — returning it
 * unchanged on success. WHERE the path points is a separate concern, decided
 * by {@link assertPresetPathWithinPresetsDirectory}; this helper is named for
 * the shape rules as a set rather than for the blankness one alone, because
 * all three reject and none of them is the primary.
 *
 * A padded path gets the same treatment as a padded name, for a further
 * reason: `path.join` would happily absolutise `" data/…"` into a
 * whitespace-prefixed directory name, so tolerating the padding produces a
 * path nobody declared.
 *
 * `.trim()` reaches the ENDS only, and does not treat U+0085 (NEL) or U+202E
 * (RLO) as trimmable at all — so a control or format character in the MIDDLE
 * of a file name survives it untouched and would land in a `--preset=` argv
 * token, a log line, or a terminal. The path stays out of the message:
 * echoing it would re-emit the very bytes being rejected.
 *
 * Every rule here is one of `lib/preset-names.ts`'s shared shape predicates,
 * never a local copy: the same shape is re-checked at argv-build time by
 * `lib/cli-surface.ts`, and a review found the two sites disagreeing while
 * they shared only the directory constant. The first two arms call the
 * individual predicates so an operator learns which rule they broke; the
 * third is a catch-all on the conjunction
 * ({@link isWellFormedPresetPathShape}), so a rule added for the use site
 * cannot end up enforced at only one of the two sites.
 *
 * @param presetPath - The entry's captured path. Typed optional only because
 *   an {@link PRESET_ALLOWLIST_ENTRY_RE} capture indexes as
 *   `string | undefined`; see the `undefined` arm below.
 * @returns The validated path, still exactly as declared.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when the path is absent, blank, whitespace-padded, embeds a Unicode
 *   control or format character, or carries whitespace anywhere inside it.
 */
function assertWellFormedEntryPresetPath(
  presetPath: string | undefined,
): string {
  // `presetPath === undefined` is unreachable by construction: the grammar's
  // second group is not optional and a `null` match is rejected before this
  // runs. It is checked rather than asserted away so the helper stays total
  // over its declared parameter type — dropping the arm would mean narrowing
  // the parameter to `string` and moving the assertion to the call site,
  // trading a provably-dead branch for a real one.
  if (presetPath === undefined || !isUnpaddedNonBlankPresetPath(presetPath)) {
    throw new M3LAgentOperatorCliError(
      "'presetAllowlist' entry paths must be non-blank with no leading or trailing whitespace",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  if (hasPresetPathControlOrFormatCharacter(presetPath)) {
    throw new M3LAgentOperatorCliError(
      "'presetAllowlist' entry must not contain control or format characters",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  // The catch-all arm. Today the only rule the two above do not already cover
  // is whitespace INSIDE the path (`trim()` sees the ends; `\p{C}` does not
  // match U+0020), which is why the message names it. If the shared predicate
  // grows a rule, this arm enforces it here too — widen the message with it.
  if (!isWellFormedPresetPathShape(presetPath)) {
    throw new M3LAgentOperatorCliError(
      "'presetAllowlist' entry paths must not contain embedded whitespace",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return presetPath;
}

/**
 * Parses each `"<name>=<path>"` entry into a `ReadonlyMap` of allowed preset
 * name to declared workspace-relative path. Module-private, exactly like
 * {@link parseModelRates}: the observable contract is
 * `settings.presetAllowlist`, and `config.ts` deliberately declares no
 * `validate` for this parameter so this function stays the grammar's single
 * source of truth.
 *
 * The order the three helpers run in is part of the contract, not an
 * accident: name rules, then duplicate detection, then the path rules — so an
 * entry that is wrong in two ways always reports the same one.
 *
 * @param entries - The raw `presetAllowlist` config entries.
 * @returns A map of allowed preset name to its declared relative path.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when an entry misses the grammar or repeats a name an earlier entry
 *   already declared, or when
 *   {@link assertAllowedEntryPresetName},
 *   {@link assertWellFormedEntryPresetPath}, or
 *   {@link assertPresetPathWithinPresetsDirectory} rejects it. Every message
 *   is fixed and never echoes the entry: these are operator-supplied strings
 *   carrying a filesystem path, so re-emitting one would put a chosen value
 *   into whatever renders the failure.
 */
function parsePresetAllowlist(
  entries: readonly string[],
): ReadonlyMap<string, string> {
  const allowlist = new Map<string, string>();
  for (const entry of entries) {
    const match = PRESET_ALLOWLIST_ENTRY_RE.exec(entry);
    if (match === null) {
      throw new M3LAgentOperatorCliError(
        "'presetAllowlist' entry must be '<name>=<path>'",
        "ERR_AGENT_OPERATOR_CONFIG",
      );
    }
    const name = assertAllowedEntryPresetName(match[1]);
    // A duplicate is rejected, never merged: `Map.set` would drop the
    // operator's first grant without a word, so `run` would target a preset
    // file nobody reading the config diff top-to-bottom would predict. The
    // check keys on the NAME, not on the whole entry — two grants of one name
    // pointing at different files is exactly the ambiguous case.
    if (allowlist.has(name)) {
      throw new M3LAgentOperatorCliError(
        "'presetAllowlist' must not declare the same preset name more than once",
        "ERR_AGENT_OPERATOR_CONFIG",
      );
    }
    // Kept as two statements, not nested: the order these run in is part of
    // the contract above, and top-to-bottom is how that order is read.
    const wellFormedPath = assertWellFormedEntryPresetPath(match[2]);
    const presetPath = assertPresetPathWithinPresetsDirectory(wellFormedPath);
    allowlist.set(name, presetPath);
  }
  return allowlist;
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
 *   when a config value is malformed, a `modelRates` or `presetAllowlist`
 *   entry is malformed, or `maxIterations` exceeds a declared
 *   `budgets.loopIterations` ceiling.
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
    presetAllowlist: parsePresetAllowlist(
      accessor.optionalStringArray("presetAllowlist") ?? [],
    ),
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
