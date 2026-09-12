import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import type { TriageEntityLookup, TriageLookupTier } from "./preset.js";

/** The error code a wrapped `getItem` rejection carries. */
export const LOOKUP_CODE = "ERR_DLQ_TRIAGE_LOOKUP";

/** What {@link createDynamoDBLookup} needs. */
export interface DynamoDBLookupDeps {
  readonly operations: AWS.M3LDynamoDBOperations;
  /** Checked, alongside the per-call `signal` {@link TriageEntityLookup.get} takes, before every `getItem`. */
  readonly signal: AbortSignal | undefined;
}

/**
 * Re-checked through a function rather than inlined, matching
 * `drain-queue.ts`'s `checkNotAborted` — TypeScript's narrowing of a
 * mutable external `.aborted` property does not survive an `await`.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Builds a {@link TriageEntityLookup} backed by
 * `AWS.M3LDynamoDBOperations.getItem` — the only entity-lookup seam this
 * script's step graph reads through, kept narrow so a unit test can supply
 * a fake and exercise the whole procedure with no DynamoDB client.
 *
 * Cancellation is a **pre-check only**: `getItem` takes no `AbortSignal`, so
 * a call already in flight when `deps.signal` (or the per-call `signal`
 * `get()` receives) fires is never interrupted — only a call not yet issued
 * is prevented. Both signals are checked; either being aborted stops the
 * call before it reaches `getItem`.
 *
 * @param deps - The DynamoDB operations wrapper and the run-level
 *   cancellation signal.
 * @returns A `TriageEntityLookup` the compiled procedure can be run against.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { createDynamoDBLookup } from "./lookup-entity.js";
 *
 * declare const operations: AWS.M3LDynamoDBOperations;
 * const lookup = createDynamoDBLookup({
 *   operations,
 *   signal: undefined,
 * });
 * ```
 */
export function createDynamoDBLookup(
  deps: DynamoDBLookupDeps,
): TriageEntityLookup {
  return {
    async get(
      tier: TriageLookupTier,
      key: string,
      signal: AbortSignal | undefined,
    ): Promise<Readonly<Record<string, unknown>> | undefined> {
      if (isAborted(deps.signal) || isAborted(signal)) {
        throw new Core.M3LOperationAbortedError();
      }
      try {
        return await deps.operations.getItem(tier.table, {
          [tier.keyField]: key,
        });
      } catch (cause) {
        throw new Core.M3LError(
          `entity lookup failed for tier '${tier.label}' against table '${tier.table}'`,
          { code: LOOKUP_CODE, cause },
        );
      }
    },
  };
}
