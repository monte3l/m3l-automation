/**
 * `commands/wizard-operations` — pure helpers that scope the interactive
 * wizard's per-parameter prompting by the chosen operation (ADR-0055, U8).
 *
 * @packageDocumentation
 */

import type {
  M3LCliOperationDescriptor,
  M3LCliParameterDescriptor,
} from "../discovery/load-config.js";

/**
 * Resolves a `requiredParameters` entry to its canonical (declared) name,
 * mirroring `core/config/deriveOperationValidators`'s own exact-name-first,
 * two-pass alias resolution: every descriptor's own `name` is checked for an
 * exact match before any descriptor's `aliases` are considered at all — an
 * exact canonical-name match always wins over another descriptor's alias,
 * regardless of declaration order.
 *
 * Unlike the library's own `resolveCanonicalName` (which throws on an
 * unresolvable entry, since there it guards a schema validator that must
 * exist), this CLI-facing form returns `undefined` — an unresolvable
 * `requiredParameters` entry here just means a declared operation names a
 * parameter that isn't (or is no longer) declared, which the wizard drops
 * silently rather than treating as fatal.
 *
 * A descriptor's `aliases` field is guarded with `Array.isArray` before
 * `.includes` is called on it — `aliases` ultimately traces back to an
 * unguarded duck-typed call in `discovery/load-config.ts`, so a malformed
 * script export could hand this a non-array value; a descriptor with a
 * malformed `aliases` field is treated as having no aliases, never thrown.
 *
 * @param descriptors - The full declared parameter list to resolve against.
 * @param name - The `requiredParameters` entry to resolve.
 * @returns The matching descriptor's canonical `name`, or `undefined` when no
 *   descriptor matches by name or alias.
 *
 * @example
 * ```ts
 * import { resolveCanonicalName } from "@m3l-automation/m3l-cli/commands/wizard-operations";
 *
 * resolveCanonicalName(
 *   [{ name: "key", aliases: ["k"], type: "STRING", required: false, defaultValue: undefined, description: "", secret: false }],
 *   "k",
 * ); // "key"
 * ```
 */
export function resolveCanonicalName(
  descriptors: readonly M3LCliParameterDescriptor[],
  name: string,
): string | undefined {
  const byName = descriptors.find((descriptor) => descriptor.name === name);
  if (byName !== undefined) {
    return byName.name;
  }

  const byAlias = descriptors.find(
    (descriptor) =>
      Array.isArray(descriptor.aliases) && descriptor.aliases.includes(name),
  );
  return byAlias?.name;
}

/**
 * Unions every declared operation's `requiredParameters`, each resolved to
 * its canonical form via {@link resolveCanonicalName}. An entry that names no
 * declared descriptor is dropped silently — never throws.
 *
 * @param operations - The declared operations to collect required parameter
 *   names from.
 * @param descriptors - The full declared parameter list to resolve against.
 * @returns The set of canonical parameter names required by at least one
 *   declared operation.
 *
 * @example
 * ```ts
 * import { collectScopedParameterNames } from "@m3l-automation/m3l-cli/commands/wizard-operations";
 *
 * const scoped = collectScopedParameterNames(
 *   [{ name: "get", description: "Fetch", requiredParameters: ["key"] }],
 *   [{ name: "key", aliases: [], type: "STRING", required: false, defaultValue: undefined, description: "", secret: false }],
 * );
 * // Set { "key" }
 * ```
 */
export function collectScopedParameterNames(
  operations: readonly M3LCliOperationDescriptor[],
  descriptors: readonly M3LCliParameterDescriptor[],
): ReadonlySet<string> {
  const scoped = new Set<string>();
  for (const operation of operations) {
    for (const entry of operation.requiredParameters) {
      const canonicalName = resolveCanonicalName(descriptors, entry);
      if (canonicalName !== undefined) {
        scoped.add(canonicalName);
      }
    }
  }
  return scoped;
}

/**
 * Whether `descriptor` is required by `chosenOperation` — delegates to
 * {@link collectScopedParameterNames} over the single-element operation list
 * `[chosenOperation]` rather than resolving each `requiredParameters` entry
 * independently against `descriptor` alone. "An exact canonical-name match
 * always wins over another descriptor's alias" is inherently a *global*
 * property of the full descriptor list (see {@link resolveCanonicalName}'s
 * collision case) — it cannot be decided correctly from one descriptor in
 * isolation, so this function shares the exact same resolution
 * `collectScopedParameterNames` uses instead of re-deriving it, keeping the
 * two from ever disagreeing on a name/alias collision.
 *
 * @param descriptor - The parameter descriptor to check.
 * @param chosenOperation - The operation the caller selected, or `undefined`
 *   when no operation has been chosen yet.
 * @param descriptors - The full declared parameter list to resolve
 *   `chosenOperation`'s `requiredParameters` entries against.
 * @returns Whether `chosenOperation` requires `descriptor`; always `false`
 *   when no operation is chosen.
 *
 * @example
 * ```ts
 * import { isRequiredForOperation } from "@m3l-automation/m3l-cli/commands/wizard-operations";
 *
 * const descriptors = [
 *   { name: "key", aliases: [], type: "STRING" as const, required: false, defaultValue: undefined, description: "", secret: false },
 * ];
 *
 * isRequiredForOperation(
 *   descriptors[0],
 *   { name: "get", description: "Fetch", requiredParameters: ["key"] },
 *   descriptors,
 * ); // true
 * ```
 */
export function isRequiredForOperation(
  descriptor: M3LCliParameterDescriptor,
  chosenOperation: M3LCliOperationDescriptor | undefined,
  descriptors: readonly M3LCliParameterDescriptor[],
): boolean {
  if (chosenOperation === undefined) {
    return false;
  }
  return collectScopedParameterNames([chosenOperation], descriptors).has(
    descriptor.name,
  );
}

/**
 * Decides whether `descriptor` should be prompted at all, given the chosen
 * operation (if any) and the union of every declared operation's resolved
 * `requiredParameters` (`scoped`).
 *
 * Precedence, checked in this order:
 *
 * 1. `descriptor.required === true` — an unconditionally-required descriptor
 *    is ALWAYS prompted, regardless of operation scoping. This is checked
 *    first, before any scoping logic, so a parameter the script itself
 *    declares required can never be silently skipped merely because it also
 *    happens to be named by some *other* (non-chosen) operation's
 *    `requiredParameters` — omitting it would let the wizard finish looking
 *    complete while dropping a value the script unconditionally needs.
 * 2. A parameter outside `scoped` (never named by any operation) is always
 *    prompted.
 * 3. Before any operation is chosen, every parameter is prompted (there is
 *    nothing yet to scope against).
 * 4. Once an operation is chosen, a `scoped` parameter is prompted only when
 *    it is required by that specific operation — a `scoped` parameter
 *    required by a *different* operation than the one chosen is skipped
 *    entirely.
 *
 * @param descriptor - The parameter descriptor to decide on.
 * @param chosenOperation - The operation the caller selected, or `undefined`
 *   when no operation has been chosen yet.
 * @param scoped - The union of every declared operation's resolved
 *   `requiredParameters` (see {@link collectScopedParameterNames}).
 * @param descriptors - The full declared parameter list, forwarded to
 *   {@link isRequiredForOperation} to resolve `chosenOperation`'s
 *   `requiredParameters` entries against.
 * @returns Whether `descriptor` should be prompted.
 *
 * @example
 * ```ts
 * import { shouldPromptParameter } from "@m3l-automation/m3l-cli/commands/wizard-operations";
 *
 * const descriptors = [
 *   { name: "bucket", aliases: [], type: "STRING" as const, required: false, defaultValue: undefined, description: "", secret: false },
 * ];
 *
 * shouldPromptParameter(
 *   descriptors[0],
 *   { name: "get", description: "Fetch", requiredParameters: ["key"] },
 *   new Set(["key", "bucket"]),
 *   descriptors,
 * ); // false — "bucket" is scoped to "put", not the chosen "get"
 * ```
 */
export function shouldPromptParameter(
  descriptor: M3LCliParameterDescriptor,
  chosenOperation: M3LCliOperationDescriptor | undefined,
  scoped: ReadonlySet<string>,
  descriptors: readonly M3LCliParameterDescriptor[],
): boolean {
  if (descriptor.required) {
    return true;
  }
  if (chosenOperation === undefined) {
    return true;
  }
  if (!scoped.has(descriptor.name)) {
    return true;
  }
  return isRequiredForOperation(descriptor, chosenOperation, descriptors);
}
