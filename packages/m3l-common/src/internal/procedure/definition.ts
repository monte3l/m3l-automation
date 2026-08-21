/**
 * `internal/procedure/definition` — the private, validated definition shape
 * `M3LProcedureBuilder.build()` produces and `M3LProcedure`'s constructor
 * consumes.
 *
 * `docs/reference/core/procedure.md` states there is "deliberately no public
 * constructor and no public definition type" for `M3LProcedure` — `build()`
 * is meant to be the only path to an instance. This module is the mechanism:
 * `M3LProcedure`'s constructor takes this interface as its only parameter,
 * and every field of that interface is gated behind {@link kBuilt}, a
 * module-private `unique symbol` that is never exported. A caller outside
 * this module cannot name the key, so it cannot spell an object literal that
 * satisfies the interface — construction is unforgeable, not merely
 * unexported, and no `as` escape hatch changes that: casting a value to this
 * type does not summon a value _for_ the `[kBuilt]` property, since nothing
 * outside this module can produce one to assign. {@link createBuiltDefinition}
 * is the sole producer of that value — `M3LProcedureBuilder.build()` calls it
 * once it has confirmed zero validation problems, and no other module can
 * write the witness itself.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import type {
  M3LProcedureCase,
  M3LProcedureFallback,
  M3LProcedureSummary,
} from "../../core/procedure/build-types.js";
import type { M3LProcedureShape } from "../../core/procedure/types.js";
import type { M3LProcedureStep } from "../../core/procedure/step-types.js";

/**
 * Module-private witness key. Never exported: only code inside this module
 * can write a property keyed by this symbol, so {@link createBuiltDefinition}
 * — the sole producer of a value satisfying {@link
 * M3LProcedureBuiltDefinition} — is the only place one can be constructed.
 */
const kBuilt: unique symbol = Symbol("M3LProcedureBuiltDefinition.kBuilt");

/**
 * The validated, frozen shape `build()` hands to `new M3LProcedure(...)`.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export interface M3LProcedureBuiltDefinition<TShape extends M3LProcedureShape> {
  /** Module-private witness: no external caller can name or produce this key. */
  readonly [kBuilt]: true;
  /** `canonicalJsonHash` over the built definition's serialisable projection. */
  readonly digest: string;
  /** The exact projection `digest` hashes; returned verbatim by `describe()`. */
  readonly summary: M3LProcedureSummary;
  /**
   * The declared steps, in execution (declaration) order, with their real
   * `execute`/`describeTrace` closures intact — the table `M3LProcedure.run()`
   * walks. `TJump` is widened to the whole `TShape["stepId"]` union here: the
   * per-step `TJump` narrowing only matters at the authoring call site, not to
   * the engine, which trusts a validated definition's `jumpsTo` instead.
   */
  readonly steps: readonly M3LProcedureStep<
    TShape,
    TShape["stepId"],
    TShape["stepId"]
  >[];
  /**
   * The declared cases, in declaration order (not yet priority-sorted —
   * `M3LProcedure`'s constructor sorts once, since priorities are validated
   * unique and never change after `build()`).
   */
  readonly cases: readonly M3LProcedureCase<TShape, TShape["caseId"]>[];
  /** The mandatory "no case matched" conclusion, with its real `action`. */
  readonly fallback: M3LProcedureFallback<TShape>;
}

/**
 * The sole producer of a value satisfying {@link
 * M3LProcedureBuiltDefinition}. Stamps the module-private {@link kBuilt}
 * witness onto the caller-supplied fields — since {@link kBuilt} is never
 * exported, no module other than this one can spell the property this
 * function attaches, so no caller of `M3LProcedureBuilder.build()` (nor
 * `build()`'s own object-literal syntax, were it to try) can construct a
 * {@link M3LProcedureBuiltDefinition} by any route except calling this
 * function.
 *
 * @typeParam TShape - The procedure's declared shape.
 * @param fields - Every field of {@link M3LProcedureBuiltDefinition} except
 *   the witness itself: the digest, the summary, and the validated runtime
 *   steps/cases/fallback tables.
 * @returns The witnessed, built definition — ready for `new M3LProcedure(...)`.
 */
export function createBuiltDefinition<TShape extends M3LProcedureShape>(
  fields: Omit<M3LProcedureBuiltDefinition<TShape>, typeof kBuilt>,
): M3LProcedureBuiltDefinition<TShape> {
  return { ...fields, [kBuilt]: true };
}
