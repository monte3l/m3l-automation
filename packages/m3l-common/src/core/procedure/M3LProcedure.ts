/**
 * `core/procedure/M3LProcedure` — the immutable, reusable engine produced by
 * {@link M3LProcedureBuilder.build}: a multi-step procedure whose control
 * flow and conclusions are data rather than hand-written branching.
 *
 * @packageDocumentation
 */

import { M3LProcedureInvalidDefinitionError } from "../../internal/procedure/errors.js";

import type { M3LProcedureBuiltDefinition } from "../../internal/procedure/definition.js";
import type {
  M3LProcedureOutcome,
  M3LProcedureRunOptions,
  M3LProcedureShape,
  M3LProcedureSummary,
} from "./types.js";

/**
 * A built, validated procedure: "gather evidence, then conclude". Every
 * guarantee this engine makes holds for every instance that exists, because
 * there is deliberately no public constructor and no public definition
 * type — {@link M3LProcedureBuilder.build} is the only way to obtain one.
 *
 * A procedure is inert and reusable: one instance may be `run` repeatedly
 * and concurrently. Everything run-scoped lives in the `run()` call frame;
 * only the digest and the compiled `matches` patterns are instance state,
 * both immutable after `build()`.
 *
 * @typeParam TShape - The procedure's declared shape.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * interface Triage extends Core.M3LProcedureShape {
 *   deps: { readonly logs: { query(q: string): Promise<number> } };
 *   values: { errorCount: number };
 *   parameters: Record<never, never>;
 *   conclusion: { readonly verdict: string };
 *   stepId: "count-errors";
 *   caseId: "quiet";
 * }
 *
 * declare const procedure: Core.M3LProcedure<Triage>;
 * declare const logs: Triage["deps"]["logs"];
 *
 * const outcome = await procedure.run({ deps: { logs } });
 *
 * if (outcome.status === "matched") {
 *   console.log(outcome.primary.prose, outcome.digest);
 * }
 * ```
 */
export class M3LProcedure<TShape extends M3LProcedureShape> {
  /** Computed once at build; copied onto every outcome. */
  readonly digest: string;

  /**
   * @internal Constructed only by {@link M3LProcedureBuilder.build}. The
   * parameter type lives in `internal/procedure` and is never exported
   * publicly, so no caller outside this package can supply one.
   */
  constructor(definition: M3LProcedureBuiltDefinition) {
    this.digest = definition.digest;
  }

  /**
   * Returns the exact serialisable projection `digest` hashes: the
   * procedure name and `revision`, every step's id/label/kind/etc., every
   * case's id/description/prose/priority/condition, the fallback's
   * description/prose, and the declared parameter names.
   *
   * @returns The definition summary.
   */
  describe(): M3LProcedureSummary {
    throw new M3LProcedureInvalidDefinitionError(
      "M3LProcedure.describe is not implemented yet",
    );
  }

  /**
   * Runs the three-phase contract — steps, cases, conclusion — over
   * `options` and resolves the outcome. `run()` resolves for all four
   * outcome arms (`matched`, `unrecognized`, `failed`, `aborted`); only a
   * contract violation (a malformed run option) throws.
   *
   * @param options - The dependency bag, optional signal, iteration ceiling,
   *   progress guard, tracing, logger, and initial values.
   * @returns The resolved outcome.
   * @throws `M3LError` with code `ERR_PROCEDURE_INVALID_OPTION` when an
   *   option fails eager validation (a bad `maxIterations`, a non-finite
   *   `parameters` value, or a non-function/throwing/non-primitive progress
   *   witness).
   */
  run(
    options: M3LProcedureRunOptions<TShape>,
  ): Promise<M3LProcedureOutcome<TShape>> {
    return Promise.reject(
      new M3LProcedureInvalidDefinitionError(
        "M3LProcedure.run is not implemented yet",
        { hasSignal: options.signal !== undefined },
      ),
    );
  }
}
