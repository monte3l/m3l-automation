/**
 * `aws/clients/aws-provider` — `AWSProvider`, the facade exposed on
 * `M3LScript` instances as `script.aws`.
 *
 * @packageDocumentation
 */

import {
  AWSClientProvider,
  type AWSClientProviderOptions,
} from "./provider.js";

/**
 * Constructor options for {@link AWSProvider}. Not exported.
 *
 * Reuses {@link AWSClientProviderOptions} rather than re-declaring its own
 * `{ profile?, region? }` shape, so a field added to the underlying
 * `AWSClientProvider` options automatically flows through here without a
 * second hand-maintained declaration to drift out of sync.
 */
type AWSProviderOptions = AWSClientProviderOptions;

/**
 * Facade exposed by `M3LScript` via `script.aws`. Lazily instantiates a
 * single-profile {@link AWSClientProvider} from shared configuration and
 * exposes it through the `clients` getter.
 *
 * @example
 * ```ts
 * import { AWSProvider } from "@m3l-automation/m3l-common/aws";
 *
 * const aws = new AWSProvider({ profile: "my-profile" });
 *
 * // The underlying AWSClientProvider is constructed on first access.
 * const s3 = aws.clients.s3;
 * ```
 */
export class AWSProvider {
  private readonly options: AWSProviderOptions;
  private cachedClients: AWSClientProvider | undefined;

  /**
   * Creates a new `AWSProvider`.
   *
   * Construction performs no I/O — the underlying `AWSClientProvider` (and
   * thus any AWS SDK client) is not constructed until `clients` is first
   * accessed.
   *
   * @param options - Optional configuration forwarded verbatim to the
   *   underlying `AWSClientProvider` on first `clients` access.
   */
  constructor(options: AWSProviderOptions = {}) {
    this.options = options;
  }

  /**
   * The single-profile `AWSClientProvider` for this facade, lazily
   * instantiated on first access and cached for the facade's lifetime.
   */
  get clients(): AWSClientProvider {
    this.cachedClients ??= new AWSClientProvider(this.options);
    return this.cachedClients;
  }
}
