/**
 * `runs/policy` — `createConfirmationPolicy`, the launch-confirmation gate
 * every non-dry-run run must pass before the orchestrator commits a governor
 * slot or writes a `console_runs` row.
 *
 * @packageDocumentation
 */

/**
 * The inputs {@link M3LRunPolicy.evaluate} decides over.
 *
 * Deliberately carries no `mutating` field. Until ADR-0055's declarative
 * operations land, the console has no way to introspect whether a given
 * script actually mutates anything — a script is an opaque directory the
 * resolver finds by name. Accepting a caller-supplied `mutating: false` here
 * would not be a policy decision at all; it would be a bypass wearing a
 * policy hat, since nothing on this side of the boundary can verify the
 * claim. So every non-dry-run launch requires explicit confirmation,
 * regardless of what the script actually does.
 *
 * @example
 * ```ts
 * const request: M3LRunPolicyRequest = {
 *   scriptName: "sqs-etl",
 *   dryRun: false,
 *   confirmed: true,
 *   operator: "ada",
 * };
 * ```
 */
export interface M3LRunPolicyRequest {
  /** The script identifier the operator wants to run. */
  readonly scriptName: string;
  /** Whether this launch is a dry run (performs no real work). */
  readonly dryRun: boolean;
  /** Whether the operator explicitly confirmed a non-dry-run launch. */
  readonly confirmed: boolean;
  /** The operator requesting the launch. */
  readonly operator: string;
}

/**
 * The verdict {@link M3LRunPolicy.evaluate} returns: `"allow"`, or `"deny"`
 * carrying a human-readable `reason`.
 *
 * @example
 * ```ts
 * function describe(verdict: M3LRunPolicyVerdict): string {
 *   return verdict.kind === "allow" ? "allowed" : verdict.reason;
 * }
 * ```
 */
export type M3LRunPolicyVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string };

/**
 * The launch-confirmation policy port. `evaluate` is a total function: it
 * never throws, it only returns a verdict. That is deliberate — the
 * orchestrator is the layer that converts a `"deny"` verdict into a thrown
 * `M3LConsoleError`, so "denied loudly, never silently dropped" is a
 * structural property of the call graph (the orchestrator cannot forget to
 * check the verdict and proceed anyway without a type error), rather than a
 * convention this port would otherwise rely on every caller to honor.
 *
 * @example
 * ```ts
 * import { createConfirmationPolicy } from "@m3l-automation/m3l-console-server/runs/policy.js";
 *
 * const policy = createConfirmationPolicy();
 * const verdict = policy.evaluate({
 *   scriptName: "sqs-etl",
 *   dryRun: false,
 *   confirmed: false,
 *   operator: "ada",
 * });
 * // { kind: "deny", reason: "..." }
 * ```
 */
export interface M3LRunPolicy {
  /**
   * Decides whether `request` may launch.
   *
   * @param request - See {@link M3LRunPolicyRequest}.
   * @returns `"allow"` when the launch may proceed, otherwise `"deny"` with a
   *   `reason` naming what is missing. Never throws.
   */
  evaluate(request: M3LRunPolicyRequest): M3LRunPolicyVerdict;
}

/**
 * Creates the confirmation {@link M3LRunPolicy}: a dry run is always
 * allowed (it performs no real work, so there is nothing to confirm); a
 * non-dry-run launch is allowed only when the operator explicitly set
 * `confirmed: true`, and denied — naming the missing confirmation — otherwise.
 *
 * @returns A fresh, stateless {@link M3LRunPolicy}.
 *
 * @example
 * ```ts
 * import { createConfirmationPolicy } from "@m3l-automation/m3l-console-server/runs/policy.js";
 *
 * const policy = createConfirmationPolicy();
 * policy.evaluate({
 *   scriptName: "sqs-etl",
 *   dryRun: true,
 *   confirmed: false,
 *   operator: "ada",
 * });
 * // { kind: "allow" }
 * ```
 */
export function createConfirmationPolicy(): M3LRunPolicy {
  return {
    evaluate(request: M3LRunPolicyRequest): M3LRunPolicyVerdict {
      if (request.dryRun || request.confirmed) {
        return { kind: "allow" };
      }
      return {
        kind: "deny",
        reason: `run of "${request.scriptName}" requires explicit confirmation`,
      };
    },
  };
}
