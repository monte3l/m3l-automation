/**
 * `internal/procedure/definition` — the private, validated definition shape
 * `M3LProcedureBuilder.build()` produces and `M3LProcedure`'s constructor
 * consumes.
 *
 * `docs/reference/core/procedure.md` states there is "deliberately no public
 * constructor and no public definition type" for `M3LProcedure` — `build()`
 * is meant to be the only path to an instance. This module is the mechanism:
 * `M3LProcedure`'s constructor takes this interface as its only parameter,
 * and this interface is never re-exported from a public barrel, so no caller
 * outside this package can name the parameter type (short of an explicit
 * `as` escape hatch, which no amount of API design can prevent).
 *
 * Widened by the engine-loop GREEN pass to carry the runtime step/case/
 * fallback tables `M3LProcedure.run()` needs, alongside the digest and
 * `describe()` projection the build-validation GREEN pass already produced.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import type {
  M3LProcedureCase,
  M3LProcedureFallback,
  M3LProcedureShape,
  M3LProcedureStep,
  M3LProcedureSummary,
} from "../../core/procedure/types.js";

/**
 * The validated, frozen shape `build()` hands to `new M3LProcedure(...)`.
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export interface M3LProcedureBuiltDefinition<TShape extends M3LProcedureShape> {
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
