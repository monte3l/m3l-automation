/**
 * `sessions/launch-parameters` — resolving an
 * {@link M3LSessionAddStepInput}'s bindings into the launch-parameter map
 * `service.ts`'s `addStep` hands to the launcher (X6 workbench-sessions
 * module, slice 4, Part A, issue #554).
 *
 * Split out of `sessions/service.ts` purely to keep that file under the
 * 25,000-byte file-budget cap (`bin/check-file-budget.mjs`) — a pure,
 * behavior-preserving extraction, not a design change.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";
import type { M3LConsoleSessionsRepository } from "../store/sessions-repository.js";

import type { M3LSessionArtifactStore } from "./artifacts.js";
import { decodeArtifactRef } from "./artifacts.js";
import type { M3LBindingExpectedType } from "./binding.js";
import { validateBindingValue } from "./binding.js";
import { parseStepReference, resolveStepReference } from "./reference.js";

/**
 * One binding an {@link M3LSessionAddStepInput} resolves before launch: a
 * reference into a prior step's recorded output, the shape the resolved
 * value must have, whether it must be a single value or an array, and the
 * launch-parameter name the resolved value binds to.
 *
 * @example
 * ```ts
 * const binding: M3LSessionAddStepBinding = {
 *   reference: "step-1.output.Queues[0]",
 *   expectedType: "string",
 *   multiSelect: false,
 *   parameterName: "queueName",
 * };
 * ```
 */
export interface M3LSessionAddStepBinding {
  /** The step-output reference this binding resolves — see `sessions/reference.ts`'s `parseStepReference`. */
  readonly reference: string;
  /** The shape the resolved value must have. */
  readonly expectedType: M3LBindingExpectedType;
  /** Whether the resolved value must be a single value or an array of them. */
  readonly multiSelect: boolean;
  /** The launch-parameter name this binding's resolved value binds to. */
  readonly parameterName: string;
}

/**
 * The input {@link M3LSessionService.addStep} resolves and launches. Each
 * `bindings[i]` resolves to that same binding's own `parameterName`'s
 * launch-parameter value.
 *
 * @example
 * ```ts
 * const input: M3LSessionAddStepInput = {
 *   operation: "scripts/example",
 *   bindings: [
 *     {
 *       reference: "step-1.output.Queues[0]",
 *       expectedType: "string",
 *       multiSelect: false,
 *       parameterName: "queueName",
 *     },
 *   ],
 *   confirmed: true,
 *   dryRun: false,
 *   operator: "alice",
 *   correlationId: "corr-1",
 * };
 * ```
 */
export interface M3LSessionAddStepInput {
  /** The operation (e.g. a script identifier) this step invokes. */
  readonly operation: string;
  /** The bindings to resolve before launch. */
  readonly bindings: readonly M3LSessionAddStepBinding[];
  /** Whether the caller explicitly confirmed a non-dry-run execution. */
  readonly confirmed: boolean;
  /** Whether the run should execute in dry-run mode. */
  readonly dryRun: boolean;
  /** The operator adding this step. */
  readonly operator: string;
  /** The correlation id this step's diagnostics are tagged with. */
  readonly correlationId: string;
}

/** Resolves one binding's value: parses its reference, finds the referenced step, reads and walks its recorded output, and validates the shape. */
export async function resolveBindingValue(
  sessionsRepository: M3LConsoleSessionsRepository,
  artifactStore: M3LSessionArtifactStore,
  sessionId: string,
  binding: M3LSessionAddStepBinding,
): Promise<unknown> {
  const parsed = parseStepReference(binding.reference);
  const step = sessionsRepository.getStepByOrdinal(sessionId, parsed.ordinal);
  if (step === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
      `no step at ordinal ${String(parsed.ordinal)} in session "${sessionId}" for reference "${binding.reference}"`,
    );
  }
  if (step.resultRef === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_REFERENCE_INVALID",
      `step at ordinal ${String(parsed.ordinal)} has no recorded result yet for reference "${binding.reference}"`,
    );
  }
  const output = await artifactStore.readArtifact(
    decodeArtifactRef(step.resultRef),
  );
  const value = resolveStepReference(parsed, output);
  if (!validateBindingValue(value, binding)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_REFERENCE_INVALID",
      `binding "${binding.reference}" resolved to a value that does not match its expected shape`,
    );
  }
  return value;
}
