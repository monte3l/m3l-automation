/**
 * `core/storage/append-only-entry-types` — the entry vocabulary shared by
 * {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream}, its renderer
 * (`internal/storage/append-only-render.ts`) and its projection
 * (`internal/storage/append-only-projection.ts`): the value type an append-only
 * entry may carry, and the entry shape itself.
 *
 * This sits alongside `core/storage`'s three other public-type modules —
 * `append-only-read-types.ts`, `append-only-write-types.ts`,
 * `append-only-manifest-types.ts` — none of which are part of the class file
 * either. The entry vocabulary living inside `M3LAppendOnlyStream.ts` was the
 * one holdout: it describes what a caller *hands* the stream, not the class's
 * own behavior, so it belongs here with its siblings rather than in the class
 * file. The extraction happened to be taken while that file sat close to
 * `check:file-budget`'s ceiling, but the seam itself already existed in every
 * neighboring module — this just brings the entry types in line with it.
 *
 * @packageDocumentation
 */

/**
 * A value an append-only stream entry may carry. Closed on purpose: exactly
 * what JSON can carry back out unchanged, and nothing else.
 *
 * `undefined`, a `bigint`, a function, a symbol and a class instance (a
 * `Date`, a `Map`, an `Error`) are all excluded, because each would make the
 * persisted line disagree with the entry the caller handed over — silently
 * dropped, coerced to `null`, or serialized through whatever `toJSON` it
 * carries. Pass a `Date` as `date.toISOString()` and any richer collection as
 * the plain array or object you want recorded.
 *
 * @example
 * ```ts
 * import type { M3LAppendOnlyValue } from "@monte3l/m3l-common/core";
 *
 * const actor: M3LAppendOnlyValue = { id: "u-1", roles: ["reader"] };
 * ```
 */
export type M3LAppendOnlyValue =
  | string
  | number
  | boolean
  | null
  | readonly M3LAppendOnlyValue[]
  | { readonly [key: string]: M3LAppendOnlyValue };

/**
 * One entry: a JSON object of {@link M3LAppendOnlyValue}s, persisted as
 * exactly one line.
 *
 * The stream never serializes the caller's object — it rebuilds a detached,
 * null-prototype copy first — so an entry may be handed over and then
 * mutated without changing what was written.
 *
 * This is the **shape** an entry has — the type to annotate a value with. It
 * is not the constraint
 * {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.append} imposes: an
 * `interface` carries no index signature, so a record declared as one (the
 * normal way a consumer models an audit record) does not satisfy this alias
 * and would need a cast that throws away the closure the alias provides.
 * `append` constrains its own type parameter instead, admitting any object
 * type whose properties are all {@link M3LAppendOnlyValue}s. Everything
 * assignable to this alias satisfies that constraint.
 *
 * @example
 * ```ts
 * import type { M3LAppendOnlyEntry } from "@monte3l/m3l-common/core";
 *
 * const entry: M3LAppendOnlyEntry = {
 *   at: new Date().toISOString(),
 *   event: "approval.granted",
 *   actor: { id: "u-1" },
 * };
 * ```
 */
export type M3LAppendOnlyEntry = { readonly [key: string]: M3LAppendOnlyValue };
