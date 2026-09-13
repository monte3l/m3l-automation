/**
 * `@monte3l/m3l-common` — main entry / public barrel.
 *
 * The library exposes two namespaces. Import the one you need:
 *
 * @example
 * ```typescript
 * import { Core, AWS } from "@monte3l/m3l-common";
 * // or, narrower:
 * import * as Core from "@monte3l/m3l-common/core";
 * import * as AWS from "@monte3l/m3l-common/aws";
 * ```
 *
 * @packageDocumentation
 */

export * as Core from "./core/index.js";
export * as AWS from "./aws/index.js";
