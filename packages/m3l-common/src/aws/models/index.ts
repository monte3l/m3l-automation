/**
 * `aws/models` — the shared AWS model types exchanged between the
 * credentials manager and the client providers.
 *
 * This is a dependency-free, types-only vocabulary layer, plus a small set of
 * side-effect-free runtime constructors: no `@aws-sdk/*` import and no
 * top-level side effects. The credentials manager and client providers build
 * on these shapes instead of redeclaring them. The only cross-module
 * reference is a **type-only** import of {@link M3LPrompt} from
 * `core/prompt`, used to type the optional `prompt` field — compile-time
 * only, so this module still carries no runtime dependency and tree-shakes
 * cleanly.
 *
 * @packageDocumentation
 */

import type { M3LPrompt } from "../../core/prompt/index.js";

import { M3LError } from "../../core/errors/index.js";

/**
 * A validated AWS region, branded so a plain `string` cannot be assigned
 * without going through {@link parseAWSRegion} or {@link isAWSRegion}. Its
 * `unique symbol` is distinct from {@link M3LAWSProfile}'s, so the two brands
 * are mutually non-assignable even though both are ultimately `string`.
 *
 * @example
 * ```ts
 * import { parseAWSRegion } from "@m3l-automation/m3l-common/aws";
 * import type { M3LAWSRegion } from "@m3l-automation/m3l-common/aws";
 *
 * const region: M3LAWSRegion = parseAWSRegion("eu-south-1");
 * ```
 */
export type M3LAWSRegion = string & {
  readonly __awsRegionBrand: unique symbol;
};

/**
 * A validated AWS profile name, branded so a plain `string` cannot be
 * assigned without going through {@link parseAWSProfile} or
 * {@link isAWSProfile}. Its `unique symbol` is distinct from
 * {@link M3LAWSRegion}'s, so the two brands are mutually non-assignable even
 * though both are ultimately `string`.
 *
 * @example
 * ```ts
 * import { parseAWSProfile } from "@m3l-automation/m3l-common/aws";
 * import type { M3LAWSProfile } from "@m3l-automation/m3l-common/aws";
 *
 * const profile: M3LAWSProfile = parseAWSProfile("my-profile");
 * ```
 */
export type M3LAWSProfile = string & {
  readonly __awsProfileBrand: unique symbol;
};

/**
 * The set of machine-readable codes carried by an {@link M3LAWSIdentityError}.
 *
 * - `"ERR_AWS_INVALID_REGION"` — the value failed {@link parseAWSRegion}'s
 *   validation.
 * - `"ERR_AWS_INVALID_PROFILE"` — the value failed {@link parseAWSProfile}'s
 *   validation.
 */
export type M3LAWSIdentityErrorCode =
  "ERR_AWS_INVALID_REGION" | "ERR_AWS_INVALID_PROFILE";

/**
 * Constructor options for {@link M3LAWSIdentityError}. Not exported — callers
 * catch this error, they never construct it themselves.
 */
interface M3LAWSIdentityErrorOptions {
  /** The specific identity-validation failure that occurred. */
  readonly code: M3LAWSIdentityErrorCode;
}

/**
 * Thrown by {@link parseAWSRegion} / {@link parseAWSProfile} when the
 * supplied string fails validation. Carries **no** `cause` — an invalid
 * region or profile string has no underlying failure to chain — so callers
 * narrow on {@link M3LAWSIdentityError.code} instead of inspecting `cause`.
 *
 * @example
 * ```ts
 * import {
 *   M3LAWSIdentityError,
 *   parseAWSRegion,
 * } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   parseAWSRegion("not-a-region");
 * } catch (error) {
 *   if (error instanceof M3LAWSIdentityError) {
 *     console.log(error.code); // "ERR_AWS_INVALID_REGION"
 *   }
 *   throw error;
 * }
 * ```
 */
export class M3LAWSIdentityError extends M3LError {
  /** Narrows the inherited `code` to the {@link M3LAWSIdentityErrorCode} union. */
  override readonly code: M3LAWSIdentityErrorCode;

  /**
   * Creates a new `M3LAWSIdentityError`.
   *
   * @param message - Human-readable description of the validation failure.
   * @param options - Options bag carrying the narrowed `code`.
   */
  constructor(message: string, options: M3LAWSIdentityErrorOptions) {
    super(message, { code: options.code });
    this.code = options.code;
  }
}

/**
 * Matches the AWS region shape `<area>-<direction(s)>-<number>`: two
 * lowercase letters, one or more hyphenated lowercase words, then a hyphen
 * and digits (e.g. `eu-south-1`, `us-east-1`, `us-gov-east-1`). A single
 * bounded pattern with no nested quantifiers — ReDoS-safe.
 */
const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+(?:-[a-z]+)*-\d+$/;

/** The highest code point of the C0 control character range (`0x00`-`0x1f`). */
const MAX_C0_CONTROL_CODE_POINT = 0x1f;

/** The code point of the DEL control character. */
const DEL_CODE_POINT = 0x7f;

/**
 * Returns `true` when `value` contains a C0 control character or DEL
 * anywhere in the string. Checked by code point rather than a literal
 * control-character regex, which ESLint's `no-control-regex` rule flags as
 * suspicious even when intentional.
 */
function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (
      codePoint <= MAX_C0_CONTROL_CODE_POINT ||
      codePoint === DEL_CODE_POINT
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The shared region-validation predicate backing both {@link parseAWSRegion}
 * and {@link isAWSRegion}, so the two can never disagree.
 */
function isValidRegionString(value: string): boolean {
  return AWS_REGION_PATTERN.test(value);
}

/**
 * The shared profile-validation predicate backing both
 * {@link parseAWSProfile} and {@link isAWSProfile}, so the two can never
 * disagree. Deliberately lenient: non-empty, no surrounding whitespace, and
 * no whitespace/control characters anywhere in the string — profile names are
 * user-defined, so this only rejects an empty/garbage value rather than
 * enforcing an AWS-side naming policy.
 */
function isValidProfileString(value: string): boolean {
  if (value.length === 0) return false;
  if (value !== value.trim()) return false;
  if (/\s/.test(value)) return false;
  if (containsControlCharacter(value)) return false;
  return true;
}

/**
 * Validates `value` as an AWS region and returns it branded as
 * {@link M3LAWSRegion}.
 *
 * @param value - The candidate region string, e.g. `"eu-south-1"`.
 * @returns The validated, branded region.
 * @throws {@link M3LAWSIdentityError} (`code: "ERR_AWS_INVALID_REGION"`) when
 *   `value` does not match the AWS region shape.
 * @example
 * ```ts
 * import { parseAWSRegion } from "@m3l-automation/m3l-common/aws";
 *
 * const region = parseAWSRegion("eu-south-1");
 * ```
 */
export function parseAWSRegion(value: string): M3LAWSRegion {
  if (!isValidRegionString(value)) {
    throw new M3LAWSIdentityError(
      `invalid AWS region: ${JSON.stringify(value)}`,
      { code: "ERR_AWS_INVALID_REGION" },
    );
  }
  return value as M3LAWSRegion;
}

/**
 * Validates `value` as an AWS profile name and returns it branded as
 * {@link M3LAWSProfile}.
 *
 * @param value - The candidate profile name, e.g. `"my-profile"`.
 * @returns The validated, branded profile name.
 * @throws {@link M3LAWSIdentityError} (`code: "ERR_AWS_INVALID_PROFILE"`) when
 *   `value` is empty, has surrounding whitespace, or contains a
 *   whitespace/control character.
 * @example
 * ```ts
 * import { parseAWSProfile } from "@m3l-automation/m3l-common/aws";
 *
 * const profile = parseAWSProfile("my-profile");
 * ```
 */
export function parseAWSProfile(value: string): M3LAWSProfile {
  if (!isValidProfileString(value)) {
    throw new M3LAWSIdentityError(
      `invalid AWS profile: ${JSON.stringify(value)}`,
      { code: "ERR_AWS_INVALID_PROFILE" },
    );
  }
  return value as M3LAWSProfile;
}

/**
 * Non-throwing equivalent of {@link parseAWSRegion}: narrows `value` to
 * {@link M3LAWSRegion} when it is a valid AWS region.
 *
 * @param value - The candidate region string.
 * @returns `true`, narrowing `value` to `M3LAWSRegion`, exactly when
 *   {@link parseAWSRegion} would not throw for the same input.
 * @example
 * ```ts
 * import { isAWSRegion } from "@m3l-automation/m3l-common/aws";
 *
 * if (isAWSRegion("eu-south-1")) {
 *   console.log("valid region");
 * }
 * ```
 */
export function isAWSRegion(value: string): value is M3LAWSRegion {
  return isValidRegionString(value);
}

/**
 * Non-throwing equivalent of {@link parseAWSProfile}: narrows `value` to
 * {@link M3LAWSProfile} when it is a valid AWS profile name.
 *
 * @param value - The candidate profile name.
 * @returns `true`, narrowing `value` to `M3LAWSProfile`, exactly when
 *   {@link parseAWSProfile} would not throw for the same input.
 * @example
 * ```ts
 * import { isAWSProfile } from "@m3l-automation/m3l-common/aws";
 *
 * if (isAWSProfile("my-profile")) {
 *   console.log("valid profile");
 * }
 * ```
 */
export function isAWSProfile(value: string): value is M3LAWSProfile {
  return isValidProfileString(value);
}

/**
 * The error categories produced by credential error analysis. Implemented as
 * a `const` object (not a TS `enum`) so members are accessible as plain
 * string values (`M3LAWSCredentialsErrorType.UNKNOWN === "UNKNOWN"`) while
 * still narrowing to a literal union at the type level.
 *
 * @example
 * ```ts
 * import { M3LAWSCredentialsErrorType } from "@m3l-automation/m3l-common/aws";
 * const type = M3LAWSCredentialsErrorType.SSO_SESSION_EXPIRED; // "SSO_SESSION_EXPIRED"
 * ```
 */
export const M3LAWSCredentialsErrorType = {
  SSO_SESSION_EXPIRED: "SSO_SESSION_EXPIRED",
  SSO_SESSION_INVALID: "SSO_SESSION_INVALID",
  CREDENTIALS_PROVIDER_FAILED: "CREDENTIALS_PROVIDER_FAILED",
  PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND",
  UNKNOWN: "UNKNOWN",
} as const;

/**
 * The literal union of all {@link M3LAWSCredentialsErrorType} member values.
 *
 * @example
 * ```ts
 * import type { M3LAWSCredentialsErrorType } from "@m3l-automation/m3l-common/aws";
 * function describe(type: M3LAWSCredentialsErrorType): string {
 *   return `credential error category: ${type}`;
 * }
 * ```
 */
export type M3LAWSCredentialsErrorType =
  (typeof M3LAWSCredentialsErrorType)[keyof typeof M3LAWSCredentialsErrorType];

/**
 * The result of classifying a credential failure, letting callers decide
 * whether a failure is recoverable by re-authenticating.
 *
 * Modelled as a **discriminated union** on `recoverable` so the flag can
 * never disagree with `type`: the `recoverable: true` arm carries only the
 * categories re-authentication can fix, and the `recoverable: false` arm
 * carries only the rest. Narrowing on `recoverable` narrows `type` and vice
 * versa — the impossible pairing (e.g. `PROFILE_NOT_FOUND` with
 * `recoverable: true`) does not type-check.
 *
 * @example
 * ```ts
 * import {
 *   M3LAWSCredentialsErrorType,
 *   type M3LAWSCredentialsErrorAnalysis,
 * } from "@m3l-automation/m3l-common/aws";
 *
 * const analysis: M3LAWSCredentialsErrorAnalysis = {
 *   recoverable: true,
 *   type: M3LAWSCredentialsErrorType.SSO_SESSION_EXPIRED,
 * };
 * ```
 */
export type M3LAWSCredentialsErrorAnalysis =
  | {
      /** Whether re-running SSO login can recover the failure. */
      readonly recoverable: true;
      /** The classified error category, narrowed to the recoverable ones. */
      readonly type:
        | "SSO_SESSION_EXPIRED"
        | "SSO_SESSION_INVALID"
        | "CREDENTIALS_PROVIDER_FAILED";
      /**
       * The underlying error that was analyzed. Typed `unknown` (not
       * `Error`) because the analyzed cause may originate from any thrown
       * value.
       */
      readonly cause?: unknown;
    }
  | {
      /** Whether re-running SSO login can recover the failure. */
      readonly recoverable: false;
      /** The classified error category, narrowed to the unrecoverable ones. */
      readonly type: "PROFILE_NOT_FOUND" | "UNKNOWN";
      /**
       * The underlying error that was analyzed. Typed `unknown` (not
       * `Error`) because the analyzed cause may originate from any thrown
       * value.
       */
      readonly cause?: unknown;
    };

/**
 * Describes the current attempt when the credentials manager retries an
 * operation after re-authentication.
 *
 * @example
 * ```ts
 * import {
 *   M3LAWSCredentialsErrorType,
 *   type M3LAWSRetryContext,
 * } from "@m3l-automation/m3l-common/aws";
 *
 * const context: M3LAWSRetryContext = {
 *   attempt: 1,
 *   maxAttempts: 3,
 *   analysis: {
 *     type: M3LAWSCredentialsErrorType.SSO_SESSION_EXPIRED,
 *     recoverable: true,
 *   },
 * };
 * ```
 */
export interface M3LAWSRetryContext {
  /** The 1-based index of the current attempt. */
  readonly attempt: number;
  /** The total number of attempts permitted. */
  readonly maxAttempts: number;
  /** The error analysis that triggered the retry. */
  readonly analysis: M3LAWSCredentialsErrorAnalysis;
}

/**
 * The outcome of a single SSO login attempt, modelled as a **discriminated
 * union** on `outcome` so contradictory states (a "successful" login that
 * also timed out, a "failed" login with exit code `0`) are unrepresentable.
 * Every arm carries `profile` and `durationMs`; the arms differ on `outcome`
 * and `exitCode` — `"success"` is the only arm with `exitCode: 0`, and
 * `"timedOut"` is the only arm with `exitCode: null` (the process was killed
 * for exceeding `loginTimeoutMs`).
 *
 * @example
 * ```ts
 * import {
 *   parseAWSProfile,
 *   type M3LAWSLoginResult,
 * } from "@m3l-automation/m3l-common/aws";
 *
 * const result: M3LAWSLoginResult = {
 *   outcome: "success",
 *   exitCode: 0,
 *   profile: parseAWSProfile("default"),
 *   durationMs: 1500,
 * };
 * ```
 */
export type M3LAWSLoginResult =
  | {
      /** The discriminant tag for the login outcome. */
      readonly outcome: "success";
      /** The child process exit code; always `0` on the success arm. */
      readonly exitCode: 0;
      /** The profile the SSO login targeted. */
      readonly profile: M3LAWSProfile;
      /** The wall-clock duration of the login attempt, in milliseconds. */
      readonly durationMs: number;
    }
  | {
      /** The discriminant tag for the login outcome. */
      readonly outcome: "failed";
      /**
       * The child process's non-zero exit code, or `null` when the process
       * was killed by an external signal (not our own `loginTimeoutMs`
       * timer, which is the distinct `"timedOut"` arm below).
       */
      readonly exitCode: number | null;
      /** The profile the SSO login targeted. */
      readonly profile: M3LAWSProfile;
      /** The wall-clock duration of the login attempt, in milliseconds. */
      readonly durationMs: number;
    }
  | {
      /** The discriminant tag for the login outcome. */
      readonly outcome: "timedOut";
      /**
       * Always `null` — the process was killed for exceeding
       * `loginTimeoutMs` rather than exiting on its own.
       */
      readonly exitCode: null;
      /** The profile the SSO login targeted. */
      readonly profile: M3LAWSProfile;
      /** The wall-clock duration of the login attempt, in milliseconds. */
      readonly durationMs: number;
    };

/**
 * Construction options for `M3LAWSCredentialsManager`. All fields are
 * optional; see the credentials manager's own documentation for defaults
 * applied at construction time.
 *
 * @example
 * ```ts
 * import { parseAWSProfile } from "@m3l-automation/m3l-common/aws";
 * import type { M3LAWSCredentialsManagerOptions } from "@m3l-automation/m3l-common/aws";
 *
 * const options: M3LAWSCredentialsManagerOptions = {
 *   profile: parseAWSProfile("default"),
 *   loginTimeoutMs: 60000,
 *   interactive: false,
 * };
 * ```
 */
export interface M3LAWSCredentialsManagerOptions {
  /** The default profile to validate and, if needed, re-authenticate. */
  readonly profile?: M3LAWSProfile;
  /**
   * AWS region for the STS validation client. Defaults to the AWS SDK's own
   * region resolution when omitted.
   */
  readonly region?: M3LAWSRegion;
  /** SSO login timeout in milliseconds. */
  readonly loginTimeoutMs?: number;
  /**
   * Max relogin retry attempts for a recoverable credential failure.
   * Defaults to `1`, applied by the credentials manager rather than here.
   */
  readonly maxRetries?: number;
  /** Whether to prompt the user before re-running SSO login. */
  readonly interactive?: boolean;
  /**
   * Prompt used to confirm re-login in interactive mode. A default prompt
   * is used if omitted.
   */
  readonly prompt?: M3LPrompt;
}
