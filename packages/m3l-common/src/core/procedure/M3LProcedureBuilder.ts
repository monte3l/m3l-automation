/**
 * `core/procedure/M3LProcedureBuilder` — the fluent, type-safe builder that
 * assembles a validated {@link M3LProcedure} from a caller-declared step
 * list, case list, and mandatory fallback.
 *
 * @packageDocumentation
 */

import { createBuiltDefinition } from "../../internal/procedure/definition.js";
import {
  buildProcedureSummary,
  computeProcedureDigest,
} from "../../internal/procedure/digest.js";
import { M3LProcedureInvalidDefinitionError } from "../../internal/procedure/errors.js";
import {
  renderProcedureProblemsMessage,
  validateProcedureDefinition,
} from "../../internal/procedure/validate/index.js";

import { kCreateProcedure, M3LProcedure } from "./M3LProcedure.js";
import type {
  M3LProcedureBuildOptions,
  M3LProcedureCase,
  M3LProcedureFallback,
} from "./build-types.js";
import type { M3LProcedureStep } from "./step-types.js";
import type { M3LProcedureShape } from "./types.js";
import type {
  ProcedureValidationOutcome,
  ValidatedProcedureDefinition,
} from "../../internal/procedure/validate/index.js";

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
  readonly #steps: unknown[] = [];
  readonly #cases: unknown[] = [];
  #parameters: readonly string[] = [];

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
    this.#steps.push(step);
    return this;
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
    this.#cases.push(entry);
    return this;
  }

  /**
   * Declares the parameter names this procedure reads, **at run time**.
   *
   * `TShape["parameters"]` gives the compiler the names, but types are
   * erased, so without this call `build()` has no way to know a `parameter`
   * reference addresses something real, `describe()` has no `parameters`
   * list to project into the digest, and `run()` cannot reject an
   * undeclared key. The element type is constrained to the shape's own
   * keys, so this cannot drift from the type — it can only be incomplete.
   *
   * Omitting it declares **none**, which is a loud failure rather than a
   * quiet one: every `parameter` reference then fails `build()` under
   * `ERR_PROCEDURE_UNKNOWN_REFERENCE`.
   *
   * @param names - The parameter names to declare, drawn from
   *   `TShape["parameters"]`.
   * @returns This builder, unchanged in its pending-steps/-cases unions.
   *
   * @example
   * ```ts
   * import { Core } from "@m3l-automation/m3l-common";
   *
   * interface Triage extends Core.M3LProcedureShape {
   *   deps: { readonly logs: { query(q: string): Promise<number> } };
   *   values: Record<string, never>;
   *   parameters: { threshold: number };
   *   conclusion: void;
   *   stepId: "count-errors";
   *   caseId: "quiet";
   * }
   *
   * const builder =
   *   Core.createProcedureBuilder<Triage>("log-triage").parameters([
   *     "threshold",
   *   ]);
   * ```
   */
  parameters(names: readonly (keyof TShape["parameters"] & string)[]): this {
    this.#parameters = [...names];
    return this;
  }

  /**
   * Validates and freezes. `fallback` is required, so a procedure without a
   * defined outcome cannot be constructed.
   *
   * @param fallback - The mandatory "no case matched" conclusion.
   * @param options - Build-time options, e.g. `revision`.
   * @returns The validated, immutable, reusable {@link M3LProcedure}.
   * @throws `M3LError` with code `ERR_PROCEDURE_INVALID_DEFINITION`, carrying
   *   every finding in `context.problems` — or, for a defect this module's
   *   own reads cannot recover from (e.g. a hostile getter throwing while a
   *   declared field is read), the same code wrapping the original failure
   *   as `cause`.
   */
  build(
    fallback: M3LProcedureFallback<TShape>,
    options?: M3LProcedureBuildOptions,
  ): M3LProcedure<TShape> {
    let outcome: ProcedureValidationOutcome;
    try {
      outcome = validateProcedureDefinition({
        name: this.#name,
        steps: this.#steps,
        cases: this.#cases,
        fallback,
        declaredParameters: this.#parameters,
        revision: options?.revision,
      });
    } catch (cause) {
      // Defense-in-depth backstop, not a substitute for validating and
      // projecting every field `validateProcedureDefinition` itself reads
      // (that is what closes the common cases — a non-scalar condition
      // `literal`, a non-string `revision` — as a proper structured
      // `M3LProcedureValidationProblem`). This exists for what that
      // validation pass cannot itself guard: `field()` has no protection
      // against a getter on `id`/`label`/`kind`/`execute`/`action`/etc.
      // throwing while being read.
      throw new M3LProcedureInvalidDefinitionError(
        "M3LProcedureBuilder.build(): a declared field could not be read",
        { problems: [] },
        { cause },
      );
    }

    if (outcome.kind === "invalid") {
      throw new M3LProcedureInvalidDefinitionError(
        renderProcedureProblemsMessage(outcome.problems),
        { problems: outcome.problems },
      );
    }

    const { definition, fallbackAction } = outcome;
    const summary = buildProcedureSummary(definition);
    const digest = computeProcedureDigest(summary);

    return M3LProcedure.createFromBuiltDefinition<TShape>(
      kCreateProcedure,
      createBuiltDefinition<TShape>({
        digest,
        summary,
        steps: this.#buildRuntimeSteps(definition),
        cases: this.#buildRuntimeCases(definition),
        fallback: {
          description: definition.fallback.description,
          prose: definition.fallback.prose,
          action: fallbackAction,
        } as M3LProcedureFallback<TShape>,
      }),
    );
  }

  /**
   * Combines each validated step's scalar fields with the `execute`/
   * `describeTrace` references — both read exactly once, during {@link
   * validateProcedureDefinition}'s normalization pass, and carried on the
   * validated projection ever since. This method never reads
   * `this.#steps[index]` again: doing so would both reopen the
   * validate-then-re-read hazard (a mutable/accessor-backed caller value
   * could disagree between the two reads) and skip the `execute`
   * function-ness check normalization already performed — a non-function
   * `execute` is `ERR_PROCEDURE_INVALID_DECLARATION`, never a bare
   * `TypeError` surfacing only once the step actually runs.
   */
  #buildRuntimeSteps(
    definition: ValidatedProcedureDefinition,
  ): readonly M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>[] {
    return definition.steps.map(
      (validated) =>
        ({
          id: validated.id,
          label: validated.label,
          kind: validated.kind,
          continueOnFailure: validated.continueOnFailure,
          jumpsTo: validated.jumpsTo,
          ...(validated.loop !== undefined ? { loop: validated.loop } : {}),
          execute: validated.execute,
          ...(validated.describeTrace !== undefined
            ? { describeTrace: validated.describeTrace }
            : {}),
        }) as M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
    );
  }

  /**
   * Combines each validated case's scalar fields with the `action`
   * reference — read exactly once during validation and carried on the
   * validated projection. See {@link M3LProcedureBuilder.#buildRuntimeSteps}
   * for why this method never reads `this.#cases[index]` again.
   */
  #buildRuntimeCases(
    definition: ValidatedProcedureDefinition,
  ): readonly M3LProcedureCase<TShape, TShape["caseId"]>[] {
    return definition.cases.map(
      (validated) =>
        ({
          id: validated.id,
          description: validated.description,
          prose: validated.prose,
          condition: validated.condition,
          priority: validated.priority,
          action: validated.action,
        }) as M3LProcedureCase<TShape, TShape["caseId"]>,
    );
  }
}
