/**
 * `agent-operator/steps/build-health-tools` — the four `AgentToolSpec`s the
 * fleet health-check workload exposes to the model, over `AgentCliSurface`.
 *
 * @remarks
 * This module **never gates anything itself**. `steps/build-tool-registry`'s
 * `buildAgentToolRegistry` is the only door a spec passes through to become
 * callable, and it has no bypass parameter — so "every tool is gated" stays
 * structural. What lives here is the other half: the action each tool
 * submits for judgement, and the real work it performs once approved.
 *
 * The `operation` strings map 1:1 onto the committed policy
 * (`data/input/agent-policy.json`): the `agent-operator` grant declares
 * `list` and `doctor`; every fleet-script grant declares `inspect` and
 * `dry-run`. All are listed in that grant's `readOnlyOperations`, which is
 * what auto-approves them at evaluator step 4 — and it is why
 * `dryRunFirst: true` in the committed policy is not an obstacle here: step 6
 * applies only to a would-be step-7 auto-approval, and a `read-only` action
 * has already been approved at step 4.
 *
 * ## `describeAction` is the one trust boundary
 *
 * Everything a model can influence enters through it, so every rule below is
 * load-bearing:
 *
 * - `scriptName` is read with `Object.hasOwn`, never a bracket or dot read.
 *   A model can literally send `{"__proto__": {"scriptName": "…"}}`, and an
 *   inherited read would answer from the prototype chain for a key the input
 *   never declared.
 * - The name must pass {@link isAllowedScriptName} — **not** because the CLI
 *   surface would not check (it does, immediately before any spawn), but to
 *   bound what reaches `Core.evaluateAgentAction` and the append-only
 *   decision log. Without the allowlist's length cap, a hostile 100 KB name
 *   builds an entry that breaches the log's single-line byte ceiling; the
 *   gate sees that as a *write* failure, calls `observeDecisionLog(false)`,
 *   and every subsequent action escalates on `decision-log-unavailable`.
 *   That is a model-triggerable self-DOS. Rejecting here refuses with
 *   `malformedInput`, writes nothing, and leaves the ledger clean.
 * - `kind` is **never** derived from input. It is asserted from this
 *   module's own declaration, or a model could assert its own autonomy tier.
 * - `fleet_list` and `fleet_doctor` accept `undefined` or any plain object
 *   and never read it. The ignoring *is* the guarantee: it preserves "the
 *   model supplies exactly one value across these four health-check tools —
 *   a script name." Note the scope: it is a claim about *this* tool set, not
 *   about `AgentCliSurface` as a whole. The surface exposes a fifth
 *   operation, `run`, whose second model-supplied value is a preset *name*,
 *   kept honest by its own nominal brand (`lib/preset-names.ts`) plus
 *   membership in the operator-declared `presetAllowlist` — see
 *   `lib/cli-surface.ts`'s header. No tool built here exposes `run`, so
 *   within this module the one-value claim holds exactly as stated.
 *
 * `script_dry_run` is fail-closed in **two independent layers**: its spec is
 * not built at all unless `includeDryRunProbes` is true *and* the allowlist
 * is non-empty, and `steps/run-health-check` separately hands the CLI surface
 * an empty allowlist when the flag is off. Either layer alone would suffice;
 * both exist because this is the only tool in the set that runs another
 * script's code.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

import type { AgentCliSurface } from "../lib/cli-surface.js";
import { isAllowedScriptName } from "../lib/cli-names.js";
import { M3LAgentOperatorCliError } from "../lib/errors.js";
import type { AgentToolExecution, AgentToolSpec } from "./gate-tool.js";
import type { AgentHealthObservations } from "./health-observations.js";

/**
 * The four tool names, frozen. Exported so the prompt builder and the tests
 * name the same strings this module registers, rather than re-typing them.
 *
 * Annotated rather than `as const satisfies …`: `tsconfig.build.json` sets
 * `isolatedDeclarations`, which rejects an exported `satisfies` expression.
 */
export const AGENT_HEALTH_TOOL_NAMES: {
  readonly fleetList: "fleet_list";
  readonly fleetDoctor: "fleet_doctor";
  readonly scriptInspect: "script_inspect";
  readonly scriptDryRun: "script_dry_run";
} = Object.freeze({
  fleetList: "fleet_list",
  fleetDoctor: "fleet_doctor",
  scriptInspect: "script_inspect",
  scriptDryRun: "script_dry_run",
});

/**
 * The JSON Schema both no-input tools declare: an object with **no**
 * properties.
 *
 * @remarks
 * Shared rather than duplicated so the one-value invariant is visible in one
 * place. `additionalProperties: false` is declared for the model's benefit,
 * not as enforcement — the library forwards `inputSchema` to Bedrock and
 * validates nothing itself, which is exactly why `describeAction` ignores
 * whatever arrives instead of trusting the schema to have been honoured.
 */
const NO_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/** The JSON Schema for the two tools that take a single script name. */
const SCRIPT_NAME_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  properties: {
    scriptName: {
      type: "string",
      description: "The name of a script listed by fleet_list.",
    },
  },
  required: ["scriptName"],
  additionalProperties: false,
});

/**
 * Extracts the single `scriptName` a model-supplied `input` may carry, or
 * throws.
 *
 * @remarks
 * The whole trust boundary in one function. `Object.hasOwn` refuses to
 * inherit; `isAllowedScriptName` bounds both the character set and the
 * length before the value can reach the evaluator or the audit log. The
 * thrown message never echoes `value` — it is model-supplied, and a rejected
 * value is exactly the thing least safe to quote back.
 *
 * @throws {@link M3LAgentOperatorCliError} coded
 *   `ERR_AGENT_OPERATOR_SCRIPT_NAME` when `input` is not a plain object, does
 *   not carry its own `scriptName`, or carries one the allowlist rejects.
 */
function readScriptName(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    throw new M3LAgentOperatorCliError(
      "the tool input must be an object carrying a 'scriptName'",
      "ERR_AGENT_OPERATOR_SCRIPT_NAME",
    );
  }
  // `Object.hasOwn`, never `input["scriptName"]`: a model can send
  // `{"__proto__": {"scriptName": "…"}}`, and a bracket read would answer
  // from the prototype chain for a key this input never declared.
  if (!Object.hasOwn(input, "scriptName")) {
    throw new M3LAgentOperatorCliError(
      "the tool input must carry its own 'scriptName' property",
      "ERR_AGENT_OPERATOR_SCRIPT_NAME",
    );
  }
  const value = (input as Record<string, unknown>)["scriptName"];
  if (!isAllowedScriptName(value)) {
    throw new M3LAgentOperatorCliError(
      "the supplied script name is not an allowed script name",
      "ERR_AGENT_OPERATOR_SCRIPT_NAME",
    );
  }
  return value;
}

/**
 * Builds the `AgentToolExecution` every tool here returns: the projected
 * payload as a single `json` content block, plus the audit outcome.
 *
 * @remarks
 * `{ type: "json" }`, never `{ type: "text" }` with a stringified payload:
 * untrusted text then appears only as a JSON **leaf value**, never
 * concatenated into prose the model reads as instruction. `dryRun: false` is
 * asserted by this module for all four tools — none of them is a `--dry-run`
 * *action* in the policy's sense, including `script_dry_run`, whose action
 * is the read-only `dry-run` operation the fleet grants declare rather than a
 * dry run of some mutation this script would otherwise perform.
 *
 * `exitCode` is a parameter rather than a hardcoded `0` because
 * `script_dry_run` genuinely has one to report: a probe that exits non-zero
 * still RESOLVES (the envelope carries its own outcome), and stamping `0`
 * onto that audit record would make the log claim a clean probe the run never
 * observed.
 */
function jsonExecution(payload: unknown, exitCode: number): AgentToolExecution {
  return {
    content: [{ type: "json", json: payload }],
    outcome: { dryRun: false, exitCode },
  };
}

/** The read-only action for a whole-fleet tool, asserted from this module. */
function fleetAction(operation: string): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation,
    kind: "read-only",
    parameterNames: ["command", "scripts"],
  };
}

/** The read-only action for a per-script tool, asserted from this module. */
function scriptAction(script: string, operation: string): Core.M3LAgentAction {
  return {
    script,
    operation,
    // NEVER derived from input: a model that could choose `kind` could
    // choose its own autonomy tier.
    kind: "read-only",
    parameterNames: ["command", "scriptName"],
  };
}

/** Dependencies {@link buildHealthTools} needs to build the four specs. */
export interface BuildHealthToolsDeps {
  /** The typed `m3l` CLI adapter every tool's `execute` drives. */
  readonly surface: AgentCliSurface;
  /** The collector every tool writes its projected result into. */
  readonly observations: AgentHealthObservations;
  /**
   * `true` only when `includeDryRunProbes` is set AND `dryRunAllowlist` is
   * non-empty. The first of `script_dry_run`'s two independent fail-closed
   * layers — see the module remarks.
   */
  readonly includeDryRunProbe: boolean;
}

/** Builds the `fleet_list` spec. */
function fleetListSpec(deps: BuildHealthToolsDeps): AgentToolSpec {
  return {
    name: AGENT_HEALTH_TOOL_NAMES.fleetList,
    description:
      "List every script the m3l CLI discovers, with its description and parameter count. Takes no arguments.",
    inputSchema: NO_INPUT_SCHEMA,
    // `input` is deliberately unread. Accepting anything and reading nothing
    // is what keeps "the model supplies exactly one value across these four
    // health-check tools" true. Scoped to this tool set: the wider CLI
    // surface's `run` operation adds a second value, a preset name, which no
    // tool built here can reach (see the module remarks).
    describeAction: (): Core.M3LAgentAction => fleetAction("list"),
    execute: async (): Promise<AgentToolExecution> => {
      const rows = await deps.surface.list();
      deps.observations.recordFleet(rows);
      return jsonExecution(rows, 0);
    },
  };
}

/** Builds the `fleet_doctor` spec. */
function fleetDoctorSpec(deps: BuildHealthToolsDeps): AgentToolSpec {
  return {
    name: AGENT_HEALTH_TOOL_NAMES.fleetDoctor,
    description:
      "Run the m3l environment health checks and return each check's name, status, and detail. Takes no arguments.",
    inputSchema: NO_INPUT_SCHEMA,
    describeAction: (): Core.M3LAgentAction => fleetAction("doctor"),
    execute: async (): Promise<AgentToolExecution> => {
      const report = await deps.surface.doctor();
      deps.observations.recordDoctor(report);
      return jsonExecution(report, 0);
    },
  };
}

/** Builds the `script_inspect` spec. */
function scriptInspectSpec(deps: BuildHealthToolsDeps): AgentToolSpec {
  return {
    name: AGENT_HEALTH_TOOL_NAMES.scriptInspect,
    description:
      "Describe one script's declared configuration parameters: name, type, whether it is required, and which operations need it.",
    inputSchema: SCRIPT_NAME_SCHEMA,
    describeAction: (input: unknown): Core.M3LAgentAction =>
      scriptAction(readScriptName(input), "inspect"),
    execute: async (input: unknown): Promise<AgentToolExecution> => {
      // Re-read rather than thread the name down from `describeAction`: the
      // gate calls the two independently, and a cached name would be a
      // second source of truth to keep in step.
      const script = readScriptName(input);
      const parameters = await deps.surface.inspect(script);
      deps.observations.recordInspection(script, parameters);
      return jsonExecution({ script, parameters }, 0);
    },
  };
}

/** Builds the `script_dry_run` spec. */
function scriptDryRunSpec(deps: BuildHealthToolsDeps): AgentToolSpec {
  return {
    name: AGENT_HEALTH_TOOL_NAMES.scriptDryRun,
    description:
      "Run one script's --dry-run probe and return its run envelope: exit code, outcome, and duration. Never mutates anything.",
    inputSchema: SCRIPT_NAME_SCHEMA,
    describeAction: (input: unknown): Core.M3LAgentAction =>
      scriptAction(readScriptName(input), "dry-run"),
    execute: async (input: unknown): Promise<AgentToolExecution> => {
      const script = readScriptName(input);
      const envelope = await deps.surface.dryRun(script);
      deps.observations.recordDryRun(script, envelope);
      return jsonExecution({ script, envelope }, envelope.exitCode);
    },
  };
}

/**
 * Builds the health-check tool specs — three always, plus `script_dry_run`
 * only when probes are genuinely armed.
 *
 * @param deps - See {@link BuildHealthToolsDeps}.
 * @returns The specs, in registration order. Never gated here: hand the
 *   result to `buildAgentToolRegistry`, which is the only door.
 *
 * @example
 * ```ts
 * import { buildAgentToolRegistry } from "./build-tool-registry.js";
 * import { buildHealthTools } from "./build-health-tools.js";
 * import type { BuildHealthToolsDeps } from "./build-health-tools.js";
 * import type { GateToolDeps } from "./gate-tool.js";
 *
 * declare const deps: BuildHealthToolsDeps;
 * declare const gateDeps: GateToolDeps;
 *
 * const registry = buildAgentToolRegistry(buildHealthTools(deps), gateDeps);
 * ```
 */
export function buildHealthTools(
  deps: BuildHealthToolsDeps,
): readonly AgentToolSpec[] {
  const specs: AgentToolSpec[] = [
    fleetListSpec(deps),
    fleetDoctorSpec(deps),
    scriptInspectSpec(deps),
  ];
  // Layer one of two: the destructive-adjacent tool is not merely disarmed
  // when probes are off — it is never built, so there is nothing for the
  // model to call and nothing for a later refactor to accidentally re-arm.
  if (deps.includeDryRunProbe) specs.push(scriptDryRunSpec(deps));
  return Object.freeze(specs);
}
