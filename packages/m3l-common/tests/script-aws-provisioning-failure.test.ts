/**
 * Test for `M3LScript`'s AWS provisioning seam (stage 5) — construction
 * failure (C-new: not yet reflected in docs/reference/core/script.md).
 *
 * Contract under test (about to be implemented): today,
 * `M3LScript.provisionAws()` does
 * `const { AWSProvider } = await import("../../aws/clients/index.js");
 * this.awsProvider = new AWSProvider(...)` with no error handling — if the
 * dynamic import rejects or the `AWSProvider` constructor throws, the RAW
 * error propagates untyped out of `run()`. The new contract wraps that
 * failure in a typed `M3LError` subclass with `code === "ERR_AWS_PROVISIONING"`,
 * chaining the original failure as `cause`. The concrete subclass is
 * internal/unexported, so this test asserts via `instanceof M3LError` + the
 * `code` literal + `cause`, never by importing the internal class.
 *
 * Split into its own file (rather than extending `tests/script.test.ts`) so
 * a `vi.mock` of `../src/aws/clients/index.js` cannot leak into the sibling
 * file's AWS-provisioning tests, which depend on the REAL `AWSProvider`.
 * Follows the `vi.doMock` (not hoisted) + `vi.resetModules()` + dynamic
 * re-import pattern from `tests/credentials-missing-peer.test.ts`: every
 * module that must see the SAME mocked dependency graph (`M3LScript` and
 * `M3LError`) is re-imported dynamically inside each test, after
 * `vi.resetModules()` runs in `beforeEach`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  // `M3LScript` registers real SIGTERM/SIGINT/SIGQUIT listeners on `process`
  // as a side effect of construction in non-AWS environments (mirrors the
  // guard in tests/script.test.ts) — stub them so no real listener leaks
  // onto the shared test-runner process.
  vi.spyOn(process, "on").mockImplementation(() => process);
  vi.spyOn(process, "once").mockImplementation(() => process);
});

afterEach(() => {
  vi.doUnmock("../src/aws/clients/index.js");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("M3LScript.run() — AWS provisioning seam failure", () => {
  test("AWSProvider construction throwing surfaces as M3LError with code ERR_AWS_PROVISIONING, cause chained", async () => {
    const sentinel = new Error("boom: sdk facade load failed");

    vi.doMock("../src/aws/clients/index.js", () => ({
      AWSProvider: vi.fn(function AWSProvider() {
        throw sentinel;
      }),
      AWSClientProvider: vi.fn(function AWSClientProvider() {
        // No fields needed; only used for constructibility elsewhere.
      }),
      AWSMultiClientProvider: vi.fn(function AWSMultiClientProvider() {
        // No fields needed; only used for constructibility elsewhere.
      }),
      AWS_REGION: "eu-south-1",
      M3LAWSClientError: class M3LAWSClientError extends Error {},
    }));

    const [{ M3LScript }, { M3LError }, environmentMod, configMod] =
      await Promise.all([
        import("../src/core/script/index.js"),
        import("../src/core/errors/index.js"),
        import("../src/core/environment/index.js"),
        import("../src/core/config/index.js"),
      ]);

    const {
      M3LExecutionEnvironment,
      M3LExecutionEnvironmentType,
      M3LDeploymentMode,
      M3LCredentialSource,
    } = environmentMod;
    const { M3LConfigParameter, M3LConfigParameterType } = configMod;

    const environmentInfo = {
      environmentType: M3LExecutionEnvironmentType.CI,
      isInteractive: false,
      isAWSManaged: false,
      canPromptUser: false,
      canOpenBrowser: false,
      requiresAwsProfile: false,
      credentialSource: M3LCredentialSource.ENVIRONMENT,
      detectionDetails: {
        stdoutIsTTY: false,
        stderrIsTTY: false,
        isCiEnvironment: true,
        hasLambdaTaskRoot: false,
        hasEcsMetadataUri: false,
        hasCodeBuildBuildId: false,
        workspaceMarkerPath: undefined,
      },
      deploymentMode: M3LDeploymentMode.STANDALONE,
      monorepoRoot: undefined,
    };
    vi.spyOn(M3LExecutionEnvironment, "detect").mockReturnValue(
      environmentInfo,
    );
    vi.spyOn(M3LExecutionEnvironment, "detectFresh").mockReturnValue(
      environmentInfo,
    );

    const awsProfileParam = new M3LConfigParameter<string>({
      name: "aws.profile",
      type: M3LConfigParameterType.STRING,
      defaultValue: "test-profile",
    });

    const script = new M3LScript({
      metadata: { name: "test-script", version: "1.0.0" },
      config: { params: [awsProfileParam] },
    });

    let thrown: unknown;
    try {
      await script.run(async () => {
        // No-op mainFn; provisioning is expected to reject before this runs.
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as InstanceType<typeof M3LError>).code).toBe(
      "ERR_AWS_PROVISIONING",
    );
    expect((thrown as InstanceType<typeof M3LError>).cause).toBe(sentinel);
  });
});
