/**
 * `core/prompt/M3LPrompt` — the unified interactive-prompt facade.
 *
 * @packageDocumentation
 */

import { createInquirerAdapter } from "../../internal/prompt/inquirerAdapter.js";
import { escapeTerminalControls } from "../../internal/prompt/sanitize.js";
import { isObject, isString } from "../utils/guards.js";

import { M3LLoadingBar } from "./M3LLoadingBar.js";
import type { M3LLoadingBarOptions } from "./M3LLoadingBar.js";
import { M3LMultiSpinner } from "./M3LMultiSpinner.js";
import type { M3LMultiSpinnerOptions } from "./M3LMultiSpinner.js";
import { M3LPromptValidationError } from "./M3LPromptValidationError.js";
import type {
  M3LChoice,
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
 * Returns `true` when `item` is choice-shaped: a non-null object carrying a
 * `value` key. Deliberately mirrors `@inquirer/prompts`' own arm
 * discrimination (`typeof choice === "object" && choice !== null && "value" in choice`)
 * rather than this repo's usual `isPlainObject` +
 * `Object.hasOwn` pairing. A choice built via a class instance (not an object
 * literal) has a non-`Object.prototype` prototype and would fail
 * `isPlainObject`, yet `@inquirer/prompts` still renders it as a choice; using
 * a stricter check here than the actual downstream consumer let a whole
 * choices list fall through completely unescaped (F9b security review,
 * 2026-07-30). Also intentionally uses `in`, not `Object.hasOwn`, so an
 * inherited (non-own) `value` key — which inquirer itself would still
 * resolve — is classified as choice-shaped too.
 */
function isChoiceLike<Value>(
  item: Value | M3LChoice<Value>,
): item is M3LChoice<Value> {
  return isObject(item) && "value" in item;
}

/**
 * Escapes one choices-list element's rendered label before it reaches the
 * adapter. A choice-shaped element (per {@link isChoiceLike}) is rebuilt from
 * an explicit allowlist of exactly the five `M3LChoice` fields
 * (`value`, `name`, `description`, `checked`, `disabled`), each read via
 * direct property access rather than object-spread — property access
 * triggers getters and walks the prototype chain the same way the `in`
 * operator does in {@link isChoiceLike}, so an inherited/getter-backed `value`
 * or `name` (a class instance, `Object.create`) resolves correctly instead of
 * silently vanishing the way `{...item}` (own-enumerable-only) would. No
 * other own property of `item` — a stray `short`, a hostile `toString`, a
 * `Separator`'s `type` marker — is ever forwarded onto the rebuilt object.
 * `name` is escaped — falling back to `escapeTerminalControls(String(value))`
 * when `name` is omitted, since `@inquirer/prompts` renders
 * `name ?? String(value)` and an omitted `name` previously leaked the raw
 * value — plus `description` and a string `disabled` reason, via
 * {@link escapeTerminalControls}; `value` and `checked` are forwarded by
 * reference, unchanged, since the adapter resolves the caller's return value
 * from this exact `value`. A boolean `disabled` is left untouched; only a
 * string `disabled` reason is escaped. A genuinely bare element is wrapped
 * into a new `M3LChoice<Value>` whose `value` is the original element,
 * forwarded by reference (never cloned), and whose `name` is the escaped
 * string form.
 */
function escapeChoiceItem<Value>(
  item: Value | M3LChoice<Value>,
): M3LChoice<Value> {
  if (isChoiceLike(item)) {
    return {
      value: item.value,
      name: escapeTerminalControls(item.name ?? String(item.value)),
      ...(item.description !== undefined && {
        description: escapeTerminalControls(item.description),
      }),
      ...(item.checked !== undefined && { checked: item.checked }),
      ...(item.disabled !== undefined && {
        disabled: isString(item.disabled)
          ? escapeTerminalControls(item.disabled)
          : item.disabled,
      }),
    };
  }
  return { value: item, name: escapeTerminalControls(String(item)) };
}

/**
 * Escapes the rendered label of every element in a `select`/`multiselect`/
 * `autocomplete` choices list before it reaches the adapter. Classification
 * is per-element (see {@link isChoiceLike}), not by inspecting only the first
 * element, so a mixed/malformed array cannot leak a later element's raw
 * label. See {@link M3LPrompt}'s class-level `@remarks` for the full
 * contract.
 */
function escapeChoices<Value>(
  choices: M3LChoices<Value>,
): ReadonlyArray<M3LChoice<Value>> {
  return choices.map((item) => escapeChoiceItem<Value>(item));
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
 * @remarks
 * Every method's `message` argument is passed through the same internal
 * display-escape helper used by `confirmDestructive` before it reaches the
 * adapter, so `Cc`/`Cf`/`Zl`/`Zp` code points (terminal control sequences,
 * bidi overrides, zero-width characters) render as visible literals instead
 * of manipulating the terminal. `select`/`multiselect`/`autocomplete` extend
 * this to every element of `choices`, classified individually (not by
 * inspecting only the list's first element): an object-form
 * `M3LChoice<Value>` element has its `name` escaped — falling back to the
 * escaped `String(value)` when `name` is omitted, matching what the adapter
 * would otherwise render raw — plus its `description` and a string
 * `disabled` reason, while `value` and `checked` are always forwarded
 * unchanged by reference so the adapter still resolves the caller's exact
 * selected value. A bare element is wrapped into a new choice object whose
 * `value` is the original element, forwarded unchanged by reference, and
 * whose `name` is the escaped string form. Wrapping changes the shape of
 * what reaches the adapter (an array of choice objects rather than a bare
 * value array), but this is transparent to the caller: the adapter still
 * resolves selection against the original `value` reference, so the
 * returned/selected value is identical to what a bare, unescaped list would
 * have produced.
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
      message: escapeTerminalControls(message),
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
    return this.adapter.password({ message: escapeTerminalControls(message) });
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
      message: escapeTerminalControls(message),
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
      message: escapeTerminalControls(message),
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
      message: escapeTerminalControls(message),
      choices: escapeChoices(choices),
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
      message: escapeTerminalControls(message),
      choices: escapeChoices(choices),
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
      message: escapeTerminalControls(message),
      source: async (term) => escapeChoices(await suggest(term)),
      ...(options?.default !== undefined && { default: options.default }),
    });
  }
}
