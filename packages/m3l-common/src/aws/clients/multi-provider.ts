/**
 * `aws/clients/multi-provider` — `AWSMultiClientProvider`, a multi-profile
 * fan-out over {@link AWSClientProvider}.
 *
 * @packageDocumentation
 */

import type { M3LResult } from "../../core/errors/index.js";
import { err, ok } from "../../core/errors/index.js";
import type { M3LAWSProfile } from "../models/index.js";

import { AWSClientProvider } from "./provider.js";

/** Constructor options for {@link AWSMultiClientProvider}. Not exported. */
interface AWSMultiClientProviderOptions {
  /** Profile names to manage; deduplicated on construction. */
  readonly profiles: readonly M3LAWSProfile[];
}

/**
 * A single profile's outcome from {@link AWSMultiClientProvider.mapParallelSettled}.
 *
 * @typeParam T - The value type returned by the mapped operation on success.
 */
interface AWSMultiClientSettledEntry<T> {
  /** The profile name this outcome belongs to. */
  readonly profile: M3LAWSProfile;
  /** `ok(value)` on success, `err(cause)` on failure — never throws. */
  readonly result: M3LResult<T, unknown>;
}

/**
 * Manages a map of {@link AWSClientProvider} instances keyed by profile
 * name, with helpers to run an operation across all profiles in parallel.
 *
 * Profile names are deduplicated on construction (first-seen order
 * preserved), so a repeated profile name contributes exactly one
 * `AWSClientProvider`.
 *
 * @example
 * ```ts
 * import {
 *   AWSMultiClientProvider,
 *   parseAWSProfile,
 * } from "@m3l-automation/m3l-common/aws";
 *
 * const multi = new AWSMultiClientProvider({
 *   profiles: [parseAWSProfile("profile-a"), parseAWSProfile("profile-b")],
 * });
 *
 * // Parallel across profiles; rejects if any throws.
 * await multi.mapParallel((p) => p.s3);
 *
 * // Parallel across profiles; never throws — collects results and errors.
 * const settled = await multi.mapParallelSettled((p) => p.s3);
 * ```
 */
export class AWSMultiClientProvider {
  private readonly providers: ReadonlyMap<M3LAWSProfile, AWSClientProvider>;

  /**
   * Creates a new `AWSMultiClientProvider`.
   *
   * @param options - `profiles` — the profile names to manage; duplicates
   *   are collapsed to a single `AWSClientProvider`, preserving the
   *   first-seen order.
   */
  constructor(options: AWSMultiClientProviderOptions) {
    const providers = new Map<M3LAWSProfile, AWSClientProvider>();
    for (const profile of options.profiles) {
      if (!providers.has(profile)) {
        providers.set(profile, new AWSClientProvider({ profile }));
      }
    }
    this.providers = providers;
  }

  /**
   * Runs `fn(provider)` across every distinct profile in parallel and
   * resolves to the array of results, in the same order the profiles were
   * first seen. Rejects as soon as any invocation throws synchronously or
   * returns a rejected promise — mirrors `Promise.all` semantics.
   *
   * @param fn - Operation to run against each profile's `AWSClientProvider`.
   * @returns A promise resolving to one result per distinct profile.
   *
   * @example
   * ```ts
   * import {
   *   AWSMultiClientProvider,
   *   parseAWSProfile,
   * } from "@m3l-automation/m3l-common/aws";
   *
   * const multi = new AWSMultiClientProvider({
   *   profiles: [parseAWSProfile("a"), parseAWSProfile("b")],
   * });
   * const clients = await multi.mapParallel((p) => p.s3);
   * ```
   */
  async mapParallel<T>(
    fn: (provider: AWSClientProvider) => T | Promise<T>,
  ): Promise<T[]> {
    return Promise.all(
      [...this.providers.values()].map((provider) => fn(provider)),
    );
  }

  /**
   * Runs `fn(provider)` across every distinct profile in parallel and
   * collects each outcome as `{ profile, result }`, where `result` is
   * `ok(value)` on success or `err(cause)` on failure. This method never
   * rejects, even when every invocation throws.
   *
   * @param fn - Operation to run against each profile's `AWSClientProvider`.
   * @returns A promise resolving to one entry per distinct profile, keyed
   *   by `profile` (not position — dedup collapses repeated input names).
   *
   * @example
   * ```ts
   * import {
   *   AWSMultiClientProvider,
   *   parseAWSProfile,
   * } from "@m3l-automation/m3l-common/aws";
   *
   * const multi = new AWSMultiClientProvider({
   *   profiles: [parseAWSProfile("a"), parseAWSProfile("b")],
   * });
   * const settled = await multi.mapParallelSettled((p) => p.s3);
   * for (const { profile, result } of settled) {
   *   if (result.ok) console.log(profile, "ok");
   * }
   * ```
   */
  async mapParallelSettled<T>(
    fn: (provider: AWSClientProvider) => T | Promise<T>,
  ): Promise<readonly AWSMultiClientSettledEntry<T>[]> {
    return Promise.all(
      [...this.providers.entries()].map(
        async ([profile, provider]): Promise<AWSMultiClientSettledEntry<T>> => {
          try {
            const value = await fn(provider);
            return { profile, result: ok(value) };
          } catch (cause) {
            return { profile, result: err(cause) };
          }
        },
      ),
    );
  }
}
