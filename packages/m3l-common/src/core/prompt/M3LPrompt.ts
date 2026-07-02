/**
 * `core/prompt/M3LPrompt` — the unified interactive-prompt facade.
 *
 * @packageDocumentation
 */

import { createInquirerAdapter } from "../../internal/prompt/inquirerAdapter.js";

import { M3LLoadingBar } from "./M3LLoadingBar.js";
import type { M3LLoadingBarOptions } from "./M3LLoadingBar.js";
import { M3LMultiSpinner } from "./M3LMultiSpinner.js";
import type { M3LMultiSpinnerOptions } from "./M3LMultiSpinner.js";
import { M3LPromptValidationError } from "./M3LPromptValidationError.js";
import type {
  M3LChoices,
  M3LNumberPromptOptions,
  M3LPromptAdapter,
  M3LSuggestFn,
} from "./types.js";

/**
 * Constructor options for {@link M3LPrompt}.
 *
 * @example
 * ```ts
 * import type { M3LPromptOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LPromptOptions = { spinner: { interactive: false } };
 * ```
 */
export interface M3LPromptOptions {
  /**
   * The prompt-adapter port to drive all input methods. Defaults to a
   * production adapter backed by `@inquirer/prompts`. Inject a mock in
   * tests to make prompt behavior verifiable without a real TTY.
   */
  readonly adapter?: M3LPromptAdapter;
  /**
   * The spinner used for `prompt.spinner`. Accepts either a pre-built
   * {@link M3LMultiSpinner} instance or its constructor options.
   */
  readonly spinner?: M3LMultiSpinner | M3LMultiSpinnerOptions;
  /**
   * The loading bar used for `prompt.loadingBar`. Accepts either a
   * pre-built {@link M3LLoadingBar} instance or its constructor options.
   */
  readonly loadingBar?: M3LLoadingBar | M3LLoadingBarOptions;
}

/**
 * Throws when `min` and `max` are both supplied and contradictory
 * (`min > max`), before the adapter is ever invoked.
 */
function assertValidRange(
  min: number | undefined,
  max: number | undefined,
): void {
  if (min !== undefined && max !== undefined && min > max) {
    throw new M3LPromptValidationError(
      `contradictory number range: min (${String(min)}) > max (${String(max)})`,
      { context: { min, max } },
    );
  }
}

/**
 * Narrows `value` to a finite, in-range `number`, throwing
 * {@link M3LPromptValidationError} otherwise. Re-validates independently of
 * the adapter so a misbehaving adapter can never smuggle an out-of-range or
 * non-finite value past {@link M3LPrompt.number}.
 */
function assertFiniteInRange(
  value: number | undefined,
  min: number | undefined,
  max: number | undefined,
): asserts value is number {
  const isValid =
    value !== undefined &&
    Number.isFinite(value) &&
    (min === undefined || value >= min) &&
    (max === undefined || value <= max);

  if (!isValid) {
    throw new M3LPromptValidationError(
      `number value ${String(value)} failed validation`,
      { context: { value, min, max } },
    );
  }
}

/** Narrows an already-built instance vs. a constructor-options bag by branding on the class prototype. */
function resolveSpinner(
  option: M3LMultiSpinner | M3LMultiSpinnerOptions | undefined,
): M3LMultiSpinner {
  if (option instanceof M3LMultiSpinner) return option;
  return new M3LMultiSpinner(option);
}

/** Narrows an already-built instance vs. a constructor-options bag by branding on the class prototype. */
function resolveLoadingBar(
  option: M3LLoadingBar | M3LLoadingBarOptions | undefined,
): M3LLoadingBar {
  if (option instanceof M3LLoadingBar) return option;
  return new M3LLoadingBar(option);
}

/**
 * Unified facade over interactive CLI prompts, a concurrent-task spinner,
 * and a progress bar. Every prompt method delegates to an injected
 * {@link M3LPromptAdapter} (a production adapter backed by
 * `@inquirer/prompts` by default), so behavior is fully mockable in tests
 * without touching a real terminal.
 *
 * Adapter rejections (e.g. the user cancelling a prompt) propagate to the
 * caller unchanged — `M3LPrompt` never swallows them.
 *
 * @example
 * ```ts
 * import { M3LPrompt } from "@m3l-automation/m3l-common/core";
 *
 * const prompt = new M3LPrompt();
 *
 * const name = await prompt.text("Project name?");
 * const secret = await prompt.password("API token?");
 * const retries = await prompt.number("Retries?", { min: 0, max: 10 });
 * const proceed = await prompt.confirm("Continue?");
 * const region = await prompt.select("Region?", ["eu-south-1", "us-east-1"]);
 * ```
 */
export class M3LPrompt {
  private readonly adapter: M3LPromptAdapter;

  /** The spinner composed into this facade; see {@link M3LMultiSpinner}. */
  readonly spinner: M3LMultiSpinner;

  /** The loading bar composed into this facade; see {@link M3LLoadingBar}. */
  readonly loadingBar: M3LLoadingBar;

  /**
   * Creates a new `M3LPrompt`. Construction performs no adapter calls and no
   * I/O — nothing is written to any stream, and no prompt is shown, until an
   * instance method is called.
   *
   * @param options - Optional configuration; all fields have sensible
   *   defaults for a terminal-attached process.
   */
  constructor(options: M3LPromptOptions = {}) {
    this.adapter = options.adapter ?? createInquirerAdapter();
    this.spinner = resolveSpinner(options.spinner);
    this.loadingBar = resolveLoadingBar(options.loadingBar);
  }

  /**
   * Prompts for a free-text line of input.
   *
   * @param message - The prompt message shown to the user.
   * @param options - Optional default value pre-filled in the prompt.
   * @returns The entered text.
   */
  async text(message: string, options?: { default?: string }): Promise<string> {
    return this.adapter.input({
      message,
      ...(options?.default !== undefined && { default: options.default }),
    });
  }

  /**
   * Prompts for masked (password) input. The entered value is never written
   * to any stream, spinner text, loading-bar message, or error — it is
   * returned directly to the caller only.
   *
   * @param message - The prompt message shown to the user.
   * @returns The entered secret value.
   */
  async password(message: string): Promise<string> {
    // WHY no `mask`: omitting it is what suppresses echo entirely on the
    // production @inquirer/password adapter — passing `mask: "*"` would
    // echo one `*` per keystroke instead. Adding a mask for "nicer UX" is a
    // security-relevant regression, not a cosmetic tweak.
    return this.adapter.password({ message });
  }

  /**
   * Prompts for a numeric value, bounded by `options.min`/`options.max`.
   * The bounds are passed to the adapter AND re-validated here regardless
   * of the adapter's own enforcement, so a misbehaving adapter can never
   * smuggle an out-of-range or non-finite value past this facade.
   *
   * @param message - The prompt message shown to the user.
   * @param options - Optional `min`, `max`, and `default` bounds.
   * @returns The entered numeric value; never `undefined`.
   * @throws {@link M3LPromptValidationError} When `min > max` (checked
   *   before the adapter is invoked), or when the resolved value is not
   *   finite or falls outside `[min, max]`.
   */
  async number(
    message: string,
    options?: M3LNumberPromptOptions,
  ): Promise<number> {
    const min = options?.min;
    const max = options?.max;
    assertValidRange(min, max);

    const value = await this.adapter.number({
      message,
      ...(options?.default !== undefined && { default: options.default }),
      ...(min !== undefined && { min }),
      ...(max !== undefined && { max }),
      required: true,
    });

    assertFiniteInRange(value, min, max);
    return value;
  }

  /**
   * Prompts for a yes/no confirmation.
   *
   * @param message - The prompt message shown to the user.
   * @param options - Optional default answer.
   * @returns The confirmed boolean answer.
   */
  async confirm(
    message: string,
    options?: { default?: boolean },
  ): Promise<boolean> {
    return this.adapter.confirm({
      message,
      ...(options?.default !== undefined && { default: options.default }),
    });
  }

  /**
   * Prompts for a single choice from a list.
   *
   * @param message - The prompt message shown to the user.
   * @param choices - The selectable choices; a bare `Value[]` or a richer
   *   `M3LChoice<Value>[]`.
   * @param options - Optional default choice.
   * @returns The selected value.
   */
  async select<Value = string>(
    message: string,
    choices: M3LChoices<Value>,
    options?: { default?: Value },
  ): Promise<Value> {
    return this.adapter.select<Value>({
      message,
      choices,
      ...(options?.default !== undefined && { default: options.default }),
    });
  }

  /**
   * Prompts for zero or more choices from a list.
   *
   * @param message - The prompt message shown to the user.
   * @param choices - The selectable choices; a bare `Value[]` or a richer
   *   `M3LChoice<Value>[]`.
   * @param options - Optional `required` flag forbidding an empty selection.
   * @returns The selected values.
   */
  async multiselect<Value = string>(
    message: string,
    choices: M3LChoices<Value>,
    options?: { required?: boolean },
  ): Promise<Value[]> {
    return this.adapter.checkbox<Value>({
      message,
      choices,
      ...(options?.required !== undefined && { required: options.required }),
    });
  }

  /**
   * Prompts for a single choice from a dynamically-sourced, searchable
   * list. `suggest` is bridged to the adapter's `search` source internally
   * — the `AbortSignal` the adapter provides is never surfaced to `suggest`.
   *
   * @param message - The prompt message shown to the user.
   * @param suggest - Given the current search term (`undefined` on the
   *   initial call), returns the matching choices.
   * @param options - Optional default choice.
   * @returns The selected value.
   */
  async autocomplete<Value = string>(
    message: string,
    suggest: M3LSuggestFn<Value>,
    options?: { default?: Value },
  ): Promise<Value> {
    return this.adapter.search<Value>({
      message,
      source: (term) => suggest(term),
      ...(options?.default !== undefined && { default: options.default }),
    });
  }
}
