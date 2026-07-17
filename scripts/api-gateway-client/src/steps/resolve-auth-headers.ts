import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/**
 * `resolve-auth-headers` — maps the resolved `auth` config value to the
 * per-request auth headers a step should merge into its
 * `M3LHttpRequestOptions`. Never logs the resolved `apiKey`, the
 * `x-api-key` header, or the SigV4 `authorization` header it produces — the
 * library has no automatic secret redaction (`M3LSecretsSpecifier` is
 * classification-only and not wired into `M3LScript`), so this is enforced
 * by discipline in this step, not a library guarantee.
 *
 * @param deps - The resolved config, the optional injected
 *   `AWS.M3LRequestSigner` (present only when `auth: iam` provisioned
 *   `script.aws`), and the request's `method`/`url` (plus optional
 *   `headers`/`body`) to sign for `auth: iam`.
 * @returns The auth headers to merge into the outgoing request: `{}` for
 *   `auth: none`; `{ "x-api-key": <resolved apiKey> }` for `auth: api-key`;
 *   the SigV4 signing headers (`authorization` / `x-amz-date` /
 *   `x-amz-content-sha256` / `x-amz-security-token`) for `auth: iam`.
 * @throws {@link Core.M3LError} coded `"ERR_API_GATEWAY_CLIENT_CONFIG"` when
 *   `auth: api-key` but `apiKey` is unresolved, when `auth: iam` but no
 *   `signer` is available (`script.aws` was not provisioned), or when
 *   `auth` is not one of the three declared modes.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { resolveAuthHeaders } from "./resolve-auth-headers.js";
 *
 * const headers = await resolveAuthHeaders({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "api-gateway-client", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   signer: undefined,
 *   method: "GET",
 *   url: "https://api.example.test/health",
 * });
 * ```
 */
export async function resolveAuthHeaders(deps: {
  readonly config: Core.M3LConfig;
  readonly signer: AWS.M3LRequestSigner | undefined;
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}): Promise<Record<string, string>> {
  const auth = deps.config.get("auth");

  switch (auth) {
    case "none":
      return {};

    case "api-key": {
      const apiKey = deps.config.get("apiKey");
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        throw new Core.M3LError("'apiKey' is required for 'auth: api-key'", {
          code: "ERR_API_GATEWAY_CLIENT_CONFIG",
        });
      }
      return { "x-api-key": apiKey };
    }

    case "iam": {
      if (deps.signer === undefined) {
        throw new Core.M3LError(
          "'auth: iam' requires a request signer — declare 'aws.profile' to provision script.aws",
          { code: "ERR_API_GATEWAY_CLIENT_CONFIG" },
        );
      }
      return deps.signer.signedHeaders({
        method: deps.method,
        url: deps.url,
        ...(deps.headers !== undefined && { headers: deps.headers }),
        ...(deps.body !== undefined && { body: deps.body }),
      });
    }

    default:
      throw new Core.M3LError(`unrecognized 'auth' value: ${String(auth)}`, {
        code: "ERR_API_GATEWAY_CLIENT_CONFIG",
        context: { auth },
      });
  }
}
