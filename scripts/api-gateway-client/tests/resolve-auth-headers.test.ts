import { describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { resolveAuthHeaders } from "../src/steps/resolve-auth-headers.js";
import { buildConfig, createFakeRequestSigner } from "./support/httpFakes.js";

/**
 * Contract: docs/reference/scripts/api-gateway-client.md
 * `resolve-auth-headers` row + auth-mode matrix. Maps `auth` to the
 * per-request auth headers: `none` -> `{}`; `api-key` -> `{ "x-api-key":
 * <resolved apiKey> }` (throws `ERR_API_GATEWAY_CLIENT_CONFIG` when `apiKey`
 * is unresolved); `iam` -> `signer.signedHeaders({ method, url, headers?,
 * body? })`. Never logs the resolved `apiKey`, the `x-api-key` header, or
 * `authorization` — enforced by discipline in this step, not a library
 * guarantee (no automatic secret redaction).
 */

describe("resolveAuthHeaders", () => {
  describe("auth: none", () => {
    test("resolves to an empty header set", async () => {
      const config = buildConfig({ auth: "none" });

      await expect(
        resolveAuthHeaders({
          config,
          signer: undefined,
          method: "GET",
          url: "https://api.example.test/health",
        }),
      ).resolves.toEqual({});
    });
  });

  describe("auth: api-key", () => {
    test("resolves to an 'x-api-key' header carrying the resolved apiKey", async () => {
      const config = buildConfig({ auth: "api-key", apiKey: "s3cr3t-key" });

      await expect(
        resolveAuthHeaders({
          config,
          signer: undefined,
          method: "POST",
          url: "https://api.example.test/items",
        }),
      ).resolves.toEqual({ "x-api-key": "s3cr3t-key" });
    });

    test("throws ERR_API_GATEWAY_CLIENT_CONFIG when 'apiKey' is unresolved", async () => {
      const config = buildConfig({ auth: "api-key" });

      let thrown: unknown;
      try {
        await resolveAuthHeaders({
          config,
          signer: undefined,
          method: "POST",
          url: "https://api.example.test/items",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe(
        "ERR_API_GATEWAY_CLIENT_CONFIG",
      );
    });
  });

  describe("auth: iam", () => {
    test("calls signer.signedHeaders with the request's method/url and returns the SigV4 headers verbatim", async () => {
      const signedHeaders = {
        authorization: "AWS4-HMAC-SHA256 Credential=fake",
        "x-amz-date": "20260717T000000Z",
        "x-amz-content-sha256": "abc123",
      };
      const signedHeadersFn = vi.fn().mockResolvedValue(signedHeaders);
      const signer = createFakeRequestSigner({
        signedHeaders: signedHeadersFn,
      });
      const config = buildConfig({
        auth: "iam",
        [Core.AWS_PROFILE_PARAM_NAME]: "my-profile",
      });

      await expect(
        resolveAuthHeaders({
          config,
          signer,
          method: "GET",
          url: "https://api.example.test/secure/ping",
        }),
      ).resolves.toEqual(signedHeaders);

      expect(signedHeadersFn).toHaveBeenCalledTimes(1);
      expect(signedHeadersFn).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          url: "https://api.example.test/secure/ping",
        }),
      );
    });

    test("throws ERR_API_GATEWAY_CLIENT_CONFIG when the signer is unavailable (script.aws not provisioned)", async () => {
      const config = buildConfig({ auth: "iam" });

      let thrown: unknown;
      try {
        await resolveAuthHeaders({
          config,
          signer: undefined,
          method: "GET",
          url: "https://api.example.test/secure/ping",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe(
        "ERR_API_GATEWAY_CLIENT_CONFIG",
      );
    });
  });

  test("never leaks the resolved apiKey into a thrown error's message or context", async () => {
    const secret = "s3cr3t-do-not-leak-9f8e7d";
    // A defensive, unrecognized 'auth' value forces the function's own
    // guard-throw while a real secret is present in config, proving the
    // secret is never echoed back even on an unrelated failure path.
    const config = buildConfig({ auth: "unsupported-mode", apiKey: secret });

    let thrown: unknown;
    try {
      await resolveAuthHeaders({
        config,
        signer: undefined,
        method: "GET",
        url: "https://api.example.test/x",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const serialized = JSON.stringify({
      message: (thrown as Core.M3LError).message,
      context: (thrown as Core.M3LError).context,
    });
    expect(serialized).not.toContain(secret);
  });
});
