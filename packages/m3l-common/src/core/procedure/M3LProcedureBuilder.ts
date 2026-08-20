/**
 * `core/procedure/M3LProcedureBuilder` — the fluent, type-safe builder that
 * assembles a validated {@link M3LProcedure} from a caller-declared step
 * list, case list, and mandatory fallback.
 *
 * @packageDocumentation
 */

import { M3LProcedureInvalidDefinitionError } from "../../internal/procedure/errors.js";

import type { M3LProcedure } from "./M3LProcedure.js";
import type {
  M3LProcedureBuildOptions,
  M3LProcedureCase,
  M3LProcedureFallback,
  M3LProcedureShape,
  M3LProcedureStep,
} from "./types.js";

/**
 * Starts building a procedure over `TShape`. Every step id and case id
 * declared in `TShape["stepId"]`/`TShape["caseId"]` starts out "pending" —
 * `.step()`/`.case()` narrow the pending unions as each is declared, so a
 * duplicate id is a compile error, not a run-time surprise.
 *
 * @typeParam TShape - The procedure's declared shape.
 * @param name - Non-empty; part of the digest. An empty or non-string name
 *   is a build-time `ERR_PROCEDURE_INVALID_DECLARATION` problem.
 * @returns A builder whose pending-steps and pending-cases unions are the
 *   whole of `TShape["stepId"]`/`TShape["caseId"]`.
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
 * const builder = Core.createProcedureBuilder<Triage>("log-triage");
 * ```
 */
export function createProcedureBuilder<TShape extends M3LProcedureShape>(
  name: string,
): M3LProcedureBuilder<TShape, TShape["stepId"], TShape["caseId"]> {
  return new M3LProcedureBuilder<TShape, TShape["stepId"], TShape["caseId"]>(
    name,
  );
}

/**
 * The fluent builder returned by {@link createProcedureBuilder}. Accumulates
 * a step list, a case list, and — via {@link M3LProcedureBuilder.build} — the
 * mandatory fallback, then validates and freezes the whole into an
 * {@link M3LProcedure}.
 *
 * @typeParam TShape - The procedure's declared shape.
 * @typeParam TPendingSteps - Step ids not yet declared via `.step()`.
 * @typeParam TPendingCases - Case ids not yet declared via `.case()`.
 */
export class M3LProcedureBuilder<
  TShape extends M3LProcedureShape,
  TPendingSteps extends TShape["stepId"],
  TPendingCases extends TShape["caseId"],
> {
  readonly #name: string;

  /**
   * @internal Constructed only by {@link createProcedureBuilder}.
   */
  constructor(name: string) {
    this.#name = name;
  }

  /**
   * Appends a step; execution order is call order.
   *
   * `TId extends TPendingSteps` is what makes a duplicate step id a
   * **compile** error: the returned builder's pending union excludes `TId`,
   * so a second `.step({ id: "gather" })` no longer satisfies the
   * constraint.
   *
   * @typeParam TId - This step's own id; must still be pending.
   * @typeParam TJump - The step's own declared `jumpsTo` targets.
   * @param step - The step declaration.
   * @returns A builder whose pending-steps union excludes `TId`.
   */
  step<
    const TId extends TPendingSteps,
    const TJump extends TShape["stepId"] = never,
  >(
    step: M3LProcedureStep<TShape, TId, TJump>,
  ): M3LProcedureBuilder<TShape, Exclude<TPendingSteps, TId>, TPendingCases> {
    throw new M3LProcedureInvalidDefinitionError(
      `M3LProcedureBuilder.step is not implemented yet (procedure "${this.#name}")`,
      { stepId: step.id },
    );
  }

  /**
   * Appends a case; priority (not call order) decides precedence at
   * evaluation time. Same `Exclude` discipline as {@link
   * M3LProcedureBuilder.step}, so a duplicate case id is a compile error.
   *
   * @typeParam TId - This case's own id; must still be pending.
   * @param entry - The case declaration.
   * @returns A builder whose pending-cases union excludes `TId`.
   */
  case<const TId extends TPendingCases>(
    entry: M3LProcedureCase<TShape, TId>,
  ): M3LProcedureBuilder<TShape, TPendingSteps, Exclude<TPendingCases, TId>> {
    throw new M3LProcedureInvalidDefinitionError(
      `M3LProcedureBuilder.case is not implemented yet (procedure "${this.#name}")`,
      { caseId: entry.id },
    );
  }

  /**
   * Validates and freezes. `fallback` is required, so a procedure without a
   * defined outcome cannot be constructed.
   *
   * @param fallback - The mandatory "no case matched" conclusion.
   * @param options - Build-time options, e.g. `revision`.
   * @returns The validated, immutable, reusable {@link M3LProcedure}.
   * @throws `M3LError` with code `ERR_PROCEDURE_INVALID_DEFINITION`, carrying
   *   every finding in `context.problems`.
   */
  build(
    fallback: M3LProcedureFallback<TShape>,
    options?: M3LProcedureBuildOptions,
  ): M3LProcedure<TShape> {
    throw new M3LProcedureInvalidDefinitionError(
      `M3LProcedureBuilder.build is not implemented yet (procedure "${this.#name}")`,
      {
        revision: options?.revision,
        fallbackDescription: fallback.description,
      },
    );
  }
}
