/**
 * `lib/cli-surface` — the typed adapter over `lib/cli-process.ts`. This is
 * the **only** consumer of `runCliProcess`; it owns the argv table, the
 * per-method exit-code acceptance policy, and all error minting for the five
 * agent-facing CLI operations (`list`, `doctor`, `inspect`, `dryRun`, `run`).
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
 * Net effect: the model supplies exactly two values that can influence a
 * token across the whole tool surface — a script name and, for `run` alone, a
 * preset *name*. (`run`'s `mode` is a third caller-supplied value, but it is
 * never interpolated: it selects whether a FIXED `--dry-run` token is
 * appended, and it is narrowed to one of two literals at runtime by
 * `assertRunMode` before argv is built — see {@link AgentCliRunOptions}.) It never
 * supplies a path: `run`'s `--preset=` token is looked up from the
 * operator's own `presetAllowlist` and anchored to `workspaceRoot` here, so
 * the model names a key and this module resolves the file. Distinct nominal
 * brands hold that chain together, and each one occupies a real
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

import { Core } from "@m3l-automation/m3l-common";

import {
  parseDoctorChecks,
  parseJsonText,
  parseListRows,
  parseParamDescriptors,
  parseRunEnvelope,
  type AgentOperatorDoctorCheck,
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
} from "./cli-process.js";
import { M3LAgentOperatorCliError } from "./errors.js";
import {
  AGENT_OPERATOR_PATH_SEPARATOR_RE,
  AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX,
  assertAllowedPresetName,
  isWellFormedPresetPathShape,
  type AgentOperatorPresetName,
  type AgentOperatorPresetPath,
} from "./preset-names.js";
import {
  projectDoctorReport,
  projectListRow,
  projectParamDescriptor,
  projectRunEnvelope,
  type AgentOperatorProjectedDoctorReport,
  type AgentOperatorProjectedListRow,
  type AgentOperatorProjectedParamDescriptor,
  type AgentOperatorProjectedRunEnvelope,
  type AgentOperatorProjectionOptions,
} from "./model-safety.js";

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

/** One method's fixed argv, timeout, exit-code policy, and output parser. */
interface CliInvocationSpec<T> {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly isAcceptableExitCode: (exitCode: number | null) => boolean;
  readonly parse: (raw: unknown) => ParseResult<T>;
}

/**
 * The argv table — a closed, discriminated union over the five operations.
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
 * Whether one `presetAllowlist` entry is a declarable preset path:
 * well-shaped per {@link isWellFormedPresetPathShape}, relative, free of any
 * `..` segment, and naming a file inside
 * {@link AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX}.
 *
 * Both the shape predicate and the directory boundary are imported from
 * `lib/preset-names.ts`, shared with `steps/resolve-runtime.ts`'s config
 * parser, so the two cannot drift into accepting different sets. Sharing the
 * constant alone was not enough and is what a review caught: the parser
 * rejected a whitespace-padded, NUL-bearing or newline-bearing declared path
 * while this check — the one a directly-constructed `ReadonlyMap` actually
 * passes through — accepted it and emitted a token. Calling the shared
 * predicate rather than restating its rules is what keeps this site from
 * being the looser of the two again.
 *
 * Sharing the rules is still not sharing the check: this remains a deliberate
 * use-site re-check, for the reason {@link resolveAllowedPresetPath}
 * documents.
 *
 * The `..` ban is stricter than "where does it land" —
 * `data/config/presets/sub/../x.json` normalises back inside the directory
 * and is still rejected — because the declared string is the artifact an
 * operator reviews in a config diff, and a symlinked `sub/` would make the
 * reviewed string and the resolved path genuinely disagree.
 */
function isDeclarablePresetPath(relativePath: string): boolean {
  return (
    // Shape first: a padded or control-character-bearing value is not a path
    // this script accepts anywhere, and checking it here rather than after
    // containment keeps the reason the parser would have given.
    isWellFormedPresetPathShape(relativePath) &&
    !path.isAbsolute(relativePath) &&
    // A win32-style absolute (`C:\...`) is not absolute on a POSIX host, so
    // the prefix check below is what rejects it — it cannot start with
    // `data/config/presets/`.
    !relativePath.split(AGENT_OPERATOR_PATH_SEPARATOR_RE).includes("..") &&
    // The compared prefix carries its trailing separator: without it, a bare
    // `startsWith("data/config/presets")` also accepts
    // `data/config/presetsevil/report.json`, a different directory that
    // merely shares the prefix as text.
    relativePath.startsWith(AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX) &&
    // The prefix and nothing else names the DIRECTORY, not a file in it;
    // `--preset=<a directory>` is never a preset the CLI can load.
    relativePath.length > AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX.length
  );
}

/**
 * Resolves an already-validated preset name into the ABSOLUTE path `run` may
 * emit, and is the ONLY function permitted to mint an
 * {@link AgentOperatorPresetPath}. The name must be a key of
 * `presetAllowlist`, the surface must carry an ABSOLUTE, `..`-free
 * `workspaceRoot`, and the stored entry must still satisfy
 * {@link isDeclarablePresetPath} — those checks are what the brand records.
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
 * `..` ban {@link isDeclarablePresetPath} applies to the entry half — the two
 * halves of one `path.join` must not be checked by two different rules.
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
  });
  return projectRunEnvelope(
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
 * REPLACED THE SPAWN FUNCTION for all five methods, making the polluter the
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
 * Creates the typed, model-safe {@link AgentCliSurface} adapter over the
 * `m3l` CLI. Every method validates its script-name argument (and, for
 * `dryRun`, the `dryRunAllowlist`; for `run`, the `presetAllowlist` and the
 * `workspaceRoot` needed to anchor its path) BEFORE building argv or
 * spawning anything — a rejected call never reaches `runCliProcess`.
 *
 * @param deps - Spawn configuration, timeouts, the two allowlists, and an
 *   optional `runProcess` test seam.
 * @returns The five-method {@link AgentCliSurface}.
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
 *   maxOutputBytes: 1_048_576,
 *   dryRunAllowlist: new Set(["json-etl"]),
 *   presetAllowlist: new Map([
 *     ["nightly", "data/config/presets/json-etl/nightly.json"],
 *   ]),
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
  const ctx: SurfaceRunContext = {
    entrypoint: deps.entrypoint,
    cwd: deps.cwd,
    nodeExecPath: deps.nodeExecPath,
    maxOutputBytes: deps.maxOutputBytes,
    // The three OPTIONAL keys go through `readOwnOptionalDep`, so an
    // inherited value cannot stand in for one the caller omitted; see its
    // TSDoc for the two harms that made this more than hygiene.
    workspaceRoot: readOwnOptionalDep(deps, "workspaceRoot"),
    signal: readOwnOptionalDep(deps, "signal"),
    runProcess: readOwnOptionalDep(deps, "runProcess") ?? runCliProcess,
  };

  return {
    list: () => runList(ctx, deps.cliTimeoutMs),
    doctor: () => runDoctor(ctx, deps.cliTimeoutMs),
    inspect: (scriptName) => runInspect(ctx, deps.cliTimeoutMs, scriptName),
    dryRun: (scriptName) =>
      runDryRun(ctx, deps.dryRunTimeoutMs, scriptName, deps.dryRunAllowlist),
    // `run` shares `dryRunTimeoutMs`, not `cliTimeoutMs`: like `dryRun` it
    // spawns a whole script, whose config load and work dwarf a `list`.
    run: (scriptName, presetName, options) =>
      runRun(
        ctx,
        deps.dryRunTimeoutMs,
        scriptName,
        presetName,
        deps.presetAllowlist,
        options,
      ),
  };
}
