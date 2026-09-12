/**
 * `sqs-dead-letter-triage/steps/build-procedure` — assembly only: wires the
 * nine codified steps (`./steps-graph.js`) and every case (`./cases.js`)
 * into one built, validated `M3LProcedure`.
 */

import { Core } from "@m3l-automation/m3l-common";

import { buildTriageCases, unrecognisedFallback } from "./cases.js";
import type { TriagePreset, TriageShape } from "./preset.js";
import {
  checkEntityPresentStep,
  deriveStateStep,
  extractKeyStep,
  lookupEntityStep,
  matchKnownCasesStep,
  parseEnvelopeStep,
  resolveModeStep,
  routeEventStep,
  widenLookupStep,
} from "./steps-graph.js";

/**
 * Compiles one preset into an executable, validated `M3LProcedure`. The step
 * graph is codified and identical for every preset — only the arms and case
 * rows a preset declares change what the graph actually does.
 *
 * No AWS call, no I/O: `build()` validates the definition and returns. A
 * case-id or priority collision an operator would otherwise meet mid-triage
 * surfaces here instead, as a `Core.M3LProcedureValidationProblem`.
 *
 * @param preset - The validated preset to compile.
 * @returns The built, immutable procedure.
 * @throws {@link Core.M3LError} coded `ERR_PROCEDURE_INVALID_DEFINITION`,
 *   carrying every finding in `context.problems`, when the preset's cases
 *   collide on an id or a priority, or another declaration is invalid.
 *
 * @example
 * ```typescript
 * import { buildTriageProcedure } from "./build-procedure.js";
 * import type { TriagePreset } from "./preset.js";
 *
 * declare const preset: TriagePreset;
 * const procedure = buildTriageProcedure(preset);
 * console.log(procedure.describe().cases.length);
 * ```
 */
export function buildTriageProcedure(
  preset: TriagePreset,
): Core.M3LProcedure<TriageShape> {
  let builder: Core.M3LProcedureBuilder<TriageShape, never, string> =
    Core.createProcedureBuilder<TriageShape>(
      `sqs-dead-letter-triage:${preset.queue}`,
    )
      .parameters(["queue", "messageId"])
      .step(resolveModeStep(preset))
      .step(parseEnvelopeStep(preset))
      .step(routeEventStep(preset))
      .step(extractKeyStep())
      .step(widenLookupStep())
      .step(lookupEntityStep())
      .step(checkEntityPresentStep(preset))
      .step(deriveStateStep())
      .step(matchKnownCasesStep());

  // Declared one assignment at a time rather than chained: `.case()` narrows
  // its pending-cases union by `Exclude<TPending, TId>`, and with `caseId`
  // typed `string` the first call collapses that union to `never`.
  // Re-assigning through the annotated `builder` binding restores it, which
  // is exactly what lets every arm's own rows be declared in a loop.
  for (const entry of buildTriageCases(preset)) {
    builder = builder.case(entry);
  }

  // Folding the preset's own hash into `revision` is what makes two runs
  // comparable only when the preset they ran from is byte-identical.
  return builder.build(unrecognisedFallback(preset), {
    revision: Core.canonicalJsonHash(preset),
  });
}
