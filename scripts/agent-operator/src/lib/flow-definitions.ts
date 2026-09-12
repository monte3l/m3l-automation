/**
 * `lib/flow-definitions` — the verification seam that turns an
 * operator-declared `flowAllowlist` (a bare `ReadonlySet<string>` of flow
 * NAMES, unlike `lib/triage-presets.ts`'s `name -> path` map) into a
 * {@link VerifiedFlowNames} brand plus the single {@link VerifiedFlowTarget.gradedProfile}
 * every allowlisted flow's steps agree on.
 *
 * @remarks
 * Mirrors `lib/triage-presets.ts` in structure: a brand whose only mint site
 * is the verifier, so skipping verification is a compile error rather than a
 * discipline a caller has to remember. It differs from that module in one
 * load-bearing way: a flow definition's `aws.profile` is NOT refused outright
 * the way a triage preset's own `aws.profile` key is. Flow step parameters
 * are rendered as argv tokens by `packages/m3l-cli`'s `flow/step.ts` —
 * config-resolution precedence level 1, the CLI itself — so a declared step
 * profile is authoritative for that grandchild process, and there is no
 * operator-supplied `--aws.profile` token this seam could pin instead
 * (`m3l flow` rejects every extra argument). The graded target therefore has to
 * come FROM the verified definition, never be re-derived by the caller: two
 * readers of the same fact diverge, the defect class earlier slices in this
 * script were built to close.
 *
 * **There is deliberately no containment refusal here**, unlike
 * `triage-presets.ts`'s `isDeclarablePresetPath` check. A preset allowlist
 * maps a name to an arbitrary, unvalidated relative *path*, so a containment
 * escape is representable and must be refused. A flow allowlist holds only
 * *names*, and `lib/flow-names.ts`'s `assertAllowedFlowName` (reused below,
 * never restated) already rejects any name containing `.` or `/` before this
 * module ever forms a path — its `AGENT_OPERATOR_FLOW_NAME_RE` slug pattern
 * admits only `[a-z0-9]` segments joined by single interior hyphens. By the
 * time a name survives that check it cannot carry a traversal segment or an
 * extension at all, so a containment check here would be dead code asserting
 * a condition that cannot occur. That regex is doing DOUBLE duty — it stops a
 * name from spoofing an argv flag (`m3l flow`'s own positional-argument
 * parser skips any `-`-prefixed token rather than reading it as a name) AND
 * it stops a name from being a traversal segment. Both jobs matter: a future
 * reader relaxing the regex for "just" the flag-spoofing reason would
 * silently reopen the traversal hole this module's own extension-resolution
 * step below relies on staying closed.
 *
 * Resolution appends `.yaml` itself and never probes an alternative:
 * `packages/m3l-cli`'s `flow/load.ts` declares `FLOW_EXTENSION` as `.yaml`
 * ONLY — no `.yml`, unlike `triage-presets.ts`'s preset loader, which accepts
 * both. Querying `.yml` here would verify bytes the loader would never read.
 *
 * ## Three layers of authority, and refusal 7 closes the gap between them
 *
 * A flow step's authority to run is not one fact but three, and each layer
 * is owned by a different piece of config:
 *
 * 1. **Which flows an operator allowlists** — `deps.flowAllowlist`, the
 *    runtime-resolved `flowAllowlist` config parameter this module verifies
 *    entry-by-entry.
 * 2. **Which commands the committed flow definition declares** — the
 *    `steps` array `readFlowSteps` parses out of
 *    `data/config/flows/<name>.yaml`, each step naming a `script`.
 * 3. **Which scripts the per-script policy grants permit to run at all** —
 *    `deps.policy.scripts`, the same declaration `Core.evaluateAgentAction`
 *    reads for every OTHER `agent-operator` operation.
 *
 * Before refusal 7, only layers 1 and 2 were checked here. A flow step runs
 * as a GRANDCHILD of `m3l flow run` (`packages/m3l-cli`'s `flow/step.ts`
 * shells out per step), so the only grant actually consulted at execution
 * time was the single `{"script": "m3l", "operations": ["run"]}` entry
 * layer 3 declares for the PARENT process — never the per-step script's own
 * grant. A committed flow definition (layer 2) could therefore name any
 * script at all, regardless of what that script's own grant in `scripts`
 * (layer 3) permits, making the `m3l run` grant an effective wildcard over
 * every script any allowlisted flow names. Refusal 7 closes exactly that
 * gap: it re-checks layer 2 against layer 3 directly, requiring every
 * distinct step script to hold its OWN `run` grant, so the committed
 * definition can never exceed what the per-script policy independently
 * permits.
 *
 * @packageDocumentation
 */

import { join } from "node:path";

import type { Core } from "@monte3l/m3l-common";

import { M3LAgentOperatorCliError } from "./errors.js";
import { assertAllowedFlowName } from "./flow-names.js";

declare const VERIFIED_FLOW_NAMES: unique symbol;

/**
 * A `flowAllowlist` that has already passed every refusal
 * {@link verifyFlowNames} performs — minted there and nowhere else. The brand
 * is a **compile-time-only** device, erased by `tsc`; the guarantee it
 * stands for is enforced entirely by {@link verifyFlowNames}, the only
 * function permitted to produce one.
 *
 * @example
 * ```ts
 * import type { VerifiedFlowNames } from "./flow-definitions.js";
 *
 * // A function that requires proof every name already passed verification,
 * // rather than a raw, unchecked allowlist.
 * function useVerifiedFlows(flows: VerifiedFlowNames): void {
 *   for (const name of flows) {
 *     void name;
 *   }
 * }
 * ```
 */
export type VerifiedFlowNames = ReadonlySet<string> & {
  readonly [VERIFIED_FLOW_NAMES]: unique symbol;
};

/**
 * The provider surface {@link verifyFlowNames} needs from one resolved flow
 * definition file — exactly `Core.M3LYAMLConfigProvider`'s public shape, and
 * injected for the same reason `lib/triage-presets.ts`'s `TriagePresetReader`
 * is: the seam is exercisable in a test without touching disk.
 *
 * @example
 * ```ts
 * import type { FlowDefinitionReader } from "./flow-definitions.js";
 *
 * const reader: FlowDefinitionReader = {
 *   rawKeys: () => ["steps"],
 *   getRawValue: (key) => (key === "steps" ? [] : undefined),
 * };
 * ```
 */
export interface FlowDefinitionReader {
  rawKeys(): readonly string[];
  getRawValue(key: string): unknown;
}

/**
 * Dependencies {@link verifyFlowNames} needs to check every allowlist entry.
 * Exported for the same reason as {@link FlowDefinitionReader}: a caller
 * building its own `deps` object — in a test or a real wiring site — can
 * annotate it by name.
 *
 * @example
 * ```ts
 * import { Core } from "@monte3l/m3l-common";
 * import type { VerifyFlowNamesDeps } from "./flow-definitions.js";
 *
 * const deps: VerifyFlowNamesDeps = {
 *   flowAllowlist: new Set(["dlq-reconcile"]),
 *   workspaceRoot: "/workspace/m3l-automation",
 *   readProvider: (absolutePath) => new Core.M3LYAMLConfigProvider(absolutePath),
 *   declaredParameters: async (scriptName) => {
 *     void scriptName;
 *     return ["aws.profile"];
 *   },
 *   policy: Core.validateAgentPolicy({
 *     version: 1,
 *     scripts: [{ script: "sqs-etl", operations: ["run"] }],
 *   }),
 * };
 * ```
 */
export interface VerifyFlowNamesDeps {
  /** The operator-declared set of flow names permitted to run. */
  readonly flowAllowlist: ReadonlySet<string>;
  /** The absolute directory every flow name is resolved against, at `<workspaceRoot>/data/config/flows/<name>.yaml`. */
  readonly workspaceRoot: string;
  /**
   * Builds the reader for one resolved absolute flow-definition path.
   * Injected so tests need no filesystem; a real caller passes a function
   * constructing `Core.M3LYAMLConfigProvider`.
   */
  readonly readProvider: (absolutePath: string) => FlowDefinitionReader;
  /**
   * Per-step-script parameter census: the parameter NAMES a script declares.
   * Backed by `surface.inspect` in production. Closes the hole where a step
   * omitting `aws.profile` would resolve `AWS_PROFILE` from the inherited
   * environment at config-resolution precedence level 4, ungraded.
   */
  readonly declaredParameters: (
    scriptName: string,
  ) => Promise<readonly string[]>;
  /**
   * The loaded deployment policy — layer 3 of the module remarks' three-layer
   * authority model. Backs refusal 7: every distinct step `script` across the
   * definition must hold its OWN `run` grant here, closing the gap where a
   * flow step running as a grandchild of `m3l flow run` was authorized
   * solely by the parent `m3l`/`run` grant regardless of what the step's own
   * script is permitted to do.
   */
  readonly policy: Core.M3LAgentPolicy;
}

/**
 * The raw config key every flow step's declared AWS profile lives under, and
 * the key {@link VerifiedFlowTarget.gradedProfile} is derived from.
 *
 * @example
 * ```ts
 * import { RECONCILE_GRADED_PROFILE_KEY } from "./flow-definitions.js";
 *
 * RECONCILE_GRADED_PROFILE_KEY; // "aws.profile"
 * ```
 */
export const RECONCILE_GRADED_PROFILE_KEY = "aws.profile";

/**
 * The result of a successful {@link verifyFlowNames} call: the verified
 * allowlist AND the single AWS profile every allowlisted flow's steps agree
 * on. Returned as a pair rather than the brand alone — the graded profile is
 * a PRODUCT of verification (refusals 5 and 6 below are what make "the
 * single value" a safe thing to say at all) and must not be re-derived by a
 * caller from the raw allowlist a second time. A caller re-deriving it would
 * be a second reader of the same fact, exactly the class of bug that has bit
 * three earlier slices of this script.
 *
 * @example
 * ```ts
 * import type { VerifiedFlowTarget } from "./flow-definitions.js";
 *
 * function describeTarget(target: VerifiedFlowTarget): string {
 *   return `${target.flows.size} flow(s) graded against ${target.gradedProfile}`;
 * }
 * ```
 */
export interface VerifiedFlowTarget {
  readonly flows: VerifiedFlowNames;
  readonly gradedProfile: string;
}

/** One flow step's `script` plus its raw, as-authored `parameters`. */
interface RawFlowStep {
  readonly script: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** One resolved step tagged with the flow name it came from, for rejection messages. */
interface ResolvedStep {
  readonly flowName: string;
  readonly step: RawFlowStep;
}

/**
 * Throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_FLOW`
 * naming `flowName` (operator-authored config data, safe to echo) with a
 * fixed, value-free reason. Never echoes a rejected VALUE — every thrown
 * message and context is built from fixed strings and the flow NAME alone.
 */
function rejectFlow(flowName: string, reason: string, cause?: unknown): never {
  throw new M3LAgentOperatorCliError(
    `flow "${flowName}" ${reason}`,
    "ERR_AGENT_OPERATOR_FLOW",
    { context: { flowName }, cause },
  );
}

/**
 * Reuses {@link assertAllowedFlowName} for the shape-and-membership check
 * (refusal 2), translating whatever it throws — always coded
 * `ERR_AGENT_OPERATOR_CONFIG`, a code that belongs to the standalone
 * `flow-names` seam — onto this module's own `ERR_AGENT_OPERATOR_FLOW`, so a
 * catch site narrowing on this module's code sees one consistent family.
 */
function assertFlowNameOnAllowlist(
  flowName: string,
  allowlist: ReadonlySet<string>,
): void {
  try {
    assertAllowedFlowName(flowName, allowlist);
  } catch (cause) {
    rejectFlow(flowName, "is not an allowed flow name", cause);
  }
}

/** Parses one raw step value into a {@link RawFlowStep}, refusing a malformed shape. */
function parseFlowStep(flowName: string, rawStep: unknown): RawFlowStep {
  if (typeof rawStep !== "object" || rawStep === null) {
    rejectFlow(flowName, "declares a step that is not an object");
  }
  const record = rawStep as Record<string, unknown>;
  const rawScript: unknown = Object.hasOwn(record, "script")
    ? record["script"]
    : undefined;
  if (typeof rawScript !== "string") {
    rejectFlow(flowName, "declares a step with no string script");
  }
  const rawParameters: unknown = Object.hasOwn(record, "parameters")
    ? record["parameters"]
    : {};
  if (typeof rawParameters !== "object" || rawParameters === null) {
    rejectFlow(flowName, "declares a step with a non-object parameters value");
  }
  return {
    script: rawScript,
    parameters: rawParameters as Readonly<Record<string, unknown>>,
  };
}

/** Parses a flow definition's raw `steps` value, refusing anything that is not an array. */
function parseFlowSteps(
  flowName: string,
  rawSteps: unknown,
): readonly RawFlowStep[] {
  if (!Array.isArray(rawSteps)) {
    rejectFlow(flowName, "declares a non-array steps value");
  }
  return rawSteps.map((rawStep: unknown) => parseFlowStep(flowName, rawStep));
}

/**
 * Resolves `<workspaceRoot>/data/config/flows/<flowName>.yaml`, reads it
 * through `deps.readProvider`, and parses its `steps`. Never probes `.yml` —
 * see the module remarks on why `.yaml` is the only extension
 * `flow/load.ts` ever reads.
 */
function readFlowSteps(
  flowName: string,
  deps: VerifyFlowNamesDeps,
): readonly RawFlowStep[] {
  const absolutePath = join(
    deps.workspaceRoot,
    "data",
    "config",
    "flows",
    `${flowName}.yaml`,
  );
  const reader = deps.readProvider(absolutePath);
  if (!reader.rawKeys().includes("steps")) {
    rejectFlow(flowName, "declares no steps");
  }
  return parseFlowSteps(flowName, reader.getRawValue("steps"));
}

/**
 * Refusal 4: a step declaring `yesSensitive`. That key exists only to bypass
 * `confirmDestructive`'s escalated typed-echo for a sensitive target — the
 * control V6 owns — so operator-declared flow data must not pre-empt it.
 *
 * `yes` is deliberately NOT refused: the agent spawns with
 * `stdio: ["ignore", ...]`, so any confirmation prompt is unanswerable, and
 * every destructive step would otherwise fail outright. `yesSensitive` alone
 * is the escalation bypass this refusal exists to close.
 */
function rejectIfYesSensitive(flowName: string, step: RawFlowStep): void {
  if (Object.hasOwn(step.parameters, "yesSensitive")) {
    rejectFlow(
      flowName,
      "declares a step with yesSensitive, which would bypass the sensitive-target escalation",
    );
  }
}

/**
 * Refusal 5: collects every step's declared {@link RECONCILE_GRADED_PROFILE_KEY}
 * value across every resolved step of every allowlisted flow, and refuses
 * unless exactly ONE distinct value exists. Zero means nothing to grade while
 * the environment could still supply one; two or more cannot be represented
 * by the single `{profile, region?, accountId?}` triple the graded target
 * carries downstream.
 */
function deriveGradedProfile(resolvedSteps: readonly ResolvedStep[]): string {
  const declaredProfiles = new Set<string>();
  for (const { flowName, step } of resolvedSteps) {
    if (!Object.hasOwn(step.parameters, RECONCILE_GRADED_PROFILE_KEY)) {
      continue;
    }
    const value = step.parameters[RECONCILE_GRADED_PROFILE_KEY];
    if (typeof value !== "string") {
      rejectFlow(flowName, "declares a non-string aws.profile value");
    }
    declaredProfiles.add(value);
  }
  if (declaredProfiles.size !== 1) {
    throw new M3LAgentOperatorCliError(
      "flows declare zero or multiple distinct aws.profile values across their steps",
      "ERR_AGENT_OPERATOR_FLOW",
    );
  }
  for (const gradedProfile of declaredProfiles) {
    return gradedProfile;
  }
  // Unreachable: `declaredProfiles.size === 1` was just asserted above, so
  // the loop above always returns. Kept so this function's control flow is
  // exhaustive to `tsc` without a non-null assertion.
  throw new M3LAgentOperatorCliError(
    "flows declare no resolvable aws.profile value",
    "ERR_AGENT_OPERATOR_FLOW",
  );
}

/**
 * Refusal 6: a step omitting {@link RECONCILE_GRADED_PROFILE_KEY} whose
 * script DECLARES that parameter (via `deps.declaredParameters`). Closes the
 * hole where such a step would resolve `AWS_PROFILE` from the inherited
 * environment at config-resolution precedence level 4, ungraded. A step
 * omitting it whose script does not declare it at all is fine — the
 * `json-etl`-shaped case — and is left alone here.
 */
async function rejectIfProfileOmittedButDeclared(
  flowName: string,
  step: RawFlowStep,
  declaredParameters: VerifyFlowNamesDeps["declaredParameters"],
): Promise<void> {
  if (Object.hasOwn(step.parameters, RECONCILE_GRADED_PROFILE_KEY)) {
    return;
  }
  const declared = await declaredParameters(step.script);
  if (declared.includes(RECONCILE_GRADED_PROFILE_KEY)) {
    rejectFlow(
      flowName,
      `declares a step for script "${step.script}" that omits aws.profile though the script declares that parameter`,
    );
  }
}

/**
 * Refusal 7: a step whose `script` is not granted the `run` verb in its OWN
 * policy grant — see the module remarks' three-layer authority model. Closes
 * the authority escalation where a flow step, running as a GRANDCHILD of
 * `m3l flow run`, was authorized solely by the single parent
 * `{"script": "m3l", "operations": ["run"]}` grant, regardless of what the
 * step's own script is permitted to do — making that grant an effective
 * wildcard over every script any allowlisted flow names.
 *
 * A script with no grant at all in `policy.scripts` refuses the same way as
 * one whose grant omits `run`. `allOperations: true` DOES satisfy this
 * check: it is the deployment's own explicit, script-scoped opt-in to every
 * operation for that one script — a deliberate widening the policy author
 * wrote down for that script by name — unlike the parent `m3l`/`run` grant
 * this refusal exists to stop from acting as an accidental one across every
 * script a flow happens to name.
 *
 * The rejection message never echoes the offending script name — the flow
 * NAME alone identifies the failure, per {@link rejectFlow}'s idiom.
 */
function rejectIfStepScriptLacksRunGrant(
  flowName: string,
  step: RawFlowStep,
  policy: Core.M3LAgentPolicy,
): void {
  const grant = policy.scripts.find(
    (candidate) => candidate.script === step.script,
  );
  const grantsRun =
    grant !== undefined &&
    (grant.allOperations === true ||
      (grant.operations?.includes("run") ?? false));
  if (!grantsRun) {
    rejectFlow(
      flowName,
      "declares a step for a script that is not granted the run verb in its own policy grant",
    );
  }
}

/**
 * Verifies every entry of an operator-declared `flowAllowlist` against the
 * refusals documented on this module (an empty allowlist; a name failing
 * {@link assertAllowedFlowName}; a step declaring `yesSensitive`; divergent
 * declared `aws.profile` values across every step of every flow; a step
 * omitting `aws.profile` whose script declares it; a step script not granted
 * the `run` verb in its own policy grant), and returns a
 * {@link VerifiedFlowTarget} once every entry has passed. This is the
 * **only** minting site of {@link VerifiedFlowNames}.
 *
 * Refusals run in a fixed order, cheapest-and-most-structural first: the
 * empty-allowlist check, then per-flow name/shape parsing, then the
 * per-step `yesSensitive` check, THEN the cross-flow `aws.profile`
 * agreement and omission checks, and refusal 7 (the per-script `run` grant
 * check) runs LAST — it is the only refusal that reaches outside the flow
 * definitions themselves into `deps.policy`, so every cheaper structural
 * check has already run before it is worth consulting.
 *
 * `async` is not decorative: every refusal below is a `throw`, and declaring
 * this function `async` is what turns each one into a REJECTION of the
 * returned promise rather than a synchronous throw out of the call itself —
 * the same reasoning `lib/triage-presets.ts`'s `verifyTriagePresets` TSDoc
 * gives for its own `async`.
 *
 * @param deps - See {@link VerifyFlowNamesDeps}.
 * @returns A {@link VerifiedFlowTarget} holding a defensive copy of
 *   `deps.flowAllowlist` (mutating the caller's own set afterwards does not
 *   change the returned `flows`) and the single agreed `gradedProfile`.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_FLOW`
 *   when `flowAllowlist` is empty, or when any flow or step fails one of the
 *   refusals documented above.
 *
 * @example
 * ```ts
 * import { Core } from "@monte3l/m3l-common";
 * import { verifyFlowNames } from "./flow-definitions.js";
 *
 * const target = await verifyFlowNames({
 *   flowAllowlist: new Set(["dlq-reconcile"]),
 *   workspaceRoot: "/workspace/m3l-automation",
 *   readProvider: (absolutePath) => new Core.M3LYAMLConfigProvider(absolutePath),
 *   declaredParameters: async (scriptName) => {
 *     void scriptName;
 *     return ["aws.profile"];
 *   },
 *   policy: Core.validateAgentPolicy({
 *     version: 1,
 *     scripts: [{ script: "sqs-etl", operations: ["run"] }],
 *   }),
 * });
 * ```
 */
export async function verifyFlowNames(
  deps: VerifyFlowNamesDeps,
): Promise<VerifiedFlowTarget> {
  if (deps.flowAllowlist.size === 0) {
    throw new M3LAgentOperatorCliError(
      "flow allowlist has no entries",
      "ERR_AGENT_OPERATOR_FLOW",
    );
  }

  const resolvedSteps: ResolvedStep[] = [];
  for (const flowName of deps.flowAllowlist) {
    // Membership is tautologically true at this call site — `flowName` is
    // drawn FROM `deps.flowAllowlist` by the loop itself, so the
    // allowlist-membership half of `assertFlowNameOnAllowlist` can never
    // reject here. Only the shape check does real work in this loop; that
    // membership check earns its keep instead at the tool boundary
    // (`build-flow-tools.ts`'s `readFlowName`), where a model-supplied name
    // arrives and has never been checked against the allowlist before.
    assertFlowNameOnAllowlist(flowName, deps.flowAllowlist);
    for (const step of readFlowSteps(flowName, deps)) {
      rejectIfYesSensitive(flowName, step);
      resolvedSteps.push({ flowName, step });
    }
  }

  const gradedProfile = deriveGradedProfile(resolvedSteps);

  for (const { flowName, step } of resolvedSteps) {
    await rejectIfProfileOmittedButDeclared(
      flowName,
      step,
      deps.declaredParameters,
    );
  }

  for (const { flowName, step } of resolvedSteps) {
    rejectIfStepScriptLacksRunGrant(flowName, step, deps.policy);
  }

  return {
    flows: new Set(deps.flowAllowlist) as unknown as VerifiedFlowNames,
    gradedProfile,
  };
}
