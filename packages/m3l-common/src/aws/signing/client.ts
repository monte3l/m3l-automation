/**
 * `aws/signing/client` — {@link M3LRequestSigner}, an AWS Signature Version 4
 * (SigV4) signer for a bespoke HTTP request that no service-specific SDK
 * client models (e.g. a raw `execute-api` call to AWS API Gateway with IAM
 * auth). See ADR-0029 for why the SigV4 dependency is owned by the library
 * rather than a consumer script.
 *
 * @packageDocumentation
 */

import { createHash, createHmac } from "node:crypto";
import type { Hash, Hmac } from "node:crypto";

import { fromIni } from "@aws-sdk/credential-provider-ini";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

import type { M3LAWSRegion } from "../models/index.js";
import { AWS_REGION } from "../clients/region.js";

import { M3LSigningError } from "./error.js";
import type { M3LRequestSignerOptions, M3LSignableRequest } from "./types.js";

/** Default AWS service name embedded in the credential scope when {@link M3LRequestSignerOptions.service} is omitted. */
const DEFAULT_SIGNING_SERVICE = "execute-api";

/**
 * The SigV4 signing headers `signedHeaders` reduces a signed request down
 * to; `x-amz-security-token` is included only when present (temporary
 * credentials).
 */
const SIGNING_HEADER_NAMES = [
  "authorization",
  "x-amz-date",
  "x-amz-content-sha256",
  "x-amz-security-token",
] as const;

/**
 * The value types accepted as a raw checksum/HMAC secret — matches
 * `@smithy/types`'s `SourceData` structurally (the bare structural
 * `ArrayBufferView` interface, not `NodeJS.ArrayBufferView`'s concrete
 * `TypedArray | DataView` union), so {@link NodeCryptoSha256} satisfies
 * SigV4's `ChecksumConstructor` shape without this module depending on
 * `@smithy/types` directly.
 */
type ChecksumSecret = string | ArrayBuffer | ArrayBufferView;

/**
 * Normalizes an HMAC key for `node:crypto`'s `createHmac`, whose `KeyLike`
 * type requires a concrete `NodeJS.ArrayBufferView`/`Buffer`, not the bare
 * structural `ArrayBufferView` SigV4 may pass: a raw `ArrayBuffer` secret is
 * wrapped as a `Uint8Array` view (Node's `createHmac` key type does not
 * accept a bare `ArrayBuffer`), and any other view's underlying bytes are
 * read into a concrete `Uint8Array`. A string passes through unchanged.
 */
function toHmacKey(secret: ChecksumSecret): string | Uint8Array {
  if (typeof secret === "string") return secret;
  if (secret instanceof ArrayBuffer) return new Uint8Array(secret);
  return new Uint8Array(secret.buffer, secret.byteOffset, secret.byteLength);
}

/**
 * `node:crypto`-backed SHA-256 checksum adapter satisfying the `Checksum`
 * contract SigV4's `sha256` constructor option requires. SigV4 constructs
 * this without a `secret` to hash the canonical request/payload
 * (`createHash`), and with a `secret` (an HMAC key) to derive each step of
 * the signing key (`createHmac`) — a hash-only adapter would produce
 * syntactically valid but cryptographically wrong signatures, so every
 * (re)build branches on whether a `secret` is present.
 *
 * Not exported: SigV4 consumes it purely structurally via the `sha256`
 * constructor option, never by name.
 */
class NodeCryptoSha256 {
  private readonly secret: ChecksumSecret | undefined;
  private digestor: Hash | Hmac;

  constructor(secret?: ChecksumSecret) {
    this.secret = secret;
    this.digestor = this.build();
  }

  /** Adds a chunk of data to the running checksum. */
  update(data: Uint8Array): void {
    this.digestor.update(data);
  }

  /**
   * Finalizes the checksum, converting the Node `Buffer` result to a
   * `Uint8Array`. Not declared `async` (the computation is synchronous) —
   * wrapped in an already-resolved `Promise` to satisfy the `Checksum`
   * contract's `Promise<Uint8Array>` return type.
   */
  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.digestor.digest()));
  }

  /** Resets the checksum to its initial state, rebuilt from the stored `secret`. */
  reset(): void {
    this.digestor = this.build();
  }

  private build(): Hash | Hmac {
    return this.secret === undefined
      ? createHash("sha256")
      : createHmac("sha256", toHmacKey(this.secret));
  }
}

/**
 * Groups a request URL's query-string parameters into the shape
 * `@smithy/protocol-http`'s `HttpRequest.query` (`QueryParameterBag`)
 * expects: a bare string for a key that appears once, a `string[]` for a
 * key that repeats. `Object.fromEntries(url.searchParams)` silently drops
 * every occurrence but the last for a repeated key — this preserves all of
 * them.
 */
function buildSignableQuery(
  searchParams: URLSearchParams,
): Record<string, string | string[]> {
  const grouped = new Map<string, string[]>();
  for (const [key, value] of searchParams.entries()) {
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, [value]);
    } else {
      existing.push(value);
    }
  }

  const query: Record<string, string | string[]> = {};
  for (const [key, values] of grouped) {
    const [first] = values;
    query[key] = values.length === 1 && first !== undefined ? first : values;
  }
  return query;
}

/**
 * Reduces a signed request's full header set down to just the SigV4 signing
 * headers, dropping every caller pass-through header (including `host`)
 * SigV4 also echoes back onto the signed request.
 */
function extractSigningHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of SIGNING_HEADER_NAMES) {
    const value = headers[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Parses `url`, throwing a typed {@link M3LSigningError} synchronously for a
 * malformed URL — before `signedHeaders` ever constructs a `SignatureV4`.
 */
function parseSignableUrl(url: string): URL {
  try {
    return new URL(url);
  } catch (cause) {
    throw new M3LSigningError(
      `signedHeaders: request URL "${url}" is not a valid URL`,
      { cause },
    );
  }
}

/**
 * Produces AWS Signature Version 4 (SigV4) signing headers for an arbitrary
 * HTTP request, so a caller can authenticate a request to an IAM-protected
 * endpoint (e.g. AWS API Gateway with IAM auth) without importing
 * `@smithy/*` signing primitives directly. Resolves credentials the same
 * profile-aware way `AWSClientProvider` does — `fromIni({ profile })` when a
 * profile is supplied, the SDK default credential chain otherwise.
 *
 * @example
 * ```ts
 * import { M3LRequestSigner } from "@m3l-automation/m3l-common/aws";
 *
 * const signer = new M3LRequestSigner();
 * const headers = await signer.signedHeaders({
 *   method: "GET",
 *   url: "https://abc123.execute-api.eu-south-1.amazonaws.com/prod/health",
 * });
 * // headers carries authorization / x-amz-date / x-amz-content-sha256
 * // (and x-amz-security-token for temporary credentials).
 * ```
 */
export class M3LRequestSigner {
  private readonly region: M3LAWSRegion;
  private readonly service: string;
  private readonly resolveCredentials: () =>
    ReturnType<typeof fromIni> | ReturnType<typeof fromNodeProviderChain>;

  /**
   * Creates a new `M3LRequestSigner`.
   *
   * Construction performs no I/O — no credentials are resolved and no
   * `SignatureV4` is constructed until {@link signedHeaders} is first
   * called.
   *
   * @param options - Optional configuration; see {@link M3LRequestSignerOptions}.
   */
  constructor(options?: M3LRequestSignerOptions) {
    this.region = options?.region ?? AWS_REGION;
    this.service = options?.service ?? DEFAULT_SIGNING_SERVICE;

    const { profile } = options ?? {};
    this.resolveCredentials =
      profile !== undefined
        ? () => fromIni({ profile })
        : () => fromNodeProviderChain();
  }

  /**
   * Signs `request` and resolves to just the SigV4 signing headers:
   * `authorization`, `x-amz-date`, `x-amz-content-sha256`, and
   * `x-amz-security-token` (present only when the resolved credentials carry
   * a session token). The caller's own request headers and `host` are never
   * echoed back — merge the returned headers into the outgoing request.
   *
   * @remarks
   * The returned `authorization` header is a bearer credential scoped to
   * this specific signed request — treat it like a secret and never log it
   * verbatim.
   *
   * @param request - The request to sign; see {@link M3LSignableRequest}.
   * @throws {@link M3LSigningError} if `request.url` is malformed, or the
   *   underlying SigV4 signing fails (most commonly a credential-resolution
   *   failure surfaced when the lazily-resolved credential provider is first
   *   invoked).
   */
  async signedHeaders(
    request: M3LSignableRequest,
  ): Promise<Record<string, string>> {
    const url = parseSignableUrl(request.url);

    try {
      const httpRequest = new HttpRequest({
        method: request.method,
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
        query: buildSignableQuery(url.searchParams),
        headers: { ...request.headers, host: url.hostname },
        ...(request.body !== undefined && { body: request.body }),
      });

      const signer = new SignatureV4({
        service: this.service,
        region: this.region,
        sha256: NodeCryptoSha256,
        credentials: this.resolveCredentials(),
      });

      const signed = await signer.sign(httpRequest);
      const headers = extractSigningHeaders(signed.headers);
      if (headers.authorization === undefined) {
        throw new M3LSigningError(
          `signedHeaders: SigV4 signing resolved without an authorization header for ${request.method} ${request.url}`,
        );
      }
      return headers;
    } catch (cause) {
      if (cause instanceof M3LSigningError) throw cause;
      throw new M3LSigningError(
        `signedHeaders: SigV4 signing failed for ${request.method} ${request.url}`,
        { cause },
      );
    }
  }
}
