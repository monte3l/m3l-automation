/**
 * `agent-operator/steps/triage-prompt` — the system and user prompts for the
 * `triage_logs` workload.
 *
 * @remarks
 * This operation exposes exactly **one** tool, `triage_logs`, and there is no
 * discovery tool the model can call to list what names are valid. That makes
 * the user prompt the model's *only* channel to the allowed preset names, and
 * those names are operator-declared config (`presetAllowlist`), never model
 * input. As with the ETL sibling prompt, the wording here is a closed-set
 * statement — "only these", "one of the following" — rather than a bare list
 * that could be read as illustrative examples the model is free to extend.
 *
 * Unlike `run_preset`, `triage_logs` is single-phase and READ-ONLY: it never
 * mutates anything and there is no dry-run gate to describe. The system
 * prompt states that guarantee directly instead of an ordering guarantee.
 * The target script's `analyze` verb returns a closed `AnalysisVerdict`
 * union, so the prompt asks the model to report the verdict it was given
 * rather than substitute its own reading of what happened.
 *
 * Neither prompt names a filesystem path: the model is handed a preset KEY
 * from `presetAllowlist`, and only the operator's own config resolves that
 * key to a path under `data/config/presets/`. Leaking the path here would
 * blur a boundary the whole slice keeps sharp.
 *
 * @packageDocumentation
 */

/**
 * The system prompt. Assembled from array joins rather than one long
 * template literal so prettier cannot reflow a sentence into a shape that
 * changes the rendered text, and so each clause is independently reviewable
 * in a diff.
 */
const SYSTEM_PROMPT_LINES: readonly string[] = Object.freeze([
  "You are the operator of an automation fleet. Your job in this run is to",
  "triage one CloudWatch alarm using the triage_logs tool.",
  "",
  "How the tool works:",
  "- triage_logs is READ-ONLY: it queries and analyzes logs and never",
  "  mutates anything. There is no dry-run phase to wait on — every call",
  "  gives you a final result directly.",
  "- The tool returns a verdict drawn from a fixed, closed set of outcomes.",
  "  Report the verdict you were given, in your own words, rather than",
  "  substituting a different reading of what happened.",
  "",
  "Two things are not negotiable:",
  "- You may only pass a preset name that the operator has explicitly",
  "  allowed for this run. You have no tool to discover or list other",
  "  names, and there is no way to validate a name before calling the tool.",
  "- Only ever use a name you were given for this run. An unlisted name is",
  "  not a fallback option; it is a request the gate will refuse.",
  "",
  "Your reply is PROSE ONLY, for a human reading a run log. Say what",
  "happened and why it matters, in a few sentences.",
]);

/**
 * The system prompt handed to `runBedrockToolLoop` as the conversation's
 * `system`.
 *
 * @returns The fixed, script-authored system prompt.
 *
 * @example
 * ```ts
 * import { triageLogsSystemPrompt } from "./triage-prompt.js";
 *
 * const system = triageLogsSystemPrompt();
 * ```
 */
export function triageLogsSystemPrompt(): string {
  return SYSTEM_PROMPT_LINES.join("\n");
}

/** Inputs for {@link triageLogsUserPrompt}. */
export interface TriageLogsUserPromptOptions {
  /** The consuming script's name, for the run log the model is writing for. */
  readonly scriptName: string;
  /**
   * The operator-declared `presetAllowlist` entries for this run. These
   * names came through config-load-time validation (`verifyTriagePresets`),
   * so they are operator-authored — never model-supplied. An empty array is
   * defensive only: `verifyTriagePresets` already refuses an empty
   * allowlist before this prompt can be built. The branch is kept anyway,
   * mirroring `run_preset`'s sibling prompt, so a caller that somehow
   * reaches this function with nothing allowed still gets an explicit
   * statement of emptiness rather than a list that could be misread as
   * "choose anything".
   */
  readonly presetNames: readonly string[];
}

/**
 * Builds the opening user turn.
 *
 * @remarks
 * The `presetNames` list is the one place a *configured* value reaches this
 * prompt, and it is presented as an explicit closed set ("only one of the
 * following") rather than examples in a sentence — a model that reads the
 * list as illustrative has license to try something not on it, which is
 * exactly what the allowlist exists to prevent. Every name here is a preset
 * KEY, never a path: only the operator's own config resolves a key to a
 * file under `data/config/presets/`.
 *
 * @param input - See {@link TriageLogsUserPromptOptions}.
 * @returns The opening user message text.
 *
 * @example
 * ```ts
 * import { triageLogsUserPrompt } from "./triage-prompt.js";
 *
 * const text = triageLogsUserPrompt({
 *   scriptName: "cloudwatch-logs-analysis",
 *   presetNames: ["triage-checkout-5xx"],
 * });
 * ```
 */
export function triageLogsUserPrompt(
  input: TriageLogsUserPromptOptions,
): string {
  const allowed =
    input.presetNames.length === 0
      ? "No presets are declared for this run: the allowlist is empty, so " +
        "every triage_logs call will be refused. Do not attempt a call; " +
        "report that no preset is available."
      : `Only one of the following preset names is allowed for this run: ` +
        `${input.presetNames.join(", ")}. Call triage_logs with exactly ` +
        "one of these names — never a name outside this list.";
  return [
    `Triage the CloudWatch alarm for the "${input.scriptName}" script and`,
    "report the verdict.",
    allowed,
  ].join("\n");
}
