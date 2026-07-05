/**
 * `aws/clients/region` — the default AWS region for SDK client construction.
 *
 * @packageDocumentation
 */

import { parseAWSRegion } from "../models/index.js";
import type { M3LAWSRegion } from "../models/index.js";

/**
 * Default AWS region used by {@link AWSClientProvider} when no `region`
 * option is supplied at construction time. Milan (`eu-south-1`) is the
 * organization's default deployment region.
 *
 * Typed as the branded {@link M3LAWSRegion} (not the literal `'eu-south-1'`
 * or a bare `string`) so it can be passed directly anywhere a validated
 * region is expected. It is built by validating the known-good default
 * through {@link parseAWSRegion} at this single definition site — a pure,
 * side-effect-free call with no I/O, so the module stays tree-shakeable.
 *
 * @example
 * ```ts
 * import { AWS_REGION } from "@m3l-automation/m3l-common/aws";
 *
 * console.log(AWS_REGION); // "eu-south-1"
 * ```
 */
export const AWS_REGION: M3LAWSRegion =
  /* @__PURE__ */ parseAWSRegion("eu-south-1");
