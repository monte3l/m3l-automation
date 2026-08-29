/**
 * `internal/agent/brand` — the runtime registry of the policy objects that
 * actually passed `validateAgentPolicy`.
 *
 * Private to `core/agent`; never re-exported through a public barrel.
 *
 * `M3LAgentPolicy`'s `unique symbol` brand is erased at compile time, so on
 * its own it stops nothing at runtime: `JSON.parse(text) as M3LAgentPolicy`
 * compiles, and so does `{ ...realPolicy, scripts: [...] }` — which needs no
 * cast at all, because a spread of a branded type keeps the brand. Both
 * routes put an unvalidated declaration in front of the evaluator, which is
 * the one thing `validateAgentPolicy`'s "only door" promise rules out.
 *
 * A `WeakSet` of the exact objects the validator produced closes both: a
 * spread produces a NEW object, and a new object is not a member. A
 * non-enumerable own symbol would not — `{ ...policy }` copies own enumerable
 * *symbol* keys too, but even a non-enumerable marker can be grafted on by
 * `Object.defineProperty`, whereas membership here can only be granted by
 * `validateAgentPolicy` itself.
 */

import type { M3LAgentPolicy } from "../../core/agent/policy-types.js";
import { isObject } from "../../core/utils/guards.js";

/**
 * The validated policy objects, held weakly so a policy that goes out of
 * scope is collectable. Module-private by construction: nothing exported from
 * here can add to it except {@link registerValidatedAgentPolicy}.
 */
const VALIDATED_POLICIES = new WeakSet<object>();

/**
 * Records `policy` as validator-produced and returns it unchanged.
 *
 * Called from exactly one place — `core/agent/validate-policy` — on the
 * deep-frozen projection the declaration walk just built.
 */
export function registerValidatedAgentPolicy(
  policy: M3LAgentPolicy,
): M3LAgentPolicy {
  VALIDATED_POLICIES.add(policy);
  return policy;
}

/**
 * `true` only for an object `validateAgentPolicy` itself produced.
 *
 * Takes `unknown` rather than `M3LAgentPolicy` deliberately: the values this
 * has to reject are precisely the ones the compiler already believes are
 * policies.
 */
export function isValidatedAgentPolicy(
  value: unknown,
): value is M3LAgentPolicy {
  return isObject(value) && VALIDATED_POLICIES.has(value);
}
