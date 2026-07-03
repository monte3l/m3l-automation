/**
 * `aws/models` — the shared AWS model types exchanged between the
 * credentials manager and the client providers.
 *
 * This is a dependency-free, types-only vocabulary layer: no `@aws-sdk/*`
 * import, no runtime logic beyond the one `const` object below, and no
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
 * @example
 * ```ts
 * import {
 *   M3LAWSCredentialsErrorType,
 *   type M3LAWSCredentialsErrorAnalysis,
 * } from "@m3l-automation/m3l-common/aws";
 *
 * const analysis: M3LAWSCredentialsErrorAnalysis = {
 *   type: M3LAWSCredentialsErrorType.SSO_SESSION_EXPIRED,
 *   recoverable: true,
 * };
 * ```
 */
export interface M3LAWSCredentialsErrorAnalysis {
  /** The classified error category. */
  readonly type: M3LAWSCredentialsErrorType;
  /** Whether re-running SSO login can recover the failure. */
  readonly recoverable: boolean;
  /**
   * The underlying error that was analyzed. Typed `unknown` (not `Error`)
   * because the analyzed cause may originate from any thrown value.
   */
  readonly cause?: unknown;
}

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
 * The outcome of a single SSO login attempt.
 *
 * @example
 * ```ts
 * import type { M3LAWSLoginResult } from "@m3l-automation/m3l-common/aws";
 *
 * const result: M3LAWSLoginResult = {
 *   profile: "default",
 *   success: true,
 *   durationMs: 1500,
 *   exitCode: 0,
 *   timedOut: false,
 * };
 * ```
 */
export interface M3LAWSLoginResult {
  /** The profile the SSO login targeted. */
  readonly profile: string;
  /** Whether the login completed successfully. */
  readonly success: boolean;
  /** The wall-clock duration of the login attempt, in milliseconds. */
  readonly durationMs: number;
  /**
   * The child process exit code; `null` when the process was killed (for
   * example, after exceeding `loginTimeoutMs`).
   */
  readonly exitCode: number | null;
  /** Whether the login was killed for exceeding `loginTimeoutMs`. */
  readonly timedOut: boolean;
}

/**
 * Construction options for `M3LAWSCredentialsManager`. All fields are
 * optional; see the credentials manager's own documentation for defaults
 * applied at construction time.
 *
 * @example
 * ```ts
 * import type { M3LAWSCredentialsManagerOptions } from "@m3l-automation/m3l-common/aws";
 *
 * const options: M3LAWSCredentialsManagerOptions = {
 *   profile: "default",
 *   loginTimeoutMs: 60000,
 *   interactive: false,
 * };
 * ```
 */
export interface M3LAWSCredentialsManagerOptions {
  /** The default profile to validate and, if needed, re-authenticate. */
  readonly profile?: string;
  /**
   * AWS region for the STS validation client. Defaults to the AWS SDK's own
   * region resolution when omitted.
   */
  readonly region?: string;
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
