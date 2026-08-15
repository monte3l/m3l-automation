/**
 * `aws/credentials/manager` — `M3LAWSCredentialsManager`, the SSO credential
 * validation, login, and retry-on-relogin orchestrator.
 *
 * @packageDocumentation
 */

import { spawn } from "node:child_process";

import type {
  M3LLoggerHandler,
  M3LLogEvent,
} from "../../core/logging/M3LLogEvent.js";
import { M3LLogEventCategory } from "../../core/logging/M3LLogEventCategory.js";
import { M3LPrompt } from "../../core/prompt/index.js";
import { M3LSingleFlight } from "../../core/utils/M3LSingleFlight.js";
import type {
  M3LAWSCredentialsErrorAnalysis,
  M3LAWSCredentialsManagerOptions,
  M3LAWSLoginResult,
  M3LAWSProfile,
  M3LAWSRegion,
} from "../models/index.js";
import {
  M3LAWSCredentialsErrorType,
  parseAWSProfile,
} from "../models/index.js";

import { M3LAWSCredentialsError } from "./error.js";

// Type-only imports: erased at build time. `@aws-sdk/client-sts` and
// `@aws-sdk/credential-providers` are required (hard) dependencies whose
// runtime values are loaded lazily via the `loadClientSts()` /
// `loadCredentialProviders()` loaders below, to keep the AWS SDK's
// module-eval cost off the cold-start path of a manager that is constructed
// but never used (see ADR-0017).
import type * as ClientSts from "@aws-sdk/client-sts";
import type * as CredentialProviders from "@aws-sdk/credential-providers";

/** Default SSO login timeout: 120 seconds (per the reference spec). */
const DEFAULT_LOGIN_TIMEOUT_MS = 120_000;

/** Default max relogin retry attempts for a recoverable credential failure. */
const DEFAULT_MAX_RETRIES = 1;

/**
 * Regex sets used by {@link M3LAWSCredentialsManager.analyzeError} to
 * classify a raw failure message into an {@link M3LAWSCredentialsErrorType}.
 * Most categories need multiple patterns to cover the different phrasings
 * the AWS CLI / SDK use across versions — `EXPIRED_PATTERNS` is the
 * exception, since `token.{0,200}expired` is a strict subset of `expired`
 * (any string matching the former necessarily contains the literal
 * "expired"), so a second pattern there would never be reached by
 * `classifyMessage`'s first-match `.some()` check and was removed as dead.
 * `analyzeError` runs against `error.message` from AWS SDK/CLI calls —
 * untrusted input at the public boundary — so any multi-literal pattern
 * bounds its gap with `.{0,200}` instead of an unbounded `.*`, the same
 * fixed-width rationale `core/logging/redact.ts` documents, to cap
 * worst-case backtracking per starting position at a constant and prevent
 * catastrophic (ReDoS) behavior on adversarial input.
 */
const EXPIRED_PATTERNS: readonly RegExp[] = [/expired/i];
const INVALID_PATTERNS: readonly RegExp[] = [
  /session.{0,200}invalid/i,
  /invalid.{0,200}session/i,
];
const PROFILE_NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /profile.{0,200}not found/i,
  /could not load profile/i,
];
const CREDENTIALS_PROVIDER_FAILED_PATTERNS: readonly RegExp[] = [
  /could not load credentials from any providers/i,
  /unable to (resolve|load) credentials/i,
];

/**
 * Builds the {@link M3LAWSCredentialsErrorAnalysis} union arm matching the
 * classified error category. `PROFILE_NOT_FOUND` and `UNKNOWN` are not
 * recoverable by re-authenticating — the former needs a config fix, the
 * latter is an unclassified failure — every other category is.
 */
function buildAnalysis(
  type: M3LAWSCredentialsErrorType,
  cause: unknown,
): M3LAWSCredentialsErrorAnalysis {
  switch (type) {
    case M3LAWSCredentialsErrorType.SSO_SESSION_EXPIRED:
    case M3LAWSCredentialsErrorType.SSO_SESSION_INVALID:
    case M3LAWSCredentialsErrorType.CREDENTIALS_PROVIDER_FAILED:
      return { recoverable: true, type, cause };
    case M3LAWSCredentialsErrorType.PROFILE_NOT_FOUND:
    case M3LAWSCredentialsErrorType.UNKNOWN:
      return { recoverable: false, type, cause };
    /* istanbul ignore next -- unreachable: every M3LAWSCredentialsErrorType
       member is handled above; this arm exists only to fail loud if a new
       member is ever added without a matching case. */
    default: {
      const exhaustive: never = type;
      throw new M3LAWSCredentialsError(
        `unhandled credential error type: ${String(exhaustive)}`,
      );
    }
  }
}

/** Extracts a message string from an arbitrary thrown value, without throwing. */
function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Matches `message` against any regex in `patterns`. */
function matchesAny(message: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

/**
 * Builds the {@link M3LLogEvent} reporting a settled
 * {@link M3LAWSLoginResult} for the injected logger — `SUCCESS` on a clean
 * exit, `WARNING` when our own `loginTimeoutMs` timer fired, `ERROR`
 * otherwise (a non-zero exit or an external kill). Kept as a standalone
 * function (rather than inline per branch) so {@link
 * M3LAWSCredentialsManager.spawnSsoLogin} stays within the file's
 * function-length lint budget.
 */
function buildLoginOutcomeEvent(result: M3LAWSLoginResult): M3LLogEvent {
  switch (result.outcome) {
    case "success":
      return {
        category: M3LLogEventCategory.SUCCESS,
        message: `SSO login succeeded for profile '${result.profile}'`,
        data: { profile: String(result.profile) },
      };
    case "timedOut":
      return {
        category: M3LLogEventCategory.WARNING,
        message: `SSO login for profile '${result.profile}' timed out after ${String(result.durationMs)}ms`,
        data: { profile: String(result.profile) },
      };
    case "failed":
      return {
        category: M3LLogEventCategory.ERROR,
        message: `SSO login for profile '${result.profile}' exited with code ${String(result.exitCode)}`,
        data: { profile: String(result.profile) },
      };
    /* istanbul ignore next -- unreachable: every M3LAWSLoginResult outcome is
       handled above; this arm exists only to fail loud if a new outcome is
       ever added without a matching case. */
    default: {
      const exhaustive: never = result;
      throw new M3LAWSCredentialsError(
        `unhandled SSO login outcome: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * Classifies a raw error message into an {@link M3LAWSCredentialsErrorType}.
 * Order matters: more specific categories are checked before the generic
 * `CREDENTIALS_PROVIDER_FAILED` fallback pattern.
 */
function classifyMessage(message: string): M3LAWSCredentialsErrorType {
  if (matchesAny(message, EXPIRED_PATTERNS)) {
    return M3LAWSCredentialsErrorType.SSO_SESSION_EXPIRED;
  }
  if (matchesAny(message, INVALID_PATTERNS)) {
    return M3LAWSCredentialsErrorType.SSO_SESSION_INVALID;
  }
  if (matchesAny(message, PROFILE_NOT_FOUND_PATTERNS)) {
    return M3LAWSCredentialsErrorType.PROFILE_NOT_FOUND;
  }
  if (matchesAny(message, CREDENTIALS_PROVIDER_FAILED_PATTERNS)) {
    return M3LAWSCredentialsErrorType.CREDENTIALS_PROVIDER_FAILED;
  }
  return M3LAWSCredentialsErrorType.UNKNOWN;
}

/**
 * Classifies `error` into an {@link M3LAWSCredentialsErrorType}, checking the
 * thrown value's identity (`error.name`) BEFORE falling back to
 * {@link classifyMessage}'s message-regex chain. The AWS SDK/CLI reword and
 * localize their error messages across versions and locales, but the
 * exception `name` (e.g. `"ExpiredTokenException"`,
 * `"SSOTokenProviderFailure"`) is a stable identity a reworded or translated
 * message would silently fall through to `UNKNOWN` on if matched by regex
 * alone — so identity wins whenever it is present and recognized, and only
 * falls back to the message chain when it is absent or unrecognized.
 */
function classifyError(error: unknown): M3LAWSCredentialsErrorType {
  if (error instanceof Error) {
    switch (error.name) {
      case "ExpiredTokenException":
        return M3LAWSCredentialsErrorType.SSO_SESSION_EXPIRED;
      case "SSOTokenProviderFailure":
        return M3LAWSCredentialsErrorType.SSO_SESSION_INVALID;
      default:
        break;
    }
  }
  return classifyMessage(extractMessage(error));
}

/**
 * The ` for profile 'x'` clause appended to a {@link
 * M3LAWSCredentialsManager.retryWithRelogin} failure message, or the empty
 * string when no profile was resolved. Extracted so the two throw sites
 * cannot drift apart — the ternary was previously spelled out verbatim in
 * both.
 */
function profileSuffix(profile: M3LAWSProfile | undefined): string {
  return profile !== undefined ? ` for profile '${profile}'` : "";
}

/**
 * Creates a new `M3LAWSCredentialsManager`.
 *
 * @example
 * ```ts
 * import {
 *   M3LAWSCredentialsManager,
 *   parseAWSProfile,
 * } from "@m3l-automation/m3l-common/aws";
 *
 * const manager = new M3LAWSCredentialsManager({
 *   profile: parseAWSProfile("my-profile"),
 * });
 * await manager.ensureValidCredentials();
 * ```
 */
export class M3LAWSCredentialsManager {
  private readonly profile: M3LAWSProfile | undefined;
  private readonly region: M3LAWSRegion | undefined;
  private readonly loginTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly interactive: boolean;
  private readonly injectedPrompt: M3LPrompt | undefined;
  private readonly injectedLogger: M3LLoggerHandler | undefined;

  // Memoized lazy-import promises: each SDK module is
  // `import()`-ed at most once per manager instance. The `??=` assignment in
  // the loader methods below is synchronous, so when `ensureValidCredentialsMultiple`
  // maps N profiles through `validateProfile` in the same microtask, only the
  // first call's assignment wins the race and every other concurrent caller
  // reuses that same in-flight promise instead of issuing its own `import()`.
  private clientStsModule: Promise<typeof ClientSts> | undefined;
  private credentialProvidersModule:
    Promise<typeof CredentialProviders> | undefined;

  // In-flight SSO login promises keyed by resolved profile name. Two
  // concurrent callers for the SAME profile must share one `aws sso login`
  // spawn rather than each racing their own browser-based flow; callers for
  // DIFFERENT profiles remain independent. Coalescing is delegated to
  // `M3LSingleFlight` (see ADR-0040 for the Zone A exception permitting this
  // one import) rather than a hand-rolled map.
  private readonly ssoLoginCoalescer = new M3LSingleFlight();

  /**
   * Creates a new `M3LAWSCredentialsManager`.
   *
   * Construction performs no I/O and no lazy import — the AWS SDK packages
   * (`@aws-sdk/client-sts`, `@aws-sdk/credential-providers`) are only
   * loaded when a method that needs them is actually invoked.
   *
   * @param options - Optional configuration. `loginTimeoutMs` defaults to
   *   `120000` (120s) and `maxRetries` defaults to `1` when omitted.
   */
  constructor(options: M3LAWSCredentialsManagerOptions = {}) {
    this.profile = options.profile;
    this.region = options.region;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.interactive = options.interactive ?? false;
    this.injectedPrompt = options.prompt;
    this.injectedLogger = options.logger;
  }

  /**
   * Validates one profile via STS `GetCallerIdentityCommand`; on a
   * recoverable failure, optionally confirms interactively and re-runs SSO
   * login before returning the login outcome.
   *
   * @param profile - The profile to validate; falls back to the profile
   *   supplied at construction time.
   * @returns `undefined` when credentials were already valid; otherwise the
   *   {@link M3LAWSLoginResult} of the SSO login attempt.
   * @throws {@link M3LAWSCredentialsError} When the failure is unrecoverable,
   *   or when an interactive re-login confirmation is declined.
   * @example
   * ```ts
   * import {
   *   M3LAWSCredentialsManager,
   *   parseAWSProfile,
   * } from "@m3l-automation/m3l-common/aws";
   *
   * const manager = new M3LAWSCredentialsManager({
   *   profile: parseAWSProfile("my-profile"),
   * });
   * const result = await manager.ensureValidCredentials();
   * if (result) {
   *   console.log(`re-authenticated: ${result.outcome === "success"}`);
   * }
   * ```
   */
  async ensureValidCredentials(
    profile?: M3LAWSProfile,
  ): Promise<M3LAWSLoginResult | undefined> {
    const resolvedProfile = profile ?? this.profile;

    try {
      await this.validateProfile(resolvedProfile);
      return undefined;
    } catch (error) {
      // An already-typed M3LAWSCredentialsError (e.g. an SDK module load
      // failure) is re-thrown unchanged — re-wrapping would replace its
      // actionable message (naming the missing package) with a generic one.
      if (error instanceof M3LAWSCredentialsError) throw error;

      const analysis = this.analyzeError(error);
      if (!analysis.recoverable) {
        throw new M3LAWSCredentialsError(
          `credentials for profile '${resolvedProfile ?? "default"}' are invalid and cannot be recovered by re-authenticating`,
          { type: analysis.type, profile: resolvedProfile, cause: error },
        );
      }

      await this.confirmRelogin(resolvedProfile);
      return this.runSsoLogin(resolvedProfile);
    }
  }

  /**
   * Validates many profiles in three phases: parallel validation, partition
   * into valid/invalid, then **sequential** SSO login for the invalid ones
   * (parallel browser windows would be unusable).
   *
   * @param profiles - The profiles to validate.
   * @returns One {@link M3LAWSLoginResult} per profile that needed a login;
   *   already-valid profiles contribute no entry.
   * @throws {@link M3LAWSCredentialsError} On the first unrecoverable
   *   profile encountered during the sequential login phase.
   * @example
   * ```ts
   * import {
   *   M3LAWSCredentialsManager,
   *   parseAWSProfile,
   * } from "@m3l-automation/m3l-common/aws";
   *
   * const manager = new M3LAWSCredentialsManager();
   * await manager.ensureValidCredentialsMultiple([
   *   parseAWSProfile("profile-a"),
   *   parseAWSProfile("profile-b"),
   * ]);
   * ```
   */
  async ensureValidCredentialsMultiple(
    profiles: readonly M3LAWSProfile[],
  ): Promise<readonly M3LAWSLoginResult[]> {
    // Phase 1: validate all profiles in parallel.
    const settlements = await Promise.allSettled(
      profiles.map((profile) => this.validateProfile(profile)),
    );

    // Phase 2: partition valid vs. invalid profiles, carrying each invalid
    // profile's own settlement alongside it. Re-deriving the settlement in
    // phase 3 via `profiles.indexOf(profile)` would always resolve to the
    // FIRST occurrence of a duplicated profile name, mis-attributing a
    // later occurrence's failure to an earlier one's — carrying the pair
    // through avoids that entirely.
    const invalidEntries: {
      profile: M3LAWSProfile;
      settlement: PromiseSettledResult<void>;
    }[] = [];
    for (const [index, settlement] of settlements.entries()) {
      if (settlement.status === "rejected") {
        const profile = profiles[index];
        if (profile !== undefined) {
          invalidEntries.push({ profile, settlement });
        }
      }
    }

    // Phase 3: sequential SSO login for the invalid profiles, failing fast
    // on the first unrecoverable one.
    const results: M3LAWSLoginResult[] = [];
    for (const { profile, settlement } of invalidEntries) {
      const error: unknown =
        settlement.status === "rejected" ? settlement.reason : undefined;

      // An already-typed M3LAWSCredentialsError (e.g. an SDK module load
      // failure) is re-thrown unchanged — re-wrapping would
      // replace its actionable message with a generic one.
      if (error instanceof M3LAWSCredentialsError) throw error;

      const analysis = this.analyzeError(error);

      if (!analysis.recoverable) {
        throw new M3LAWSCredentialsError(
          `credentials for profile '${profile}' are invalid and cannot be recovered by re-authenticating`,
          { type: analysis.type, profile, cause: error },
        );
      }

      await this.confirmRelogin(profile);
      // Sequential SSO login is required here: parallel browser-based logins
      // would be unusable.
      const result = await this.runSsoLogin(profile);
      results.push(result);
    }

    return results;
  }

  /**
   * Wraps an arbitrary AWS operation; on a recoverable credential error,
   * re-runs SSO login and retries the operation while attempts remain.
   *
   * @param operation - The operation to invoke and, if needed, retry.
   * @param profile - The profile to re-authenticate on a recoverable
   *   failure; falls back to the profile supplied at construction time.
   * @returns The resolved value of `operation`.
   * @throws {@link M3LAWSCredentialsError} When the failure is unrecoverable,
   *   when an interactive re-login confirmation is declined, or when retries
   *   are exhausted.
   * @example
   * ```ts
   * import {
   *   M3LAWSCredentialsManager,
   *   parseAWSProfile,
   * } from "@m3l-automation/m3l-common/aws";
   *
   * const manager = new M3LAWSCredentialsManager({
   *   profile: parseAWSProfile("my-profile"),
   * });
   * const identity = await manager.retryWithRelogin(async () => {
   *   // ... call an AWS SDK operation that may reject with an expired
   *   // credential error ...
   *   return "ok";
   * });
   * ```
   */
  async retryWithRelogin<T>(
    operation: () => Promise<T>,
    profile?: M3LAWSProfile,
  ): Promise<T> {
    const resolvedProfile = profile ?? this.profile;
    const maxAttempts = this.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // Retries are inherently sequential: each attempt depends on the
        // previous one's outcome (and, on failure, on the relogin it
        // triggers).
        return await operation();
      } catch (error) {
        // Throws on an unrecoverable/already-typed/exhausted failure;
        // returns only once the relogin has completed and the next attempt
        // should be issued.
        await this.reloginOrThrow(
          error,
          resolvedProfile,
          attempt < maxAttempts,
        );
      }
    }

    /* istanbul ignore next -- unreachable: the loop above always returns or
       throws before falling off the end. */
    throw new M3LAWSCredentialsError("retryWithRelogin: unreachable");
  }

  /**
   * Reacts to one failed `retryWithRelogin` attempt: either THROWS (the error
   * was already typed, is unrecoverable, or no attempts remain) or completes
   * the interactive confirmation + SSO relogin and returns normally, which is
   * the caller's signal to issue the next attempt.
   *
   * Returning normally is the ONLY "keep going" signal — there is no boolean
   * result to misread.
   *
   * @param error - The value the operation rejected with; `unknown` because
   *   any thrown value may surface here.
   * @param profile - The already-resolved profile (may be `undefined`).
   * @param attemptsRemain - Whether the loop has another attempt left after
   *   this failure.
   * @throws {@link M3LAWSCredentialsError} On an already-typed error
   *   (re-thrown by identity), an unrecoverable classification, exhausted
   *   retries, or a declined interactive confirmation.
   */
  private async reloginOrThrow(
    error: unknown,
    profile: M3LAWSProfile | undefined,
    attemptsRemain: boolean,
  ): Promise<void> {
    // An already-typed M3LAWSCredentialsError (e.g. an SDK module load
    // failure surfaced by the relogin path) is re-thrown
    // unchanged rather than re-wrapped.
    if (error instanceof M3LAWSCredentialsError) throw error;

    const analysis = this.analyzeError(error);
    if (!analysis.recoverable) {
      throw new M3LAWSCredentialsError(
        `operation failed with an unrecoverable credential error${profileSuffix(profile)}`,
        { type: analysis.type, profile, cause: error },
      );
    }

    if (!attemptsRemain) {
      throw new M3LAWSCredentialsError(
        `operation failed with a recoverable credential error, but retries are exhausted${profileSuffix(profile)}`,
        { type: analysis.type, profile, cause: error },
      );
    }

    // The relogin must complete before the next retry attempt is issued.
    await this.confirmRelogin(profile);
    await this.runSsoLogin(profile);
  }

  /**
   * Classifies an arbitrary failure into an
   * {@link M3LAWSCredentialsErrorAnalysis}, without acting on it. This
   * method is synchronous — it performs no I/O.
   *
   * @param error - The failure to classify; typed `unknown` because any
   *   thrown value may be analyzed.
   * @returns The classification, including whether re-running SSO login can
   *   recover the failure, and the original `error` verbatim as `cause`.
   * @example
   * ```ts
   * import { M3LAWSCredentialsManager } from "@m3l-automation/m3l-common/aws";
   *
   * const manager = new M3LAWSCredentialsManager();
   * const analysis = manager.analyzeError(new Error("Token has expired"));
   * console.log(analysis.type, analysis.recoverable);
   * ```
   */
  analyzeError(error: unknown): M3LAWSCredentialsErrorAnalysis {
    const type = classifyError(error);
    return buildAnalysis(type, error);
  }

  /**
   * Resolves the profile's credentials via `fromSSO` and validates them
   * against STS `GetCallerIdentityCommand`. Rejects with the raw SDK error
   * on failure — callers classify it via {@link analyzeError}.
   */
  private async validateProfile(
    profile: M3LAWSProfile | undefined,
  ): Promise<void> {
    const { STSClient, GetCallerIdentityCommand } = await this.loadClientSts();
    const { fromSSO } = await this.loadCredentialProviders();

    const client = new STSClient({
      ...(this.region !== undefined && { region: this.region }),
      credentials: fromSSO({ ...(profile !== undefined && { profile }) }),
    });

    await client.send(new GetCallerIdentityCommand({}));
  }

  /**
   * Resolves `profile` (falling back to the `"default"` profile) and runs
   * SSO login for it, coalescing concurrent callers that resolve to the SAME
   * profile onto a single in-flight {@link spawnSsoLogin} call via
   * {@link M3LSingleFlight} — two callers racing a recoverable credential
   * error for one profile must not each spawn their own `aws sso login`
   * browser flow.
   */
  private async runSsoLogin(
    profile: M3LAWSProfile | undefined,
  ): Promise<M3LAWSLoginResult> {
    const resolvedProfile = profile ?? parseAWSProfile("default");

    return this.ssoLoginCoalescer.run(String(resolvedProfile), () =>
      this.spawnSsoLogin(resolvedProfile),
    );
  }

  /**
   * Spawns `aws sso login --profile=<name>` with `stdio: "inherit"`,
   * enforcing `loginTimeoutMs` by killing the child process if it does not
   * exit in time. When an `options.logger` was injected at construction, this
   * method dispatches one `STEP` event before spawning and one terminal
   * outcome event once the child settles — covering the full ADR-0041
   * lifecycle: `SUCCESS` on a clean exit, `WARNING` on our own timeout,
   * `ERROR` on a non-zero exit (via {@link finalizeSsoLogin}), and `ERROR`
   * on a spawn failure itself (`"error"` event, below) — a no-op when no
   * logger was supplied. Every dispatch goes through
   * {@link dispatchLoggerEvent}, which isolates a throwing handler so it can
   * neither crash the process nor leave this method's returned promise
   * unsettled.
   *
   * @param resolvedProfile - The already-resolved profile to log in with
   *   (never `undefined` — callers resolve the `"default"` fallback before
   *   invoking this method, since the {@link runSsoLogin} coalescing key
   *   needs a concrete value).
   * @throws {@link M3LAWSCredentialsError} When the `aws` executable itself
   *   fails to spawn (e.g. it is not installed or not on `PATH`) — Node
   *   reports this via the child process's `"error"` event rather than
   *   `"exit"`.
   */
  private async spawnSsoLogin(
    resolvedProfile: M3LAWSProfile,
  ): Promise<M3LAWSLoginResult> {
    const startedAt = Date.now();

    this.dispatchLoggerEvent({
      category: M3LLogEventCategory.STEP,
      message: `starting SSO login for profile '${resolvedProfile}'`,
      data: { profile: String(resolvedProfile) },
    });

    return new Promise<M3LAWSLoginResult>((resolve, reject) => {
      const child = spawn(
        "aws",
        ["sso", "login", `--profile=${resolvedProfile}`],
        { stdio: "inherit" },
      );

      let settled = false;
      // Set only by the timer below, so `timedOut` reflects OUR timeout
      // firing — not a heuristic over exitCode/signal, which would also be
      // true for an unrelated external kill (e.g. a user Ctrl-C or the
      // parent process forwarding SIGTERM via `stdio: "inherit"`).
      let timedOutByUs = false;
      const timer = setTimeout(() => {
        timedOutByUs = true;
        child.kill();
      }, this.loginTimeoutMs);

      // A spawn failure (ENOENT when `aws` is not on PATH, EACCES, etc.)
      // surfaces as an "error" event, not "exit" — an unhandled "error" on a
      // ChildProcess is fatal to the process, and the promise would
      // otherwise never settle. Dispatches its own terminal ERROR event
      // (ADR-0041's start/success/failure/timeout lifecycle) — data is kept
      // to the profile name only, deliberately omitting the raw spawn
      // error's message to avoid leaking argv/environment detail into a log
      // sink.
      child.on("error", (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.dispatchLoggerEvent({
          category: M3LLogEventCategory.ERROR,
          message: `failed to spawn 'aws sso login' for profile '${resolvedProfile}'`,
          data: { profile: String(resolvedProfile) },
        });
        reject(
          new M3LAWSCredentialsError(
            `failed to spawn 'aws sso login' for profile '${resolvedProfile}'; is the AWS CLI installed and on PATH?`,
            { profile: resolvedProfile, cause },
          ),
        );
      });

      child.on("exit", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const durationMs = Date.now() - startedAt;
        resolve(
          this.finalizeSsoLogin(
            resolvedProfile,
            exitCode,
            timedOutByUs,
            durationMs,
          ),
        );
      });
    });
  }

  /**
   * Builds the settled {@link M3LAWSLoginResult} for a spawned `aws sso login`
   * child process and reports it to the injected logger (a no-op when none
   * was supplied) via {@link buildLoginOutcomeEvent}, dispatched through
   * {@link dispatchLoggerEvent} so a throwing handler cannot prevent this
   * method from returning `result` to its `"exit"`-handler caller. Extracted
   * out of {@link spawnSsoLogin}'s `"exit"` handler to keep that closure
   * within the file's function-length lint budget.
   *
   * @param resolvedProfile - The profile the login attempt targeted.
   * @param exitCode - The child process's exit code (`null` on a signal
   *   kill, our own timeout included).
   * @param timedOutByUs - Whether OUR `loginTimeoutMs` timer fired (as
   *   opposed to an external signal kill).
   * @param durationMs - The wall-clock duration of the login attempt.
   */
  private finalizeSsoLogin(
    resolvedProfile: M3LAWSProfile,
    exitCode: number | null,
    timedOutByUs: boolean,
    durationMs: number,
  ): M3LAWSLoginResult {
    // `exitCode` is `null` on the "failed" arm when the process was killed by
    // a signal we did not send (an external Ctrl-C, a forwarded SIGTERM via
    // `stdio: "inherit"`, etc.) rather than exiting on its own with a
    // non-zero code — passed through as-is instead of coercing to `0`, which
    // would misrepresent an external kill as a normal zero-exit
    // success-adjacent code.
    const result: M3LAWSLoginResult = timedOutByUs
      ? {
          outcome: "timedOut",
          exitCode: null,
          profile: resolvedProfile,
          durationMs,
        }
      : exitCode === 0
        ? {
            outcome: "success",
            exitCode: 0,
            profile: resolvedProfile,
            durationMs,
          }
        : { outcome: "failed", exitCode, profile: resolvedProfile, durationMs };

    this.dispatchLoggerEvent(buildLoginOutcomeEvent(result));
    return result;
  }

  /**
   * Dispatches `event` to the injected logger (a no-op when none was
   * supplied), isolating a synchronous throw from `handle()` exactly as
   * {@link M3LLogger}'s own `dispatch` does: from this manager's
   * perspective, a caller-supplied handler is untrusted code, so a throw in
   * it must never crash the process or leave the SSO login promise
   * unsettled — every call site here runs inside either a synchronous
   * pre-spawn step or a `child` `"error"`/`"exit"` event listener, and an
   * uncaught exception in either is fatal to the caller (an unhandled
   * `EventEmitter` `"error"`) or would abandon the login promise mid-flight.
   * The failure is not silently discarded: it is written to `process.stderr`
   * as a last-resort, best-effort diagnostic.
   */
  private dispatchLoggerEvent(event: M3LLogEvent): void {
    try {
      this.injectedLogger?.handle(event);
    } catch (cause) {
      const detail =
        cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
      process.stderr.write(
        `[m3l-common] SSO login logger handler threw: ${detail}\n`,
      );
    }
  }

  /**
   * Resolves the confirmation gate before a relogin: no-op when not
   * interactive; otherwise prompts (the injected `prompt`, or a lazily
   * constructed default `M3LPrompt`) and throws
   * {@link M3LAWSCredentialsError} when declined.
   */
  private async confirmRelogin(profile: string | undefined): Promise<void> {
    if (!this.interactive) return;

    const prompt = this.injectedPrompt ?? new M3LPrompt();
    const message = `Credentials for profile '${profile ?? "default"}' need re-authentication. Run SSO login now?`;
    const confirmed = await prompt.confirm(message);

    if (!confirmed) {
      throw new M3LAWSCredentialsError(
        `re-login declined for profile '${profile ?? "default"}'`,
        { profile },
      );
    }
  }

  /**
   * Lazily loads `@aws-sdk/client-sts`, wrapping a load failure as
   * a typed error naming the missing package. Memoized per instance: the
   * first call issues the `import()` and caches the resulting promise (a
   * rejection included); every subsequent or concurrent call reuses it, so
   * only one dynamic import of the module is ever in flight at once.
   */
  private loadClientSts(): Promise<typeof ClientSts> {
    this.clientStsModule ??= import("@aws-sdk/client-sts").catch(
      (cause: unknown) => {
        throw new M3LAWSCredentialsError(
          "could not load the AWS SDK package '@aws-sdk/client-sts'",
          { type: M3LAWSCredentialsErrorType.UNKNOWN, cause },
        );
      },
    );
    return this.clientStsModule;
  }

  /**
   * Lazily loads `@aws-sdk/credential-providers`, wrapping a load
   * failure as a typed error naming the missing package. Memoized per
   * instance: the first call issues the `import()` and caches the resulting
   * promise (a rejection included); every subsequent or concurrent call
   * reuses it, so only one dynamic import of the module is ever in flight
   * at once.
   */
  private loadCredentialProviders(): Promise<typeof CredentialProviders> {
    this.credentialProvidersModule ??=
      import("@aws-sdk/credential-providers").catch((cause: unknown) => {
        throw new M3LAWSCredentialsError(
          "could not load the AWS SDK package '@aws-sdk/credential-providers'",
          { type: M3LAWSCredentialsErrorType.UNKNOWN, cause },
        );
      });
    return this.credentialProvidersModule;
  }
}
