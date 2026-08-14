import { describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { preflightSecret } from "../../src/steps/preflight-secret.js";

/**
 * Contract: docs/reference/scripts/rds-data-sql.md, `preflight-secret` row —
 * "One `secretsManager.describeSecret(secret.arn)` call before any operation
 * runs, turning a typo'd or wrong-account secret ARN into `Core.M3LError`
 * coded `ERR_RDS_DATA_SQL_SECRET_PREFLIGHT` instead of an opaque Data API
 * `BadRequestException` surfacing mid-statement."
 */

const PREFLIGHT_CODE = "ERR_RDS_DATA_SQL_SECRET_PREFLIGHT";
const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";

/**
 * Builds a plain-object fake of `AWS.M3LSecretsManagerOperations`'s public
 * surface, exposing only `describeSecret` as a configurable `vi.fn()`.
 * `M3LSecretsManagerOperations` is a concrete class, so a structural object
 * literal is cast through `unknown` — the same pattern
 * `scripts/eks-ops/tests/support/eksFakes.ts` uses for `M3LEKSOperations`.
 */
function createFakeSecretsManager(
  describeSecret: ReturnType<typeof vi.fn>,
): AWS.M3LSecretsManagerOperations {
  return { describeSecret } as unknown as AWS.M3LSecretsManagerOperations;
}

describe("preflightSecret", () => {
  it("resolves when describeSecret resolves normally", async () => {
    const describeSecret = vi.fn().mockResolvedValue({
      arn: SECRET_ARN,
      name: "my-secret",
    });
    const secretsManager = createFakeSecretsManager(describeSecret);

    await expect(
      preflightSecret({ secretsManager, secretArn: SECRET_ARN }),
    ).resolves.toBeUndefined();
    expect(describeSecret).toHaveBeenCalledWith(SECRET_ARN);
    expect(describeSecret).toHaveBeenCalledTimes(1);
  });

  it("wraps a rejected describeSecret call into Core.M3LError coded ERR_RDS_DATA_SQL_SECRET_PREFLIGHT, chaining the cause", async () => {
    const originalError = new Error(
      "ResourceNotFoundException: secret not found",
    );
    const describeSecret = vi.fn().mockRejectedValue(originalError);
    const secretsManager = createFakeSecretsManager(describeSecret);

    await expect(
      preflightSecret({ secretsManager, secretArn: SECRET_ARN }),
    ).rejects.toBeInstanceOf(Core.M3LError);

    let thrown: unknown;
    try {
      await preflightSecret({ secretsManager, secretArn: SECRET_ARN });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(PREFLIGHT_CODE);
    expect((thrown as Core.M3LError).cause).toBe(originalError);
  });
});
