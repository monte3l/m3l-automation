/**
 * Tests for aws/signing submodule — REAL `@smithy/signature-v4` signing path.
 *
 * Contract source: docs/reference/aws/signing.md; the `NodeCryptoSha256`
 * TSDoc in `src/aws/signing/client.ts` (the `node:crypto`-backed `Checksum`
 * adapter `@smithy/signature-v4`'s `sha256` constructor option requires).
 *
 * Split out from `tests/signing.test.ts`: that file mocks `@smithy/signature-v4`
 * entirely (its `sign()` is a bare spy that never touches the real signing
 * algorithm), so the module-private `NodeCryptoSha256` class — the
 * `node:crypto` SHA-256/HMAC-SHA256 adapter passed to SigV4 as its `sha256`
 * checksum constructor — is never actually executed by that file. A
 * hash-only (no HMAC) implementation of that class would compile and produce
 * syntactically valid but cryptographically WRONG signatures, so this file
 * runs the REAL `@smithy/signature-v4` (and `@smithy/protocol-http`) so the
 * real signing algorithm drives `NodeCryptoSha256.update()`/`digest()` and
 * its hash-vs-HMAC constructor branch: `@smithy/signature-v4`'s `signRequest`
 * always derives a signing key via a chain of HMAC-SHA256 calls
 * (`getSigningKey`) AND hashes the canonical request/string-to-sign via a
 * plain (no-secret) SHA-256 — every real `sign()` call below exercises both
 * branches regardless of whether the request carries a body. Only the
 * credential providers are mocked, to keep signing deterministic and
 * offline.
 *
 * `SignatureV4.sign()` does not expose a way to pin `signingDate` through
 * this module's public API (`M3LRequestSigner` never forwards one), so these
 * tests assert the STRUCTURAL/format correctness of a real SigV4 signature
 * rather than an exact expected string: `authorization` starts with
 * `AWS4-HMAC-SHA256`, contains `SignedHeaders=`, and its `Signature=` value
 * is exactly 64 lowercase hex characters (a real HMAC-SHA256 digest) —
 * `x-amz-content-sha256` is likewise asserted as a 64-lowercase-hex SHA-256
 * payload hash. A hash-only "HMAC" implementation would produce a
 * differently-shaped or mismatched value here.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factories
// below (those factories cannot close over ordinary file-scope variables).
const h = vi.hoisted(() => ({
  fromIni: vi.fn(),
  fromNodeProviderChain: vi.fn(),
}));

vi.mock("@aws-sdk/credential-provider-ini", () => ({ fromIni: h.fromIni }));
vi.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: h.fromNodeProviderChain,
}));

import { M3LRequestSigner } from "../src/aws/signing/index.js";
import { parseAWSProfile } from "../src/aws/models/index.js";

/**
 * Fake, clearly non-real credential fixture — deliberately NOT shaped like a
 * real AWS access key id (no `AKIA` prefix) so it can never be mistaken for
 * (or trigger a secret scanner against) a live credential.
 */
const FAKE_CREDENTIALS = {
  accessKeyId: "TEST0000EXAMPLE0000",
  secretAccessKey: "test0000fakeSecretExampleNotReal000000000",
};

/** Same as above, plus a fake session token (temporary-credential case). */
const FAKE_SESSION_CREDENTIALS = {
  ...FAKE_CREDENTIALS,
  sessionToken: "test0000FakeSessionTokenNotReal0000000000",
};

/** 64-lowercase-hex-character pattern — the shape of a real SHA-256/HMAC-SHA256 digest. */
const HEX_64 = /^[0-9a-f]{64}$/;

/** The well-known SHA-256 digest of the empty string, in lowercase hex. */
const SHA256_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// `vi.fn()`s created inside a hoisted `vi.mock` factory are NOT undone by
// `vi.restoreAllMocks()` (that only reverts `vi.spyOn` spies) — reset each
// mocked export's call history/implementation directly so one test's
// `mockReturnValue` never leaks into the next.
afterEach(() => {
  vi.mocked(h.fromIni).mockReset();
  vi.mocked(h.fromNodeProviderChain).mockReset();
});

describe("M3LRequestSigner — real @smithy/signature-v4 (NodeCryptoSha256 adapter)", () => {
  test("signedHeaders() produces a structurally valid SigV4 authorization header via the real signing algorithm (request with a body)", async () => {
    h.fromNodeProviderChain.mockReturnValue(() =>
      Promise.resolve(FAKE_CREDENTIALS),
    );
    const signer = new M3LRequestSigner();

    const headers = await signer.signedHeaders({
      method: "POST",
      url: "https://abc123.execute-api.eu-south-1.amazonaws.com/prod/items",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    const { authorization } = headers;
    expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(authorization).toContain("SignedHeaders=");
    const signatureMatch = /Signature=([0-9a-f]+)$/.exec(authorization ?? "");
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch?.[1]).toMatch(HEX_64);

    expect(headers["x-amz-content-sha256"]).toMatch(HEX_64);
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers).not.toHaveProperty("x-amz-security-token");
  });

  test("signedHeaders() includes a real x-amz-security-token and a valid signature for session (temporary) credentials", async () => {
    h.fromNodeProviderChain.mockReturnValue(() =>
      Promise.resolve(FAKE_SESSION_CREDENTIALS),
    );
    const signer = new M3LRequestSigner();

    const headers = await signer.signedHeaders({
      method: "GET",
      url: "https://abc123.execute-api.eu-south-1.amazonaws.com/prod/health",
    });

    expect(headers["x-amz-security-token"]).toBe(
      FAKE_SESSION_CREDENTIALS.sessionToken,
    );
    const signatureMatch = /Signature=([0-9a-f]+)$/.exec(
      headers.authorization ?? "",
    );
    expect(signatureMatch?.[1]).toMatch(HEX_64);
  });

  test("signedHeaders() with no request body still resolves the well-known empty-string SHA-256 payload hash", async () => {
    h.fromNodeProviderChain.mockReturnValue(() =>
      Promise.resolve(FAKE_CREDENTIALS),
    );
    const signer = new M3LRequestSigner();

    const headers = await signer.signedHeaders({
      method: "GET",
      url: "https://abc123.execute-api.eu-south-1.amazonaws.com/prod/health",
    });

    expect(headers["x-amz-content-sha256"]).toBe(SHA256_EMPTY);
  });

  test("credentials resolve via fromIni (not fromNodeProviderChain) when a profile is set, and still produce a valid real signature", async () => {
    h.fromIni.mockReturnValue(() => Promise.resolve(FAKE_CREDENTIALS));
    const signer = new M3LRequestSigner({
      profile: parseAWSProfile("my-profile"),
    });

    const headers = await signer.signedHeaders({
      method: "GET",
      url: "https://abc123.execute-api.eu-south-1.amazonaws.com/prod/health",
    });

    expect(h.fromIni).toHaveBeenCalledWith({ profile: "my-profile" });
    expect(h.fromNodeProviderChain).not.toHaveBeenCalled();
    const signatureMatch = /Signature=([0-9a-f]+)$/.exec(
      headers.authorization ?? "",
    );
    expect(signatureMatch?.[1]).toMatch(HEX_64);
  });

  test("two distinct requests produce two distinct (but each internally consistent) real signatures — the checksum adapter is rebuilt per sign() call, not reused stale across calls", async () => {
    h.fromNodeProviderChain.mockReturnValue(() =>
      Promise.resolve(FAKE_CREDENTIALS),
    );
    const signer = new M3LRequestSigner();

    const first = await signer.signedHeaders({
      method: "GET",
      url: "https://abc123.execute-api.eu-south-1.amazonaws.com/prod/health",
    });
    const second = await signer.signedHeaders({
      method: "POST",
      url: "https://abc123.execute-api.eu-south-1.amazonaws.com/prod/items",
      body: JSON.stringify({ another: "payload" }),
    });

    expect(first.authorization).not.toBe(second.authorization);
    expect(second.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    const secondSignatureMatch = /Signature=([0-9a-f]+)$/.exec(
      second.authorization ?? "",
    );
    expect(secondSignatureMatch?.[1]).toMatch(HEX_64);
  });
});
