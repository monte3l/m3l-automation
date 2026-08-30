/**
 * `agent-operator/steps/load-policy` — reads and validates the deployment's
 * agent policy file (ADR-0060), the declared ceiling every subsequent step
 * evaluates actions against.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../lib/errors.js";

/**
 * Dependencies for {@link loadAgentPolicy}.
 */
export interface LoadAgentPolicyDeps {
  /** The paths port used to resolve `policyFile` under the input directory. */
  readonly paths: Core.M3LPaths;
  /** The policy file name, relative to the input directory. */
  readonly policyFile: string;
}

/**
 * Loads and validates `deps.policyFile` into a branded {@link Core.M3LAgentPolicy}.
 *
 * Reads through `Core.M3LInputFileReader.readJSONRecord` — never `readJSON` —
 * so the decoded value is screened for a top-level `__proto__`/`constructor`/
 * `prototype` key before it ever reaches {@link Core.validateAgentPolicy}.
 * There is deliberately **no inline fallback policy**: a missing, malformed,
 * or structurally invalid file is always a loud failure, never a silent
 * degradation to a built-in grant — the only way to run with authority is to
 * declare it in a reviewable file.
 *
 * Every failure (missing file, malformed JSON, prototype-pollution attempt,
 * or a structurally invalid declaration) is re-thrown as a single
 * {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_POLICY`,
 * chaining the original failure as `cause`. The reader's own malformed-JSON
 * message never embeds a snippet of the file's content (F10/W5), and this
 * function does not read `cause.message` into its own message, so that
 * guarantee is preserved rather than undone at this boundary.
 *
 * @param deps - See {@link LoadAgentPolicyDeps}.
 * @returns The validated, branded policy.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_POLICY`
 *   on any read, parse, or validation failure.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { loadAgentPolicy } from "./load-policy.js";
 *
 * const policy = await loadAgentPolicy({
 *   paths: new Core.M3LPaths(),
 *   policyFile: "agent-policy.json",
 * });
 * ```
 */
export async function loadAgentPolicy(
  deps: LoadAgentPolicyDeps,
): Promise<Core.M3LAgentPolicy> {
  const reader = new Core.M3LInputFileReader({
    paths: deps.paths,
    code: "ERR_AGENT_OPERATOR_POLICY",
  });
  try {
    const record = await reader.readJSONRecord(deps.policyFile);
    return Core.validateAgentPolicy(record);
  } catch (cause) {
    throw new M3LAgentOperatorCliError(
      "failed to load the agent policy file",
      "ERR_AGENT_OPERATOR_POLICY",
      { cause },
    );
  }
}
