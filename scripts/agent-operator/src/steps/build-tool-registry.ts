/**
 * `agent-operator/steps/build-tool-registry` — the only door through which a
 * set of {@link AgentToolSpec}s and {@link TwoPhaseAgentToolSpec}s becomes an
 * `AWS.M3LBedrockToolRegistry`.
 *
 * @remarks
 * Every entry is built through exactly one of two gates — {@link gateToolSpec}
 * for a `specs` entry, {@link gateTwoPhaseToolSpec} for a `twoPhaseSpecs`
 * entry — and there is no bypass parameter, so a registry produced here
 * cannot contain an ungated handler. The result is a `Map`, never a plain
 * object: a `Map` is what keeps a tool literally named `"__proto__"` or
 * `"constructor"` from resolving to anything but its own registration.
 *
 * `Object.freeze` is applied to the `Map` object itself — it freezes only the
 * object's own properties, never a `Map`'s entries, so a caller holding a
 * reference typed as the plain `Map` can still `.set`/`.delete` an entry after
 * this function returns. The caller-facing guarantee is therefore the
 * declared `ReadonlyMap` return type, not the runtime freeze: `ReadonlyMap`
 * has no mutating methods in its type, so an honest caller (one that does not
 * reach for an `as Map` cast) structurally cannot mutate what it was handed.
 *
 * @packageDocumentation
 */

import type { AWS } from "@monte3l/m3l-common";

import { M3LAgentOperatorCliError } from "../lib/errors.js";
import { gateToolSpec, gateTwoPhaseToolSpec } from "./gate-tool.js";
import type {
  AgentToolSpec,
  GateToolDeps,
  TwoPhaseAgentToolSpec,
} from "./gate-tool.js";

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
    `a tool name must be non-blank, at most ${TOOL_NAME_MAX_LENGTH} ` +
      "characters, and match /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/",
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
 * through {@link gateToolSpec} and every `twoPhaseSpecs` entry through
 * {@link gateTwoPhaseToolSpec}.
 *
 * @param specs - The single-phase tool declarations to gate and register.
 * @param deps - See {@link GateToolDeps}; shared by every gated entry.
 * @param twoPhaseSpecs - The two-phase (dry-run-then-mutate) tool
 *   declarations to gate and register. Defaults to empty.
 * @returns A `ReadonlyMap` keyed by tool name — the declared return type is
 *   the caller-facing guarantee; see the module remarks for why the runtime
 *   `Object.freeze` on the underlying `Map` object does not itself stop a
 *   caller holding a looser-typed reference from mutating an entry. `specs`
 *   and `twoPhaseSpecs` together must be non-empty — a tool-free agent run is
 *   a configuration mistake here, not a valid mode — but either array alone
 *   may be empty.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `specs` and `twoPhaseSpecs` are both empty, when a name (from
 *   either array) is blank/non-conforming, or when two specs — from the same
 *   array or across both — share a name.
 *
 * @example
 * ```ts
 * import type { AWS } from "@monte3l/m3l-common";
 * import { buildAgentToolRegistry } from "./build-tool-registry.js";
 * import type {
 *   AgentToolSpec,
 *   GateToolDeps,
 *   TwoPhaseAgentToolSpec,
 * } from "./gate-tool.js";
 *
 * declare const specs: readonly AgentToolSpec[];
 * declare const deps: GateToolDeps;
 * declare const twoPhaseSpecs: readonly TwoPhaseAgentToolSpec[];
 *
 * const registry: AWS.M3LBedrockToolRegistry = buildAgentToolRegistry(
 *   specs,
 *   deps,
 *   twoPhaseSpecs,
 * );
 * ```
 */
export function buildAgentToolRegistry(
  specs: readonly AgentToolSpec[],
  deps: GateToolDeps,
  twoPhaseSpecs: readonly TwoPhaseAgentToolSpec[] = [],
): AWS.M3LBedrockToolRegistry {
  if (specs.length === 0 && twoPhaseSpecs.length === 0) {
    throw new M3LAgentOperatorCliError(
      "at least one AgentToolSpec or TwoPhaseAgentToolSpec is required: a tool-free agent run is a configuration mistake",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }

  const registry = new Map<string, AWS.M3LBedrockToolRegistration>();
  for (const spec of specs) {
    assertValidToolName(spec.name);
    assertNoDuplicate(registry, spec.name);
    registry.set(spec.name, gateToolSpec(spec, deps));
  }
  for (const spec of twoPhaseSpecs) {
    assertValidToolName(spec.name);
    assertNoDuplicate(registry, spec.name);
    registry.set(spec.name, gateTwoPhaseToolSpec(spec, deps));
  }
  return Object.freeze(registry);
}
