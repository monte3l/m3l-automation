/**
 * `lib/cli-surface` — the typed adapter over `lib/cli-process.ts`. This is
 * the **only** consumer of `runCliProcess`; it owns the argv table, the
 * per-method exit-code acceptance policy, and all error minting for the six
 * agent-facing CLI operations (`list`, `doctor`, `inspect`, `dryRun`, `run`,
 * `triageRun`).
 *
 * Argument-injection defence, layered in the order each layer is applied:
 *
 * 1. `shell: false` plus an argv array (`lib/cli-process.ts`) — with no
 *    shell, there is no command line for a value to inject into.
 * 2. `lib/cli-names.ts`'s anchored, ReDoS-safe
 *    `AGENT_OPERATOR_SCRIPT_NAME_RE` — a name cannot begin with `-` and
 *    admits no shell metacharacter. `lib/preset-names.ts`'s equally
 *    anchored `AGENT_OPERATOR_PRESET_NAME_RE` does the same character-class
 *    job for a preset name, but — unlike the script pattern — imposes no
 *    structure on it, which is why layer 3 carries the weight there.
 * 3. Membership in the fleet's `m3l list` set (enforced by the real CLI
 *    rejecting an unknown script) / the caller-supplied `dryRunAllowlist`
 *    (enforced here, before `dryRun` ever spawns) / the operator-declared
 *    `presetAllowlist` (enforced here, before `run` ever spawns). Membership
 *    is the load-bearing layer for a preset name: the pattern alone accepts
 *    `--json`, `-h` and `123`, so only an entry an operator wrote into
 *    config can turn a name into a path.
 * 4. The V6 policy gate (a later slice — not yet implemented).
 * 5. Fixed argv positions built here from a closed `switch` over a
 *    discriminated `CliOperation` union — never string concatenation.
 *
 * Net effect: the MODEL supplies exactly two values that can influence a
 * token across the whole tool surface — a script name and, for `run` and
 * `triageRun` alike, a preset *name*. (`run`'s `mode` is a third
 * caller-supplied value, but it is never interpolated: it selects whether a
 * FIXED `--dry-run` token is appended, and it is narrowed to one of two
 * literals at runtime by `assertRunMode` before argv is built — see
 * {@link AgentCliRunOptions}. `triageRun` has no such third value: see its own
 * TSDoc for why a caller-selectable mode would be strictly less safe here,
 * not merely unneeded.) `triageRun`'s trailing `--operation=analyze` token
 * supplies **no** model-influenced value at all — it is a literal written
 * into a closed `switch` arm, the same way every other fixed token in this
 * table is, and stating that plainly is the point of this section: the
 * defect this method closes was a verb that looked fixed (the preset file's
 * own `operation:` key) but was actually overridable by an inherited
 * environment variable one precedence level below it. A `TRIAGE_OPERATION_ARG`
 * module constant, spawned as a child passthrough argument, binds at
 * precedence level 1 — above both the preset file (level 6) and environment
 * (level 4) — so nothing later in `M3LScript.loadConfig`'s resolution order
 * can move it. It never
 * supplies a path: `run`'s `--preset=` token is looked up from the
 * operator's own `presetAllowlist` and anchored to `workspaceRoot` here, so
 * the model names a key and this module resolves the file.
 *
 * `triageRun`'s trailing `--aws.profile=<value>` token is the one departure
 * from "no model-influenced value is interpolated": it DOES interpolate a
 * caller-supplied `operatorProfile` string, closing the same precedence gap
 * as `TRIAGE_OPERATION_ARG` (a preset is forbidden from declaring its own
 * `aws.profile`, so the spawned child would otherwise resolve one from the
 * inherited environment — level 4 — independently of the operator's own
 * profile, which resolves through the PARENT's full CLI (level 1) and
 * config-file (levels 2-3) precedence; a policy grading the parent's value
 * while the child reads a different one is a confidentiality bypass, not
 * merely a verb mismatch). What keeps the "the model supplies exactly two
 * values" claim above true despite this interpolation is WHO supplies it:
 * `operatorProfile` is read from agent-operator's own validated config by
 * `steps/build-triage-tools.ts` before any tool call reaches this module,
 * never derived from model-supplied tool input — it is a third
 * CALLER-supplied value, not a third MODEL-supplied one. Interpolating it is
 * exactly as safe as `run`'s `--preset=` token: `shell: false` plus an argv
 * array means no spawned command line exists for any value, however chosen,
 * to inject into, and an `=` embedded in the profile is harmless because the
 * child's own `parseArgv` (`internal/config/parseArgv`) splits on the FIRST
 * `=` only — the whole value binds, never a truncation.
 *
 * Distinct nominal brands hold the script/preset chain together, and each one
 * occupies a real
 * parameter or field position rather than sitting decoratively at its mint
 * site: `AgentOperatorScriptName` (minted by `assertAllowedScriptName`, and
 * the type of every `scriptName` field on the argv union),
 * `AgentOperatorPresetName` (minted by `assertAllowedPresetName`, and the
 * declared parameter type of `resolveAllowedPresetPath`), and
 * `AgentOperatorPresetPath` (minted ONLY by `resolveAllowedPresetPath`,
 * after the membership, workspace-root and containment checks have all
 * passed, and the declared type of the `run` operation's `presetPath`
 * field). The compiler therefore enforces the whole chain — name check,
 * then resolver, then argv. An unvalidated `string` genuinely is a compile
 * error at the argv boundary, as is a hand-built `path.join` that skips the
 * resolver; and because each brand's `unique symbol` is its own type, a name
 * cannot be passed where a path is expected either.
 *
 * @packageDocumentation
 */

import path from "node:path";

import { Core } from "@monte3l/m3l-common";

import {
  parseDoctorChecks,
  parseFlowEnvelope,
  parseJsonText,
  parseListRows,
  parseParamDescriptors,
  parseRunEnvelope,
  type AgentOperatorDoctorCheck,
  type AgentOperatorFlowEnvelope,
  type AgentOperatorListRow,
  type AgentOperatorParamDescriptor,
  type AgentOperatorRunEnvelope,
  type ParseResult,
} from "./cli-envelopes.js";
import {
  assertAllowedScriptName,
  type AgentOperatorScriptName,
} from "./cli-names.js";
import {
  runCliProcess,
  type CliRunDisposition,
  type CliRunResult,
  type CliTeardownScope,
} from "./cli-process.js";
import { M3LAgentOperatorCliError } from "./errors.js";
import {
  assertAllowedFlowName,
  type AgentOperatorFlowName,
} from "./flow-names.js";
import {
  projectDoctorReport,
  projectFlowEnvelope,
  projectListRow,
  projectParamDescriptor,
  projectRunEnvelope,
  type AgentOperatorProjectedDoctorReport,
  type AgentOperatorProjectedFlowEnvelope,
  type AgentOperatorProjectedListRow,
  type AgentOperatorProjectedParamDescriptor,
  type AgentOperatorProjectedRunEnvelope,
  type AgentOperatorProjectionOptions,
} from "./model-safety.js";
import {
  AGENT_OPERATOR_PATH_SEPARATOR_RE,
  AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX,
  assertAllowedPresetName,
  isDeclarablePresetPath,
  type AgentOperatorPresetName,
  type AgentOperatorPresetPath,
} from "./preset-names.js";

// ---------------------------------------------------------------------------
// Fixed, non-interpolated model-facing rejection messages. Every reachable
// rejection this module raises uses exactly one of the fixed strings below,
// verbatim — never a
// script name, a preset name, raw stdout, a filesystem path, or a spawn
// `error.message`.
// ---------------------------------------------------------------------------

const SCRIPT_NAME_REJECTION_MESSAGE =
  "the script name did not pass this tool's allowed-name check";
const CLI_SPAWN_REJECTION_MESSAGE =
  "the CLI process could not be run to completion";
const CLI_OUTPUT_REJECTION_MESSAGE =
  "the CLI exited with an unacceptable status or produced output that could not be parsed";
// Its own string rather than a reuse of the script-name one: the two name a
// different argument, and an operator reading a log needs to know which.
const PRESET_NAME_REJECTION_MESSAGE =
  "the preset name did not pass this tool's allowed-name check";
// Its own string too: a caller that declared no usable `mode` never got as
// far as naming a preset, so reusing the preset message would send an
// operator to audit `presetAllowlist` over a malformed options bag.
const RUN_MODE_REJECTION_MESSAGE =
  "the run mode must be declared as exactly 'dry-run' or 'mutate'";
// Its own string too: an empty `operatorProfile` is a caller-supplied-value
// failure exactly like an unrecognised `mode` (same `ERR_AGENT_OPERATOR_CONFIG`
// code — "the caller supplied a value this seam does not accept" — rather
// than an eleventh code for the same class of failure), but names a
// different argument; reusing RUN_MODE_REJECTION_MESSAGE would send an
// operator auditing the wrong config key.
const OPERATOR_PROFILE_REJECTION_MESSAGE =
  "the operator profile must be a non-empty string";

/**
 * The fixed passthrough argument `triageRun` appends after its `--preset=`
 * token. Reasoning is on the module's own layered-defence section: a preset
 * file's declared `operation:` key resolves at `M3LScript.loadConfig`
 * precedence level 6, and the operator's own environment (the config key
 * `operation` and its derived env var name `OPERATION` both bind, per
 * `M3LEnvironmentConfigProvider.getRawValue`) resolves at level 4 — with
 * `lib/cli-process.ts` spawning the child with no `env` option, an inherited
 * `OPERATION=convert` silently overrode the preset's declared verb while
 * `triage-logs`'s action was graded `read-only-auto-approved`. A CLI
 * passthrough argument binds at level 1, above both, so this token — a
 * literal in a closed `switch`, never templated from a caller value —
 * pins the verb where nothing later in the resolution order can move it.
 *
 * Named `_ARG`, not `_TOKEN`: gitleaks' `generic-api-key` rule flags a
 * keyword (`TOKEN` among them) followed by `=` and a 10+ character value
 * drawn from `[\w.=-]`, which this literal is. Keep the "argv token"
 * meaning in prose; keep "token" out of adjacency with `=`.
 */
const TRIAGE_OPERATION_ARG = "--operation=analyze";

/**
 * The mode a {@link AgentCliSurface.run} call must declare. There is no
 * default and no optional field: `mode` is a required discriminator, so a
 * caller has to *say* `"mutate"`.
 *
 * What this type does and does not buy, stated exactly — an earlier revision
 * of this comment claimed that a required discriminator meant "neither an
 * omitted options bag nor a failed coercion from model-supplied JSON can
 * select mutation", and probing disproved both halves:
 *
 * - The literal union stops an **honest** caller, at compile time: `run(s, p)`,
 *   `run(s, p, {})` and `{ mode: "dryrun" }` written as a TypeScript object
 *   literal are all compile errors.
 * - It stops a **casting** caller from nothing at all: a bag parsed out of
 *   model-supplied JSON and cast to this type typechecks with zero errors,
 *   and every unrecognised value that reached the old
 *   `options.mode === "dry-run"` derivation was read as `"mutate"` — a typo,
 *   a case difference, a stray space or an omitted bag all selected mutation.
 * - {@link AgentCliSurface.run}'s runtime narrowing is therefore what makes
 *   the guarantee real: it accepts the two literals and rejects everything
 *   else with a coded {@link M3LAgentOperatorCliError}, so an unrecognised
 *   bag reaches argv in neither mode.
 *
 * This is the same erased-type lesson `lib/preset-names.ts`'s brands carry:
 * a type is a compile-time device with no runtime representation, so only a
 * runtime check guarantees anything about a value that arrived through a cast.
 *
 * `"dry-run"` appends the trailing `--dry-run` passthrough token after the
 * `--preset=` token; `"mutate"` omits it. Both phases of a two-phase
 * "probe, then commit" caller therefore share one signature and one options
 * type, differing by exactly one argv token.
 *
 * @example
 * ```ts
 * import type { AgentCliRunOptions } from "./cli-surface.js";
 *
 * const probe: AgentCliRunOptions = { mode: "dry-run" };
 * const commit: AgentCliRunOptions = { mode: "mutate" };
 * ```
 */
export interface AgentCliRunOptions {
  /** Whether this invocation probes (`"dry-run"`) or mutates (`"mutate"`). */
  readonly mode: "dry-run" | "mutate";
}

/**
 * The typed, model-safe adapter over the `m3l` CLI. Every method spawns the
 * CLI at most once, applies this method's exit-code acceptance policy, and
 * returns the parsed output already passed through `lib/model-safety.ts`'s
 * projections — never the raw parsed value.
 */
export interface AgentCliSurface {
  /** Runs `m3l list --json`. Only exit `0` is acceptable. */
  list(): Promise<readonly AgentOperatorProjectedListRow[]>;
  /**
   * Runs `m3l doctor --json`. Exit `{0, 1}` are both acceptable — a failing
   * health check is the answer, not an error, so `doctor --json` exiting `1`
   * must not reject this promise.
   */
  doctor(): Promise<AgentOperatorProjectedDoctorReport>;
  /**
   * Runs `m3l inspect <name> --json`. `name` is validated against the
   * allowlist before anything is spawned. Only exit `0` is acceptable.
   */
  inspect(
    scriptName: string,
  ): Promise<readonly AgentOperatorProjectedParamDescriptor[]>;
  /**
   * Runs `m3l run <name> --json -- --dry-run`. `name` must pass the
   * allowlist AND be a member of the caller-supplied `dryRunAllowlist`
   * before anything is spawned. Any exit code is acceptable — the envelope
   * carries its own `exitCode`/`outcome`.
   */
  dryRun(scriptName: string): Promise<AgentOperatorProjectedRunEnvelope>;
  /**
   * Runs `m3l run <name> --json -- --preset=<absolute path>` — the mutating
   * counterpart to {@link AgentCliSurface.dryRun}. `scriptName` must pass
   * the script allowlist; `presetName` must pass the preset-name check AND
   * be a key of the constructed `presetAllowlist`, whose stored
   * workspace-relative value is re-checked for containment and joined onto
   * the surface's absolute `workspaceRoot` to build the emitted token. Any exit code is acceptable — the envelope carries its
   * own `exitCode`/`outcome`.
   *
   * Deliberately NOT gated on `dryRunAllowlist`: that set is the per-script
   * `--dry-run` opt-in list, whereas a mutating run is gated by the V6
   * policy layer plus the preset allowlist.
   *
   * @param scriptName - The target script's name.
   * @param presetName - A key of the operator-declared `presetAllowlist`.
   * @param options - Required, and re-checked at RUNTIME: `mode` must be
   *   exactly `"dry-run"` (appends `--dry-run` after the `--preset=` token)
   *   or exactly `"mutate"` (omits it). Anything else — including an absent
   *   bag, a near-miss spelling, or a value that arrived through a cast from
   *   model-supplied JSON — rejects before argv is built rather than
   *   defaulting to mutation. See {@link AgentCliRunOptions}.
   */
  run(
    scriptName: string,
    presetName: string,
    options: AgentCliRunOptions,
  ): Promise<AgentOperatorProjectedRunEnvelope>;
  /**
   * Runs `m3l run <name> --json -- --preset=<absolute path> --operation=analyze --aws.profile=<profile>`
   * — the fixed-verb sibling of
   * {@link AgentCliSurface.run} that `agent-operator`'s `triage-logs`
   * operation drives. `scriptName` must pass the script allowlist;
   * `presetName` must pass the preset-name check AND be a key of the
   * constructed `presetAllowlist`, resolved to an absolute path exactly as
   * `run` resolves one; `operatorProfile` must be a non-empty string. Any
   * exit code is acceptable — the envelope carries its own
   * `exitCode`/`outcome`.
   *
   * Deliberately has NO `options` bag and NO `mode` parameter: `run`'s `mode`
   * exists so a caller can choose between probing and committing, and
   * {@link assertRunMode}'s own reasoning is that only a RUNTIME-narrowed
   * choice is safe against a cast from model-supplied JSON. A triage run
   * never rehearses — there is nothing to choose between — so giving this
   * method a `mode` parameter would only add a caller-influenced value for no
   * caller-facing benefit. Omitting the parameter entirely is therefore
   * strictly safer than `run`'s runtime-narrowed `mode`: there is no bag to
   * cast into, and so no near-miss narrowing failure mode to guard against in
   * the first place.
   *
   * The trailing `--operation=analyze` token is the fixed
   * `TRIAGE_OPERATION_ARG` — see the module header and that constant's own
   * TSDoc for the precedence defect this method closes. The final
   * `--aws.profile=<profile>` token closes the SAME class of precedence gap
   * for the target profile: a preset is forbidden from declaring its own
   * `aws.profile`, so without this passthrough argument the spawned child
   * would resolve one from the inherited environment (config precedence
   * level 4) independently of the operator's own profile, which the caller
   * graded through the PARENT's full CLI (level 1) and config-file (levels
   * 2-3) precedence — see the module header's own note on this token for why
   * interpolating `operatorProfile` here does not widen what the MODEL can
   * influence.
   *
   * @param scriptName - The target script's name.
   * @param presetName - A key of the operator-declared `presetAllowlist`.
   * @param operatorProfile - The operator's own resolved `aws.profile` — the
   *   SAME value the caller stamped into the judged action's `target`, never
   *   model-supplied. Rejected before anything spawns when empty.
   */
  triageRun(
    scriptName: string,
    presetName: string,
    operatorProfile: string,
  ): Promise<AgentOperatorProjectedRunEnvelope>;
  /**
   * Runs `m3l flow run <name> --json` — the flow-orchestration sibling of
   * {@link AgentCliSurface.run}. `flowName` must pass
   * `lib/flow-names.ts`'s {@link "./flow-names.js".assertAllowedFlowName}
   * (shape, then membership in the caller-supplied `flowAllowlist`) before
   * anything is spawned. Any exit code is acceptable — the envelope carries
   * its own `exitCode`/`status`.
   *
   * Unlike `run`/`triageRun`, `flowName` is never resolved to a filesystem
   * path: `m3l flow run <name>` resolves `data/config/flows/<name>.yaml`
   * itself, so there is no `--preset=` token, no `workspaceRoot` anchoring,
   * and no containment check at this boundary.
   *
   * @param flowName - The target flow's name.
   * @param options - Required, and re-checked at RUNTIME by the same
   *   {@link assertRunMode} `run` uses: `mode` must be exactly `"dry-run"`
   *   (appends `--dry-run`, forcing every step dry) or exactly `"mutate"`
   *   (omits it). See {@link AgentCliRunOptions}.
   */
  flowRun(
    flowName: string,
    options: AgentCliRunOptions,
  ): Promise<AgentOperatorProjectedFlowEnvelope>;
}

/** Constructor options for {@link createAgentCliSurface}. */
export interface CreateAgentCliSurfaceOptions {
  /** Absolute path to the `m3l` CLI entrypoint (`packages/m3l-cli/bin/m3l.mjs`). */
  readonly entrypoint: string;
  /** Working directory for the spawned CLI process. */
  readonly cwd: string;
  /** Absolute path to the Node executable to spawn. */
  readonly nodeExecPath: string;
  /** Timeout applied to `list`/`doctor`/`inspect`. */
  readonly cliTimeoutMs: number;
  /** Timeout applied to `dryRun` (a real script's config load can be slower). */
  readonly dryRunTimeoutMs: number;
  /**
   * Timeout applied to `flowRun`, for BOTH modes — a dry-run flow still
   * spawns every step, it just stops each after its config and credential
   * checks. Deliberately not `dryRunTimeoutMs`: a flow spawns N scripts
   * sequentially, so the single-script budget is the wrong unit.
   *
   * Expiry DOES stop the flow: `flowRun` is the one method that spawns with
   * `teardown: "group"`, so `cli-process` resolves `"timed-out"` and signals
   * the whole process group — the `m3l` CLI and the step it spawned as its
   * own grandchild — escalating to `SIGKILL` after its grace period. The
   * run's effects are still INDETERMINATE (a step killed mid-mutation is not
   * undone, and this seam never emits `--resume`), and teardown is
   * POSIX-only — see `config.ts`'s `FLOW_TIMEOUT_MS_DEFAULT` for the full
   * rationale.
   */
  readonly flowTimeoutMs: number;
  /** Per-stream byte cap forwarded to `runCliProcess`. */
  readonly maxOutputBytes: number;
  /**
   * The closed set of script names `dryRun` may target. `--dry-run` is a
   * per-script convention (each script opts in via
   * `process.argv.includes("--dry-run")`), not a CLI contract, so this
   * allowlist — not the name regex alone — is what keeps the tool honestly
   * read-only.
   */
  readonly dryRunAllowlist: ReadonlySet<string>;
  /**
   * The operator-declared `preset name -> workspace-relative preset path`
   * map `run` resolves its `--preset=` token from. Membership here — not
   * `AGENT_OPERATOR_PRESET_NAME_RE`, which admits `-h` and `123` — is what
   * makes a model-supplied preset name safe, and only an operator editing
   * config can add a member.
   *
   * Required, even though an **empty map still means closed** — with nothing
   * to look up, every `run` call rejects with the fixed preset message. The
   * point of the requirement is that closed becomes *declared* rather than
   * accidental: a caller wiring a new surface cannot forget to forward the
   * operator's parsed allowlist and get a plausible-looking "not on the
   * allowlist" rejection at runtime instead of a compile error. Passing an
   * explicit `new Map()` is the supported way to say "no mutating runs here".
   *
   * Entries stay workspace-relative because that is the reviewable form in a
   * config diff; making the path absolute is `run`'s job, for the reason
   * documented on `resolveAllowedPresetPath`.
   */
  readonly presetAllowlist: ReadonlyMap<string, string>;
  /**
   * The closed set of flow names `flowRun` may target, consulted by
   * {@link "./flow-names.js".assertAllowedFlowName}.
   *
   * Deliberately a `ReadonlySet<string>`, NOT a `presetAllowlist`-shaped
   * `ReadonlyMap<string, string>` — a flow name needs no path resolution at
   * all: `m3l flow run <name>` resolves `data/config/flows/<name>.yaml`
   * itself, so there is no path to build, no containment rule to enforce
   * here, and nothing to anchor to `workspaceRoot`. Do not "align" this
   * field's shape with `presetAllowlist` for symmetry; the asymmetry
   * reflects a real difference in what the CLI accepts.
   */
  readonly flowAllowlist: ReadonlySet<string>;
  /**
   * The absolute host workspace-root path, forwarded into every `project*`
   * call as `AgentOperatorProjectionOptions.workspaceRoot` so
   * `model-safety.ts`'s scrub actually runs against production CLI output
   * (`doctor`'s `workspace-root` check, `inspect`'s `description`/
   * `defaultValue`, `dryRun`'s echoed `script`) — otherwise the absolute host
   * path reaches the model unmasked. Optional: omitting it disables the
   * scrub without failing any of the four read-only methods — but `run`
   * cannot anchor a preset path without it and rejects rather than emit an
   * unanchored one.
   */
  readonly workspaceRoot?: string;
  /** Optional cooperative-cancellation signal, forwarded to every spawn. */
  readonly signal?: AbortSignal;
  /** Test injection seam; defaults to the real `runCliProcess`. */
  readonly runProcess?: typeof runCliProcess;
}

/** The resolved, method-independent context every CLI invocation shares. */
interface SurfaceRunContext {
  readonly entrypoint: string;
  readonly cwd: string;
  readonly nodeExecPath: string;
  readonly maxOutputBytes: number;
  readonly workspaceRoot: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly runProcess: typeof runCliProcess;
}

/**
 * Builds the {@link AgentOperatorProjectionOptions} forwarded to every
 * `project*` call: `workspaceRoot` when the surface was constructed with
 * one, and `secrets` when the caller (currently only `runInspect`) supplies
 * declared secret parameter names. Built via conditional spread — never an
 * explicit `undefined` — so `exactOptionalPropertyTypes` sees a genuinely
 * absent property rather than a present-but-`undefined` one.
 */
function buildProjectionOptions(
  workspaceRoot: string | undefined,
  secrets?: readonly string[],
): AgentOperatorProjectionOptions {
  return {
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(secrets === undefined ? {} : { secrets }),
  };
}

/**
 * One method's fixed argv, timeout, exit-code policy, output parser, and
 * teardown scope.
 *
 * `teardown` is REQUIRED, not optional with a `"child"` default. This is an
 * internal type with exactly seven construction sites, and requiring the
 * field makes "`flowRun` is the only method that group-kills" provable by
 * reading seven literals rather than by reasoning about a default — and
 * makes an eighth method that forgets it a compile error instead of a silent
 * revert to the orphan behaviour.
 */
interface CliInvocationSpec<T> {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly isAcceptableExitCode: (exitCode: number | null) => boolean;
  readonly parse: (raw: unknown) => ParseResult<T>;
  readonly teardown: CliTeardownScope;
}

/**
 * The argv table — a closed, discriminated union over the six operations.
 * `scriptName` is typed as the branded {@link AgentOperatorScriptName}
 * (never bare `string`), so `buildArgv` structurally cannot be called with a
 * name that has not already passed {@link assertAllowedScriptName} — the
 * brand protects this internal path from the boundary inward; it does not
 * push validation onto the surface's public callers, which still pass raw
 * `string`.
 */
type CliOperation =
  | { readonly method: "list" }
  | { readonly method: "doctor" }
  | { readonly method: "inspect"; readonly scriptName: AgentOperatorScriptName }
  | { readonly method: "dryRun"; readonly scriptName: AgentOperatorScriptName }
  | {
      readonly method: "run";
      readonly scriptName: AgentOperatorScriptName;
      /**
       * The **absolute**, already-resolved preset path — not the branded
       * preset name. Its own {@link AgentOperatorPresetPath} brand is minted
       * by `resolveAllowedPresetPath` and nowhere else, so this field cannot
       * be populated by a bare `string`, by a hand-built `path.join`, or by
       * a preset NAME that skipped resolution. That keeps `buildArgv` a pure
       * argv builder with no allowlist or filesystem knowledge of its own,
       * while making the missing check a compile error rather than a
       * convention.
       */
      readonly presetPath: AgentOperatorPresetPath;
      /** Whether to append the trailing `--dry-run` passthrough token. */
      readonly dryRun: boolean;
    }
  | {
      readonly method: "triageRun";
      readonly scriptName: AgentOperatorScriptName;
      /** Same brand, same one mint site, as the `run` arm's `presetPath`. */
      readonly presetPath: AgentOperatorPresetPath;
      /**
       * The operator's own resolved `aws.profile`, already validated
       * non-empty by {@link assertUsableOperatorProfile} before this arm is
       * ever constructed — a bare `string` field (unbranded, unlike
       * `presetPath`) because it is never resolved from a name-to-path
       * lookup, only checked for non-emptiness.
       */
      readonly operatorProfile: string;
      // Deliberately NO `dryRun` field: triage never rehearses, so there is
      // no boolean to thread and no second argv shape to build — see
      // `AgentCliSurface.triageRun`'s own TSDoc.
    }
  | {
      readonly method: "flowRun";
      /**
       * Branded; minted ONLY by `assertAllowedFlowName`, called with this
       * flow name and the surface's own `flowAllowlist`. Typing this field
       * with the brand rather than `string` is what makes a skipped
       * validation a compile error rather than a convention — mirroring how
       * the `run`/`triageRun` arms above type their `presetPath` field with
       * `AgentOperatorPresetPath`.
       */
      readonly flowName: AgentOperatorFlowName;
      /** Whether to append the trailing `--dry-run` token. */
      readonly dryRun: boolean;
    };

/**
 * Builds one operation's fixed argv from a closed `switch`, at fixed
 * positions — never by string concatenation or templating a caller value
 * into a larger string.
 */
function buildArgv(operation: CliOperation): readonly string[] {
  switch (operation.method) {
    case "list":
      return ["list", "--json"];
    case "doctor":
      return ["doctor", "--json"];
    case "inspect":
      return ["inspect", operation.scriptName, "--json"];
    case "dryRun":
      // `splitAtFirstDoubleDash` (packages/m3l-cli/src/main.ts) runs before
      // `partitionJsonFlag`, so `--json` must precede the bare `--` to be
      // stripped by the CLI's own flag partitioning, and `--dry-run` must
      // follow the `--` to be forwarded verbatim to the child script.
      return ["run", operation.scriptName, "--json", "--", "--dry-run"];
    case "run":
      // Same ordering reasoning as `dryRun` above. The attached
      // `--preset=<path>` form is required rather than stylistic: the child
      // script's own `parseArgv` binds a passthrough arg by splitting on its
      // first `=`, so a detached `--preset <path>` pair would never bind.
      // `--dry-run` is appended LAST, so the probing argv differs from the
      // mutating one by exactly one trailing token.
      return [
        "run",
        operation.scriptName,
        "--json",
        "--",
        `--preset=${operation.presetPath}`,
        ...(operation.dryRun ? ["--dry-run"] : []),
      ];
    case "triageRun":
      // Same `--json`-before-`--` and attached-`--preset=` reasoning as the
      // `run` case above. `TRIAGE_OPERATION_ARG` follows `--preset=` — see
      // that constant's own TSDoc for why a passthrough argument (precedence
      // level 1) is what makes it un-overridable by the preset file's
      // `operation:` key (level 6) or an inherited environment variable
      // (level 4). The interpolated `--aws.profile=` token is appended LAST,
      // for the same precedence reason applied to the profile instead of the
      // verb — see the module header and `AgentCliSurface.triageRun`'s own
      // TSDoc.
      return [
        "run",
        operation.scriptName,
        "--json",
        "--",
        `--preset=${operation.presetPath}`,
        TRIAGE_OPERATION_ARG,
        `--aws.profile=${operation.operatorProfile}`,
      ];
    case "flowRun":
      // Four argv facts, each a decision rather than an oversight:
      //
      // 1. No bare `--`: `main.ts` bypasses `parseStaticCommandArgs` for
      //    `flow` entirely, so `m3l flow run` parses `--json` itself. The
      //    "--json before the bare --" ordering constraint that governs the
      //    whole `run`/`triageRun` family above does not apply here, and
      //    adding a `--` would be a usage error, not a no-op.
      // 2. `m3l flow` REJECTS every extra argument (exit code 2, via its own
      //    `reportUnknownFlag`) rather than silently dropping it — so no
      //    speculative flag is ever safe to add to this arm.
      // 3. That rejection is also why no `--aws.profile=` token is pinned
      //    here the way `triageRun` pins one above: the profile cannot be
      //    forced from this side at all. A later slice grades it from the
      //    flow definition instead.
      // 4. `--resume` is deliberately never emitted: resuming re-enters a
      //    partially-executed flow whose earlier steps already mutated,
      //    under an authorization granted for a fresh run, not a resumed
      //    one.
      return [
        "flow",
        "run",
        operation.flowName,
        "--json",
        ...(operation.dryRun ? ["--dry-run"] : []),
      ];
    default: {
      const exhaustive: never = operation;
      throw new M3LAgentOperatorCliError(
        CLI_SPAWN_REJECTION_MESSAGE,
        "ERR_AGENT_OPERATOR_CLI_SPAWN",
        { context: { unexpectedOperation: exhaustive } },
      );
    }
  }
}

/**
 * Validates `triageRun`'s `operatorProfile` argument, rejecting an empty
 * string BEFORE anything spawns and before either the script name or the
 * preset name is checked.
 *
 * @remarks
 * `steps/build-triage-tools.ts` stamps this SAME value into a judged
 * action's `target.profile` — the value the policy gate grades. An empty
 * string would still be a caller-supplied value the parent had already
 * graded (an empty profile is not the same failure as "the caller never
 * graded anything"), but handing the spawned child no usable target while
 * the parent's grading proceeded is the same class of divergence this
 * method's third parameter exists to close in the first place, so it must
 * fail loudly rather than emit an argv token of `--aws.profile=`.
 *
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `operatorProfile` is the empty string.
 */
function assertUsableOperatorProfile(operatorProfile: string): string {
  if (operatorProfile === "") {
    throw new M3LAgentOperatorCliError(
      OPERATOR_PROFILE_REJECTION_MESSAGE,
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return operatorProfile;
}

/**
 * Validates a caller-supplied script name against the allowlist, remapping
 * any rejection to the fixed {@link SCRIPT_NAME_REJECTION_MESSAGE} — the
 * original allowlist message is preserved as `cause` for diagnostics, but
 * never surfaced to the model, which is this boundary's whole purpose.
 */
function assertUsableScriptName(scriptName: string): AgentOperatorScriptName {
  try {
    return assertAllowedScriptName(scriptName);
  } catch (cause) {
    throw new M3LAgentOperatorCliError(
      SCRIPT_NAME_REJECTION_MESSAGE,
      "ERR_AGENT_OPERATOR_SCRIPT_NAME",
      { cause },
    );
  }
}

/**
 * Validates a caller-supplied script name for `dryRun`: it must pass the
 * allowlist AND be a member of `dryRunAllowlist`. Both failure modes surface
 * the same fixed message and code — the model cannot distinguish "not a
 * valid name" from "a valid name this tool won't dry-run".
 */
function assertDryRunEligible(
  scriptName: string,
  dryRunAllowlist: ReadonlySet<string>,
): AgentOperatorScriptName {
  const name = assertUsableScriptName(scriptName);
  if (!dryRunAllowlist.has(name)) {
    throw new M3LAgentOperatorCliError(
      SCRIPT_NAME_REJECTION_MESSAGE,
      "ERR_AGENT_OPERATOR_SCRIPT_NAME",
    );
  }
  return name;
}

/**
 * Mints the fixed preset rejection. Every way a preset request can fail
 * collapses onto this one message and code — a malformed name, a well-formed
 * name the operator never declared, an allowlist entry that does not sit
 * inside the presets directory, an entry whose shape the config parser would
 * have refused, a surface with no absolute, `..`-free `workspaceRoot` to
 * anchor a path to — so the error text cannot be used to enumerate the
 * allowlist one guess at a time. The message and code are identical across
 * every one of those rejection arms; that identity is the property, and a
 * new arm joins it rather than adding a signal.
 *
 * `cause` is REQUIRED, and each arm passes a different one. The collapse is
 * deliberately model-facing only: `cause` is this module's operator-only
 * channel (as on {@link assertUsableScriptName}), and it is what tells an
 * operator "the model is guessing names" apart from "this surface was wired
 * without a workspace root". Without it, a standalone-mode
 * `deriveWorkspaceRoot` returning `undefined` made every `run` — including
 * one naming a perfectly valid entry — report a *name* failure forever,
 * sending the operator hunting a preset name that was never the problem.
 *
 * @param cause - The operator-facing reason, never surfaced to the model.
 */
function buildPresetError(cause: unknown): M3LAgentOperatorCliError {
  return new M3LAgentOperatorCliError(
    PRESET_NAME_REJECTION_MESSAGE,
    "ERR_AGENT_OPERATOR_PRESET",
    { cause },
  );
}

/**
 * Builds one arm's operator-facing `cause`. Every arm shares
 * `ERR_AGENT_OPERATOR_PRESET`: which arm fired is a remediation difference,
 * not a catch-site one, so it lives in this message rather than in an
 * eleventh error code no caller would narrow on.
 *
 * No arm interpolates the model-supplied preset name, which is the same rule
 * `lib/cli-names.ts` and `lib/preset-names.ts` already follow. Carrying it
 * would be safe today — by the arms that could, the name has passed
 * `^[a-z0-9-]{1,64}$` — but "safe because a check upstream is tight" is a
 * property that has to be re-audited every time the charset moves, and a
 * `cause` reaches `logger.error`. The name the model asked for is already on
 * the tool call an operator reads next to this error, so the interpolation
 * bought no diagnostic the log did not already have.
 *
 * @param reason - The fixed, operator-facing reason text for one arm.
 */
function buildPresetCause(reason: string): M3LAgentOperatorCliError {
  return new M3LAgentOperatorCliError(reason, "ERR_AGENT_OPERATOR_PRESET");
}

/**
 * Validates a caller-supplied preset name, remapping the name check's own
 * rejection to the fixed {@link PRESET_NAME_REJECTION_MESSAGE} exactly as
 * {@link assertUsableScriptName} does — the original message is kept as
 * `cause` for an operator, never surfaced to the model.
 */
function assertUsablePresetName(presetName: string): AgentOperatorPresetName {
  try {
    return assertAllowedPresetName(presetName);
  } catch (cause) {
    // Narrow-then-rethrow (the repo pattern, as in `steps/resolve-runtime.ts`
    // and `steps/run-health-check.ts`): only this module's own rejection is a
    // name verdict worth collapsing. `assertAllowedPresetName` throws nothing
    // else today, so no test can reach the rethrow — the narrowing is here so
    // that when the name check grows a real check, a `TypeError` from inside
    // it propagates as the bug it is instead of being laundered into
    // `PRESET_NAME_REJECTION_MESSAGE` — a name verdict it never was.
    if (!(cause instanceof M3LAgentOperatorCliError)) throw cause;
    throw buildPresetError(cause);
  }
}

/**
 * Resolves an already-validated preset name into the ABSOLUTE path `run` may
 * emit, and is the ONLY function permitted to mint an
 * {@link AgentOperatorPresetPath}. The name must be a key of
 * `presetAllowlist`, the surface must carry an ABSOLUTE, `..`-free
 * `workspaceRoot`, and the stored entry must still satisfy
 * {@link "./preset-names.js".isDeclarablePresetPath} — those checks are what
 * the brand records.
 *
 * Taking an {@link AgentOperatorPresetName} rather than a `string` is what
 * makes {@link assertUsablePresetName} unskippable: there is no expression
 * that reaches this resolver from raw, model-supplied text.
 *
 * Why containment is re-checked here when `steps/resolve-runtime.ts`'s config
 * parser already applies it: that parser is one component away, and
 * `presetAllowlist` is a plain `ReadonlyMap` a caller can build directly.
 * Probes against a directly-constructed map emitted `--preset=/etc/passwd`
 * from an entry of `../../../etc/passwd`, because `path.join` normalises the
 * escape away silently.
 *
 * Why absolute AND `..`-free, and why a missing, relative or `..`-bearing
 * `workspaceRoot` must reject rather than degrade: `m3l run` spawns the child with `cwd: scriptDirectory`
 * (not the workspace root) and the library's preset loader does a bare
 * `path.resolve`, so a workspace-relative token would resolve under
 * `scripts/<name>/` and silently load the wrong file — or none. Emitting a
 * relative token (which `workspaceRoot: ""` produced) or one with
 * `undefined` interpolated into it would turn a wiring mistake into a
 * mutating run against the wrong configuration. `path.isAbsolute` alone does
 * not settle that: `/repo/../etc` is absolute and anchors the join under
 * `/etc`, so the root half of the join is held to the same unconditional
 * `..` ban {@link "./preset-names.js".isDeclarablePresetPath} applies to the
 * entry half — the two halves of one `path.join` must not be checked by two
 * different rules.
 */
function resolveAllowedPresetPath(
  presetName: AgentOperatorPresetName,
  presetAllowlist: ReadonlyMap<string, string>,
  workspaceRoot: string | undefined,
): AgentOperatorPresetPath {
  // Every arm below throws the SAME model-facing message and code on
  // purpose: "you named a preset I do not have", "that entry is not
  // declarable" and "I cannot anchor a path right now" must all be
  // indistinguishable from "that is not a well-formed preset name", or the
  // error text becomes an allowlist oracle. The `cause` each arm attaches is
  // the operator's channel, and it is where they differ.
  const relativePath = presetAllowlist.get(presetName);
  if (relativePath === undefined) {
    throw buildPresetError(
      buildPresetCause(
        "the requested preset name is not a key of the operator-declared 'presetAllowlist'",
      ),
    );
  }
  if (workspaceRoot === undefined) {
    throw buildPresetError(
      buildPresetCause(
        "this surface was built without a 'workspaceRoot', so a preset path cannot be anchored to one; the preset name is not the problem",
      ),
    );
  }
  if (!path.isAbsolute(workspaceRoot)) {
    throw buildPresetError(
      buildPresetCause(
        "this surface's 'workspaceRoot' is not an absolute path, so anchoring a preset path onto it would emit a relative '--preset=' token; the preset name is not the problem",
      ),
    );
  }
  // Rejected, never normalised, for the same reviewability reason
  // `isDeclarablePresetPath` bans a `..` segment that normalises back inside:
  // the root a surface was wired with is the artifact an operator reads, and
  // a `..` in it makes the wired string and the anchored path disagree.
  if (workspaceRoot.split(AGENT_OPERATOR_PATH_SEPARATOR_RE).includes("..")) {
    throw buildPresetError(
      buildPresetCause(
        "this surface's 'workspaceRoot' contains a '..' segment, so anchoring a preset path onto it would emit a token under a directory nobody wired; the preset name is not the problem",
      ),
    );
  }
  if (!isDeclarablePresetPath(relativePath)) {
    throw buildPresetError(
      buildPresetCause(
        `the 'presetAllowlist' entry for the requested preset name must be workspace-relative, free of '..' segments and of whitespace or control characters, and name a file inside '${AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX}'`,
      ),
    );
  }
  // The one mint site for the path brand: reachable only after membership,
  // the workspace root's absoluteness and `..`-freedom, and the entry's own
  // shape and containment have all passed just above.
  return path.join(workspaceRoot, relativePath) as AgentOperatorPresetPath;
}

/** Parses raw stdout text through `parseJsonText` then the method's own parser. */
function parseCliOutput<T>(
  stdout: string,
  parse: (raw: unknown) => ParseResult<T>,
): ParseResult<T> {
  const json = parseJsonText(stdout);
  if (!json.ok) return json;
  return parse(json.value);
}

/**
 * Mints an `ERR_AGENT_OPERATOR_CLI_OUTPUT` error. `context` carries only
 * structured, non-sensitive fields (a parse-failure reason, an exit code) —
 * never raw stdout/stderr, which could otherwise leak a rejected script's
 * arbitrary output text into an error a model reads.
 */
function buildOutputError(
  context: Record<string, unknown>,
): M3LAgentOperatorCliError {
  return new M3LAgentOperatorCliError(
    CLI_OUTPUT_REJECTION_MESSAGE,
    "ERR_AGENT_OPERATOR_CLI_OUTPUT",
    { context },
  );
}

/**
 * The four non-`exited`, non-`aborted` dispositions this module folds into a
 * single `ERR_AGENT_OPERATOR_CLI_SPAWN`. Named here so `context.disposition`
 * is provably one of those literals and nothing wider.
 */
type CliFailedDisposition = Exclude<CliRunDisposition, "exited" | "aborted">;

/**
 * Mints an `ERR_AGENT_OPERATOR_CLI_SPAWN` error. `context` carries the
 * settled `disposition` — a closed union of six non-sensitive literals, so
 * an operator can tell a spawn failure from a timeout, a kill, and a
 * byte-cap breach, all of which share one fixed model-facing message — plus
 * `failureCode` when present. Never a spawn `error.message`, which can embed
 * a resolved absolute path.
 */
function buildSpawnError(
  disposition: CliFailedDisposition,
  failureCode: string | undefined,
): M3LAgentOperatorCliError {
  const context: Record<string, unknown> = {
    disposition,
    ...(failureCode === undefined ? {} : { failureCode }),
  };
  return new M3LAgentOperatorCliError(
    CLI_SPAWN_REJECTION_MESSAGE,
    "ERR_AGENT_OPERATOR_CLI_SPAWN",
    { context },
  );
}

/** Resolves an `"exited"` disposition: exit-code policy, then output parsing. */
function resolveExited<T>(
  exitCode: number | null,
  stdout: string,
  spec: CliInvocationSpec<T>,
): T {
  if (!spec.isAcceptableExitCode(exitCode)) {
    throw buildOutputError({ reason: "unacceptable-exit-code", exitCode });
  }
  const parsed = parseCliOutput(stdout, spec.parse);
  if (!parsed.ok) {
    throw buildOutputError({ reason: parsed.reason });
  }
  return parsed.value;
}

/**
 * Classifies a settled `CliRunResult` via an exhaustive `switch` over its
 * disposition. `"aborted"` throws `Core.M3LOperationAbortedError` — never a
 * script-local code — so ADR-0049's `deriveCommandOutcome` maps it to exit 5
 * the same way whether the abort happened in-process or on this spawn path.
 */
function resolveCliRunResult<T>(
  result: CliRunResult,
  spec: CliInvocationSpec<T>,
): T {
  const disposition: CliRunDisposition = result.disposition;
  switch (disposition) {
    case "exited":
      return resolveExited(result.exitCode, result.stdout, spec);
    case "aborted":
      throw new Core.M3LOperationAbortedError();
    case "spawn-failed":
    case "timed-out":
    case "signalled":
    case "output-truncated":
      throw buildSpawnError(disposition, result.failureCode);
    default: {
      const exhaustive: never = disposition;
      throw new M3LAgentOperatorCliError(
        CLI_SPAWN_REJECTION_MESSAGE,
        "ERR_AGENT_OPERATOR_CLI_SPAWN",
        { context: { unexpectedDisposition: exhaustive } },
      );
    }
  }
}

/** Runs one CLI invocation end to end: spawn, then classify the result. */
async function runCliInvocation<T>(
  ctx: SurfaceRunContext,
  spec: CliInvocationSpec<T>,
): Promise<T> {
  const result = await ctx.runProcess({
    nodeExecPath: ctx.nodeExecPath,
    entrypoint: ctx.entrypoint,
    args: spec.args,
    cwd: ctx.cwd,
    timeoutMs: spec.timeoutMs,
    maxOutputBytes: ctx.maxOutputBytes,
    // Forwarded unconditionally, not through the conditional spread `signal`
    // uses: `spec.teardown` is always present, and the spread idiom belongs
    // where a value is genuinely absent — using it here would let a missing
    // spec field silently fall back to `"child"`.
    teardown: spec.teardown,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  return resolveCliRunResult(result, spec);
}

/** `list()` — the `{0}`-only exit policy. */
async function runList(
  ctx: SurfaceRunContext,
  timeoutMs: number,
): Promise<readonly AgentOperatorProjectedListRow[]> {
  const rows = await runCliInvocation<readonly AgentOperatorListRow[]>(ctx, {
    args: buildArgv({ method: "list" }),
    timeoutMs,
    isAcceptableExitCode: (exitCode) => exitCode === 0,
    parse: parseListRows,
    teardown: "child",
  });
  const opts = buildProjectionOptions(ctx.workspaceRoot);
  return rows.map((row) => projectListRow(row, opts));
}

/**
 * `doctor()` — the `{0, 1}` exit policy. This asymmetry with `list`/`inspect`
 * is deliberate: a failing health check is the answer this tool exists to
 * report, not a failure of the tool itself, so `doctor --json` exiting `1`
 * (its documented behaviour when any check fails) must resolve, not reject.
 */
async function runDoctor(
  ctx: SurfaceRunContext,
  timeoutMs: number,
): Promise<AgentOperatorProjectedDoctorReport> {
  const checks = await runCliInvocation<readonly AgentOperatorDoctorCheck[]>(
    ctx,
    {
      args: buildArgv({ method: "doctor" }),
      timeoutMs,
      isAcceptableExitCode: (exitCode) => exitCode === 0 || exitCode === 1,
      parse: parseDoctorChecks,
      teardown: "child",
    },
  );
  return projectDoctorReport(checks, buildProjectionOptions(ctx.workspaceRoot));
}

/** `inspect(scriptName)` — allowlist first, then the `{0}`-only exit policy. */
async function runInspect(
  ctx: SurfaceRunContext,
  timeoutMs: number,
  scriptName: string,
): Promise<readonly AgentOperatorProjectedParamDescriptor[]> {
  const name = assertUsableScriptName(scriptName);
  const descriptors = await runCliInvocation<
    readonly AgentOperatorParamDescriptor[]
  >(ctx, {
    args: buildArgv({ method: "inspect", scriptName: name }),
    timeoutMs,
    isAcceptableExitCode: (exitCode) => exitCode === 0,
    parse: parseParamDescriptors,
    teardown: "child",
  });
  // `inspect` already knows which parameter names this script declares
  // `secret: true` — thread them into the redactor's `secrets` widening
  // (S2) so a secret-flagged parameter's description/default is redacted
  // even when it embeds a value the library's default denylist can't see.
  const secretNames = descriptors
    .filter((descriptor) => descriptor.secret)
    .map((descriptor) => descriptor.name);
  const opts = buildProjectionOptions(ctx.workspaceRoot, secretNames);
  return descriptors.map((descriptor) =>
    projectParamDescriptor(descriptor, opts),
  );
}

/**
 * `dryRun(scriptName)` — allowlist AND `dryRunAllowlist` membership first,
 * then any exit code is acceptable (the envelope carries its own outcome).
 */
async function runDryRun(
  ctx: SurfaceRunContext,
  timeoutMs: number,
  scriptName: string,
  dryRunAllowlist: ReadonlySet<string>,
): Promise<AgentOperatorProjectedRunEnvelope> {
  const name = assertDryRunEligible(scriptName, dryRunAllowlist);
  const envelope = await runCliInvocation<AgentOperatorRunEnvelope>(ctx, {
    args: buildArgv({ method: "dryRun", scriptName: name }),
    timeoutMs,
    isAcceptableExitCode: () => true,
    parse: parseRunEnvelope,
    teardown: "child",
  });
  return projectRunEnvelope(
    envelope,
    buildProjectionOptions(ctx.workspaceRoot),
  );
}

/**
 * Narrows a caller-supplied options bag to one of the two `mode` literals at
 * RUNTIME, returning the matched literal, and rejects everything else with a
 * coded {@link M3LAgentOperatorCliError} before any argv is built.
 *
 * Why a runtime check when {@link AgentCliRunOptions} already declares a
 * required two-member union: the union is erased by `tsc`, so it constrains
 * only a caller who writes the object literal in TypeScript.
 * `JSON.parse(text) as AgentCliRunOptions` typechecks with zero errors — and
 * that cast is exactly what a model-driven caller does with a tool-call
 * argument bag typed `unknown`.
 *
 * The narrowing is POSITIVE (accept the two literals) rather than negative
 * (`mode !== "mutate"` selects a probe), because both directions of a
 * near-miss are failures and they fail differently: a mistyped `"dry-run"`
 * read as mutation destroys data, while a mistyped `"mutate"` read as a probe
 * reports success for work that never happened. Neither is a default worth
 * having, so an unrecognised bag reaches argv in neither mode.
 *
 * @param options - The caller's options bag, trusted only as far as its
 *   declared type, which a cast can make a lie.
 * @returns The matched `mode` literal.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when the bag is absent, carries no OWN `mode` key, or its own `mode` is
 *   not exactly one of the two literals.
 *   `ERR_AGENT_OPERATOR_CONFIG` rather than `ERR_AGENT_OPERATOR_PRESET`
 *   because nothing about the preset was wrong — a caller supplied a value
 *   the seam does not accept, which is what that code's `caller` origin
 *   already means — and rather than an eleventh code, which no catch site
 *   would narrow on. A coded error, never a bare `TypeError` from reading
 *   `.mode` off `undefined`: a caller narrowing on `.code` must see something.
 */
function assertRunMode(
  options: AgentCliRunOptions,
): AgentCliRunOptions["mode"] {
  // Read through `unknown`: the declared type asserts both that the bag is
  // present and that its `mode` is one of two literals, and this function
  // exists because a caller who cast can make either claim false.
  const bag: unknown = options;
  if (typeof bag === "object" && bag !== null) {
    // Read ONCE into a local, then compare the LOCAL — never the property
    // twice. A getter (or a `Proxy`) could answer the check with `"dry-run"`
    // and the derivation with anything at all.
    //
    // `Object.hasOwn` GATES that single read, because a plain `bag.mode` dot
    // read walks the prototype chain: with `Object.prototype.mode = "mutate"`
    // set, `run(s, p, {})` — a bag the caller never populated — read a mode
    // it never declared and SPAWNED A MUTATING RUN. This is the same rule
    // `packages/m3l-common/src/internal/agent/decide.ts` applies to every
    // policy field it reads (`sensitiveTargets`, `dryRunFirst`,
    // `requireDecisionLog`), and it is recorded there for the same kind of
    // incident: a polluted `Object.prototype.sensitiveTargets` skipped the
    // grading arm and auto-approved a prod mutation under a policy that had
    // opted out of grading. Applied here, the field is the mode
    // DISCRIMINATOR rather than a policy option, and the failure direction is
    // toward MUTATION — which is why an inherited value is refused even when
    // it reads `"dry-run"`: a caller that did not write the key chose
    // neither mode, and only an own key is a choice. An own `mode` still
    // wins over a polluted inherited one, because `Object.hasOwn` decides
    // only whether the read happens — the read itself, and the comparison
    // below, are unchanged.
    const mode: unknown = Object.hasOwn(bag, "mode")
      ? (bag as { readonly mode?: unknown }).mode
      : undefined;
    if (mode === "dry-run" || mode === "mutate") {
      return mode;
    }
  }
  // The unrecognised value is NOT echoed: it may be model-supplied, and this
  // module never puts caller text into a message. See
  // {@link PRESET_NAME_REJECTION_MESSAGE}'s neighbours.
  throw new M3LAgentOperatorCliError(
    RUN_MODE_REJECTION_MESSAGE,
    "ERR_AGENT_OPERATOR_CONFIG",
  );
}

/**
 * `run(scriptName, presetName, options)` — the requested `mode` first, then
 * the script allowlist, then the preset allowlist (which is also what anchors
 * the stored relative path to an absolute one), then the same "any exit code
 * is acceptable" policy as `dryRun`. Every validation runs before
 * `buildArgv`, so a rejected call never reaches `runCliProcess`.
 *
 * `mode` is checked FIRST, ahead of both allowlists: it decides whether this
 * call may mutate at all, and a bag that cannot say which it wants has
 * nothing to gain from having its preset name resolved.
 */
async function runRun(
  ctx: SurfaceRunContext,
  timeoutMs: number,
  scriptName: string,
  presetName: string,
  presetAllowlist: ReadonlyMap<string, string>,
  options: AgentCliRunOptions,
): Promise<AgentOperatorProjectedRunEnvelope> {
  const mode = assertRunMode(options);
  const name = assertUsableScriptName(scriptName);
  // Two steps, not one, because the brands make the order compulsory:
  // `resolveAllowedPresetPath` accepts only an `AgentOperatorPresetName`, and
  // `buildArgv` accepts only the `AgentOperatorPresetPath` it returns.
  const preset = assertUsablePresetName(presetName);
  const presetPath = resolveAllowedPresetPath(
    preset,
    presetAllowlist,
    ctx.workspaceRoot,
  );
  const envelope = await runCliInvocation<AgentOperatorRunEnvelope>(ctx, {
    args: buildArgv({
      method: "run",
      scriptName: name,
      presetPath,
      // Derived from the RUNTIME-narrowed `mode`, not from the parameter.
      // The required discriminator is what stops an honest caller at compile
      // time; `assertRunMode` above is what stops a casting one, and reading
      // its return value here is what makes the derivation total over the two
      // literals rather than "everything that is not `dry-run` mutates" — the
      // shape that let `{}`, `{ mode: "dryrun" }` and an omitted bag all
      // select mutation.
      dryRun: mode === "dry-run",
    }),
    timeoutMs,
    isAcceptableExitCode: () => true,
    parse: parseRunEnvelope,
    teardown: "child",
  });
  return projectRunEnvelope(
    envelope,
    buildProjectionOptions(ctx.workspaceRoot),
  );
}

/**
 * `triageRun(scriptName, presetName, operatorProfile)` — `operatorProfile`
 * checked FIRST (mirrors {@link runRun}'s `mode`-first ordering: a call that
 * cannot supply a usable profile has nothing to gain from having its script
 * or preset name resolved), then the script allowlist, then the preset
 * allowlist (which is also what anchors the stored relative path to an
 * absolute one), then the same "any exit code is acceptable" policy as
 * `run`/`dryRun`. Every validation runs before `buildArgv`, so a rejected
 * call never reaches `runCliProcess`. Otherwise mirrors {@link runRun} minus
 * its `mode` handling: there is no bag to narrow and no dry-run boolean to
 * derive, because `triageRun` never rehearses.
 */
async function runTriageRun(
  ctx: SurfaceRunContext,
  timeoutMs: number,
  scriptName: string,
  presetName: string,
  operatorProfile: string,
  presetAllowlist: ReadonlyMap<string, string>,
): Promise<AgentOperatorProjectedRunEnvelope> {
  const profile = assertUsableOperatorProfile(operatorProfile);
  const name = assertUsableScriptName(scriptName);
  // Two steps, not one, because the brands make the order compulsory:
  // `resolveAllowedPresetPath` accepts only an `AgentOperatorPresetName`, and
  // `buildArgv` accepts only the `AgentOperatorPresetPath` it returns.
  const preset = assertUsablePresetName(presetName);
  const presetPath = resolveAllowedPresetPath(
    preset,
    presetAllowlist,
    ctx.workspaceRoot,
  );
  const envelope = await runCliInvocation<AgentOperatorRunEnvelope>(ctx, {
    args: buildArgv({
      method: "triageRun",
      scriptName: name,
      presetPath,
      operatorProfile: profile,
    }),
    timeoutMs,
    isAcceptableExitCode: () => true,
    parse: parseRunEnvelope,
    teardown: "child",
  });
  return projectRunEnvelope(
    envelope,
    buildProjectionOptions(ctx.workspaceRoot),
  );
}

/**
 * `flowRun(flowName, options)` — `mode` checked FIRST via the SAME
 * {@link assertRunMode} `run` uses (mirrors `runRun`'s ordering: a bag that
 * cannot say which mode it wants has nothing to gain from having its flow
 * name resolved), then {@link "./flow-names.js".assertAllowedFlowName}
 * against `flowAllowlist`, then the same "any exit code is acceptable"
 * policy as `run`/`dryRun`/`triageRun`. Every validation runs before
 * `buildArgv`, so a rejected call never reaches `runCliProcess`.
 *
 * Uses `timeoutMs` for BOTH modes — see
 * `CreateAgentCliSurfaceOptions.flowTimeoutMs`'s own TSDoc for why a
 * dry-run flow still spawns every step rather than returning early.
 */
async function runFlowRun(
  ctx: SurfaceRunContext,
  timeoutMs: number,
  flowName: string,
  options: AgentCliRunOptions,
  flowAllowlist: ReadonlySet<string>,
): Promise<AgentOperatorProjectedFlowEnvelope> {
  const mode = assertRunMode(options);
  const name = assertAllowedFlowName(flowName, flowAllowlist);
  const envelope = await runCliInvocation<AgentOperatorFlowEnvelope>(ctx, {
    args: buildArgv({
      method: "flowRun",
      flowName: name,
      dryRun: mode === "dry-run",
    }),
    timeoutMs,
    isAcceptableExitCode: () => true,
    parse: parseFlowEnvelope,
    // The ONE method that opts into process-group teardown, in both modes.
    // A flow spawns each step as a grandchild of the `m3l` CLI, and `m3l`
    // survives the first SIGTERM by design, so a child-scoped kill leaves a
    // step mutating AWS after `flowRun` has already rejected. See
    // `lib/cli-process.ts`'s `CliTeardownScope`.
    teardown: "group",
  });
  return projectFlowEnvelope(
    envelope,
    buildProjectionOptions(ctx.workspaceRoot),
  );
}

/**
 * Reads ONE of `deps`' three OPTIONAL keys, treating an inherited value as
 * absent: the property is read only when the bag OWNS it, so a
 * prototype-supplied value resolves to `undefined` and each key's documented
 * omission fallback applies unchanged. An OWN value still wins over an
 * inherited one — `Object.hasOwn` decides only whether the read happens.
 *
 * Why, rather than a plain dot read: a dot read walks the prototype chain,
 * and these three keys are the ones a caller is entitled to omit, so the
 * chain is consulted on exactly the calls that never named them. Both
 * directions found here are worse than hygiene. An inherited `runProcess`
 * REPLACED THE SPAWN FUNCTION for all six methods, making the polluter the
 * process that every CLI call runs through; an inherited `workspaceRoot`
 * anchored `run`'s `--preset=` path under a directory the polluter chose,
 * and a mutating run takes every parameter value from that preset file. An
 * inherited `signal` forges an abort channel the caller never handed over.
 *
 * Same rule, same reason as {@link assertRunMode}'s `mode` gate above, as
 * `packages/m3l-common/src/internal/agent/decide.ts` on every policy field
 * it reads, and as `lib/cli-envelopes.ts` on parsed CLI output — see
 * `decide.ts` for the recorded incident behind the rule.
 *
 * @param bag - The caller's construction options.
 * @param key - The optional key to read.
 * @returns The own value, or `undefined` when the bag does not own the key.
 */
function readOwnOptionalDep<
  K extends "runProcess" | "workspaceRoot" | "signal",
>(
  bag: CreateAgentCliSurfaceOptions,
  key: K,
): CreateAgentCliSurfaceOptions[K] | undefined {
  return Object.hasOwn(bag, key) ? bag[key] : undefined;
}

/**
 * The closed set of {@link CreateAgentCliSurfaceOptions} keys
 * {@link assertSurfaceDeps} validates. Mirrors `readOwnOptionalDep`'s
 * `K extends ...` generic pattern, naming the ten REQUIRED keys instead of
 * the three optional ones.
 */
type RequiredSurfaceDepKey =
  | "entrypoint"
  | "cwd"
  | "nodeExecPath"
  | "cliTimeoutMs"
  | "dryRunTimeoutMs"
  | "flowTimeoutMs"
  | "maxOutputBytes"
  | "dryRunAllowlist"
  | "presetAllowlist"
  | "flowAllowlist";

/**
 * Mints the fixed rejection for a required constructor dependency. One
 * message and code cover every failure mode — absent, inherited from a
 * polluted `Object.prototype`, and present-but-wrong-typed — so the text
 * cannot be used to distinguish which of the three fired. The field NAME is
 * interpolated (never the caller-supplied VALUE): the ten required keys are
 * this module's OWN closed vocabulary, not caller-supplied text, so naming
 * one is safe and is the whole diagnostic value — an operator reading this
 * error needs to know WHICH dependency was rejected, not what value reached
 * it.
 */
function buildDepError(field: RequiredSurfaceDepKey): M3LAgentOperatorCliError {
  return new M3LAgentOperatorCliError(
    `the required '${field}' dependency is missing, was inherited rather than an own property, or has an unexpected type`,
    "ERR_AGENT_OPERATOR_CONFIG",
    { context: { field } },
  );
}

/**
 * Reads ONE of `deps`' TEN required keys, gated on `Object.hasOwn` exactly
 * as {@link readOwnOptionalDep} gates the three optional ones — a plain dot
 * read walks the prototype chain, so `Object.prototype.<key> = value` would
 * make every caller who never wrote `key` read `value` anyway (the same
 * incident class {@link assertRunMode} documents for `options.mode`). Unlike
 * `readOwnOptionalDep`, a required key has no absent-is-fine fallback: an
 * own-property miss throws {@link buildDepError} rather than returning
 * `undefined`.
 *
 * Returns `unknown`, not the field's declared type: the caller reached this
 * state through a cast (issue #1019's whole premise), so the declared
 * interface type is a claim the runtime value may not honour. Every
 * `require*` helper built on this one re-validates the raw value with a real
 * `typeof`/`instanceof` check rather than trusting the cast — an already
 * `string`/`number`-typed return here would make that check read as
 * statically unreachable to the linter, even though it is the whole point.
 *
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when `bag` does not own `key`.
 */
function requireOwnDep(
  bag: CreateAgentCliSurfaceOptions,
  key: RequiredSurfaceDepKey,
): unknown {
  if (!Object.hasOwn(bag, key)) {
    throw buildDepError(key);
  }
  return bag[key];
}

/**
 * Validates one of the three path-shaped required keys (`entrypoint`, `cwd`,
 * `nodeExecPath`): a non-empty string. Deliberately does NOT require an
 * ABSOLUTE path — both this module's real construction sites and
 * `config.ts` allow a relative `cliEntrypoint` in standalone mode, and
 * enforcing absoluteness here would be a behaviour change beyond this
 * guard's scope.
 */
function requireNonEmptyString(
  bag: CreateAgentCliSurfaceOptions,
  key: Extract<RequiredSurfaceDepKey, "entrypoint" | "cwd" | "nodeExecPath">,
): string {
  const raw = requireOwnDep(bag, key);
  if (typeof raw !== "string" || raw.length === 0) {
    throw buildDepError(key);
  }
  return raw;
}

/**
 * Validates one of the four timeout/byte-cap required keys: a finite,
 * strictly positive integer. `Number.isInteger` alone rejects `NaN` and
 * `±Infinity` (neither is an integer) and any fraction; combined with the
 * `> 0` check it also rejects zero and every negative value.
 */
function requirePositiveInteger(
  bag: CreateAgentCliSurfaceOptions,
  key: Extract<
    RequiredSurfaceDepKey,
    "cliTimeoutMs" | "dryRunTimeoutMs" | "flowTimeoutMs" | "maxOutputBytes"
  >,
): number {
  const raw = requireOwnDep(bag, key);
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw buildDepError(key);
  }
  return raw;
}

/**
 * Validates one of the two `Set`-shaped required keys (`dryRunAllowlist`,
 * `flowAllowlist`): the CONTAINER's identity, never its elements. Checking
 * `instanceof Set` rather than duck-typing (e.g. a `.has` method) is
 * load-bearing — a polluted `Object.prototype` can forge a `.has` method
 * exactly as easily as any other property, so only a real identity check
 * closes that gap. Element types are deliberately NOT checked here: every
 * name reaching `.has()` is validated on its own path
 * (`assertUsableScriptName`, `assertAllowedFlowName`), so re-checking each
 * element here would only be a second, driftable copy of that check. Empty
 * is legal — see `CreateAgentCliSurfaceOptions.presetAllowlist`'s own TSDoc
 * on why a required-but-possibly-empty allowlist is a deliberate "declared
 * closed" state, not an oversight; the same reasoning applies to both `Set`
 * fields.
 *
 * Returns the SAME reference passed in, never a copy: a caller-constructed
 * `Set` subclass with overridden behaviour must keep behaving that way
 * through this surface, for the same reason {@link requireStringMap}
 * preserves `presetAllowlist`'s identity.
 */
function requireStringSet(
  bag: CreateAgentCliSurfaceOptions,
  key: Extract<RequiredSurfaceDepKey, "dryRunAllowlist" | "flowAllowlist">,
): ReadonlySet<string> {
  const raw = requireOwnDep(bag, key);
  if (!(raw instanceof Set)) {
    throw buildDepError(key);
  }
  return raw;
}

/**
 * Validates `presetAllowlist`: the CONTAINER's identity (`instanceof Map`),
 * never its entries — `resolveAllowedPresetPath` already re-validates every
 * entry's value at use time via `isDeclarablePresetPath`, so duplicating
 * that check here would create a second, driftable copy of it. Empty is
 * legal (see that field's own TSDoc).
 *
 * Returns the SAME reference passed in, never a copy into a fresh `Map`:
 * `cli-surface.test.ts`'s "run() does not launder an unexpected internal
 * error" regression test constructs a `ThrowingAllowlist extends Map` whose
 * overridden `get()` throws a bare `TypeError` on purpose, and asserts that
 * `TypeError` propagates unchanged. A snapshot built with
 * `new Map(deps.presetAllowlist)` would silently defeat that override — the
 * copy's `.get()` would be the ordinary `Map.prototype.get`, not the
 * caller's — so identity must be preserved end to end.
 */
function requireStringMap(
  bag: CreateAgentCliSurfaceOptions,
  key: Extract<RequiredSurfaceDepKey, "presetAllowlist">,
): ReadonlyMap<string, string> {
  const raw = requireOwnDep(bag, key);
  if (!(raw instanceof Map)) {
    throw buildDepError(key);
  }
  return raw;
}

/**
 * The construction-time snapshot of all TEN required
 * {@link CreateAgentCliSurfaceOptions} keys, validated exactly once by
 * {@link assertSurfaceDeps} and consumed by every method closure
 * `createAgentCliSurface` returns — never `deps` again.
 */
interface ValidatedSurfaceDeps {
  readonly entrypoint: string;
  readonly cwd: string;
  readonly nodeExecPath: string;
  readonly cliTimeoutMs: number;
  readonly dryRunTimeoutMs: number;
  readonly flowTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly dryRunAllowlist: ReadonlySet<string>;
  readonly presetAllowlist: ReadonlyMap<string, string>;
  readonly flowAllowlist: ReadonlySet<string>;
}

/**
 * Validates all TEN required {@link CreateAgentCliSurfaceOptions} keys and
 * returns a frozen snapshot — the single read-and-validate pass that closes
 * issue #1019.
 *
 * Why a snapshot, not "validate up front, then keep reading `deps`": a
 * construction-time check and a later per-method read are two SEPARATE
 * reads of the same property, and nothing forces them to agree. A getter
 * can answer the construction-time check with an honest value and a later
 * read with a hostile one; a caller holding the same object
 * `createAgentCliSurface` was given can mutate it after construction
 * returns. Reading each key exactly ONCE, here, and threading only the
 * validated local onward through {@link ValidatedSurfaceDeps} is what makes
 * "validated" and "used" the same read rather than two reads of a moving
 * target — the same single-read invariant {@link assertRunMode} documents
 * for `options.mode`.
 *
 * Every branch this function's own complexity would otherwise carry lives
 * in the `require*` helpers above it instead: this function is ten
 * straight-line declarations and a freeze, deliberately, to stay well under
 * this file's `complexity`/`max-depth`/`max-lines-per-function` ESLint caps.
 *
 * Field order matches {@link CreateAgentCliSurfaceOptions}'s own declaration
 * order — the ordering carries no runtime significance (every one of the ten
 * checks is independent), but keeping it fixed makes a diff against the
 * interface easy to eyeball.
 */
function assertSurfaceDeps(
  deps: CreateAgentCliSurfaceOptions,
): ValidatedSurfaceDeps {
  const entrypoint = requireNonEmptyString(deps, "entrypoint");
  const cwd = requireNonEmptyString(deps, "cwd");
  const nodeExecPath = requireNonEmptyString(deps, "nodeExecPath");
  const cliTimeoutMs = requirePositiveInteger(deps, "cliTimeoutMs");
  const dryRunTimeoutMs = requirePositiveInteger(deps, "dryRunTimeoutMs");
  const flowTimeoutMs = requirePositiveInteger(deps, "flowTimeoutMs");
  const maxOutputBytes = requirePositiveInteger(deps, "maxOutputBytes");
  const dryRunAllowlist = requireStringSet(deps, "dryRunAllowlist");
  const presetAllowlist = requireStringMap(deps, "presetAllowlist");
  const flowAllowlist = requireStringSet(deps, "flowAllowlist");
  return Object.freeze({
    entrypoint,
    cwd,
    nodeExecPath,
    cliTimeoutMs,
    dryRunTimeoutMs,
    flowTimeoutMs,
    maxOutputBytes,
    dryRunAllowlist,
    presetAllowlist,
    flowAllowlist,
  });
}

/**
 * Creates the typed, model-safe {@link AgentCliSurface} adapter over the
 * `m3l` CLI. Every method validates its script-name argument (and, for
 * `dryRun`, the `dryRunAllowlist`; for `run` and `triageRun` alike, the
 * `presetAllowlist` and the `workspaceRoot` needed to anchor its path)
 * BEFORE building argv or spawning anything — a rejected call never reaches
 * `runCliProcess`.
 *
 * @param deps - Spawn configuration, timeouts, the two allowlists, and an
 *   optional `runProcess` test seam. All ten required keys are read and
 *   validated exactly once, here, by {@link assertSurfaceDeps} — every
 *   returned method consumes that one validated snapshot, never `deps`
 *   itself, so neither a prototype-inherited value nor reassigning one of
 *   the ten required properties on `deps` after construction can reach a
 *   later call. That snapshot holds each allowlist `Set`/`Map` by
 *   reference, not by copy — deliberately, so a `Map` subclass with a
 *   live-overridden `get` keeps working through `run`/`flowRun` — so a
 *   caller that retains and later mutates the CONTENTS of an allowlist it
 *   passed in (`.set(...)`, `.add(...)`, `.delete(...)`, `.clear()`) DOES
 *   reach a later call. Treat every `Set`/`Map` handed to this constructor
 *   as owned by the returned surface for its lifetime.
 * @returns The seven-method {@link AgentCliSurface}.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   when a required dependency is missing (including one only present via
 *   `Object.prototype`) or is present but wrong-typed.
 * @example
 * ```ts
 * import { createAgentCliSurface } from "./cli-surface.js";
 *
 * const surface = createAgentCliSurface({
 *   entrypoint: "/repo/packages/m3l-cli/bin/m3l.mjs",
 *   cwd: "/repo",
 *   nodeExecPath: process.execPath,
 *   cliTimeoutMs: 30_000,
 *   dryRunTimeoutMs: 120_000,
 *   flowTimeoutMs: 600_000,
 *   maxOutputBytes: 1_048_576,
 *   dryRunAllowlist: new Set(["json-etl"]),
 *   presetAllowlist: new Map([
 *     ["nightly", "data/config/presets/json-etl/nightly.json"],
 *   ]),
 *   flowAllowlist: new Set(["json-etl-flow"]),
 *   workspaceRoot: "/repo",
 * });
 *
 * const rows = await surface.list();
 * const envelope = await surface.run("json-etl", "nightly", {
 *   mode: "mutate",
 * });
 * ```
 */
export function createAgentCliSurface(
  deps: CreateAgentCliSurfaceOptions,
): AgentCliSurface {
  // FIRST statement — throws before anything else touches `deps`. Every
  // downstream read below consumes `validated`, never `deps` again; see
  // `assertSurfaceDeps`'s own TSDoc for why that single read is the fix.
  const validated = assertSurfaceDeps(deps);
  const ctx: SurfaceRunContext = {
    entrypoint: validated.entrypoint,
    cwd: validated.cwd,
    nodeExecPath: validated.nodeExecPath,
    maxOutputBytes: validated.maxOutputBytes,
    // The three OPTIONAL keys go through `readOwnOptionalDep`, so an
    // inherited value cannot stand in for one the caller omitted; see its
    // TSDoc for the two harms that made this more than hygiene.
    workspaceRoot: readOwnOptionalDep(deps, "workspaceRoot"),
    signal: readOwnOptionalDep(deps, "signal"),
    runProcess: readOwnOptionalDep(deps, "runProcess") ?? runCliProcess,
  };

  return {
    list: () => runList(ctx, validated.cliTimeoutMs),
    doctor: () => runDoctor(ctx, validated.cliTimeoutMs),
    inspect: (scriptName) =>
      runInspect(ctx, validated.cliTimeoutMs, scriptName),
    dryRun: (scriptName) =>
      runDryRun(
        ctx,
        validated.dryRunTimeoutMs,
        scriptName,
        validated.dryRunAllowlist,
      ),
    // `run` shares `dryRunTimeoutMs`, not `cliTimeoutMs`: like `dryRun` it
    // spawns a whole script, whose config load and work dwarf a `list`.
    run: (scriptName, presetName, options) =>
      runRun(
        ctx,
        validated.dryRunTimeoutMs,
        scriptName,
        presetName,
        validated.presetAllowlist,
        options,
      ),
    // Same reason as `run` above: `triageRun` also spawns a whole script.
    triageRun: (scriptName, presetName, operatorProfile) =>
      runTriageRun(
        ctx,
        validated.dryRunTimeoutMs,
        scriptName,
        presetName,
        operatorProfile,
        validated.presetAllowlist,
      ),
    // `flowRun` uses its own `flowTimeoutMs`, not `dryRunTimeoutMs`: a flow
    // spawns N scripts sequentially, so the single-script budget the other
    // methods share is the wrong unit — see `flowTimeoutMs`'s own TSDoc.
    flowRun: (flowName, options) =>
      runFlowRun(
        ctx,
        validated.flowTimeoutMs,
        flowName,
        options,
        validated.flowAllowlist,
      ),
  };
}
