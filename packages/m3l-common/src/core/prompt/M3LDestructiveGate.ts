/**
 * `core/prompt/M3LDestructiveGate` — the shared confirm-before-destroy step
 * promoted from an identical `destructive-gate.ts` step duplicated across 5
 * consumer scripts.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";
import { escapeTerminalControls } from "../../internal/prompt/sanitize.js";

import type { M3LLogger } from "../logging/index.js";

import type { M3LPrompt } from "./M3LPrompt.js";

/**
 * The resolved AWS identity a destructive action is pointed at.
 *
 * `M3LScript.awsTarget` returns exactly this shape, so callers can pass
 * the resolved target directly without adapting it.
 *
 * `region` is optional because `M3LScript` resolves `aws.region` as
 * `M3LAWSRegion | undefined`. Most consumer scripts leave `aws.region`
 * undeclared, so requiring it would silently disable target-graded
 * confirmation for exactly the scripts this feature is designed for.
 * When `region` is absent, the banner and `sensitiveTargets` region matching
 * degrade gracefully: no `region=` fragment is rendered, and a `regions`
 * spec never matches a region-less target (mirrors the `accountId` guard).
 *
 * @example
 * ```ts
 * import type { M3LDestructiveTarget } from "@m3l-automation/m3l-common/core";
 *
 * const target: M3LDestructiveTarget = {
 *   profile: "prod",
 *   region: "us-east-1",
 *   accountId: "123456789012",
 * };
 * ```
 */
export interface M3LDestructiveTarget {
  /** The AWS CLI profile name resolved for this run. */
  readonly profile: string;
  /**
   * The AWS region the action is directed at. Optional because
   * `M3LScript.aws.region` resolves as `M3LAWSRegion | undefined`; callers
   * that cannot supply a region still benefit from profile- and account-based
   * grading. Absent when the region is unknown or undeclared.
   */
  readonly region?: string;
  /**
   * The AWS account ID, when available. Absent when the caller cannot
   * resolve it (e.g. no STS access).
   */
  readonly accountId?: string;
}

/**
 * A caller-owned policy that classifies a {@link M3LDestructiveTarget} as
 * sensitive, triggering the escalated typed-echo confirmation path in
 * {@link confirmDestructive}.
 *
 * Return `true` to treat the target as sensitive; `false` otherwise.
 *
 * @example
 * ```ts
 * import type { M3LDestructiveTargetPredicate } from "@m3l-automation/m3l-common/core";
 *
 * const alwaysSensitive: M3LDestructiveTargetPredicate = () => true;
 * ```
 */
export type M3LDestructiveTargetPredicate = (
  target: M3LDestructiveTarget,
) => boolean;

/**
 * The declarative spec consumed by {@link sensitiveTargets} to build an
 * OR-semantics {@link M3LDestructiveTargetPredicate}.
 *
 * A target is sensitive when its `profile` is in `profiles`, its `region` is
 * in `regions`, **or** its `accountId` (when present) is in `accountIds`.
 * Omitting all three lists produces a predicate that matches nothing.
 *
 * @example
 * ```ts
 * import type { M3LSensitiveTargetSpec } from "@m3l-automation/m3l-common/core";
 *
 * const spec: M3LSensitiveTargetSpec = {
 *   profiles: ["prod", "prod-secondary"],
 *   regions: ["us-east-1"],
 *   accountIds: ["123456789012"],
 * };
 * ```
 */
export interface M3LSensitiveTargetSpec {
  /** Profile names that are considered sensitive. */
  readonly profiles?: readonly string[];
  /** Region names that are considered sensitive. */
  readonly regions?: readonly string[];
  /** Account IDs that are considered sensitive. */
  readonly accountIds?: readonly string[];
}

/**
 * Builds a {@link M3LDestructiveTargetPredicate} from a declarative
 * {@link M3LSensitiveTargetSpec} using OR semantics.
 *
 * A target is classified as **sensitive** if **any** of the following are
 * true:
 * - `spec.profiles` is supplied and contains the target's `profile`.
 * - `spec.regions` is supplied, the target has a `region`, and
 *   `spec.regions` contains that `region`.
 * - `spec.accountIds` is supplied, the target has an `accountId`, and
 *   `spec.accountIds` contains that `accountId`.
 *
 * A target whose `region` is absent is never matched by `spec.regions`,
 * regardless of the list contents — mirrors the `accountId` guard.
 * A target whose `accountId` is absent is never matched by `spec.accountIds`,
 * regardless of the list contents. An all-omitted spec matches nothing.
 *
 * @param spec - The declarative classification spec.
 * @returns A predicate that returns `true` when the target is sensitive.
 * @example
 * ```ts
 * import {
 *   sensitiveTargets,
 *   confirmDestructive,
 *   M3LPrompt,
 *   M3LLogger,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const isSensitiveTarget = sensitiveTargets({
 *   profiles: ["prod", "prod-secondary"],
 *   regions: ["us-east-1"],
 * });
 *
 * const prompt = new M3LPrompt();
 * const logger = new M3LLogger([]);
 *
 * await confirmDestructive({
 *   prompt,
 *   logger,
 *   description: "delete bucket my-bucket",
 *   yes: false,
 *   code: "ERR_LAMBDA_OPS_ABORTED",
 *   target: { profile: "prod", region: "us-east-1" },
 *   isSensitiveTarget,
 * });
 * ```
 */
export function sensitiveTargets(
  spec: M3LSensitiveTargetSpec,
): M3LDestructiveTargetPredicate {
  return (target: M3LDestructiveTarget): boolean => {
    if (spec.profiles !== undefined && spec.profiles.includes(target.profile)) {
      return true;
    }
    if (
      spec.regions !== undefined &&
      target.region !== undefined &&
      spec.regions.includes(target.region)
    ) {
      return true;
    }
    if (
      spec.accountIds !== undefined &&
      target.accountId !== undefined &&
      spec.accountIds.includes(target.accountId)
    ) {
      return true;
    }
    return false;
  };
}

/**
 * Dependencies for {@link confirmDestructive}.
 */
export interface M3LConfirmDestructiveOptions {
  /** The prompt facade used to ask for confirmation. */
  readonly prompt: M3LPrompt;
  /** The logger used to record a bypass warning. */
  readonly logger: M3LLogger;
  /** Human-readable description of the destructive action, e.g. `"delete bucket my-bucket"`. */
  readonly description: string;
  /**
   * When `true`, skips the interactive confirmation entirely (a
   * caller-supplied `--yes`/`-y` flag) and logs a warning instead.
   */
  readonly yes: boolean;
  /**
   * The `M3LError` `code` to use if the caller declines confirmation.
   * Caller-supplied, not a value hardcoded by this function.
   */
  readonly code: string;
  /**
   * The resolved AWS identity the action is pointed at, when known.
   * When supplied together with {@link isSensitiveTarget}, enables
   * target-graded confirmation (see {@link confirmDestructive} remarks).
   */
  readonly target?: M3LDestructiveTarget;
  /**
   * Caller-owned policy that classifies {@link target} as sensitive.
   * Only consulted when {@link target} is supplied; never called when
   * `target` is absent.
   *
   * A **truthy** return value (including non-`true` values such as `1`,
   * `"yes"`, or `{}`) escalates to the sensitive path. Only a **falsy**
   * return means "not sensitive". This deliberate asymmetry means the
   * sensitivity check fails closed: a predicate accidentally returning a
   * truthy non-`true` value escalates rather than bypassing.
   *
   * The companion {@link yesSensitive} bypass uses strict `=== true` — do
   * **not** "harmonise" the two checks: one fails closed on truthiness,
   * the other bypasses only on exact `true`.
   */
  readonly isSensitiveTarget?: M3LDestructiveTargetPredicate;
  /**
   * When `true` together with `yes`, bypasses confirmation even for a
   * sensitive target (state 3). Deliberately distinct from `yes` so that a
   * routine automation flag cannot silently carry the same authority over
   * the most consequential targets without an explicit opt-in.
   *
   * Ignored when no {@link target} is supplied or the target is not sensitive.
   */
  readonly yesSensitive?: boolean;
}

/**
 * Builds a display-escaped banner string from a target's identity fields.
 * Always renders `profile=<p>`; appends `region=<r>` and `accountId=<a>`
 * only when the respective field is present.
 */
function buildTargetBanner(target: M3LDestructiveTarget): string {
  const parts: string[] = [`profile=${escapeTerminalControls(target.profile)}`];
  if (target.region !== undefined) {
    parts.push(`region=${escapeTerminalControls(target.region)}`);
  }
  if (target.accountId !== undefined) {
    parts.push(`accountId=${escapeTerminalControls(target.accountId)}`);
  }
  return parts.join(", ");
}

/**
 * Runs the escalated typed-echo prompt for a sensitive target (states 4 and
 * 5). A rejection from `prompt.text` propagates unchanged.
 *
 * The echo token is the **raw** `target.profile`. A profile whose trimmed
 * form is non-empty is confirmable only when the trimmed input equals the raw
 * profile exactly. A profile with leading or trailing whitespace is therefore
 * **unconfirmable** by any input — the trimmed input can never equal the raw
 * whitespace-padded profile — which is intentional and stricter than "type it
 * exactly". A blank or whitespace-only profile (`token.trim().length === 0`)
 * is treated as an unsatisfiable token — no input can ever match it, and the
 * gate always throws the standard decline error. This is a safety property: a
 * hand-built `{ profile: "" }` target must never be confirmable via an empty
 * keystroke. `prompt.text` is still called first so the operator is always
 * prompted; the confirmation simply cannot succeed when the profile is blank.
 */
async function runEscalatedEcho(
  target: M3LDestructiveTarget,
  deps: M3LConfirmDestructiveOptions,
  displayDescription: string,
): Promise<void> {
  const token = target.profile;
  const banner = buildTargetBanner(target);
  const input = await deps.prompt.text(
    `Sensitive target (${banner}) — type the profile name to confirm: ${displayDescription}`,
  );
  if (token.trim().length === 0 || input.trim() !== token) {
    throw new M3LError(`aborted: ${deps.description}`, { code: deps.code });
  }
}

/**
 * Confirms a destructive action before proceeding, with a `yes`-flag bypass
 * and optional target-graded escalation.
 *
 * Five behaviors determined by whether a target is supplied and whether it is
 * sensitive (`target` supplied and `isSensitiveTarget(target)` returns `true`):
 *
 * 1. No `target` — exactly the ungraded behavior below; `yesSensitive` is
 *    ignored.
 * 2. `target` supplied, not sensitive — exactly the ungraded behavior below,
 *    including the plain `yes` bypass and the same message text.
 * 3. Sensitive, `yes` **and** `yesSensitive` both `true` — bypassed; one
 *    warning naming the target is logged; `prompt` is never called.
 * 4. Sensitive, `yes: true`, `yesSensitive` absent or `false` — **still
 *    prompts** via the escalated typed-echo (the load-bearing half of ADR-0048).
 * 5. Sensitive, not bypassed — escalated typed-echo via `prompt.text`
 *    instead of a yes/no `confirm`.
 *
 * **Ungraded behavior (states 1 and 2):**
 * - `deps.yes` is `true` — confirmation bypassed; a single warning is logged
 *   (`destructive confirmation bypassed (yes=true): <description>`) and the
 *   function resolves; `deps.prompt.confirm` is never called.
 * - `deps.yes` is `false` and the prompt resolves `true` — resolves normally.
 * - `deps.yes` is `false` and the prompt resolves `false` — throws an
 *   {@link M3LError} (`aborted: <description>`) carrying `deps.code` verbatim.
 *
 * **Escalated typed-echo (states 4 and 5):**
 * A banner naming `profile`, `region` (when present), and `accountId` (when
 * present) is shown alongside the description. `prompt.text` asks the operator
 * to type the target profile. The input is trimmed before comparison; the
 * comparison target is the **raw** profile. A profile whose trimmed form is
 * non-empty is confirmable only when the trimmed input equals the raw profile
 * exactly. A profile with leading or trailing whitespace is therefore
 * **unconfirmable** by any input, which is intentional and stricter than
 * "type it exactly". A mismatch throws the same `aborted: <description>`
 * {@link M3LError}.
 *
 * A blank or whitespace-only profile (`target.profile.trim().length === 0`)
 * is an **unsatisfiable token**: no input can confirm it, and the gate always
 * throws the standard decline error. This is a safety property — a
 * caller-supplied `{ profile: "" }` must never be confirmable via an empty
 * keystroke. `prompt.text` is still called so the operator is always prompted;
 * the confirmation simply cannot succeed.
 *
 * A rejection from `deps.prompt.confirm` or `deps.prompt.text` (e.g. the
 * underlying adapter throws on a cancelled prompt) propagates unchanged — it
 * is never converted into the `aborted` {@link M3LError}.
 *
 * @remarks
 * `deps.description` is passed through the internal display-escape helper in
 * the observable **display** channels — the bypass-warning log, the
 * `Confirm: ...?` message, the state-3 target-naming warning, and the
 * escalated prompt message — but **deliberately not** in the thrown
 * `aborted: ...` {@link M3LError}'s message. That message is a data value,
 * not a render target: it flows downstream into `core/logging`'s name-based
 * secret redaction (`redactSensitiveLogText`), applied here by
 * `core/diagnostics`'s error-chain serialization, which locates
 * `key=value`-shaped secrets by matching on surrounding word boundaries.
 * Escaping the description first would introduce alphanumeric escape text
 * (`\x09`, `\u{202e}`) that merges into those boundaries and can suppress a
 * secret's redaction in a persisted run report — a worse outcome than the
 * display issue this escape exists to close. The thrown message therefore
 * carries `deps.description` unchanged, exactly as before this escape was
 * introduced, so downstream redaction keeps operating on unmodified text.
 * This is a display-integrity fix for the escaped display channels — it is
 * not an authorization control and does not otherwise change confirmation
 * semantics.
 *
 * Target fields (`profile`, `region`, `accountId`) are likewise
 * display-escaped in every channel that renders them (the state-3 warning
 * and the escalated prompt banner). The echo comparison in states 4 and 5
 * runs against the **raw** profile — escaping the comparison operand would
 * make a profile containing a control code point permanently unconfirmable.
 * The thrown `aborted: <description>` message carries no target fields so the
 * redaction contract above is unchanged across all five states.
 *
 * @param deps - The prompt, logger, description, bypass flags, error code, and
 *   optional target-grading fields described above.
 * @returns A promise that resolves once the action is confirmed (or bypassed).
 * @throws {@link M3LError} with `code: deps.code` when the caller declines
 *   confirmation or the typed-echo input does not match the target profile.
 * @example
 * ```ts
 * import {
 *   confirmDestructive,
 *   sensitiveTargets,
 *   M3LLogger,
 *   M3LPrompt,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const prompt = new M3LPrompt();
 * const logger = new M3LLogger([]);
 *
 * await confirmDestructive({
 *   prompt,
 *   logger,
 *   description: "delete bucket my-bucket",
 *   yes: false,
 *   code: "ERR_LAMBDA_OPS_ABORTED",
 *   target: { profile: "prod", region: "us-east-1", accountId: "123456789012" },
 *   isSensitiveTarget: sensitiveTargets({ profiles: ["prod"] }),
 * });
 * ```
 */
export async function confirmDestructive(
  deps: M3LConfirmDestructiveOptions,
): Promise<void> {
  const displayDescription = escapeTerminalControls(deps.description);
  const { target } = deps;

  // States 1 & 2: no target, or target is not sensitive — existing ungraded path.
  // Truthy-escalates: any truthy return from isSensitiveTarget reaches the
  // sensitive path; only a falsy return means "not sensitive" (fail-closed).
  if (
    target === undefined ||
    deps.isSensitiveTarget === undefined ||
    !deps.isSensitiveTarget(target)
  ) {
    if (deps.yes) {
      deps.logger.warning(
        `destructive confirmation bypassed (yes=true): ${displayDescription}`,
      );
      return;
    }

    const confirmed = await deps.prompt.confirm(
      `Confirm: ${displayDescription}?`,
    );

    if (!confirmed) {
      throw new M3LError(`aborted: ${deps.description}`, { code: deps.code });
    }
    return;
  }

  // State 3: sensitive + yes:true + yesSensitive:true → bypass naming the target.
  if (deps.yes && deps.yesSensitive === true) {
    const banner = buildTargetBanner(target);
    deps.logger.warning(
      `destructive confirmation bypassed (yes=true, yesSensitive=true) on sensitive target ${banner}: ${displayDescription}`,
    );
    return;
  }

  // States 4 & 5: sensitive, not bypassed → escalated typed-echo.
  await runEscalatedEcho(target, deps, displayDescription);
}
