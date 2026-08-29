/**
 * `internal/agent/shape` — the one dry-run shape key computation both doors
 * (step 0's action projection and the public `agentActionShapeKey`) call
 * (ADR-0060, slice 2 § Dry-run-first).
 *
 * Private to `core/agent`; never re-exported through a public barrel.
 */

import { canonicalJsonHash } from "../../core/json/index.js";
import { compareByCodePoint } from "../json/compare-code-points.js";

/** The four action fields the dry-run shape key is computed over. */
export interface M3LAgentActionShapeFields {
  readonly script: string;
  readonly operation: string | undefined;
  readonly kind: string;
  readonly parameterNames: readonly string[];
}

/**
 * Computes the dry-run shape key for an action's already-validated fields.
 *
 * The key is `canonicalJsonHash` over exactly `script`, `operation`, `kind`,
 * and `parameterNames`, with `parameterNames` sorted by the same code-point
 * comparator `core/json` uses for object keys. Every part of that shape is
 * normative — see docs/reference/core/agent.md § Dry-run-first — because the
 * key is a **stored value**: a key written by one version must equal the key
 * computed by the next.
 *
 * `operation` is passed through as `undefined` when absent, and
 * `canonicalJsonStringify` drops keys that serialize to `undefined`, so an
 * action with no operation hashes as if the key were never written.
 * `parameterNames` is **copied** before sorting — the caller's array may be
 * frozen, and sorting it in place would either throw or silently change what
 * the decision log reports the caller asked for. `target` and `dryRun` are
 * deliberately excluded; see the docs section above for why neither weakens
 * the guarantee.
 */
export function computeAgentActionShapeKey(
  fields: M3LAgentActionShapeFields,
): string {
  return canonicalJsonHash({
    script: fields.script,
    operation: fields.operation,
    kind: fields.kind,
    parameterNames: [...fields.parameterNames].sort(compareByCodePoint),
  });
}
