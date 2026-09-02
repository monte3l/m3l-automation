/**
 * `flow/branch` — validation of one flow step's branch arm
 * (`onSuccess`/`onFailure`/`onPartial`): `"continue"`, `"stop"`, or a
 * `{ goto }` mapping naming a declared step id.
 *
 * Split out of `flow/validate.ts` purely to keep that file under the
 * per-file byte budget — `readBranch` is `flow/validate.ts`'s only
 * dependency on this module, and this module's own dependency
 * (`flow/validate-guards.ts`) does not depend back on either file, so the
 * split introduces no import cycle.
 *
 * @packageDocumentation
 */

import {
  asRecord,
  readString,
  rejectFlow,
  screenDangerousKeys,
  screenUnknownKeys,
} from "./validate-guards.js";
import type { M3LCliFlowBranch } from "./types.js";

/** The only key a `{ goto }` branch mapping may carry. */
const GOTO_KEYS: ReadonlySet<string> = new Set(["goto"]);

/**
 * Validates one branch arm's value: `"continue"`, `"stop"`, or a `{ goto }`
 * mapping naming a declared step id. A `goto` may point forward, backward, or
 * at the step itself — a cycle is bounded by the flow's `maxStepExecutions`,
 * not by this rule.
 *
 * @param value - The raw arm value.
 * @param arm - The arm's key name, for the rejection message.
 * @param label - How to name the step in the rejection message.
 * @param stepIds - Every declared step id, for `goto` resolution.
 * @returns The validated branch.
 */
function validateBranch(
  value: unknown,
  arm: string,
  label: string,
  stepIds: ReadonlySet<string>,
): M3LCliFlowBranch {
  if (typeof value === "string") {
    if (value === "continue" || value === "stop") {
      return value;
    }
    rejectFlow(
      `${label} declares an invalid '${arm}' value '${value}' — must be 'continue', 'stop' or a { goto } mapping`,
    );
  }

  const armLabel = `${label}'s '${arm}'`;
  const record = asRecord(value, armLabel);
  screenDangerousKeys(record, armLabel);
  screenUnknownKeys(record, GOTO_KEYS, armLabel);
  const target = readString(record, "goto", armLabel);
  if (!stepIds.has(target)) {
    rejectFlow(
      `${armLabel} names an undeclared step id '${target}' — no step in this flow declares it`,
    );
  }
  return { goto: target };
}

/**
 * Reads a branch arm, falling back to `fallback` when the key is absent.
 *
 * @param record - The step-level record.
 * @param arm - The arm's key name.
 * @param fallback - The branch to use when the arm is undeclared.
 * @param label - How to name the step in the rejection message.
 * @param stepIds - Every declared step id, for `goto` resolution.
 * @returns The validated branch, or `fallback`.
 */
export function readBranch(
  record: Record<string, unknown>,
  arm: string,
  fallback: M3LCliFlowBranch,
  label: string,
  stepIds: ReadonlySet<string>,
): M3LCliFlowBranch {
  const value = record[arm];
  return value === undefined
    ? fallback
    : validateBranch(value, arm, label, stepIds);
}
