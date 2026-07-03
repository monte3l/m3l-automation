/**
 * `aws/clients/region` — the default AWS region for SDK client construction.
 *
 * @packageDocumentation
 */

/**
 * Default AWS region used by {@link AWSClientProvider} when no `region`
 * option is supplied at construction time. Milan (`eu-south-1`) is the
 * organization's default deployment region.
 *
 * Typed as the literal `'eu-south-1'` (not widened to `string`) so
 * consumers that need the literal type — e.g. a discriminated config shape
 * — can rely on it narrowing correctly.
 *
 * @example
 * ```ts
 * import { AWS_REGION } from "@m3l-automation/m3l-common/aws";
 *
 * console.log(AWS_REGION); // "eu-south-1"
 * ```
 */
export const AWS_REGION = "eu-south-1" as const;
