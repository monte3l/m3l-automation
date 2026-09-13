/**
 * `agent-operator/steps/build-etl-tools` — the single `run_preset` two-phase
 * tool an ETL-shaped fleet script (e.g. `json-etl`) exposes over
 * `AgentCliSurface.run`, gated through {@link gateTwoPhaseToolSpec}.
 *
 * @remarks
 * This module never gates anything itself — see `steps/build-health-tools.ts`'s
 * module remarks for why that split is structural. What lives here is the
 * other half: the action `run_preset` submits for judgement, and the two-phase
 * work it performs once approved.
 *
 * ## The trust boundary has three ordered checks, not one
 *
 * A model-supplied `presetName` is checked for SHAPE
 * (`assertAllowedPresetName` — a character-class check copied **verbatim**
 * from the upstream preset store, plus a length cap that is this repo's own
 * tightening and has no upstream counterpart; see `lib/preset-names.ts`'s
 * `AGENT_OPERATOR_PRESET_NAME_RE` and `AGENT_OPERATOR_PRESET_NAME_MAX_LENGTH`
 * remarks) and then for MEMBERSHIP in `deps.presetAllowlist` (the
 * load-bearing layer: the shape check alone accepts `-h` and `123`, so only
 * an entry an operator wrote into config can name a real preset). Both run,
 * in that order, and both reject before anything is authorized — mirroring
 * the argument `cli-surface.ts` already makes for its own `presetAllowlist`
 * gate.
 *
 * ## Fails closed at BUILD time, not per call
 *
 * `describeAction`'s judged `target` is the OPERATOR's own resolved
 * `aws.profile` — a coarse "is this agent running in a prod context" grade.
 * That grade is honest only for a target script with no AWS target of its
 * own: `json-etl` declares no `aws.profile` parameter, so there is nothing
 * else to grade against. The moment a target script declares its own
 * `aws.profile`, the operator's profile would be judging a DIFFERENT account
 * than the one actually being mutated, and no per-call check can fix that —
 * the judged field itself would be lying. `buildEtlTools` therefore refuses
 * to construct the tool at all when `deps.scriptDeclaresAwsProfile` is
 * `true`: no spec is ever registered, so no call can reach a mis-graded
 * authorization. There is deliberately no per-call cross-check against the
 * preset file's own `aws.profile` either — `M3LScriptPresetLoader` would
 * reject any preset that tried to declare one for a script with no such
 * parameter (`M3LPresetUnknownKeysError`), and a raw YAML read would miss a
 * value inherited through `extends` anyway (only the preset loader follows
 * it). The build-time refusal is the only check that can be sound.
 *
 * ## The outcome's `dryRun` must mirror the phase, not a hardcoded value
 *
 * `build-health-tools.ts`'s `jsonExecution` helper hardcodes
 * `outcome.dryRun: false` for its four single-phase, read-only tools. Reusing
 * it here would corrupt the `dryRunFirst` credit `gateTwoPhaseToolSpec`
 * mints from a dry-run phase's REPORTED outcome — not a cosmetic audit-log
 * detail, but the authorization path itself. `execute` below builds its own
 * `AgentToolExecution` inline, stamping `outcome.dryRun` from `phase.dryRun`.
 *
 * @packageDocumentation
 */

import type { Core } from "@monte3l/m3l-common";

import type { AgentCliSurface } from "../lib/cli-surface.js";
import type { AgentOperatorScriptName } from "../lib/cli-names.js";
import { M3LAgentOperatorCliError } from "../lib/errors.js";
import { assertAllowedPresetName } from "../lib/preset-names.js";
import type { AgentToolExecution, TwoPhaseAgentToolSpec } from "./gate-tool.js";

/**
 * The one tool name this module registers, frozen. Exported so the prompt
 * builder and the tests name the same string.
 *
 * Annotated rather than `as const satisfies …`: `tsconfig.build.json` sets
 * `isolatedDeclarations`, which rejects an exported `satisfies` expression.
 */
export const AGENT_ETL_TOOL_NAMES: {
  readonly runPreset: "run_preset";
} = Object.freeze({
  runPreset: "run_preset",
});

/** The JSON Schema `run_preset` declares: an object with one required string. */
const RUN_PRESET_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  properties: {
    presetName: {
      type: "string",
      description: "A key of the operator-declared preset allowlist.",
    },
  },
  required: ["presetName"],
  additionalProperties: false,
});

/** Dependencies {@link buildEtlTools} needs to build the `run_preset` spec. */
export interface BuildEtlToolsDeps {
  /** The typed `m3l` CLI adapter `execute` drives via `surface.run`. */
  readonly surface: AgentCliSurface;
  /**
   * The target script's branded name — operator-declared, NEVER
   * model-supplied. Minted once by `assertAllowedScriptName` and threaded in
   * here, never re-derived from tool input.
   */
  readonly scriptName: AgentOperatorScriptName;
  /**
   * The operator's own resolved `aws.profile`, stamped onto every judged
   * action's `target`. See the module remarks for why this grade is only
   * honest when {@link BuildEtlToolsDeps.scriptDeclaresAwsProfile} is `false`.
   */
  readonly operatorProfile: string;
  /**
   * The closed `preset name -> workspace-relative preset path` map, shared
   * with the `AgentCliSurface` this tool's `execute` drives. Membership here
   * — not the preset-name shape check alone — is what makes a model-supplied
   * preset name safe.
   */
  readonly presetAllowlist: ReadonlyMap<string, string>;
  /**
   * `true` when the target script declares its own `aws.profile`
   * configuration parameter. `buildEtlTools` throws rather than build the
   * tool when this is `true` — see the module remarks' "fails closed at
   * BUILD time" section.
   */
  readonly scriptDeclaresAwsProfile: boolean;
}

/**
 * Extracts the single `presetName` a model-supplied `input` may carry, or
 * throws before anything is authorized.
 *
 * @remarks
 * Runs the shape check ({@link assertAllowedPresetName}) and then the
 * membership check against `presetAllowlist`, in that order — both reject
 * before anything is authorized. The thrown messages are fixed and never
 * echo `presetName`: it is model-supplied, and a rejected value is exactly
 * the thing least safe to quote back.
 *
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_PRESET`
 *   when `input` is an array, is not a plain object, does not carry its own
 *   string `presetName`, or when the shape check or the membership check
 *   rejects the name.
 */
function readPresetName(
  input: unknown,
  presetAllowlist: ReadonlyMap<string, string>,
): string {
  // Reject an array outright, before the shape check and before the
  // allowlist check ever run: `typeof [] === "object"`, so an array would
  // otherwise reach both checks exactly like a plain object. An array is not
  // the plain-object shape `RUN_PRESET_SCHEMA` declares, and it is the one
  // shape `snapshotInputOrRefuse` (gate-tool.ts) deliberately leaves
  // un-snapshotted — so it must never be allowed to reach the allowlist
  // check, where a diverging own `presetName` getter could pass here and
  // return something else to `execute`.
  if (Array.isArray(input)) {
    throw new M3LAgentOperatorCliError(
      "the tool input must be an object carrying a 'presetName'",
      "ERR_AGENT_OPERATOR_PRESET",
    );
  }
  if (typeof input !== "object" || input === null) {
    throw new M3LAgentOperatorCliError(
      "the tool input must be an object carrying a 'presetName'",
      "ERR_AGENT_OPERATOR_PRESET",
    );
  }
  // `Object.hasOwn`, never a bracket or dot read: a model can send
  // `{"__proto__": {"presetName": "…"}}`, and an inherited read would answer
  // from the prototype chain for a key this input never declared.
  if (!Object.hasOwn(input, "presetName")) {
    throw new M3LAgentOperatorCliError(
      "the tool input must carry its own 'presetName' property",
      "ERR_AGENT_OPERATOR_PRESET",
    );
  }
  const raw = (input as Record<string, unknown>)["presetName"];
  if (typeof raw !== "string") {
    throw new M3LAgentOperatorCliError(
      "the tool input's 'presetName' must be a string",
      "ERR_AGENT_OPERATOR_PRESET",
    );
  }
  const presetName = assertAllowedPresetName(raw);
  // Membership is the load-bearing layer, not the shape check above: the
  // shape check alone accepts `-h` and `123`. Only an entry an operator wrote
  // into config can name a real preset.
  if (!presetAllowlist.has(presetName)) {
    throw new M3LAgentOperatorCliError(
      "the preset name is not a member of the configured preset allowlist",
      "ERR_AGENT_OPERATOR_PRESET",
    );
  }
  return presetName;
}

/**
 * The subset of {@link BuildEtlToolsDeps} `runPresetSpec` needs, captured
 * once as locals by {@link buildEtlTools} rather than threaded through as the
 * `deps` object itself. `scriptDeclaresAwsProfile` is deliberately excluded:
 * it is only ever consulted once, at build time, before this spec exists.
 */
interface RunPresetSpecLocals {
  readonly surface: AgentCliSurface;
  readonly scriptName: AgentOperatorScriptName;
  readonly operatorProfile: string;
  readonly presetAllowlist: ReadonlyMap<string, string>;
}

/**
 * Builds the `run_preset` spec over `locals`.
 *
 * @remarks
 * `locals` is destructured by {@link buildEtlTools} out of its `deps`
 * parameter before this function is ever called, so `describeAction` and
 * `execute` below close over plain local bindings — never over the `deps`
 * object — and cannot observe a caller mutating a field on `deps` (e.g.
 * `operatorProfile`) after `buildEtlTools` has already returned. The judged
 * `target` a tool grades against must be exactly as point-in-time as the
 * build-time refusal that decided this tool may exist at all.
 */
function runPresetSpec(locals: RunPresetSpecLocals): TwoPhaseAgentToolSpec {
  const { surface, scriptName, operatorProfile, presetAllowlist } = locals;
  return {
    name: AGENT_ETL_TOOL_NAMES.runPreset,
    description:
      "Run one allowlisted ETL preset, dry run first. The mutating phase only runs if the dry run cleared the gate.",
    inputSchema: RUN_PRESET_SCHEMA,
    phases: "dry-run-then-mutate",
    describeAction: (input: unknown): Core.M3LAgentAction => {
      readPresetName(input, presetAllowlist);
      return {
        script: scriptName,
        operation: "run",
        // NEVER derived from input: a model that could choose `kind` could
        // choose its own autonomy tier.
        kind: "mutating",
        target: { profile: operatorProfile },
        parameterNames: ["presetName"],
      };
    },
    execute: async (
      input: unknown,
      _context,
      phase,
    ): Promise<AgentToolExecution> => {
      // Re-read rather than thread the name down from `describeAction`: the
      // gate calls the two independently, and a cached name would be a
      // second source of truth to keep in step.
      const presetName = readPresetName(input, presetAllowlist);
      const envelope = await surface.run(scriptName, presetName, {
        mode: phase.dryRun ? "dry-run" : "mutate",
      });
      return {
        content: [{ type: "json", json: envelope }],
        outcome: {
          // Stamped from `phase.dryRun`, never hardcoded: `gateTwoPhaseToolSpec`
          // mints the `dryRunFirst` credit from THIS reported outcome, so an
          // outcome that misreports the phase would corrupt the
          // authorization path, not just the audit log.
          dryRun: phase.dryRun,
          exitCode: envelope.exitCode,
        },
      };
    },
  };
}

/**
 * Builds the ETL tool specs: exactly one, `run_preset`, or throws when the
 * target script cannot be honestly graded by the operator's own profile.
 *
 * @param deps - See {@link BuildEtlToolsDeps}.
 * @returns The one `run_preset` spec, in a frozen array. Never gated here:
 *   hand the result to `gateTwoPhaseToolSpec` (via `buildAgentToolRegistry`),
 *   the only door.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `deps.scriptDeclaresAwsProfile` is anything other than the literal
 *   `false` — see the module remarks' "fails closed at BUILD time" section
 *   for why no per-call check can substitute for this refusal.
 *
 * @example
 * ```ts
 * import { buildEtlTools } from "./build-etl-tools.js";
 * import type { BuildEtlToolsDeps } from "./build-etl-tools.js";
 *
 * declare const deps: BuildEtlToolsDeps;
 *
 * const specs = buildEtlTools(deps);
 * ```
 */
export function buildEtlTools(
  deps: BuildEtlToolsDeps,
): readonly TwoPhaseAgentToolSpec[] {
  // Captured as locals immediately, before the refusal check runs, so that
  // both the refusal itself and every judged `target` this tool will ever
  // report are decided from the SAME point-in-time snapshot of `deps` — a
  // caller that mutates `deps` (or widens `presetAllowlist`) after this
  // function returns cannot retroactively change either.
  const { surface, scriptName, operatorProfile, presetAllowlist } = deps;

  // Guard polarity is deliberately an opt-OUT requiring the literal `false`,
  // the mirror image of `decideAgentAction`'s `allOperations !== true`
  // opt-IN (packages/m3l-common/src/internal/agent/decide.ts). This value can
  // arrive from untyped JSON config, so `undefined`, `null`, `0`, `""`, and
  // an entirely absent key must all be treated exactly like `true`: this
  // refusal is the ONLY thing standing between a script with its own
  // `aws.profile` and a tool whose judged `target` would grade the wrong
  // account. A truthiness read (`if (deps.scriptDeclaresAwsProfile)`) fails
  // OPEN on every one of those values — the failure direction here is toward
  // registering a mutating tool, so the guard must fail CLOSED on anything
  // that is not the literal `false`.
  if (deps.scriptDeclaresAwsProfile !== false) {
    // Fixed, non-interpolated message: the operator can see which script
    // triggered this from their own build wiring, not from this text.
    throw new M3LAgentOperatorCliError(
      "an ETL tool cannot be built for a script that declares its own aws.profile",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return Object.freeze([
    runPresetSpec({ surface, scriptName, operatorProfile, presetAllowlist }),
  ]);
}
