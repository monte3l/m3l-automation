# Core / prompt

Interactive CLI UI for `@m3l-automation/m3l-common`: a unified facade over spinners, a loading bar, and interactive input prompts that degrades gracefully in non-interactive environments.

## Overview

`M3LPrompt` is a single facade that composes a multi-spinner, a loading bar, and an interactive-prompt adapter. It offers a full set of prompt methods (text, password, number, confirm, select, multiselect, autocomplete) alongside live progress UI.

Both the spinner and the prompt facade detect whether they are running in an interactive terminal. In a TTY they render live, ANSI-redrawn output; in Lambda, CI, or a pipe they fall back to plain-text line output with ANSI color codes stripped.

## Public API

Public surface (`prompt/index.ts`):

- `M3LPrompt` — the unified facade.
- `M3LMultiSpinner`, `M3LMultiSpinnerOptions` — concurrent and single spinner control.
- `M3LLoadingBar`, `M3LLoadingBarOptions` — a progress bar.
- `M3LPromptValidationError` — thrown for out-of-range `number` input, an invalid
  loading-bar `width`, or a contradictory `number` range (`min > max`); an
  `M3LError` subclass (`code: "ERR_PROMPT_VALIDATION"`). A rejected `password`
  value is never carried in the error `context`.
- `M3LPromptOptions`, `M3LPromptAdapter` — the constructor options bag and the
  injected prompt-adapter port. The adapter defaults to a thin pass-through over
  `@inquirer/prompts`; injecting a custom adapter is what makes prompt behavior
  mockable without a TTY.
- `M3LChoice`, `M3LChoices` — the choice shape for `select` / `multiselect` /
  `autocomplete`. A bare `string[]` is the zero-friction default; a richer
  `{ name?, value, description?, disabled? }` object form is also accepted.
- `M3LNumberPromptOptions` — `{ min?, max?, default? }` for `number`.
- `M3LSuggestFn` — the `autocomplete` suggest function,
  `(term: string | undefined) => M3LChoices<Value> | Promise<M3LChoices<Value>>`.
- `confirmDestructive`, `M3LConfirmDestructiveOptions` — the shared
  confirm-before-destroy step, promoted from an identical `destructive-gate.ts`
  step duplicated across 5 consumer scripts. Bypasses, prompts for, or aborts a
  destructive action depending on a caller-supplied `yes` flag.

### `M3LPrompt`

`M3LPrompt` composes an `M3LMultiSpinner`, an `M3LLoadingBar`, and an `@inquirer/prompts` adapter. The adapter is injected via the constructor, enabling test mocking.

Prompt methods:

- `text` — free-text input.
- `password` — masked input.
- `number` — numeric input, with `min` / `max` validation.
- `confirm` — yes/no.
- `select` — single-choice.
- `multiselect` — checkbox multi-choice.
- `autocomplete` — input with a custom suggest function.

### `M3LMultiSpinner`

Operates in two modes:

- **Multi-spinner** — tracks concurrent named tasks by ID: `.spin(id, text)`, `.spinSucceed(id, text)`, `.spinFail(id, text)`, `.spinWarn(id, text)`.
- **Single-spinner** (backward-compatible) — `.startSpinner(message)`, `.updateSpinner(message)`, `.spinnerStop`, `.spinnerFail`.

### `M3LLoadingBar`

Renders a progress bar with configurable fill characters (default `█` / `░`) and accepts percentage updates (0–100) via `.update(percentage, message)`.

### `confirmDestructive`

A standalone function (not a method on `M3LPrompt`) that gates a destructive action behind interactive confirmation, with a `yes`-flag bypass for non-interactive/scripted runs. Takes `{ prompt, logger, description, yes, code }` and has three behaviors:

- **Bypass** (`yes: true`) — skips confirmation entirely, logs a single warning (`destructive confirmation bypassed (yes=true): <description>`) via `logger.warning`, and resolves. `prompt.confirm` is never called.
- **Confirmed** (`yes: false`, `prompt.confirm` resolves `true`) — prompts with `Confirm: <description>?` and resolves normally once confirmed.
- **Declined** (`yes: false`, `prompt.confirm` resolves `false`) — throws an `M3LError` (`aborted: <description>`) carrying the caller-supplied `code` verbatim.

A rejection from `prompt.confirm` (e.g. the adapter throws on a cancelled prompt) propagates unchanged and is never converted into the `aborted` error — callers that need to distinguish an explicit decline from a cancelled/failed prompt can rely on this passthrough.

## Usage examples

### Interactive input

```typescript
import { Core } from "@m3l-automation/m3l-common";

const prompt = new Core.M3LPrompt();

const name = await prompt.text("Project name?");
const secret = await prompt.password("API token?");
const retries = await prompt.number("Retries?", { min: 0, max: 10 });
const proceed = await prompt.confirm("Continue?");
const region = await prompt.select("Region?", ["eu-south-1", "us-east-1"]);
const targets = await prompt.multiselect("Targets?", [
  "dev",
  "staging",
  "prod",
]);
```

### Concurrent task spinners

```typescript
import { Core } from "@m3l-automation/m3l-common";

const spinner = new Core.M3LMultiSpinner();

spinner.spin("upload", "Uploading…");
spinner.spin("index", "Indexing…");

spinner.spinSucceed("upload", "Uploaded");
spinner.spinFail("index", "Index failed");
```

### Loading bar

```typescript
import { Core } from "@m3l-automation/m3l-common";

const bar = new Core.M3LLoadingBar();
bar.update(0, "Starting");
bar.update(50, "Halfway");
bar.update(100, "Done");
```

## Notes and behavior

- **Environment-aware rendering.** `M3LMultiSpinner` consults `M3LExecutionEnvironment.isInteractive()` and `process.stdout.isTTY` to choose between live ANSI-redrawn output (interactive terminal) and plain-text line output (Lambda, CI, pipe). In non-interactive mode ANSI color codes are stripped, keeping logs machine-readable.
- **Single vs. multi spinner.** The single-spinner methods are a backward-compatible subset; the multi-spinner methods track several named tasks concurrently by ID.
- **Testability.** Because the `@inquirer/prompts` adapter is injected via the constructor, prompt behavior can be mocked in unit tests without touching a real terminal.

## See also

- [Core / logging](./logging.md) — shares TTY-aware rendering
- [Core / environment](./environment.md) — `M3LExecutionEnvironment` drives the interactivity decision
- [Core / events](./events.md)
- [Architecture overview](../../m3l-common-architecture.md)
