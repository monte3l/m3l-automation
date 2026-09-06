/**
 * `agent-operator/steps/etl-prompt` — the system and user prompts for the ETL
 * `run_preset` workload.
 *
 * @remarks
 * This operation exposes exactly **one** tool, `run_preset`, and there is no
 * discovery tool the model can call to list what names are valid. That makes
 * the user prompt the model's *only* channel to the allowed preset names, and
 * those names are operator-declared config (`presetAllowlist`), never model
 * input. The wording here is deliberately a closed-set statement — "only
 * these", "one of the following" — rather than a bare list that could be
 * read as illustrative examples the model is free to extend.
 *
 * The system prompt states the two-phase contract the tool itself enforces:
 * every `run_preset` call performs a dry run first, and the mutating run
 * only happens once that dry run has cleared. The prompt does not invent
 * this gate; it just tells the model the order so it does not expect the
 * mutating effect on the first call.
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
  "run one declared ETL preset by name using the run_preset tool.",
  "",
  "How the tool works:",
  "- Every run_preset call performs a dry run FIRST. The real, mutating run",
  "  only happens after that dry run has cleared. You do not choose this",
  "  order and cannot skip the dry run — it is enforced before your call",
  "  returns.",
  "- If the dry run does not clear, the call stops there. Do not retry it,",
  "  do not rephrase it, and do not try a different preset name to force a",
  "  result.",
  "",
  "Two things are not negotiable:",
  "- You may only pass a preset name that the operator has explicitly",
  "  allowed for this run. You have no tool to discover or list other",
  "  names, and there is no way to validate a name before calling the tool.",
  "- Never guess, invent, or construct a preset name that was not given to",
  "  you. An unlisted name is not a fallback option; it is a request the",
  "  gate will refuse.",
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
 * import { runPresetSystemPrompt } from "./etl-prompt.js";
 *
 * const system = runPresetSystemPrompt();
 * ```
 */
export function runPresetSystemPrompt(): string {
  return SYSTEM_PROMPT_LINES.join("\n");
}

/** Inputs for {@link runPresetUserPrompt}. */
export interface RunPresetUserPromptOptions {
  /** The consuming script's name, for the run log the model is writing for. */
  readonly scriptName: string;
  /**
   * The operator-declared `presetAllowlist` entries for this run. These
   * names came through config-load-time validation, so they are
   * operator-authored — never model-supplied. An empty array is a real
   * operating state (no `presetAllowlist` declared yet), not a hypothetical:
   * it must be stated plainly rather than rendered as an empty list, which
   * would read as "choose anything" instead of "nothing is allowed".
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
 * exactly what the allowlist exists to prevent.
 *
 * @param options - See {@link RunPresetUserPromptOptions}.
 * @returns The opening user message text.
 *
 * @example
 * ```ts
 * import { runPresetUserPrompt } from "./etl-prompt.js";
 *
 * const text = runPresetUserPrompt({
 *   scriptName: "nightly-export",
 *   presetNames: ["eu-west-1", "us-east-1"],
 * });
 * ```
 */
export function runPresetUserPrompt(
  options: RunPresetUserPromptOptions,
): string {
  const allowed =
    options.presetNames.length === 0
      ? "No presets are declared for this run: the allowlist is empty, so " +
        "every run_preset call will be refused. Do not attempt a call; " +
        "report that no preset is available."
      : `Only one of the following preset names is allowed for this run: ` +
        `${options.presetNames.join(", ")}. Call run_preset with exactly ` +
        "one of these names — never a name outside this list.";
  return [
    `Run the declared ETL preset for the "${options.scriptName}" script and`,
    "report what happened.",
    allowed,
  ].join("\n");
}
