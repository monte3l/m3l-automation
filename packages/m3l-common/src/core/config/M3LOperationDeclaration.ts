/**
 * `core/config/M3LOperationDeclaration` — a script's operation set declared
 * as data (ADR-0055), so it can be enumerated without importing the script's
 * business logic.
 *
 * @packageDocumentation
 */

/**
 * One operation a script can perform, declared as data rather than a
 * closure — a fleet-facing discovery cache (ADR-0042) can read this shape
 * off disk without ever evaluating the script it describes.
 *
 * The shape is deliberately plain JSON (`string` / `string` / `string[]?`):
 * no class, no closure, no `Symbol`. A value of this type — and of
 * {@link M3LOperationDeclarationList} — must round-trip
 * `JSON.parse(JSON.stringify(x))` byte-identically.
 *
 * @example
 * ```ts
 * import type { M3LOperationDeclaration } from "@m3l-automation/m3l-common/core";
 *
 * const getItem: M3LOperationDeclaration = {
 *   name: "get",
 *   description: "Fetch one item by key.",
 *   requiredParameters: ["key"],
 * };
 * ```
 */
export interface M3LOperationDeclaration {
  /** The operation's canonical name — the value a selector parameter resolves to. */
  readonly name: string;
  /** A human-readable description, rendered by {@link M3LConfigHelpFormatter}. */
  readonly description: string;
  /**
   * Names of other declared parameters this operation requires to be set.
   * Consumed opt-in by {@link deriveOperationValidators} — declaring this
   * does not, by itself, enforce anything.
   */
  readonly requiredParameters?: readonly string[];
}

/**
 * A non-empty, ordered list of {@link M3LOperationDeclaration}s sharing one
 * literal name union `TName`. Modeled as a non-empty tuple so that
 * `operations: []` is a compile error — an empty operation set can never
 * satisfy `M3LConfigValidators.oneOf`, so allowing it at the type level
 * would only defer a guaranteed-to-fail declaration to runtime.
 *
 * @typeParam TName - The literal union of operation names in this list,
 *   inferred from the array literal passed at the declaration site (pair
 *   with `const TName` at a call site that wants to preserve the literal
 *   union, as {@link deriveOperationNames} does).
 *
 * @example
 * Declare with `as const satisfies M3LOperationDeclarationList`, not a
 * plain `: M3LOperationDeclarationList` annotation — the annotation form
 * widens every `name` to `string` before {@link deriveOperationNames} ever
 * sees the list, defeating its `const TName` literal-union inference.
 * ```ts
 * import type { M3LOperationDeclarationList } from "@m3l-automation/m3l-common/core";
 *
 * const operations = [
 *   { name: "get", description: "Fetch one item by key." },
 *   { name: "put", description: "Write one item." },
 * ] as const satisfies M3LOperationDeclarationList;
 * ```
 */
export type M3LOperationDeclarationList<TName extends string = string> =
  readonly [
    M3LOperationDeclaration & { readonly name: TName },
    ...(readonly (M3LOperationDeclaration & { readonly name: TName })[]),
  ];

/**
 * Projects an {@link M3LOperationDeclarationList} to its name tuple, in
 * declaration order with no deduplication — a pure projection, and the
 * bridge from a declared operation list to
 * {@link M3LConfigValidators.oneOf}'s allowed-set argument.
 *
 * `const TName` preserves the literal union inferred from `operations`
 * rather than widening it to `string`, so a downstream exhaustive
 * `Record<Op, …>` dispatch table built from the result keeps failing to
 * compile the moment a new operation is added and left unhandled.
 *
 * @typeParam TName - The literal union of operation names, inferred as a
 *   `const` type parameter from `operations`.
 * @param operations - The declaration list to project.
 * @returns A non-empty, ordered, non-deduplicated tuple of every declared
 *   operation's `name`.
 *
 * @example
 * ```ts
 * import { deriveOperationNames } from "@m3l-automation/m3l-common/core";
 *
 * const names = deriveOperationNames([
 *   { name: "get", description: "Fetch one item by key." },
 *   { name: "put", description: "Write one item." },
 * ]);
 * // names: readonly ["get" | "put", ...("get" | "put")[]] === ["get", "put"]
 * ```
 */
export function deriveOperationNames<const TName extends string>(
  operations: M3LOperationDeclarationList<TName>,
): readonly [TName, ...(readonly TName[])] {
  const [first, ...rest] = operations;
  return [first.name, ...rest.map((operation) => operation.name)];
}
