/**
 * `lib/cli-names` — the script-name allowlist that anchors the argument
 * injection defence for the CLI seam. A model-supplied script name is the
 * first of the two free-form values that ever reach `runCliProcess`'s argv
 * array (the second is the preset name handled by `lib/preset-names`); this
 * module is what keeps that one value honest.
 *
 * @packageDocumentation
 */

import { M3LAgentOperatorCliError } from "./errors.js";

/**
 * A script name that has already passed {@link assertAllowedScriptName}. The
 * brand exists so a model-proposed string cannot reach `buildArgv` (and from
 * there, `runCliProcess`'s argv array) without first passing through the
 * allowlist — the internal `CliOperation` union in `cli-surface.ts` types its
 * `scriptName` field with this brand, so passing an unvalidated `string`
 * there is a compile error, not just a runtime risk.
 *
 * The brand is a **compile-time-only** device: it is erased by `tsc` and
 * carries no runtime representation or check of its own. The actual
 * guarantee — that a value tagged with this brand really did pass the
 * allowlist — is enforced entirely by {@link assertAllowedScriptName}, the
 * only function permitted to produce one.
 *
 * @example
 * ```ts
 * import type { AgentOperatorScriptName } from "./cli-names.js";
 *
 * function buildArgv(scriptName: AgentOperatorScriptName): readonly string[] {
 *   return ["inspect", scriptName, "--json"];
 * }
 * ```
 */
export type AgentOperatorScriptName = string & {
  readonly __brand: unique symbol;
};

/**
 * Kebab-case script name pattern, copied **verbatim** from `SCRIPT_NAME_RE`
 * in `packages/m3l-cli/src/scaffold/manifest.ts` (the CLI's own scaffold
 * validator). It cannot be imported here: ADR-0029 restricts a `scripts/*`
 * package to a single dependency, `@m3l-automation/m3l-common`. A
 * drift-guard test reads `manifest.ts` as text and asserts this literal
 * still matches, so any future change to the upstream pattern is caught
 * rather than silently diverging.
 *
 * ReDoS-safety: the pattern is fully anchored (`^`...`$`), and every
 * quantifier applies to a character class that does not overlap the
 * character class of any other quantifier in the pattern (`[a-z0-9]*` inside
 * the optional group never re-matches characters `[a-z]` at the start
 * already consumed, and the outer `(...)*` group's alternatives don't
 * overlap each other either) — so there is no ambiguous split point for a
 * pathological input to backtrack across.
 *
 * @example
 * ```ts
 * AGENT_OPERATOR_SCRIPT_NAME_RE.test("json-etl"); // true
 * AGENT_OPERATOR_SCRIPT_NAME_RE.test("Json-Etl"); // false
 * ```
 */
export const AGENT_OPERATOR_SCRIPT_NAME_RE: RegExp =
  /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * The maximum length `agent-operator` accepts for a script name. This is
 * **our own** tightening, not part of the upstream CLI contract — the
 * copied {@link AGENT_OPERATOR_SCRIPT_NAME_RE} imposes no length cap at all.
 * A model-supplied value has no legitimate reason to approach this length
 * (the fleet's longest real script name is a fraction of it), so capping it
 * gives a cheap, length-only rejection for a large class of junk input
 * before the regex ever runs.
 *
 * @example
 * ```ts
 * AGENT_OPERATOR_SCRIPT_NAME_MAX_LENGTH; // 64
 * ```
 */
export const AGENT_OPERATOR_SCRIPT_NAME_MAX_LENGTH = 64;

/**
 * Narrows `value` to an allowed script name: a string, non-empty, at most
 * {@link AGENT_OPERATOR_SCRIPT_NAME_MAX_LENGTH} characters (checked
 * **before** the regex, so an over-length string is rejected on length
 * alone without ever running the pattern against it), and matching
 * {@link AGENT_OPERATOR_SCRIPT_NAME_RE}.
 *
 * @param value - An unknown, potentially model-supplied value.
 * @returns Whether `value` is a string that satisfies every allowlist rule.
 *
 * @example
 * ```ts
 * import { isAllowedScriptName } from "./cli-names.js";
 *
 * isAllowedScriptName("json-etl"); // true
 * isAllowedScriptName("../../etc/passwd"); // false
 * ```
 */
export function isAllowedScriptName(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  // The explicit length guard stays ahead of the pattern, and keeps its own
  // `length === 0` arm rather than leaning on the pattern's mandatory leading
  // `[a-z]`: if the copied regex is ever relaxed upstream — an optional first
  // character, an outer `*` — the empty string must still be rejected here.
  if (
    value.length === 0 ||
    value.length > AGENT_OPERATOR_SCRIPT_NAME_MAX_LENGTH
  ) {
    return false;
  }
  return AGENT_OPERATOR_SCRIPT_NAME_RE.test(value);
}

/**
 * Asserts that `value` is an allowed script name, returning the narrowed,
 * **branded** {@link AgentOperatorScriptName} on success. This is the only
 * function permitted to mint the brand — it is earned here, immediately
 * after `isAllowedScriptName` has confirmed every allowlist rule, and
 * nowhere else. On rejection, throws {@link M3LAgentOperatorCliError} coded
 * `ERR_AGENT_OPERATOR_SCRIPT_NAME` with a fixed message that never echoes
 * `value` — `value` may be model-supplied, and a rejected value is exactly
 * the kind of content (shell metacharacters, path traversal, control bytes)
 * that must never be threaded into a log or error message. No `cause` is
 * attached either: nothing underneath failed, the value simply did not
 * qualify.
 *
 * @param value - An unknown, potentially model-supplied value.
 * @returns The narrowed, allowed, branded script name.
 * @throws {@link M3LAgentOperatorCliError} when `value` fails any allowlist
 *   rule.
 *
 * @example
 * ```ts
 * import { assertAllowedScriptName } from "./cli-names.js";
 *
 * const name = assertAllowedScriptName("json-etl");
 * ```
 */
export function assertAllowedScriptName(
  value: unknown,
): AgentOperatorScriptName {
  if (!isAllowedScriptName(value)) {
    throw new M3LAgentOperatorCliError(
      "script name is not on the allowlist",
      "ERR_AGENT_OPERATOR_SCRIPT_NAME",
    );
  }
  return value as AgentOperatorScriptName;
}
