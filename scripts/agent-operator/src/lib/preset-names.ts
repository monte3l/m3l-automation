/**
 * `lib/preset-names` — the preset-name check that guards the `run` seam's
 * `--preset=` token. A model-supplied preset name is the second free-form
 * value (after the script name handled by `lib/cli-names`) that can influence
 * `runCliProcess`'s argv array; this module is what keeps that value honest
 * before the operator-declared allowlist decides whether it is permitted at
 * all. The name itself never becomes a token — `cli-surface.ts` resolves it
 * into the {@link AgentOperatorPresetPath} that argv actually carries.
 *
 * @packageDocumentation
 */

import { M3LAgentOperatorCliError } from "./errors.js";

/**
 * A preset name that has already passed {@link assertAllowedPresetName} —
 * minted there and nowhere else. What the brand buys is the *entry* to the
 * resolution chain rather than the emitted token itself: `cli-surface.ts`'s
 * `resolveAllowedPresetPath` takes an `AgentOperatorPresetName`, so a
 * model-proposed `string` cannot be handed to the resolver without passing
 * the name check first. The value that ultimately reaches `runCliProcess`'s
 * argv is the resolved path, which carries its own, distinct
 * {@link AgentOperatorPresetPath} brand.
 *
 * It is a **separate** nominal type from `AgentOperatorScriptName` and from
 * {@link AgentOperatorPresetPath}: each declaration's `unique symbol` is its
 * own type, so none of the three is assignable to either of the other two
 * even though all three erase to `string`. The `run` operation carries a
 * script name and a preset path in adjacent fields, so swapping the two — or
 * passing a name where a path is expected — must fail at compile time rather
 * than emit a nonsense argv.
 *
 * The brand is a **compile-time-only** device: it is erased by `tsc` and
 * carries no runtime representation or check of its own. The actual
 * guarantee — that a value tagged with this brand really did pass the name
 * check — is enforced entirely by {@link assertAllowedPresetName}, the only
 * function permitted to produce one.
 *
 * @example
 * ```ts
 * import { assertAllowedPresetName } from "./preset-names.js";
 *
 * // The resolver's parameter is branded, so the name check is the only way
 * // in: there is no expression that reaches it from a raw `string`.
 * const presetName = assertAllowedPresetName(candidate);
 * ```
 */
export type AgentOperatorPresetName = string & {
  readonly __brand: unique symbol;
};

/**
 * An **absolute** preset file path that has already been resolved from a
 * validated {@link AgentOperatorPresetName}, confirmed to be a member of the
 * operator-declared `presetAllowlist`, and re-asserted to live inside the
 * presets directory. `cli-surface.ts`'s `resolveAllowedPresetPath` is the only
 * function permitted to mint it. The mint site is named rather than linked on
 * purpose: this module must not import `cli-surface.ts` (the dependency runs
 * the other way, and importing back would be a cycle).
 *
 * Why the path is branded and not just the name: the path is the value that
 * actually reaches argv. `buildArgv` interpolates only the resolved preset
 * path into the attached `--preset=<path>` token and never the name, so
 * branding the name alone left the argv-bound value a bare `string` — a review
 * found {@link AgentOperatorPresetName} was consumed as a `presetAllowlist`
 * key and then discarded, which made this file's claim that an unvalidated
 * `string` "is a compile error" false at the one position where it mattered.
 * With the `run` operation's `presetPath` field typed to this brand, skipping
 * the resolver — a hand-built `path.join`, or a model-proposed path threaded
 * straight through — is a compile error at the argv boundary.
 *
 * {@link assertAllowedPresetName} deliberately does **not** produce this
 * brand: a name check knows neither a workspace root nor an allowlist, so it
 * cannot have earned a path.
 *
 * Like the name brand it is a **compile-time-only** device: it is erased by
 * `tsc` and carries no runtime representation or check of its own. Holding one
 * proves nothing by itself — it records that the value came from
 * `resolveAllowedPresetPath`, and the guarantee lives in that function.
 *
 * @example
 * ```ts
 * import type { AgentOperatorPresetPath } from "./preset-names.js";
 *
 * function buildPresetToken(presetPath: AgentOperatorPresetPath): string {
 *   return `--preset=${presetPath}`;
 * }
 * ```
 */
export type AgentOperatorPresetPath = string & {
  readonly __brand: unique symbol;
};

/**
 * Preset-name pattern, copied **verbatim** from `PRESET_NAME_PATTERN` in
 * `packages/m3l-cli/src/presets/store.ts` (the CLI's own preset-store
 * validator). It cannot be imported here: ADR-0029 restricts a `scripts/*`
 * package to a single dependency, `@m3l-automation/m3l-common`. A drift-guard
 * test reads `store.ts` as text and asserts this literal still matches, so any
 * future change to the upstream pattern is caught rather than silently
 * diverging.
 *
 * Scope, and why it looks so permissive: this is a **character-class** check
 * only. Unlike `AGENT_OPERATOR_SCRIPT_NAME_RE` it imposes no structure — no
 * leading-letter requirement, no ban on a bare `-`, a doubled `--`, or an
 * all-digit name — so it genuinely accepts `--json`, `-h`, `--` and `123`.
 * That is not a gap being tolerated: a preset name never becomes its own argv
 * element. It is interpolated into the attached `--preset=<path>` form, and it
 * must additionally be a member of the operator-declared `presetAllowlist`
 * before any token is emitted. Membership plus the attached form are the
 * safety property; this pattern only rejects characters upstream would refuse.
 *
 * ReDoS-safety: the pattern is fully anchored (`^`...`$`) and contains a
 * single quantifier over a single character class, so there is no ambiguous
 * split point for a pathological input to backtrack across.
 *
 * @example
 * ```ts
 * AGENT_OPERATOR_PRESET_NAME_RE.test("eu-west-1"); // true
 * AGENT_OPERATOR_PRESET_NAME_RE.test("Prod"); // false
 * ```
 */
export const AGENT_OPERATOR_PRESET_NAME_RE: RegExp = /^[a-z0-9-]+$/;

/**
 * The maximum length `agent-operator` accepts for a preset name. This is
 * **our own** tightening, not part of the upstream CLI contract — the copied
 * {@link AGENT_OPERATOR_PRESET_NAME_RE} imposes no length cap at all. A
 * model-supplied value has no legitimate reason to approach this length (a
 * real preset name is a fraction of it), so capping it gives a cheap,
 * length-only rejection for a large class of junk input before the regex ever
 * runs.
 *
 * @example
 * ```ts
 * AGENT_OPERATOR_PRESET_NAME_MAX_LENGTH; // 64
 * ```
 */
export const AGENT_OPERATOR_PRESET_NAME_MAX_LENGTH = 64;

/**
 * The workspace-relative directory every allowlisted preset file must sit
 * inside — the same location the CLI's own preset store reads
 * (`packages/m3l-cli/src/presets/store.ts`'s `presetsDirectory`). This is the
 * **single** local copy of that upstream value. It is copied rather than
 * imported because ADR-0029 restricts a `scripts/*` package to one
 * dependency, `@m3l-automation/m3l-common`, and `presetsDirectory` is
 * module-private upstream anyway.
 *
 * Drift between this copy and upstream is guarded by a dedicated test in
 * `tests/steps/resolve-runtime.test.ts` that reads `store.ts` as TEXT and
 * extracts the segment list `presetsDirectory` joins onto the workspace root,
 * then feeds the DERIVED directory back through `parsePresetAllowlist`. The
 * copy is module-private, so that test cannot compare the two strings
 * directly and asserts their agreement behaviourally instead: a path under
 * the derived directory must be accepted, and its parent — plus a sibling
 * that merely shares its prefix as text — must be rejected. If either side
 * moves alone, that pair fails.
 *
 * What that does NOT cover: whether the directory exists on disk, whether
 * upstream still composes it in the `join(workspaceRoot, …)` shape the
 * extraction matches (a change there trips the test's own extraction
 * self-check rather than a containment assertion), and anything about the
 * presets directory beyond the segments that one upstream helper joins. The
 * ordinary containment fixtures spell this same literal, so they are not
 * themselves a drift guard.
 *
 * Spelled with `/` instead of `path.join` deliberately: it is compared
 * against a config-declared string, and the declared string is the reviewable
 * artifact — normalising either side would make the reviewed text and the
 * checked text two different things.
 */
const PRESETS_DIRECTORY = "data/config/presets";

/**
 * {@link PRESETS_DIRECTORY} carrying its trailing separator — the form both of
 * this script's preset-path containment checks compare against
 * (`steps/resolve-runtime.ts`'s config parser and `lib/cli-surface.ts`'s
 * use-site re-check at argv-build time). The separator is load-bearing:
 * without it, a bare `startsWith("data/config/presets")` also accepts
 * `data/config/presetsevil/report.yaml`, a different directory that merely
 * shares the prefix as text.
 *
 * DERIVED from the single local copy rather than spelled as a second literal,
 * and shared by both checks rather than declared per call site, because the
 * two must accept and reject exactly the same set of declared paths. When
 * they disagree, a correctly declared allowlist entry parses cleanly at config
 * time and is then refused at argv-build time (or the reverse) — which reads
 * to an operator as an inert grant rather than as a bug, and only one of the
 * two copies was ever pinned to upstream by the drift guard.
 *
 * Sharing the boundary does not merge the checks: the second remains a
 * deliberate *use-site* re-check rather than a second read of the same guard,
 * because `presetAllowlist` reaches `cli-surface.ts` as a plain `ReadonlyMap`
 * that any caller can construct directly, bypassing the config parser.
 *
 * @example
 * ```ts
 * import { AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX } from "./preset-names.js";
 *
 * "data/config/presets/report.yaml".startsWith(
 *   AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX,
 * ); // true
 * "data/config/presetsevil/report.yaml".startsWith(
 *   AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX,
 * ); // false
 * ```
 */
export const AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX: string = `${PRESETS_DIRECTORY}/`;

/**
 * Splits a path on either separator, so a `..` segment written win32-style
 * (`data\config\presets\..\etc`) is seen on a POSIX host too, where
 * `path.join` would treat the backslashes as ordinary filename characters.
 *
 * Shared by every `..` rejection in this script — `steps/resolve-runtime.ts`'s
 * config parser, `lib/cli-surface.ts`'s use-site re-check of a declared entry,
 * and `lib/cli-surface.ts`'s check of the `workspaceRoot` the entry is
 * anchored onto — for the same reason
 * {@link AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX} is shared: two copies of a
 * boundary drift, and only one of them tends to get the next fix.
 *
 * @example
 * ```ts
 * import { AGENT_OPERATOR_PATH_SEPARATOR_RE } from "./preset-names.js";
 *
 * "data/config/presets/../etc".split(AGENT_OPERATOR_PATH_SEPARATOR_RE); // [..., "..", "etc"]
 * ```
 */
export const AGENT_OPERATOR_PATH_SEPARATOR_RE: RegExp = /[/\\]/;

/**
 * Any Unicode control or format character (`\p{C}`) — the class that must
 * never reach a `--preset=` argv token, a `Map` key, a log line, or a
 * terminal. An embedded line feed, NUL, ANSI CSI introducer, DEL, C1 control
 * or bidi override all live here.
 */
const PRESET_PATH_CONTROL_OR_FORMAT_RE = /\p{C}/u;

/**
 * Any whitespace character. Checked in ADDITION to the padding rule below,
 * which `String.prototype.trim` can only see at the ends: a declared path
 * with a space in the MIDDLE survives trimming untouched and would become a
 * `--preset=` token no operator reading the config diff would recognise as
 * one argument.
 */
const PRESET_PATH_WHITESPACE_RE = /\s/u;

/**
 * Whether a declared preset path is non-blank and carries no leading or
 * trailing whitespace. Padding is *rejected*, never trimmed: a trimmed value
 * and an untrimmed declaration drift apart silently, and `path.join` would
 * happily absolutise `" data/…"` into a whitespace-prefixed directory nobody
 * declared.
 *
 * One of the two rules `steps/resolve-runtime.ts`'s config parser reports on
 * its own message, and one of the conjuncts of
 * {@link isWellFormedPresetPathShape}.
 *
 * @param presetPath - A declared, workspace-relative preset path.
 * @returns Whether the path is non-blank and unpadded.
 *
 * @example
 * ```ts
 * import { isUnpaddedNonBlankPresetPath } from "./preset-names.js";
 *
 * isUnpaddedNonBlankPresetPath("data/config/presets/report.yaml"); // true
 * isUnpaddedNonBlankPresetPath("data/config/presets/report.yaml "); // false
 * ```
 */
export function isUnpaddedNonBlankPresetPath(presetPath: string): boolean {
  const trimmed = presetPath.trim();
  return trimmed !== "" && presetPath === trimmed;
}

/**
 * Whether a declared preset path embeds a Unicode control or format
 * character. The other rule the config parser reports on its own message, and
 * the second conjunct of {@link isWellFormedPresetPathShape}.
 *
 * @param presetPath - A declared, workspace-relative preset path.
 * @returns Whether the path contains a `\p{C}` character.
 *
 * @example
 * ```ts
 * import { hasPresetPathControlOrFormatCharacter } from "./preset-names.js";
 *
 * hasPresetPathControlOrFormatCharacter("data/config/presets/report.yaml"); // false
 * hasPresetPathControlOrFormatCharacter(
 *   `data/config/presets/${String.fromCodePoint(0)}.yaml`,
 * ); // true
 * ```
 */
export function hasPresetPathControlOrFormatCharacter(
  presetPath: string,
): boolean {
  return PRESET_PATH_CONTROL_OR_FORMAT_RE.test(presetPath);
}

/**
 * Whether a declared preset path has an acceptable SHAPE: non-blank,
 * unpadded, free of any Unicode control or format character, and free of
 * whitespace anywhere in it. Says nothing about containment — that is
 * {@link AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX}'s job — and nothing about
 * whether an operator declared the entry at all.
 *
 * This is the shape boundary `steps/resolve-runtime.ts`'s config parser and
 * `lib/cli-surface.ts`'s use-site re-check both apply, so the two accept and
 * reject exactly the same set of declared paths. Sharing the constant was not
 * enough: a review found the parser rejecting padded, NUL-bearing and
 * newline-bearing paths while the use site — which `presetAllowlist` reaches
 * as a plain `ReadonlyMap` any caller can build directly — still joined them
 * onto the workspace root and emitted a token. The use site must never be the
 * looser of the two, and it is written as a call to this predicate rather
 * than as its own copy of the rules so it structurally cannot become so.
 *
 * The parser reports {@link isUnpaddedNonBlankPresetPath} and
 * {@link hasPresetPathControlOrFormatCharacter} on their own messages (an
 * operator needs to know which rule they broke) and then checks this
 * conjunction as a catch-all, which is what keeps a rule added here from
 * being enforced at only one of the two sites.
 *
 * The first conjunct's padding half is redundant here: any leading or
 * trailing whitespace `PRESET_PATH_WHITESPACE_RE` matches is whitespace
 * `String.prototype.trim` also strips, so the third conjunct alone already
 * rejects every padded path this predicate sees, BOM and NBSP padding
 * included. What the first conjunct uniquely contributes to this
 * conjunction is rejecting the empty path, which carries no whitespace and
 * no `\p{C}` character and so would otherwise satisfy the other two on its
 * own. Its padding half is not dead weight, though —
 * `steps/resolve-runtime.ts`'s config parser still calls
 * {@link isUnpaddedNonBlankPresetPath} directly to report padding on its own
 * operator-facing message, independent of this conjunction.
 *
 * @param presetPath - A declared, workspace-relative preset path.
 * @returns Whether the path's shape is acceptable at every site that uses one.
 *
 * @example
 * ```ts
 * import { isWellFormedPresetPathShape } from "./preset-names.js";
 *
 * isWellFormedPresetPathShape("data/config/presets/report.yaml"); // true
 * isWellFormedPresetPathShape("data/config/presets/night ly.yaml"); // false
 * ```
 */
export function isWellFormedPresetPathShape(presetPath: string): boolean {
  return (
    isUnpaddedNonBlankPresetPath(presetPath) &&
    !hasPresetPathControlOrFormatCharacter(presetPath) &&
    !PRESET_PATH_WHITESPACE_RE.test(presetPath)
  );
}

/**
 * Narrows `value` to an allowed preset name: a string, non-empty, at most
 * {@link AGENT_OPERATOR_PRESET_NAME_MAX_LENGTH} characters (checked
 * **before** the regex, so an over-length string is rejected on length alone
 * without ever running the pattern against it), and matching
 * {@link AGENT_OPERATOR_PRESET_NAME_RE}.
 *
 * This is a name-shape check, not an authorization check — a `true` here says
 * only that the characters are ones the upstream preset store would accept.
 * Whether the operator permits that preset is decided separately, by
 * membership in the configured `presetAllowlist`.
 *
 * @param value - An unknown, potentially model-supplied value.
 * @returns Whether `value` is a string that satisfies every name rule.
 *
 * @example
 * ```ts
 * import { isAllowedPresetName } from "./preset-names.js";
 *
 * isAllowedPresetName("eu-west-1"); // true
 * isAllowedPresetName("../../etc/passwd"); // false
 * ```
 */
export function isAllowedPresetName(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  // The explicit length guard stays ahead of the pattern, and keeps its own
  // `length === 0` arm rather than leaning on the pattern's `+`: if the copied
  // regex is ever relaxed upstream to `*`, the empty string must still be
  // rejected here.
  if (
    value.length === 0 ||
    value.length > AGENT_OPERATOR_PRESET_NAME_MAX_LENGTH
  ) {
    return false;
  }
  return AGENT_OPERATOR_PRESET_NAME_RE.test(value);
}

/**
 * Asserts that `value` is an allowed preset name, returning the narrowed,
 * **branded** {@link AgentOperatorPresetName} on success. This is the only
 * function permitted to mint the NAME brand — it is earned here, immediately
 * after `isAllowedPresetName` has confirmed every name rule, and nowhere else.
 * It cannot mint an {@link AgentOperatorPresetPath}: no allowlist or workspace
 * root is in scope here, so no path has been earned. On rejection, throws
 * {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_PRESET` with a
 * fixed message that never echoes `value`
 * — `value` may be model-supplied, and a rejected value is exactly the kind of
 * content (shell metacharacters, path traversal, control bytes) that must
 * never be threaded into a log or error message. No `cause` is attached
 * either: nothing underneath failed, the value simply did not qualify.
 *
 * @param value - An unknown, potentially model-supplied value.
 * @returns The narrowed, allowed, branded preset name.
 * @throws {@link M3LAgentOperatorCliError} when `value` fails any name rule.
 *
 * @example
 * ```ts
 * import { assertAllowedPresetName } from "./preset-names.js";
 *
 * const preset = assertAllowedPresetName("eu-west-1");
 * ```
 */
export function assertAllowedPresetName(
  value: unknown,
): AgentOperatorPresetName {
  if (!isAllowedPresetName(value)) {
    // The message names the SHAPE rule, which is the only rule this function
    // enforces. Wording it as an allowlist (or permission) outcome would send
    // an operator to audit `presetAllowlist` over what is really a bad
    // character; the allowlist-miss rejection is `cli-surface.ts`'s to report,
    // on its own arm.
    throw new M3LAgentOperatorCliError(
      "preset name is malformed",
      "ERR_AGENT_OPERATOR_PRESET",
    );
  }
  return value as AgentOperatorPresetName;
}
