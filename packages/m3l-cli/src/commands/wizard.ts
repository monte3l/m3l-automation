/**
 * `commands/wizard` — the interactive `m3l wizard` flow: a TTY guard, a
 * fuzzy script picker, per-parameter prompting driven by each declared
 * parameter's type/secret flag, a redacted confirm summary, an optional
 * save-as-preset step, and a final run decision that spawns the selected
 * script and best-effort records history.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../cli/errors.js";
import { formatAlignedTable } from "../cli/table.js";
import { sanitizeTerminalText } from "../cli/output.js";
import type { M3LCliOutput } from "../cli/output.js";
import type { M3LCliCommandContext } from "./context.js";
import { discoverScripts } from "../discovery/discover.js";
import type { M3LCliScriptCandidate } from "../discovery/discover.js";
import { loadParametersCached } from "../discovery/cached-load.js";
import type {
  M3LCliOperationDescriptor,
  M3LCliParameterDescriptor,
} from "../discovery/load-config.js";
import { spawnScript } from "../run/spawn.js";
import { recordHistoryEntry } from "../history/store.js";
import { writePreset } from "../presets/store.js";
import { translateArgv } from "./dynamic.js";
import {
  collectScopedParameterNames,
  isRequiredForOperation,
  shouldPromptParameter,
} from "./wizard-operations.js";

/**
 * `M3LCliCommandContext` plus the run-history file's absolute path (8f) —
 * `runWizard`'s own parameter type, narrower than the shared base so the
 * best-effort history recording below can read `context.historyFilePath`
 * without a cast.
 */
interface M3LCliWizardCommandContext extends M3LCliCommandContext {
  readonly historyFilePath: string;
}

/**
 * The minimal prompt port `runWizard` drives — shaped to exactly the
 * `Core.M3LPrompt` methods the wizard flow uses, so the real class satisfies
 * this structurally (see the pinned type-contract test in
 * `tests/wizard.test.ts`) while a hand-scripted fake stays trivial to build
 * for tests.
 *
 * @example
 * ```ts
 * import { M3LPrompt } from "@m3l-automation/m3l-common/core";
 * import type { M3LCliWizardPrompt } from "./wizard.js";
 *
 * // M3LPrompt structurally satisfies M3LCliWizardPrompt — no adapter needed.
 * const prompt: M3LCliWizardPrompt = new M3LPrompt();
 * ```
 */
export interface M3LCliWizardPrompt {
  /**
   * Prompts for a single choice from a dynamically-sourced, searchable list.
   * Fixed to `string` (rather than `Core.M3LPrompt.autocomplete`'s generic
   * `Value`) — the wizard only ever picks a script name.
   */
  autocomplete(
    message: string,
    suggest: Core.M3LSuggestFn<string>,
    options?: { default?: string },
  ): Promise<string>;
  /** Prompts for a free-text line of input. */
  text(message: string, options?: { default?: string }): Promise<string>;
  /** Prompts for masked (password) input; the entered value is never echoed. */
  password(message: string): Promise<string>;
  /** Prompts for a numeric value. */
  number(
    message: string,
    options?: Core.M3LNumberPromptOptions,
  ): Promise<number>;
  /** Prompts for a yes/no confirmation. */
  confirm(message: string, options?: { default?: boolean }): Promise<boolean>;
  /** Prompts for a single choice from a fixed list (U8 — operation selection). */
  select(
    message: string,
    choices: Core.M3LChoices<string>,
    options?: { default?: string },
  ): Promise<string>;
}

/** The set of value shapes a collected/translated parameter value can take. */
type M3LCliWizardValues = Record<string, string | boolean | string[]>;

/** Exit code for the non-interactive-stdin usage guard. */
const USAGE_EXIT_CODE = 2;

/**
 * Resolves the prompt port `runWizard` drives: an injected override, or a
 * lazily-constructed real `Core.M3LPrompt`.
 *
 * Typed as `unknown` at this injection seam (rather than
 * {@link M3LCliWizardPrompt} directly), narrowed here via a single `as`: a
 * hand-scripted test fake built from bare `vi.fn()` calls infers to
 * vitest's `Mock<Procedure | Constructable>` type, whose `Constructable`
 * union member carries no call signature at all — under TypeScript's union
 * assignability rules (a union is only usable for what EVERY member
 * supports) that makes `Mock<Procedure | Constructable>` structurally
 * unmatchable against ANY concretely-typed callable interface, regardless of
 * the target method's arity or parameter shapes. `M3LCliWizardPrompt` itself
 * stays strictly typed (see the exported type-contract test pinning
 * `Core.M3LPrompt` against it); only this call-site injection seam is
 * loosened to accommodate that unrelated toolchain limitation.
 */
function resolveWizardPrompt(override: unknown): M3LCliWizardPrompt {
  if (override !== undefined) {
    return override as M3LCliWizardPrompt;
  }
  return new Core.M3LPrompt();
}

/** Fuzzy-picks a script via `prompt.autocomplete`, throwing when the selection doesn't match a discovered candidate. */
async function resolveSelectedScript(
  prompt: M3LCliWizardPrompt,
  candidates: readonly M3LCliScriptCandidate[],
): Promise<M3LCliScriptCandidate> {
  const scriptName = await prompt.autocomplete(
    "Select a script to run",
    buildScriptSuggestFn(candidates),
  );
  const candidate = candidates.find((entry) => entry.name === scriptName);
  if (candidate === undefined) {
    throw new M3LCliError(
      "ERR_CLI_UNKNOWN_SCRIPT",
      `unknown script '${scriptName}'`,
    );
  }
  return candidate;
}

/**
 * Prompts for every declared parameter, in declaration order, collecting the
 * non-skipped values.
 *
 * Once a value has been collected for a descriptor declaring a non-empty
 * `operations` array (ADR-0055, U8), every subsequent descriptor is scoped
 * against the chosen operation: {@link shouldPromptParameter} decides whether
 * it is prompted at all (a parameter scoped to a *different* operation is
 * skipped entirely — no prompt call, no entry in the returned values), and
 * {@link isRequiredForOperation} widens the empty-answer re-ask policy to
 * cover a parameter the chosen operation requires even when its own
 * `required` flag is `false`.
 */
async function collectAllParameterValues(
  prompt: M3LCliWizardPrompt,
  descriptors: readonly M3LCliParameterDescriptor[],
  output: M3LCliOutput,
): Promise<M3LCliWizardValues> {
  const values: M3LCliWizardValues = {};
  let chosenOperation: M3LCliOperationDescriptor | undefined;
  let scoped: ReadonlySet<string> = new Set();

  for (const descriptor of descriptors) {
    if (
      !shouldPromptParameter(descriptor, chosenOperation, scoped, descriptors)
    ) {
      continue;
    }

    const required =
      descriptor.required ||
      isRequiredForOperation(descriptor, chosenOperation, descriptors);
    const collected = await collectParameterValue(
      prompt,
      descriptor,
      output,
      required,
    );
    if (collected !== undefined) {
      values[descriptor.name] = finalizeValue(descriptor, collected.value);
    }

    if (
      chosenOperation === undefined &&
      collected !== undefined &&
      descriptor.operations !== undefined &&
      descriptor.operations.length > 0
    ) {
      const selected = descriptor.operations.find(
        (operation) => operation.name === collected.value,
      );
      if (selected !== undefined) {
        chosenOperation = selected;
        scoped = collectScopedParameterNames(
          descriptor.operations,
          descriptors,
        );
      }
    }
  }
  return values;
}

/** Builds the prompt message for one declared parameter: its name, plus its description when non-empty. */
function buildParameterMessage(descriptor: M3LCliParameterDescriptor): string {
  return descriptor.description === ""
    ? descriptor.name
    : `${descriptor.name} — ${descriptor.description}`;
}

/**
 * Parses a descriptor's declared `defaultValue` as a finite number for the
 * `number` prompt's `default` option — `undefined` when no default is
 * declared or it isn't parseable.
 */
function parseNumberDefault(
  defaultValue: string | undefined,
): number | undefined {
  if (defaultValue === undefined) {
    return undefined;
  }
  const parsed = Number(defaultValue);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** One raw prompt answer: `raw` is the string form (for emptiness checks) when the underlying prompt is string-shaped, `undefined` for confirm/number answers that can never be "empty". */
interface M3LCliWizardRawAnswer {
  readonly raw: string | undefined;
  readonly value: string | boolean | number;
}

/** Builds the `select` choices for a descriptor's declared operations, rendered as `"name — description"` (ADR-0055, U8). */
function buildOperationChoices(
  operations: readonly M3LCliOperationDescriptor[],
): Core.M3LChoices<string> {
  return operations.map((operation) => ({
    value: operation.name,
    name: `${operation.name} — ${operation.description}`,
  }));
}

/**
 * Prompts once for `descriptor`'s value, dispatching by secret flag, then a
 * non-empty declared `operations` list (ADR-0055, U8 — prompted via
 * `select`, choices rendered as `"name — description"`), then declared type:
 * `secret` always uses `password` (regardless of the declared type); `BOOL`
 * uses `confirm` (default `false` unless `defaultValue` is the literal
 * string `"true"`); `INT`/`DOUBLE` use `number` (forwarding a parseable
 * declared default); everything else (including `STRING_ARRAY`) uses `text`
 * (a non-array type forwards its declared default as the prefill, sanitized
 * via {@link sanitizeTerminalText} — `M3LPrompt` escapes only the prompt
 * `message`, not the `default` prefill, and a declared default is
 * attacker-influencable script config).
 */
async function promptOnce(
  prompt: M3LCliWizardPrompt,
  descriptor: M3LCliParameterDescriptor,
): Promise<M3LCliWizardRawAnswer> {
  const message = buildParameterMessage(descriptor);

  if (descriptor.secret === true) {
    const value = await prompt.password(message);
    return { raw: value, value };
  }

  if (descriptor.operations !== undefined && descriptor.operations.length > 0) {
    const value = await prompt.select(
      message,
      buildOperationChoices(descriptor.operations),
    );
    return { raw: value, value };
  }

  switch (descriptor.type) {
    case "BOOL": {
      const value = await prompt.confirm(message, {
        default: descriptor.defaultValue === "true",
      });
      return { raw: undefined, value };
    }
    case "INT":
    case "DOUBLE": {
      const parsedDefault = parseNumberDefault(descriptor.defaultValue);
      const value = await prompt.number(
        message,
        parsedDefault === undefined ? {} : { default: parsedDefault },
      );
      return { raw: undefined, value };
    }
    case "STRING_ARRAY": {
      const value = await prompt.text(message);
      return { raw: value, value };
    }
    default: {
      const value = await prompt.text(
        message,
        descriptor.defaultValue === undefined
          ? {}
          : { default: sanitizeTerminalText(descriptor.defaultValue) },
      );
      return { raw: value, value };
    }
  }
}

/** Whether a raw answer counts as "empty" — only string-shaped answers (never confirm/number) can be. */
function isEmptyAnswer(answer: M3LCliWizardRawAnswer): boolean {
  return answer.raw !== undefined && answer.raw.trim() === "";
}

/**
 * Prompts for one declared parameter's value, applying the empty-answer
 * policy: an empty answer is skipped silently unless `required` is `true` —
 * `required` is the caller-resolved union of `descriptor.required` and
 * {@link isRequiredForOperation} against the chosen operation (U8), not just
 * the descriptor's own flag. A required empty answer is re-prompted once,
 * then skipped with a rendered warning naming it (the script's own
 * required-validation is the authority and will fail loud at run).
 *
 * @returns The collected raw value, or `undefined` when the parameter was
 *   skipped.
 */
async function collectParameterValue(
  prompt: M3LCliWizardPrompt,
  descriptor: M3LCliParameterDescriptor,
  output: M3LCliOutput,
  required: boolean,
): Promise<{ readonly value: string | boolean | number } | undefined> {
  let answer = await promptOnce(prompt, descriptor);
  if (isEmptyAnswer(answer)) {
    if (!required) {
      return undefined;
    }
    answer = await promptOnce(prompt, descriptor);
    if (isEmptyAnswer(answer)) {
      output.error(
        `skipped required parameter '${descriptor.name}' — no value entered after re-prompt`,
      );
      return undefined;
    }
  }
  return { value: answer.value };
}

/**
 * Transforms a collected raw answer into its final stored shape: a
 * `STRING_ARRAY` answer is comma-split, trimmed, and empty entries dropped; a
 * numeric answer is rendered via `String(...)` (matching `translateArgv`'s
 * own non-array/non-boolean translation and `writePreset`'s value type);
 * everything else passes through unchanged.
 */
function finalizeValue(
  descriptor: M3LCliParameterDescriptor,
  rawValue: string | boolean | number,
): string | boolean | string[] {
  if (descriptor.type === "STRING_ARRAY" && typeof rawValue === "string") {
    return rawValue
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (typeof rawValue === "number") {
    return String(rawValue);
  }
  return rawValue;
}

/** Builds the fuzzy autocomplete suggest function over discovered script candidates, rendered as `"name — description"`. */
function buildScriptSuggestFn(
  candidates: readonly M3LCliScriptCandidate[],
): Core.M3LSuggestFn<string> {
  return (term) => {
    const needle = (term ?? "").toLowerCase();
    return candidates
      .filter((candidate) => candidate.name.toLowerCase().includes(needle))
      .map((candidate) => ({
        value: candidate.name,
        name: `${candidate.name} — ${candidate.description}`,
      }));
  };
}

/**
 * Renders one value for the confirm summary: a secret-flagged parameter's
 * value is ALWAYS hard-masked, regardless of what
 * `Core.redactSensitiveLogValue` would otherwise render — the raw secret
 * value must never reach this rendering path.
 */
function displaySummaryValue(
  descriptor: M3LCliParameterDescriptor,
  value: string | boolean | string[],
): string {
  if (descriptor.secret === true) {
    return "********";
  }
  const redacted = Core.redactSensitiveLogValue(value);
  return Array.isArray(redacted)
    ? redacted.map((item) => String(item)).join(", ")
    : String(redacted);
}

/**
 * Renders the PARAMETER/VALUE confirm summary for every collected
 * (non-skipped) parameter — both cells are sanitized via
 * {@link sanitizeTerminalText} before rendering, since a parameter's name and
 * value both ultimately trace back to attacker-influencable script config or
 * user-entered input.
 */
function renderSummary(
  output: M3LCliOutput,
  descriptors: readonly M3LCliParameterDescriptor[],
  values: Readonly<M3LCliWizardValues>,
): void {
  const rows = descriptors
    .filter((descriptor) => Object.hasOwn(values, descriptor.name))
    .map((descriptor) => [
      sanitizeTerminalText(descriptor.name),
      sanitizeTerminalText(
        displaySummaryValue(descriptor, values[descriptor.name] ?? ""),
      ),
    ]);

  if (rows.length === 0) {
    output.info("no parameters entered");
    return;
  }

  output.heading("Summary");
  for (const line of formatAlignedTable(["PARAMETER", "VALUE"], rows)) {
    output.info(line);
  }
}

/**
 * Prompts for a preset name and attempts to save `values` via
 * {@link writePreset}, rendering a notice naming any secret-flagged
 * parameters `writePreset` refused to persist. A write failure (invalid
 * name, unknown key, or the write itself failing) renders the error but does
 * NOT propagate — a failed save must not lose the composed run.
 */
async function saveAsPreset(
  prompt: M3LCliWizardPrompt,
  context: M3LCliWizardCommandContext,
  values: Readonly<M3LCliWizardValues>,
  descriptors: readonly M3LCliParameterDescriptor[],
): Promise<void> {
  const presetName = await prompt.text("Preset name?");
  try {
    const result = writePreset(
      context.workspaceRoot,
      presetName,
      values,
      descriptors,
    );
    context.output.info(
      result.skippedSecrets.length > 0
        ? `preset saved to '${result.filePath}'; skipped secret parameter(s): ${result.skippedSecrets.join(", ")}`
        : `preset saved to '${result.filePath}'`,
    );
  } catch (error) {
    context.output.error(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Best-effort records a run-history entry after a successful spawn — never
 * throws, since history recording must never affect the resolved exit code
 * {@link runWizard} already has in hand.
 */
function recordWizardHistory(
  historyFilePath: string,
  scriptName: string,
  parameterNames: readonly string[],
  exitCode: number,
): void {
  try {
    recordHistoryEntry(historyFilePath, {
      timestamp: new Date().toISOString(),
      script: scriptName,
      parameterNames,
      exitCode,
    });
  } catch {
    /* best-effort: history recording must never affect the resolved exit code */
  }
}

/**
 * Runs the interactive `m3l wizard` flow.
 *
 * 1. TTY guard — a non-interactive stdin (`options.isTTY`, defaulting to
 *    `process.stdin.isTTY`) returns exit `2` without touching discovery.
 * 2. Lets the caller fuzzy-pick a discovered script via
 *    `prompt.autocomplete`.
 * 3. Loads the selected script's declared parameters (cache-aware) and
 *    prompts for each in declaration order, per its type/secret flag.
 * 4. Renders a redacted PARAMETER/VALUE confirm summary.
 * 5. Offers an optional save-as-preset step.
 * 6. Asks a final "run now?" confirm — declining resolves `0` without
 *    spawning; accepting translates the collected answers to child argv
 *    (via `commands/dynamic.js`'s shared `translateArgv`), spawns the
 *    script, and best-effort records history.
 *
 * @param context - The command context to run against; must carry
 *   `historyFilePath`.
 * @param options - Optional prompt-port and TTY overrides; both default to
 *   the real `Core.M3LPrompt` (constructed lazily, only once the TTY guard
 *   passes) and `process.stdin.isTTY`. `prompt` is accepted as `unknown` and
 *   narrowed internally (see {@link resolveWizardPrompt}).
 * @returns `2` when stdin isn't interactive; `0` when the run is declined;
 *   otherwise the spawned script's resolved exit code, propagated verbatim.
 *
 * @example
 * ```ts
 * const exitCode = await runWizard(context);
 * ```
 */
export async function runWizard(
  context: M3LCliWizardCommandContext,
  options?: { readonly prompt?: unknown; readonly isTTY?: boolean },
): Promise<number> {
  const isTTY = options?.isTTY ?? process.stdin.isTTY === true;
  if (!isTTY) {
    context.output.error("wizard requires an interactive terminal");
    return USAGE_EXIT_CODE;
  }

  const prompt = resolveWizardPrompt(options?.prompt);
  const candidates = discoverScripts(context.workspaceRoot);
  const candidate = await resolveSelectedScript(prompt, candidates);

  const descriptors = await loadParametersCached(
    candidate.name,
    candidate.directory,
    context.cacheFilePath,
  );
  const values = await collectAllParameterValues(
    prompt,
    descriptors,
    context.output,
  );
  const translatedArgs = translateArgv(descriptors, values);

  renderSummary(context.output, descriptors, values);

  if (
    await prompt.confirm("Save these values as a preset?", { default: false })
  ) {
    await saveAsPreset(prompt, context, values, descriptors);
  }

  if (!(await prompt.confirm("Run now?", { default: true }))) {
    context.output.info("wizard finished without running the script");
    return 0;
  }

  const exitCode = await spawnScript(candidate.directory, translatedArgs);
  recordWizardHistory(
    context.historyFilePath,
    candidate.name,
    Object.keys(values),
    exitCode,
  );
  return exitCode;
}
