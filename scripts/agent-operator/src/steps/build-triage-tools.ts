/**
 * `agent-operator/steps/build-triage-tools` — the single `triage_logs`
 * single-phase tool that drives `cloudwatch-logs-analysis`'s `analyze` verb
 * through `AgentCliSurface.triageRun`'s fixed-verb argv shape.
 *
 * @remarks
 * This module never gates anything itself — see `steps/build-health-tools.ts`'s
 * module remarks for why that split is structural. What lives here is the
 * other half: the action `triage_logs` submits for judgement, and the single
 * `execute` it performs once approved.
 *
 * ## Single-phase, not two-phase
 *
 * Unlike `steps/build-etl-tools.ts`'s `run_preset`, there is no dry-run
 * rehearsal here: `analyze` — the one operation a triage preset may name, see
 * {@link TRIAGE_READ_ONLY_OPERATIONS} — is read-only by construction, so a
 * two-phase gate would buy nothing but an extra `recordInvocation()` credit
 * spent on a plan nobody needed. `execute` below takes `(input, context)`
 * with no phase argument, and calls
 * `surface.triageRun(scriptName, presetName, operatorProfile)`. `triageRun`
 * has no `options`/`mode` parameter — there is nothing to choose between when
 * a run never rehearses — but it does take a third `operatorProfile`
 * parameter, pinning the target the policy gate graded as a level-1 argv
 * passthrough (see "The `aws.profile` pin" section below). `outcome.dryRun`
 * is stamped `false` unconditionally — honest, because this run is never a
 * rehearsal.
 *
 * ## Why `triageRun`, not `run` — the pin `verifyTriagePresets` cannot supply
 *
 * An earlier revision of this module drove `triage_logs` through
 * `surface.run(scriptName, presetName, { mode: "mutate" })`, reasoning that
 * `lib/triage-presets.ts`'s `verifyTriagePresets` — which refuses any
 * allowlisted preset whose own `operation:` key names something outside
 * {@link TRIAGE_READ_ONLY_OPERATIONS} — closed the verb. That reasoning was
 * unsound: a preset's `operation:` key is `M3LScript` config precedence
 * **level 6**, and an environment variable is precedence **level 4** — one
 * level *above* it, not below — while `lib/cli-process.ts` spawns the child
 * with no `env` option, so the child inherits the operator's own environment
 * whole. An operator whose environment happened to carry `OPERATION=convert`
 * would therefore re-verb the child at runtime: `cloudwatch-logs-analysis`'s
 * one operation that writes to disk would run, while this tool's
 * `describeAction` had already reported `kind: "read-only"` and the policy
 * gate had already returned `read-only-auto-approved` — no dry-run-first
 * credit, no per-target grading, no escalation. `verifyTriagePresets`'s
 * per-preset `operation` check still matters — it screens
 * operator-authored config, catching a mistyped or malicious preset file
 * before it ever reaches the allowlist — but it is not, and was never, the
 * thing that pins the verb the child actually runs.
 *
 * `surface.triageRun` is what closes it: its trailing
 * `--operation=analyze` token is `TRIAGE_OPERATION_ARG`, a module constant
 * in `lib/cli-surface.ts` appended as a child passthrough argument — argv
 * position, config precedence **level 1**, above both the preset file and
 * the environment. Nothing later in `M3LScript.loadConfig`'s resolution
 * order can move it, and there is no environment variable that binds above
 * argv. `triageRun` also has no `options`/`mode` parameter at all — `run`'s
 * runtime-narrowed `mode` exists so a caller can choose between probing and
 * committing, but a triage run never rehearses, so giving this method a
 * `mode` would only add a second caller-influenced value for no benefit;
 * omitting the parameter is strictly safer than a runtime-narrowed one,
 * because there is no bag left for a cast from model-supplied JSON to land
 * in, and so no near-miss-narrowing failure mode to guard against in the
 * first place.
 *
 * ## The `aws.profile` pin — closing PR #1081's Should-fix 1
 *
 * The same precedence gap `triageRun`'s fixed verb closed also applied to
 * the TARGET: a triage preset is refused if it declares its own
 * `aws.profile` (see `lib/triage-presets.ts`'s own remarks), so the spawned
 * child otherwise resolved its `aws.profile` from the inherited environment
 * (config precedence level 4) — independently of the operator's own profile,
 * which resolves through the PARENT's full CLI (level 1) and config-file
 * (levels 2-3) precedence. The policy gate grades the parent's value; a
 * child that reads a different one is a confidentiality bypass, not merely a
 * verb mismatch (read-only, so not a mutation bypass, but still a bypass of
 * `sensitive-target-escalated`). `execute` closes it exactly the way it
 * closed the verb: `operatorProfile` — the SAME local this function's
 * `describeAction` sibling stamped into the judged action's `target.profile`
 * — is passed as `triageRun`'s third argument, which pins it as a level-1
 * `--aws.profile=` argv passthrough token. See `lib/cli-surface.ts`'s module
 * header for why interpolating this operator-supplied value does not widen
 * what a MODEL can influence.
 *
 * ## The script pin is what makes `describeAction`'s `read-only` claim sound
 *
 * `describeAction` below always answers `kind: "read-only"`. That claim is
 * only true for the one script whose read-only verb set this module knows —
 * nothing in `describeAction` or `execute` reads the target script's actual
 * declared operation, so nothing here would notice if `deps.scriptName` named
 * a mutating script instead (e.g. `json-etl`). `buildTriageTools` therefore
 * refuses to construct the tool at all — throwing `M3LAgentOperatorCliError`
 * coded `ERR_AGENT_OPERATOR_CONFIG` — unless `deps.scriptName` is exactly
 * {@link TRIAGE_TARGET_SCRIPT}. Without that pin, a preset for a mutating
 * script reaching this tool would run an arbitrary verb on it, gated only by
 * this module's blanket `read-only` claim. The pin runs once, at build time;
 * `verifyTriagePresets` runs once, when `deps.presetAllowlist` is minted; and
 * `triageRun`'s fixed token is checked never, at call time — it is simply the
 * one thing the child process itself cannot be argued into overriding.
 *
 * ## No `scriptDeclaresAwsProfile` dependency
 *
 * `build-etl-tools.ts`'s `buildEtlTools` refuses any target script that
 * declares its own `aws.profile` parameter, because the operator's own
 * profile would then be judging a different account than the one actually
 * targeted. `cloudwatch-logs-analysis` legitimately declares `aws.profile` —
 * that parameter is precisely *why* `buildEtlTools`'s refusal excludes it,
 * and precisely why this module needs its own builder. The `boolean`
 * `scriptDeclaresAwsProfile` polarity that guard rests on has no counterpart
 * here: {@link VerifiedTriagePresets} replaces it. That brand is minted only
 * by `verifyTriagePresets`, whose six ordered checks refuse an empty
 * allowlist, a containment escape, a non-`.yaml`/`.yml` extension, an own
 * `extends` key, an own `aws.profile` key (inert or misleading under the
 * operator's own profile — see that module's remarks), and an
 * absent/non-string/non-read-only `operation` key naming anything outside
 * {@link TRIAGE_READ_ONLY_OPERATIONS}. Requiring the branded type as
 * this module's `presetAllowlist` field turns "the caller forgot to verify
 * the presets" into a compile error rather than a boolean a caller could
 * simply pass `true`/`false` for without having earned it.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

import type { AgentCliSurface } from "../lib/cli-surface.js";
import type { AgentOperatorScriptName } from "../lib/cli-names.js";
import { M3LAgentOperatorCliError } from "../lib/errors.js";
import { assertAllowedPresetName } from "../lib/preset-names.js";
import type { VerifiedTriagePresets } from "../lib/triage-presets.js";
import type { AgentToolExecution, AgentToolSpec } from "./gate-tool.js";

/**
 * The one tool name this module registers, frozen. Exported so the prompt
 * builder and the tests name the same string.
 *
 * Annotated rather than `as const satisfies …`: `tsconfig.build.json` sets
 * `isolatedDeclarations`, which rejects an exported `satisfies` expression.
 */
export const AGENT_TRIAGE_TOOL_NAMES: {
  readonly triageLogs: "triage_logs";
} = Object.freeze({
  triageLogs: "triage_logs",
});

/**
 * The one script `buildTriageTools` may target. `describeAction`'s
 * `kind: "read-only"` claim is sound only for this script's read-only verb
 * set — see the module remarks' "the script pin" section for why
 * `buildTriageTools` refuses every other `scriptName`.
 */
export const TRIAGE_TARGET_SCRIPT = "cloudwatch-logs-analysis";

/** The JSON Schema `triage_logs` declares: an object with one required string. */
const TRIAGE_LOGS_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  properties: {
    presetName: {
      type: "string",
      description: "A key of the operator-declared triage preset allowlist.",
    },
  },
  required: ["presetName"],
  additionalProperties: false,
});

/** Dependencies {@link buildTriageTools} needs to build the `triage_logs` spec. */
export interface BuildTriageToolsDeps {
  /**
   * The typed `m3l` CLI adapter `execute` drives via `surface.triageRun`, not
   * `surface.run` — `triageRun` appends the fixed `--operation=analyze`
   * passthrough token, which is what pins the child's verb at config
   * precedence level 1, above both the inherited environment (level 4) and
   * the preset's own `operation:` key (level 6). See the module remarks'
   * "why `triageRun`, not `run`" section for the full argument.
   */
  readonly surface: AgentCliSurface;
  /**
   * The target script's branded name — operator-declared, NEVER
   * model-supplied. Minted once by `assertAllowedScriptName` and threaded in
   * here, never re-derived from tool input. `buildTriageTools` refuses to
   * build anything unless this is exactly {@link TRIAGE_TARGET_SCRIPT}.
   */
  readonly scriptName: AgentOperatorScriptName;
  /**
   * The operator's own resolved `aws.profile`, stamped onto every judged
   * action's `target`. See the module remarks for why this is the only
   * target grade — `cloudwatch-logs-analysis`'s own `aws.profile` is never
   * compared against it.
   */
  readonly operatorProfile: string;
  /**
   * The verified `preset name -> workspace-relative preset path` map, minted
   * exclusively by `verifyTriagePresets`. Holding this brand is what proves
   * every entry already cleared the six triage-preset refusals — see the
   * module remarks' "no `scriptDeclaresAwsProfile` dependency" section.
   */
  readonly presetAllowlist: VerifiedTriagePresets;
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
  presetAllowlist: VerifiedTriagePresets,
): string {
  // Reject an array outright, before the shape check and before the
  // allowlist check ever run: `typeof [] === "object"`, so an array would
  // otherwise reach both checks exactly like a plain object. An array is not
  // the plain-object shape `TRIAGE_LOGS_SCHEMA` declares, and it is the one
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
  // into config — and that `verifyTriagePresets` already cleared — can name a
  // real preset.
  if (!presetAllowlist.has(presetName)) {
    throw new M3LAgentOperatorCliError(
      "the preset name is not a member of the configured preset allowlist",
      "ERR_AGENT_OPERATOR_PRESET",
    );
  }
  return presetName;
}

/**
 * The subset of {@link BuildTriageToolsDeps} `triageLogsSpec` needs, captured
 * once as locals by {@link buildTriageTools} rather than threaded through as
 * the `deps` object itself — mirrors `build-etl-tools.ts`'s
 * `RunPresetSpecLocals`. Capturing locals before the refusal check runs means
 * the refusal and every judged `target` this tool will ever report come from
 * the SAME point-in-time snapshot of `deps`, and a caller mutating `deps`
 * after `buildTriageTools` has returned cannot retroactively change either.
 */
interface TriageLogsSpecLocals {
  readonly surface: AgentCliSurface;
  readonly scriptName: AgentOperatorScriptName;
  readonly operatorProfile: string;
  readonly presetAllowlist: VerifiedTriagePresets;
}

/** Builds the `triage_logs` spec over `locals`. */
function triageLogsSpec(locals: TriageLogsSpecLocals): AgentToolSpec {
  const { surface, scriptName, operatorProfile, presetAllowlist } = locals;
  return {
    name: AGENT_TRIAGE_TOOL_NAMES.triageLogs,
    description:
      "Run one allowlisted, read-only CloudWatch Logs triage preset.",
    inputSchema: TRIAGE_LOGS_SCHEMA,
    describeAction: (input: unknown): Core.M3LAgentAction => {
      readPresetName(input, presetAllowlist);
      return {
        script: scriptName,
        operation: "run",
        // NEVER derived from input: a model that could choose `kind` could
        // choose its own autonomy tier. This tool exists only because the
        // script pin below already proved `scriptName` is
        // `TRIAGE_TARGET_SCRIPT` and every allowlisted preset's own
        // `operation` is a member of `TRIAGE_READ_ONLY_OPERATIONS`.
        kind: "read-only",
        target: { profile: operatorProfile },
        parameterNames: ["presetName"],
      };
    },
    execute: async (input: unknown, _context): Promise<AgentToolExecution> => {
      // Re-read rather than thread the name down from `describeAction`: the
      // gate calls the two independently, and a cached name would be a
      // second source of truth to keep in step.
      const presetName = readPresetName(input, presetAllowlist);
      // `operatorProfile` is the SAME local `triageLogsSpec` captured from
      // `locals` above — never a fresh read off `deps` here — so the value
      // this call pins as a level-1 `--aws.profile=` passthrough argument is
      // provably the one `describeAction` already stamped into the judged
      // action's `target.profile`. Two independent lookups of "the
      // operator's profile" is exactly the divergence class this programme
      // has already fixed twice before (the phase-divergence input snapshot,
      // and the reported-outcome snapshot before it) — closing PR #1081's
      // Should-fix 1 the same way: `triageRun`'s fixed `--operation=analyze`
      // passthrough token pins the verb — see the module remarks' "why
      // triageRun, not run" section for why `verifyTriagePresets`'s own
      // `operation` check cannot substitute for it — and its
      // `--aws.profile=` token pins the target the SAME policy gate graded.
      // There is no dry-run phase for this tool either: see the module
      // remarks' "single-phase, not two-phase" section.
      const envelope = await surface.triageRun(
        scriptName,
        presetName,
        operatorProfile,
      );
      return {
        content: [{ type: "json", json: envelope }],
        outcome: {
          // Fixed `false`, never derived: this run is never a rehearsal, so
          // reporting anything else would be dishonest.
          dryRun: false,
          exitCode: envelope.exitCode,
        },
      };
    },
  };
}

/**
 * Builds the triage tool specs: exactly one, `triage_logs`, or throws when
 * `deps.scriptName` is not the one script this module's read-only claim is
 * sound for.
 *
 * @param deps - See {@link BuildTriageToolsDeps}.
 * @returns The one `triage_logs` spec, in a frozen array. Never gated here:
 *   hand the result to `gateToolSpec` (via `buildAgentToolRegistry`), the
 *   only door.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `deps.scriptName` is anything other than {@link TRIAGE_TARGET_SCRIPT}
 *   — see the module remarks' "the script pin" section for why no per-call
 *   check can substitute for this refusal.
 *
 * @example
 * ```ts
 * import { buildTriageTools } from "./build-triage-tools.js";
 * import type { BuildTriageToolsDeps } from "./build-triage-tools.js";
 *
 * declare const deps: BuildTriageToolsDeps;
 *
 * const specs = buildTriageTools(deps);
 * ```
 */
export function buildTriageTools(
  deps: BuildTriageToolsDeps,
): readonly AgentToolSpec[] {
  // Captured as locals immediately, before the refusal check runs, so that
  // both the refusal itself and every judged `target` this tool will ever
  // report are decided from the SAME point-in-time snapshot of `deps` — a
  // caller that mutates `deps` after this function returns cannot
  // retroactively change either.
  const { surface, scriptName, operatorProfile, presetAllowlist } = deps;

  if (scriptName !== TRIAGE_TARGET_SCRIPT) {
    // Fixed, non-interpolated message: the operator can see which script
    // triggered this from their own build wiring, not from this text — the
    // rejected name is never echoed in the message or the context.
    throw new M3LAgentOperatorCliError(
      "a triage tool can only be built for the one script this module's read-only claim covers",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return Object.freeze([
    triageLogsSpec({ surface, scriptName, operatorProfile, presetAllowlist }),
  ]);
}
