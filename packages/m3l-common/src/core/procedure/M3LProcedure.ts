/**
 * `core/procedure/M3LProcedure` — the immutable, reusable engine produced by
 * {@link M3LProcedureBuilder.build}: a multi-step procedure whose control
 * flow and conclusions are data rather than hand-written branching.
 *
 * Slice 2a ships the constructor, `digest`, and `describe()` only — `run()`
 * lands in a later slice.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

import type { M3LProcedureBuiltDefinition } from "../../internal/procedure/definition.js";
import type { M3LProcedureSummary } from "./build-types.js";
import type { M3LProcedureShape } from "./types.js";

/**
 * Module-scoped witness value gating {@link M3LProcedure}'s construction.
 * Exported from this file (never re-exported through the public
 * `core/procedure` barrel) purely so its one legitimate caller,
 * `M3LProcedureBuilder.build()` — a sibling module within `core/procedure`
 * — can invoke the guarded static factory below. A consumer of
 * `@m3l-automation/m3l-common/core` has no route to this symbol: it is not
 * part of the barrel's exports, and the package's `exports` map admits no
 * subpath that would let a deep import reach this module directly.
 *
 * @remarks
 * This is a witness **value** check, not a computed member key, because
 * `tsc --isolatedDeclarations` (this package's build mode) rejects a
 * computed class-member name outright (`TS9038`) even for a
 * `unique symbol`-typed constant — only well-known symbols
 * (`Symbol.iterator`, …) get that special-cased support. Gating on the
 * argument's value rather
 * than the member's name achieves the same "unforgeable by an external
 * caller" property: a `witness` cannot be produced by an `as`/`as unknown`
 * cast the way a TYPE can, only by importing this exact binding.
 */
export const kCreateProcedure: unique symbol = Symbol(
  "M3LProcedure.kCreateProcedure",
);

/**
 * The engine `M3LProcedureBuilder.build()` returns: an immutable, reusable
 * value identified by its `digest` and describable via `describe()`.
 *
 * There is deliberately no public constructor and no public definition type
 * — `build()` is the only way to obtain an instance. The constructor is
 * `private`, so `ConstructorParameters<typeof M3LProcedure>` no longer
 * resolves to the internal built-definition shape (it fails to resolve at
 * all — `typeof M3LProcedure` no longer satisfies a public construct
 * signature); the sole construction path is
 * {@link M3LProcedure.createFromBuiltDefinition}, gated behind
 * {@link kCreateProcedure}, a witness value never re-exported through the
 * public barrel. This mirrors `internal/procedure/definition.ts`'s
 * `kBuilt` pattern one level up: that witness makes a
 * {@link M3LProcedureBuiltDefinition} unforgeable by an external caller;
 * this one makes the `M3LProcedure` instance itself unconstructable by any
 * route except `M3LProcedureBuilder.build()`.
 *
 * @typeParam TShape - The procedure's declared shape.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * interface Triage extends Core.M3LProcedureShape {
 *   deps: Record<string, never>;
 *   values: Record<string, never>;
 *   parameters: Record<string, never>;
 *   conclusion: void;
 *   stepId: "gather";
 *   caseId: "quiet";
 * }
 *
 * declare const procedure: Core.M3LProcedure<Triage>;
 * console.log(procedure.digest);
 * console.log(procedure.describe().name);
 * ```
 */
export class M3LProcedure<TShape extends M3LProcedureShape> {
  /** `canonicalJsonHash` over the built definition's serialisable projection. */
  readonly digest: string;

  readonly #summary: M3LProcedureSummary;

  /**
   * @internal Constructed only via
   * {@link M3LProcedure.createFromBuiltDefinition}, itself called only by
   * `M3LProcedureBuilder.build()`.
   */
  private constructor(definition: M3LProcedureBuiltDefinition<TShape>) {
    this.digest = definition.digest;
    this.#summary = definition.summary;
  }

  /**
   * @internal The sole construction path. `witness` must be the exact
   * {@link kCreateProcedure} value — never re-exported through the public
   * `core/procedure` barrel — or this throws; only
   * `M3LProcedureBuilder.build()` holds that value.
   */
  static createFromBuiltDefinition<TProcedureShape extends M3LProcedureShape>(
    witness: typeof kCreateProcedure,
    definition: M3LProcedureBuiltDefinition<TProcedureShape>,
  ): M3LProcedure<TProcedureShape> {
    if (witness !== kCreateProcedure) {
      throw new M3LError(
        "M3LProcedure.createFromBuiltDefinition(): invalid construction witness",
        { code: "ERR_INVALID_ARGUMENT" },
      );
    }
    return new M3LProcedure(definition);
  }

  /**
   * Returns the exact serialisable projection `digest` hashes: the
   * procedure name and `revision`, every step's id/label/kind/etc., every
   * case's id/description/prose/priority/condition, the fallback's
   * description/prose, and the declared parameter names. Frozen (deeply):
   * mutating any nested field throws in strict mode / is a silent no-op
   * otherwise, rather than corrupting every subsequent `describe()` call.
   *
   * @returns The definition summary.
   */
  describe(): M3LProcedureSummary {
    return this.#summary;
  }
}
