/**
 * `auth/identity` — the ADR-0071 auth seam.
 *
 * Pulled forward from a later slice so `http/context.ts` can be written once
 * against its final shape. At this slice the only implementation is a
 * single, boot-resolved operator: every request on the loopback-only
 * listener is that operator, so there is nothing to authenticate per
 * request yet. A real identity provider (session cookie, bearer token, …)
 * lands later behind the same {@link M3LOperatorProvider} contract.
 *
 * @packageDocumentation
 */

/**
 * The identity of the console's operator — the human (or single automated
 * actor) the console server was booted for (ADR-0071).
 *
 * @example
 * ```ts
 * const profile: M3LOperatorProfile = { name: "ada", email: undefined };
 * ```
 */
export interface M3LOperatorProfile {
  /** The operator's display name. */
  readonly name: string;
  /** The operator's email, when declared. Never logged — see `config/env.ts`. */
  readonly email: string | undefined;
}

/**
 * The ADR-0071 auth seam: where a real identity provider (session cookie,
 * bearer token, SSO handoff, …) lands later. This slice ships exactly one
 * implementation, {@link createSingleOperatorProvider}, which resolves every
 * request to the one operator profile declared at boot.
 *
 * @example
 * ```ts
 * function authenticate(
 *   provider: M3LOperatorProvider,
 *   headers: Readonly<Record<string, string | undefined>>,
 * ): boolean {
 *   return provider.resolve(headers) !== undefined;
 * }
 * ```
 */
export interface M3LOperatorProvider {
  /**
   * Names which provider authenticated a session, for a log line — without
   * leaking the resolved profile itself.
   */
  readonly kind: string;
  /**
   * Resolves the operator profile for a request, given its inbound headers.
   * Returns `undefined` when no operator can be resolved.
   */
  resolve(
    headers: Readonly<Record<string, string | undefined>>,
  ): M3LOperatorProfile | undefined;
}

/**
 * Builds an {@link M3LOperatorProvider} that always resolves to `profile`,
 * regardless of the request headers supplied. The operator was already
 * required at boot (`config/env.ts`'s `loadConsoleConfig`), so every request
 * on the loopback-only listener is that same operator.
 *
 * @param profile - The single operator profile resolved at boot.
 * @returns A provider whose `kind` is `"single-operator"` and whose
 *   `resolve` always returns `profile`.
 *
 * @example
 * ```ts
 * const provider = createSingleOperatorProvider({
 *   name: "ada",
 *   email: undefined,
 * });
 * provider.resolve({}); // { name: "ada", email: undefined }
 * ```
 */
export function createSingleOperatorProvider(
  profile: M3LOperatorProfile,
): M3LOperatorProvider {
  return {
    kind: "single-operator",
    resolve: () => profile,
  };
}
