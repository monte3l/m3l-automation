/**
 * `agent-operator/steps/build-tool-registry` — the only door through which a
 * set of {@link AgentToolSpec}s becomes an `AWS.M3LBedrockToolRegistry`.
 *
 * @remarks
 * Every entry is built through {@link gateToolSpec} — there is no bypass
 * parameter, so a registry produced here cannot contain an ungated handler.
 * The result is a `Map`, never a plain object: a `Map` is what keeps a tool
 * literally named `"__proto__"` or `"constructor"` from resolving to
 * anything but its own registration.
 *
 * @packageDocumentation
 */

import type { AWS } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../lib/errors.js";
import { gateToolSpec } from "./gate-tool.js";
import type { AgentToolSpec, GateToolDeps } from "./gate-tool.js";

/**
 * Tool names are declared by this script, never by the model, so this is a
 * self-check rather than input validation: lowercase snake_case, starting
 * with a letter, no doubled/leading/trailing underscore.
 */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** The ceiling on a tool name's length, enforced by {@link buildAgentToolRegistry}. */
const TOOL_NAME_MAX_LENGTH = 64;

/**
 * Rejects a blank or non-conforming tool name.
 *
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `name` is empty, exceeds {@link TOOL_NAME_MAX_LENGTH}, or does not
 *   match {@link TOOL_NAME_PATTERN}.
 */
function assertValidToolName(name: string): void {
  const withinBounds = name.length > 0 && name.length <= TOOL_NAME_MAX_LENGTH;
  if (withinBounds && TOOL_NAME_PATTERN.test(name)) return;
  throw new M3LAgentOperatorCliError(
    "a tool name must be non-blank, at most 64 characters, and match " +
      "/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/",
    "ERR_AGENT_OPERATOR_CONFIG",
    { context: { name } },
  );
}

/**
 * Rejects a `name` already present in `registry`.
 *
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `registry` already has an entry keyed `name` — a silent last-wins
 *   overwrite would let one tool shadow another's gate.
 */
function assertNoDuplicate(
  registry: ReadonlyMap<string, AWS.M3LBedrockToolRegistration>,
  name: string,
): void {
  if (!registry.has(name)) return;
  throw new M3LAgentOperatorCliError(
    `duplicate tool name '${name}': every gated tool must have a unique name`,
    "ERR_AGENT_OPERATOR_CONFIG",
    { context: { name } },
  );
}

/**
 * Builds a frozen `AWS.M3LBedrockToolRegistry`, gating every `specs` entry
 * through {@link gateToolSpec}.
 *
 * @param specs - The tool declarations to gate and register. Must be
 *   non-empty — a tool-free agent run is a configuration mistake here, not a
 *   valid mode.
 * @param deps - See {@link GateToolDeps}; shared by every gated entry.
 * @returns A frozen `Map` keyed by tool name.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `specs` is empty, when a name is blank/non-conforming, or when two
 *   specs share a name.
 *
 * @example
 * ```ts
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { buildAgentToolRegistry } from "./build-tool-registry.js";
 * import type { AgentToolSpec, GateToolDeps } from "./gate-tool.js";
 *
 * declare const specs: readonly AgentToolSpec[];
 * declare const deps: GateToolDeps;
 *
 * const registry: AWS.M3LBedrockToolRegistry = buildAgentToolRegistry(
 *   specs,
 *   deps,
 * );
 * ```
 */
export function buildAgentToolRegistry(
  specs: readonly AgentToolSpec[],
  deps: GateToolDeps,
): AWS.M3LBedrockToolRegistry {
  if (specs.length === 0) {
    throw new M3LAgentOperatorCliError(
      "at least one AgentToolSpec is required: a tool-free agent run is a configuration mistake",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }

  const registry = new Map<string, AWS.M3LBedrockToolRegistration>();
  for (const spec of specs) {
    assertValidToolName(spec.name);
    assertNoDuplicate(registry, spec.name);
    registry.set(spec.name, gateToolSpec(spec, deps));
  }
  return Object.freeze(registry);
}
