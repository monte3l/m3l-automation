/**
 * `core/prompt/types` — shared type contracts for the `core/prompt`
 * submodule: the choice shapes, the injected prompt-adapter port, and the
 * per-method option bags.
 *
 * @packageDocumentation
 */

/**
 * A single selectable option for {@link M3LPromptAdapter.select},
 * {@link M3LPromptAdapter.checkbox}, or {@link M3LPromptAdapter.search}.
 *
 * A bare value is also accepted wherever `M3LChoice<Value>` is accepted (see
 * {@link M3LChoices}) — the object form exists only when a label,
 * description, or disabled/checked state is needed.
 *
 * @example
 * ```ts
 * import type { M3LChoice } from "@m3l-automation/m3l-common/core";
 *
 * const choice: M3LChoice<string> = {
 *   name: "Europe (South)",
 *   value: "eu-south-1",
 *   description: "Milan, Italy",
 * };
 * ```
 */
export interface M3LChoice<Value> {
  /** Display label shown to the user; defaults to `String(value)` when omitted. */
  readonly name?: string;
  /** The value resolved when this choice is selected. */
  readonly value: Value;
  /** Optional helper text shown alongside the choice. */
  readonly description?: string;
  /**
   * Whether the choice is pre-checked (checkbox/multiselect context) — only
   * meaningful for `checkbox`.
   */
  readonly checked?: boolean;
  /**
   * Disables the choice. A `string` value is shown as the disabled reason;
   * `true` disables without a reason.
   */
  readonly disabled?: boolean | string;
}

/**
 * The choices list accepted by `select` / `multiselect` / `autocomplete`: a
 * bare `Value[]` (the zero-friction default) or a richer
 * `M3LChoice<Value>[]` when labels, descriptions, or disabled state are
 * needed. The two forms may not be mixed within a single list.
 *
 * @example
 * ```ts
 * import type { M3LChoices } from "@m3l-automation/m3l-common/core";
 *
 * const regions: M3LChoices<string> = ["eu-south-1", "us-east-1"];
 * ```
 */
export type M3LChoices<Value> =
  ReadonlyArray<Value> | ReadonlyArray<M3LChoice<Value>>;

/**
 * The `autocomplete` suggest function: given the current search term (or
 * `undefined` for the initial, empty-input call), returns the matching
 * choices synchronously or asynchronously.
 *
 * Unlike the underlying `@inquirer/prompts` `search` source, this signature
 * takes no `AbortSignal` — {@link M3LPrompt.autocomplete} bridges the
 * signal internally so consumers never have to thread cancellation through
 * their own suggest logic.
 *
 * @example
 * ```ts
 * import type { M3LSuggestFn } from "@m3l-automation/m3l-common/core";
 *
 * const suggestRegion: M3LSuggestFn<string> = (term) => {
 *   const regions = ["eu-south-1", "us-east-1", "ap-northeast-1"];
 *   if (term === undefined) return regions;
 *   return regions.filter((r) => r.includes(term));
 * };
 * ```
 */
export type M3LSuggestFn<Value = string> = (
  term: string | undefined,
) => M3LChoices<Value> | Promise<M3LChoices<Value>>;

/**
 * Options accepted by {@link M3LPrompt.number}.
 *
 * @example
 * ```ts
 * import type { M3LNumberPromptOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LNumberPromptOptions = { min: 0, max: 10, default: 3 };
 * ```
 */
export interface M3LNumberPromptOptions {
  /** Inclusive lower bound; validated both by the adapter and by `M3LPrompt` itself. */
  readonly min?: number;
  /** Inclusive upper bound; validated both by the adapter and by `M3LPrompt` itself. */
  readonly max?: number;
  /** Value pre-filled in the prompt when the user submits without typing. */
  readonly default?: number;
}

/**
 * The injected prompt-adapter port consumed by {@link M3LPrompt}. The
 * default production adapter is a thin pass-through over
 * `@inquirer/prompts`; tests inject a mock implementing this interface so
 * prompt behavior is verifiable without a real TTY.
 *
 * Every method returns a `Promise` that rejects when the underlying prompt
 * is cancelled (e.g. Ctrl+C) — `M3LPrompt` never swallows that rejection.
 *
 * @example
 * ```ts
 * import type { M3LPromptAdapter } from "@m3l-automation/m3l-common/core";
 *
 * const noopAdapter: M3LPromptAdapter = {
 *   input: async () => "value",
 *   password: async () => "secret",
 *   number: async () => 1,
 *   confirm: async () => true,
 *   select: async (config) => config.choices[0] as never,
 *   checkbox: async () => [],
 *   search: async (config) => {
 *     const results = await config.source(undefined, {
 *       signal: new AbortController().signal,
 *     });
 *     const [first] = results;
 *     return (typeof first === "object" && first !== null
 *       ? first.value
 *       : first) as never;
 *   },
 * };
 * ```
 */
export interface M3LPromptAdapter {
  /** Prompts for a free-text line of input. */
  input(config: {
    readonly message: string;
    readonly default?: string;
    readonly validate?: (
      value: string,
    ) => boolean | string | Promise<boolean | string>;
  }): Promise<string>;

  /** Prompts for masked (password) input. */
  password(config: {
    readonly message: string;
    readonly mask?: boolean | string;
    readonly validate?: (
      value: string,
    ) => boolean | string | Promise<boolean | string>;
  }): Promise<string>;

  /** Prompts for a numeric value, optionally bounded by `min`/`max`. */
  number(config: {
    readonly message: string;
    readonly default?: number;
    readonly min?: number;
    readonly max?: number;
    readonly required?: boolean;
    readonly validate?: (
      value: number | undefined,
    ) => boolean | string | Promise<boolean | string>;
  }): Promise<number | undefined>;

  /** Prompts for a yes/no confirmation. */
  confirm(config: {
    readonly message: string;
    readonly default?: boolean;
  }): Promise<boolean>;

  /** Prompts for a single choice from a list. */
  select<Value>(config: {
    readonly message: string;
    readonly choices: M3LChoices<Value>;
    readonly default?: Value;
  }): Promise<Value>;

  /** Prompts for zero or more choices from a list. */
  checkbox<Value>(config: {
    readonly message: string;
    readonly choices: M3LChoices<Value>;
    readonly required?: boolean;
    readonly validate?: (
      choices: ReadonlyArray<{ readonly value: Value }>,
    ) => boolean | string | Promise<boolean | string>;
  }): Promise<Value[]>;

  /** Prompts for a single choice from a dynamically-sourced, searchable list. */
  search<Value>(config: {
    readonly message: string;
    readonly source: (
      term: string | undefined,
      opt: { readonly signal: AbortSignal },
    ) => M3LChoices<Value> | Promise<M3LChoices<Value>>;
    readonly default?: Value;
  }): Promise<Value>;
}
