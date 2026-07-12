import { Core } from "@m3l-automation/m3l-common";

/**
 * Resolves a `--preset` CLI flag into a spreadable `M3LScriptOptions`
 * fragment (explicit path only — per `scripts.md` there is no library
 * search root or per-script fallback).
 *
 * `M3LScriptOptions.preset` must never be an explicit `""`: the library
 * treats an empty string as "a preset was configured" and throws
 * `ERR_PRESET_LOAD` trying to read it. This helper folds the bare-boolean
 * (`--preset` with no value) and blank-value (`--preset=` / whitespace-only)
 * cases down to "no preset" (`{}`) instead of forwarding them, and omits the
 * key entirely when absent so callers can spread the result without ever
 * assigning `undefined` to the optional field
 * (`exactOptionalPropertyTypes`).
 *
 * @param argv - The raw argument list to parse; defaults to
 *   `process.argv.slice(2)`, matching
 *   `Core.M3LCommandLineConfigProvider`'s own default.
 * @returns `{ preset: path }` when `--preset` carries a non-blank string
 *   value, otherwise `{}`.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { resolvePresetOption } from "./steps/resolve-preset.js";
 *
 * const script = new Core.M3LScript({
 *   metadata: { name: "json-etl", version: "0.0.0" },
 *   config: { params: [] },
 *   ...resolvePresetOption(),
 * });
 * ```
 */
export function resolvePresetOption(argv?: readonly string[]): {
  readonly preset?: string;
} {
  const raw = new Core.M3LCommandLineConfigProvider(argv).getRawValue("preset");
  return typeof raw === "string" && raw.trim().length > 0
    ? { preset: raw }
    : {};
}
