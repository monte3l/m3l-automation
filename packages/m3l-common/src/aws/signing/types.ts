/**
 * `aws/signing/types` — plain, SDK-free types at the request-signing
 * boundary. Neither carries an `@smithy/*` type; {@link M3LRequestSigner}
 * translates {@link M3LSignableRequest} into an internal `HttpRequest` and
 * reduces the signed result back down to a plain header record.
 *
 * @packageDocumentation
 */

import type { M3LAWSProfile, M3LAWSRegion } from "../models/index.js";

/**
 * Constructor options for {@link M3LRequestSigner}.
 *
 * @example
 * ```ts
 * import {
 *   parseAWSProfile,
 *   parseAWSRegion,
 * } from "@m3l-automation/m3l-common/aws";
 * import type { M3LRequestSignerOptions } from "@m3l-automation/m3l-common/aws";
 *
 * const options: M3LRequestSignerOptions = {
 *   profile: parseAWSProfile("my-profile"),
 *   region: parseAWSRegion("eu-south-1"),
 *   service: "execute-api",
 * };
 * ```
 */
export interface M3LRequestSignerOptions {
  /** The AWS region to sign for; defaults to `AWS_REGION` when omitted. */
  readonly region?: M3LAWSRegion;
  /**
   * The AWS profile whose credentials sign the request; when omitted, the
   * SDK default credential chain applies.
   */
  readonly profile?: M3LAWSProfile;
  /**
   * The AWS service name embedded in the credential scope. Defaults to
   * `"execute-api"` (API Gateway) when omitted.
   */
  readonly service?: string;
}

/**
 * A plain, SDK-free description of an HTTP request to sign via
 * {@link M3LRequestSigner.signedHeaders}.
 *
 * @example
 * ```ts
 * import type { M3LSignableRequest } from "@m3l-automation/m3l-common/aws";
 *
 * const request: M3LSignableRequest = {
 *   method: "POST",
 *   url: "https://abc123.execute-api.eu-south-1.amazonaws.com/prod/items",
 *   headers: { "content-type": "application/json" },
 *   body: JSON.stringify({ hello: "world" }),
 * };
 * ```
 */
export interface M3LSignableRequest {
  /** The HTTP method, e.g. `"GET"` or `"POST"`. */
  readonly method: string;
  /**
   * The absolute request URL; its host, path, and query are all folded into
   * the SigV4 canonical request.
   */
  readonly url: string;
  /** Caller request headers that must be covered by the signature. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The request body, as a string. */
  readonly body?: string;
}
