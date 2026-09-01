/**
 * `core/config/deriveEnvVarName` — derives the SCREAMING_SNAKE_CASE
 * environment-variable name a dotted or dashed config key is readable under.
 *
 * @packageDocumentation
 */

/** Matches the characters replaced with `_` when deriving the variable name. */
const KEY_NORMALIZATION_PATTERN = /[.-]/g;

/**
 * Derives the SCREAMING_SNAKE_CASE environment-variable name for a config
 * key: every `.` and `-` becomes `_`, then the whole key is uppercased.
 *
 * This is the exact derivation {@link M3LEnvironmentConfigProvider} applies
 * when resolving a key at the provider chain's environment level, promoted
 * out of that class's module privacy so an out-of-process caller can compute
 * the same name without duplicating the transform. The m3l CLI is the first
 * such caller: it injects a `secret: true` parameter's value into a spawned
 * script's environment under this name instead of writing it into the
 * child's argv (ADR-0085), which only works because both sides agree on the
 * derivation exactly.
 *
 * The transform is pure and idempotent — applying it to its own output
 * returns that output unchanged — so a key already in
 * SCREAMING_SNAKE_CASE passes through untouched.
 *
 * @param key - A config key, in any of the dotted, dashed, or already-upper
 *   forms a declared parameter's canonical name can take.
 * @returns The derived environment-variable name.
 *
 * @example
 * ```ts
 * import { deriveEnvVarName } from "@m3l-automation/m3l-common/core";
 *
 * deriveEnvVarName("canonical.name"); // "CANONICAL_NAME"
 * deriveEnvVarName("license-code"); // "LICENSE_CODE"
 * ```
 */
export function deriveEnvVarName(key: string): string {
  return key.replace(KEY_NORMALIZATION_PATTERN, "_").toUpperCase();
}
