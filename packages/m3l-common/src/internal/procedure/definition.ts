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
 * Widened by the GREEN pass that implements `build()` to carry the
 * `describe()` projection alongside the digest. A later pass (the engine
 * loop) widens this further with whatever `run()` needs at run time (the
 * compiled step/case/fallback tables, the compiled `matches` patterns).
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import type { M3LProcedureSummary } from "../../core/procedure/types.js";

/**
 * The validated, frozen shape `build()` hands to `new M3LProcedure(...)`.
 */
export interface M3LProcedureBuiltDefinition {
  /** `canonicalJsonHash` over the built definition's serialisable projection. */
  readonly digest: string;
  /** The exact projection `digest` hashes; returned verbatim by `describe()`. */
  readonly summary: M3LProcedureSummary;
}
