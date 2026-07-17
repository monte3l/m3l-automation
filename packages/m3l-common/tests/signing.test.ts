/**
 * Tests for aws/signing submodule.
 *
 * Contract source: docs/reference/aws/signing.md, ADR-0029, ADR-0017.
 *
 * Exports under test (from `../src/aws/signing/index.js`, following the
 * package's `../src/aws/index.js` barrel):
 *   M3LRequestSigner, M3LSigningError, and the M3LRequestSignerOptions /
 *   M3LSignableRequest plain types.
 *
 * Mocking strategy: `@smithy/signature-v4`'s `SignatureV4` is mocked with a
 * top-level `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/sqs.test.ts` / `tests/clients.test.ts`): a spy constructor records
 * its init args (`{ service, region, sha256, credentials }`), and a `sign()`
 * spy resolves whatever fake `HttpRequest`-shaped `{ headers }` object each
 * test configures — the real SigV4 `sign()` echoes back the full header set
 * (caller pass-through headers plus the new signing headers), so the module
 * under test must filter that down to just the signing subset before
 * returning it, which the "resolves only the SigV4 signing headers" test
 * below asserts directly. `@aws-sdk/credential-provider-ini`'s `fromIni` and
 * `@aws-sdk/credential-providers`'s `fromNodeProviderChain` are mocked the
 * same way `tests/clients.test.ts` mocks `fromIni`, so the profile-aware
 * credential resolution documented in docs/reference/aws/signing.md ("the
 * same profile-aware way AWSClientProvider does — fromIni({ profile }) ...
 * the SDK default credential chain otherwise") can be asserted
 * deterministically. Neither `@smithy/signature-v4` nor
 * `@aws-sdk/credential-providers`'s `fromNodeProviderChain` export is
 * exercised for real here — Vitest resolves `vi.mock` by import specifier,
 * so mocking `@smithy/signature-v4` (not yet an installed dependency) works
 * fine ahead of the GREEN-phase implementer adding it (ADR-0017).
 *
 * SCAFFOLD STATUS: this file is RED by design — `src/aws/signing/` does not
 * exist yet. `implementing-submodules` turns it GREEN.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factories
// below (those factories cannot close over ordinary file-scope variables).
const h = vi.hoisted(() => {
  const sign = vi.fn();
  const signatureV4Ctor = vi.fn();
  const fromIni = vi.fn();
  const fromNodeProviderChain = vi.fn();

  class SignatureV4 {
    constructor(init: unknown) {
      signatureV4Ctor(init);
    }
    sign(request: unknown): unknown {
      return sign(request);
    }
  }

  return {
    sign,
    signatureV4Ctor,
    fromIni,
    fromNodeProviderChain,
    SignatureV4,
  };
});

vi.mock("@smithy/signature-v4", () => ({ SignatureV4: h.SignatureV4 }));
vi.mock("@aws-sdk/credential-provider-ini", () => ({ fromIni: h.fromIni }));
vi.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: h.fromNodeProviderChain,
}));

import type {
  M3LRequestSignerOptions,
  M3LSignableRequest,
} from "../src/aws/signing/index.js";
import { M3LRequestSigner, M3LSigningError } from "../src/aws/signing/index.js";

import { AWS_REGION } from "../src/aws/clients/region.js";
import { parseAWSProfile, parseAWSRegion } from "../src/aws/models/index.js";
import type { M3LAWSProfile, M3LAWSRegion } from "../src/aws/models/index.js";
import type { M3LError } from "../src/core/errors/index.js";

/** Sentinel credentials object the mocked `fromIni` resolves to. */
const SENTINEL_PROFILE_CREDENTIALS = { sentinel: "fromIni-credentials" };
/** Sentinel credentials object the mocked `fromNodeProviderChain` resolves to. */
const SENTINEL_DEFAULT_CREDENTIALS = {
  sentinel: "fromNodeProviderChain-credentials",
};

/**
 * The full header set the mocked `sign()` resolves to for the "no session
 * token" case — mirroring what a real SigV4 `sign()` call returns: caller
 * pass-through headers (`host`, `content-type`) alongside the new signing
 * headers.
 */
const SIGNED_HEADERS_NO_TOKEN = {
  host: "abc123.execute-api.eu-south-1.amazonaws.com",
  "content-type": "application/json",
  authorization:
    "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260716/eu-south-1/execute-api/aws4_request, SignedHeaders=host;x-amz-date, Signature=deadbeef",
  "x-amz-date": "20260716T000000Z",
  "x-amz-content-sha256":
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

/** Same as above, plus `x-amz-security-token` for the session-credential case. */
const SIGNED_HEADERS_WITH_TOKEN = {
  ...SIGNED_HEADERS_NO_TOKEN,
  "x-amz-security-token": "FQoGZXIvYXdzEA0aDEXAMPLETOKEN",
};

/** Builds a well-formed `M3LSignableRequest`, overridable per test. */
function fakeRequest(
  overrides: Partial<M3LSignableRequest> = {},
): M3LSignableRequest {
  return {
    method: "POST",
    url: "https://abc123.execute-api.eu-south-1.amazonaws.com/prod/items",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
    ...overrides,
  };
}

describe("M3LRequestSigner", () => {
  beforeEach(() => {
    h.sign.mockReset().mockResolvedValue({ headers: SIGNED_HEADERS_NO_TOKEN });
    h.signatureV4Ctor.mockReset();
    h.fromIni.mockReset().mockReturnValue(SENTINEL_PROFILE_CREDENTIALS);
    h.fromNodeProviderChain
      .mockReset()
      .mockReturnValue(SENTINEL_DEFAULT_CREDENTIALS);
  });

  test("construction performs no I/O: no credential resolver or SignatureV4 constructor runs until signedHeaders is called", () => {
    expect(() => {
      new M3LRequestSigner();
      new M3LRequestSigner({
        profile: parseAWSProfile("my-profile"),
        region: parseAWSRegion("us-east-1"),
        service: "s3",
      });
    }).not.toThrow();

    expect(h.fromIni).not.toHaveBeenCalled();
    expect(h.fromNodeProviderChain).not.toHaveBeenCalled();
    expect(h.signatureV4Ctor).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
  });

  test("signedHeaders() resolves only the SigV4 signing headers, dropping caller pass-through headers (content-type, host)", async () => {
    const signer = new M3LRequestSigner();

    const headers = await signer.signedHeaders(fakeRequest());

    expect(headers).toEqual({
      authorization: SIGNED_HEADERS_NO_TOKEN.authorization,
      "x-amz-date": SIGNED_HEADERS_NO_TOKEN["x-amz-date"],
      "x-amz-content-sha256": SIGNED_HEADERS_NO_TOKEN["x-amz-content-sha256"],
    });
    expect(headers).not.toHaveProperty("content-type");
    expect(headers).not.toHaveProperty("host");
  });

  test("signedHeaders() includes x-amz-security-token when the resolved signature carries one (session-credential case)", async () => {
    h.sign.mockResolvedValue({ headers: SIGNED_HEADERS_WITH_TOKEN });
    const signer = new M3LRequestSigner();

    const headers = await signer.signedHeaders(fakeRequest());

    expect(headers["x-amz-security-token"]).toBe(
      SIGNED_HEADERS_WITH_TOKEN["x-amz-security-token"],
    );
  });

  test("signedHeaders() omits x-amz-security-token when the resolved signature carries none (long-lived credential case)", async () => {
    h.sign.mockResolvedValue({ headers: SIGNED_HEADERS_NO_TOKEN });
    const signer = new M3LRequestSigner();

    const headers = await signer.signedHeaders(fakeRequest());

    expect(headers).not.toHaveProperty("x-amz-security-token");
  });

  test('service defaults to "execute-api" when omitted', async () => {
    const signer = new M3LRequestSigner();

    await signer.signedHeaders(fakeRequest());

    expect(h.signatureV4Ctor).toHaveBeenCalledWith(
      expect.objectContaining({ service: "execute-api" }),
    );
  });

  test("region defaults to AWS_REGION and credentials resolve via the SDK default chain (fromNodeProviderChain), not fromIni, when profile is omitted", async () => {
    const signer = new M3LRequestSigner();

    await signer.signedHeaders(fakeRequest());

    expect(h.signatureV4Ctor).toHaveBeenCalledWith(
      expect.objectContaining({
        region: AWS_REGION,
        credentials: SENTINEL_DEFAULT_CREDENTIALS,
      }),
    );
    expect(h.fromIni).not.toHaveBeenCalled();
    expect(h.fromNodeProviderChain).toHaveBeenCalled();
  });

  test("explicit region/profile/service override the defaults and are forwarded to SignatureV4 (credentials via fromIni)", async () => {
    const profile = parseAWSProfile("my-profile");
    const region = parseAWSRegion("us-east-1");
    const signer = new M3LRequestSigner({ profile, region, service: "s3" });

    await signer.signedHeaders(fakeRequest());

    expect(h.fromIni).toHaveBeenCalledWith({ profile: "my-profile" });
    expect(h.signatureV4Ctor).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "s3",
        region: "us-east-1",
        credentials: SENTINEL_PROFILE_CREDENTIALS,
      }),
    );
    expect(h.fromNodeProviderChain).not.toHaveBeenCalled();
  });

  test("signedHeaders() rejects M3LSigningError (code ERR_SIGNING_FAILURE) for a malformed URL, without ever constructing SignatureV4", async () => {
    const signer = new M3LRequestSigner();

    let thrown: unknown;
    try {
      await signer.signedHeaders({ method: "GET", url: "not a valid url" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LSigningError);
    expect((thrown as M3LSigningError).code).toBe("ERR_SIGNING_FAILURE");
    expect(h.signatureV4Ctor).not.toHaveBeenCalled();
  });

  test("signedHeaders() rejects M3LSigningError with the underlying signing failure chained via cause", async () => {
    const credentialError = new Error(
      "credential resolution failed: profile not found",
    );
    h.sign.mockRejectedValueOnce(credentialError);
    const signer = new M3LRequestSigner();

    let thrown: unknown;
    try {
      await signer.signedHeaders(fakeRequest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LSigningError);
    expect((thrown as M3LSigningError).code).toBe("ERR_SIGNING_FAILURE");
    expect((thrown as M3LSigningError).cause).toBe(credentialError);
    // Distinguishes "really attempted to sign and the SigV4 call rejected"
    // from the malformed-URL pre-flight-guard path above, which never
    // reaches SignatureV4 construction.
    expect(h.signatureV4Ctor).toHaveBeenCalled();
  });

  test("signedHeaders() groups repeated query-string keys into a string[] while a single-occurrence key stays a plain string", async () => {
    const signer = new M3LRequestSigner();

    await signer.signedHeaders(
      fakeRequest({
        url: "https://abc123.execute-api.eu-south-1.amazonaws.com/prod/items?tag=a&tag=b&other=x",
      }),
    );

    const [httpRequest] = h.sign.mock.calls[0] as [
      { query: Record<string, unknown> },
    ];
    expect(httpRequest.query).toMatchObject({
      tag: ["a", "b"],
      other: "x",
    });
  });

  test("signedHeaders() overrides a caller-supplied host header with the parsed URL's hostname, never the reverse", async () => {
    const signer = new M3LRequestSigner();

    await signer.signedHeaders(
      fakeRequest({
        url: "https://real-host.example.com/path",
        headers: { host: "attacker-controlled.example.com" },
      }),
    );

    const [httpRequest] = h.sign.mock.calls[0] as [
      { headers: Record<string, unknown> },
    ];
    expect(httpRequest.headers.host).toBe("real-host.example.com");
  });

  test("signedHeaders() rejects M3LSigningError (code ERR_SIGNING_FAILURE) when the resolved signature is missing authorization", async () => {
    h.sign.mockResolvedValueOnce({
      headers: { "x-amz-date": "20260716T000000Z" },
    });
    const signer = new M3LRequestSigner();

    let thrown: unknown;
    try {
      await signer.signedHeaders(fakeRequest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LSigningError);
    expect((thrown as M3LSigningError).code).toBe("ERR_SIGNING_FAILURE");
  });

  test("M3LRequestSignerOptions: all fields optional, correctly typed", () => {
    expectTypeOf<M3LRequestSignerOptions>().toEqualTypeOf<{
      readonly region?: M3LAWSRegion;
      readonly profile?: M3LAWSProfile;
      readonly service?: string;
    }>();
  });

  test("M3LSignableRequest: method/url required, headers/body optional", () => {
    expectTypeOf<M3LSignableRequest>().toEqualTypeOf<{
      readonly method: string;
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    }>();
  });

  test("M3LRequestSigner.signedHeaders has the exact contract signature", () => {
    expectTypeOf<M3LRequestSigner["signedHeaders"]>().toEqualTypeOf<
      (request: M3LSignableRequest) => Promise<Record<string, string>>
    >();
  });

  test("M3LSigningError extends M3LError and pins code to the ERR_SIGNING_FAILURE literal", () => {
    expectTypeOf<M3LSigningError>().toMatchTypeOf<M3LError>();
    expectTypeOf<
      M3LSigningError["code"]
    >().toEqualTypeOf<"ERR_SIGNING_FAILURE">();
  });
});
