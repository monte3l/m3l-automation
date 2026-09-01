/**
 * `agent-operator/steps/health-prompt` — the system and user prompts for the
 * fleet health-check workload.
 *
 * @remarks
 * Every string this module produces is **script-authored or config-authored**.
 * No CLI output and no prior model output ever reaches a prompt: tool results
 * come back to the model as `{ type: "json" }` leaves through the loop's own
 * `toolResult` path (see `steps/build-health-tools`), never by being spliced
 * into prose here. That is what keeps the prompt a fixed, reviewable artifact
 * rather than a channel.
 *
 * ## The structural core of the system prompt
 *
 * The model is told, in as many words, that it has **no machine-readable
 * output channel** — the report is assembled by the operator from the tool
 * results themselves. That sentence does two jobs at once:
 *
 * 1. It removes the model's incentive to invent one (a JSON block, a
 *    `FINDINGS:` preamble, a fenced YAML summary) that a future maintainer
 *    might then be tempted to parse.
 * 2. It removes that temptation itself. A reviewer reading this prompt can
 *    see that parsing the reply was never the design, so a later "let's just
 *    read the model's JSON" change has to argue against an explicit
 *    statement rather than fill a silence.
 *
 * @packageDocumentation
 */

import { AGENT_HEALTH_TOOL_NAMES } from "./build-health-tools.js";

/**
 * The system prompt. Assembled from array joins rather than one long template
 * literal so prettier cannot reflow a sentence into a shape that changes the
 * rendered text, and so each clause is independently reviewable in a diff.
 */
const SYSTEM_PROMPT_LINES: readonly string[] = Object.freeze([
  "You are the operator of an automation fleet. Your job in this run is a",
  "read-only health check: find out whether the fleet is healthy, and say so.",
  "",
  "How to work:",
  `- Call ${AGENT_HEALTH_TOOL_NAMES.fleetDoctor} to see the environment checks.`,
  `- Call ${AGENT_HEALTH_TOOL_NAMES.fleetList} to see which scripts exist.`,
  `- Call ${AGENT_HEALTH_TOOL_NAMES.scriptInspect} on a script only when the`,
  "  first two results give you a specific reason to look closer.",
  "- Stop as soon as you can answer. Extra calls cost budget and add nothing.",
  "",
  "Two things are not negotiable:",
  "- Every tool call is authorized by a deployment policy before it runs. A",
  "  refusal is final. Do not retry it, do not rephrase it, and do not try a",
  "  different tool to reach the same result.",
  "- You cannot mutate anything. There is no tool here that changes state.",
  "",
  "Your reply is PROSE ONLY, for a human reading a run log. The",
  "machine-readable report is assembled by the operator from the tool results",
  "themselves, not from your reply — so there is no JSON, no table, and no",
  "structured block for you to produce, and nothing you write will be parsed.",
  "Say what you found and why it matters, in a few sentences.",
]);

/**
 * The system prompt handed to `runBedrockToolLoop` as the conversation's
 * `system`.
 *
 * @returns The fixed, script-authored system prompt.
 *
 * @example
 * ```ts
 * import { healthCheckSystemPrompt } from "./health-prompt.js";
 *
 * const system = healthCheckSystemPrompt();
 * ```
 */
export function healthCheckSystemPrompt(): string {
  return SYSTEM_PROMPT_LINES.join("\n");
}

/** Inputs for {@link healthCheckUserPrompt}. */
export interface HealthCheckUserPromptOptions {
  /**
   * The operator's declared scope from the `scripts` config parameter. Empty
   * means "every discovered script". These names came through
   * `config.ts`'s `eachAllowedScriptName` validator at config-load time, so
   * they are operator-authored and allowlist-checked — never model-supplied.
   */
  readonly scripts: readonly string[];
  /**
   * Whether the `script_dry_run` tool was actually registered. The prompt
   * must not advertise a tool the registry does not carry: a model told to
   * use a nonexistent tool spends turns discovering it is not there.
   */
  readonly dryRunProbesEnabled: boolean;
}

/**
 * Builds the opening user turn.
 *
 * @remarks
 * The `scripts` list is the one place a *configured* value reaches a prompt,
 * and it is joined with `", "` into a single sentence rather than
 * interpolated per-name into instructions. Every name is already
 * allowlist-shaped (`config.ts` attaches `eachAllowedScriptName`), so it
 * cannot carry a newline, a quote, or a control character that would change
 * the prompt's structure.
 *
 * @param options - See {@link HealthCheckUserPromptOptions}.
 * @returns The opening user message text.
 *
 * @example
 * ```ts
 * import { healthCheckUserPrompt } from "./health-prompt.js";
 *
 * const text = healthCheckUserPrompt({
 *   scripts: [],
 *   dryRunProbesEnabled: false,
 * });
 * ```
 */
export function healthCheckUserPrompt(
  options: HealthCheckUserPromptOptions,
): string {
  const scope =
    options.scripts.length === 0
      ? "Check the whole fleet."
      : `Focus on these scripts: ${options.scripts.join(", ")}.`;
  const probes = options.dryRunProbesEnabled
    ? `The ${AGENT_HEALTH_TOOL_NAMES.scriptDryRun} tool is available for this run; use it only on a script you already have reason to suspect.`
    : `No dry-run probe tool is available for this run; do not ask for one.`;
  return [
    "Run a health check on the automation fleet and report what you find.",
    scope,
    probes,
  ].join("\n");
}
