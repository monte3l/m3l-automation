/**
 * `internal/prompt/inquirerAdapter` — the production {@link M3LPromptAdapter}
 * implementation, a thin pass-through over `@inquirer/prompts`.
 *
 * Private to `core/prompt`; never re-exported through a public barrel.
 */

import {
  checkbox,
  confirm,
  input,
  number,
  password,
  search,
  select,
} from "@inquirer/prompts";

import type { M3LPromptAdapter } from "../../core/prompt/types.js";

/**
 * Builds the default production {@link M3LPromptAdapter}, delegating each
 * method directly to the matching `@inquirer/prompts` function.
 *
 * @returns An adapter backed by real terminal prompts.
 */
export function createInquirerAdapter(): M3LPromptAdapter {
  return {
    input: (config) => input(config),
    // WHY no `mask` passed through: on @inquirer/password@5.x, omitting
    // `mask` is what suppresses echo entirely — passing `mask: "*"` would
    // echo one `*` per keystroke instead of hiding input. Do not add a
    // default mask here "for nicer UX"; that is a security regression.
    password: (config) => password(config),
    number: (config) => number(config),
    confirm: (config) => confirm(config),
    select: (config) => select(config),
    checkbox: (config) => checkbox(config),
    search: (config) => search(config),
  };
}
