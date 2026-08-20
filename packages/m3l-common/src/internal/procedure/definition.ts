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
 * Kept minimal for the scaffold — just what the stub constructor assigns
 * today. The GREEN pass that implements `build()` widens this with whatever
 * else the engine needs at run time (the compiled step/case/fallback
 * tables, the compiled `matches` patterns, the `describe()` projection).
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

/**
 * The validated, frozen shape `build()` hands to `new M3LProcedure(...)`.
 */
export interface M3LProcedureBuiltDefinition {
  /** `canonicalJsonHash` over the built definition's serialisable projection. */
  readonly digest: string;
}
