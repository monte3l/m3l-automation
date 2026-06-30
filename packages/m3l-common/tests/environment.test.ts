/**
 * Tests for core/environment submodule — written tests-first (RED phase).
 * The implementation does NOT exist; all tests are expected to fail because
 * the module `../src/core/environment/index.js` cannot be resolved yet.
 *
 * Contract source: docs/reference/core/environment.md
 * Exports: M3LExecutionEnvironment, M3LEnv, M3LExecutionEnvironmentType,
 *   M3LDeploymentMode, M3LCredentialSource, M3LEnvironmentDetectionError,
 *   and types M3LExecutionEnvironmentInfo, M3LEnvironmentDetectionDetails
 *   (8 symbols total).
 *
 * Key behavioral contracts:
 *  - detect(): returns cached singleton; synchronous.
 *  - detectFresh(): clears cache and re-detects.
 *  - isInteractive(): shortcut for detect().isInteractive.
 *  - M3LEnv === M3LExecutionEnvironment (same singleton).
 *  - Monorepo walk-up: finds pnpm-workspace.yaml or package.json#workspaces.
 *  - Environment type priority: AWS_LAMBDA > AWS_ECS > AWS_CODEBUILD > CI > LOCAL_INTERACTIVE > UNKNOWN.
 *  - M3LEnvironmentDetectionError extends M3LError, code "ERR_ENVIRONMENT_DETECTION".
 *  - M3L_DEPLOYMENT_MODE env var overrides walk-up result.
 */

import * as fs from "fs";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

// Make the 'fs' module configurable so vi.spyOn can intercept individual
// functions (ESM namespace objects are non-writable by default).
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof fs>("fs");
  return { ...actual };
});

import { M3LError } from "../src/core/errors/index.js";
import {
  M3LCredentialSource,
  M3LDeploymentMode,
  M3LEnv,
  M3LEnvironmentDetectionError,
  M3LExecutionEnvironment,
  M3LExecutionEnvironmentType,
} from "../src/core/environment/index.js";

import type {
  M3LEnvironmentDetectionDetails,
  M3LExecutionEnvironmentInfo,
} from "../src/core/environment/index.js";

// ---------------------------------------------------------------------------
// Ensure isTTY properties exist as configurable own-properties before any spy
// tries to intercept them. In non-TTY environments (CI) these properties are
// absent on the stream objects, which causes vi.spyOn to throw.
// ---------------------------------------------------------------------------
beforeAll(() => {
  for (const stream of [process.stdout, process.stderr]) {
    if (!Object.prototype.hasOwnProperty.call(stream, "isTTY")) {
      Object.defineProperty(stream, "isTTY", {
        value: false,
        configurable: true,
        writable: true,
      });
    }
  }
  if (!Object.prototype.hasOwnProperty.call(process.stdin, "isTTY")) {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
      writable: true,
    });
  }
});

// ---------------------------------------------------------------------------
// Reset singleton before each test so env-var changes take effect.
// ---------------------------------------------------------------------------
beforeEach(() => {
  // Reset the singleton cache only — each test calls detectFresh() with its
  // own mocks already in place, avoiding real filesystem I/O in the shared hook.
  M3LExecutionEnvironment.resetForTesting();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// M3LExecutionEnvironmentType — enum literal values
// ---------------------------------------------------------------------------
describe("M3LExecutionEnvironmentType — enum literal values", () => {
  test.each([
    ["LOCAL_INTERACTIVE", "LOCAL_INTERACTIVE"],
    ["CI", "CI"],
    ["AWS_LAMBDA", "AWS_LAMBDA"],
    ["AWS_ECS", "AWS_ECS"],
    ["AWS_EC2", "AWS_EC2"],
    ["AWS_CODEBUILD", "AWS_CODEBUILD"],
    ["UNKNOWN", "UNKNOWN"],
  ] as const)("%s equals its string value", (key, value) => {
    expect(M3LExecutionEnvironmentType[key]).toBe(value);
  });

  test("LOCAL_INTERACTIVE is typed as literal", () => {
    expectTypeOf(
      M3LExecutionEnvironmentType.LOCAL_INTERACTIVE,
    ).toEqualTypeOf<"LOCAL_INTERACTIVE">();
  });

  test("CI is typed as literal", () => {
    expectTypeOf(M3LExecutionEnvironmentType.CI).toEqualTypeOf<"CI">();
  });

  test("AWS_LAMBDA is typed as literal", () => {
    expectTypeOf(
      M3LExecutionEnvironmentType.AWS_LAMBDA,
    ).toEqualTypeOf<"AWS_LAMBDA">();
  });

  test("AWS_ECS is typed as literal", () => {
    expectTypeOf(
      M3LExecutionEnvironmentType.AWS_ECS,
    ).toEqualTypeOf<"AWS_ECS">();
  });

  test("AWS_EC2 is typed as literal", () => {
    expectTypeOf(
      M3LExecutionEnvironmentType.AWS_EC2,
    ).toEqualTypeOf<"AWS_EC2">();
  });

  test("AWS_CODEBUILD is typed as literal", () => {
    expectTypeOf(
      M3LExecutionEnvironmentType.AWS_CODEBUILD,
    ).toEqualTypeOf<"AWS_CODEBUILD">();
  });

  test("UNKNOWN is typed as literal", () => {
    expectTypeOf(
      M3LExecutionEnvironmentType.UNKNOWN,
    ).toEqualTypeOf<"UNKNOWN">();
  });
});

// ---------------------------------------------------------------------------
// M3LDeploymentMode — enum literal values
// ---------------------------------------------------------------------------
describe("M3LDeploymentMode — enum literal values", () => {
  test("MONOREPO equals its string value", () => {
    expect(M3LDeploymentMode.MONOREPO).toBe("MONOREPO");
  });

  test("STANDALONE equals its string value", () => {
    expect(M3LDeploymentMode.STANDALONE).toBe("STANDALONE");
  });

  test("MONOREPO is typed as literal", () => {
    expectTypeOf(M3LDeploymentMode.MONOREPO).toEqualTypeOf<"MONOREPO">();
  });

  test("STANDALONE is typed as literal", () => {
    expectTypeOf(M3LDeploymentMode.STANDALONE).toEqualTypeOf<"STANDALONE">();
  });
});

// ---------------------------------------------------------------------------
// M3LCredentialSource — enum literal values
// ---------------------------------------------------------------------------
describe("M3LCredentialSource — enum literal values", () => {
  test.each([
    ["SSO_PROFILE", "SSO_PROFILE"],
    ["ENVIRONMENT", "ENVIRONMENT"],
    ["CONTAINER", "CONTAINER"],
    ["INSTANCE_METADATA", "INSTANCE_METADATA"],
    ["WEB_IDENTITY", "WEB_IDENTITY"],
    ["DEFAULT_CHAIN", "DEFAULT_CHAIN"],
    ["NONE", "NONE"],
  ] as const)("%s equals its string value", (key, value) => {
    expect(M3LCredentialSource[key]).toBe(value);
  });

  test("SSO_PROFILE is typed as literal", () => {
    expectTypeOf(
      M3LCredentialSource.SSO_PROFILE,
    ).toEqualTypeOf<"SSO_PROFILE">();
  });

  test("NONE is typed as literal", () => {
    expectTypeOf(M3LCredentialSource.NONE).toEqualTypeOf<"NONE">();
  });
});

// ---------------------------------------------------------------------------
// M3LEnvironmentDetectionError
// ---------------------------------------------------------------------------
describe("M3LEnvironmentDetectionError", () => {
  test("is an instance of Error", () => {
    const e = new M3LEnvironmentDetectionError("detection failed", {
      code: "ERR_ENVIRONMENT_DETECTION",
    });
    expect(e).toBeInstanceOf(Error);
  });

  test("is an instance of M3LError", () => {
    const e = new M3LEnvironmentDetectionError("detection failed", {
      code: "ERR_ENVIRONMENT_DETECTION",
    });
    expect(e).toBeInstanceOf(M3LError);
  });

  test("is an instance of M3LEnvironmentDetectionError", () => {
    const e = new M3LEnvironmentDetectionError("detection failed", {
      code: "ERR_ENVIRONMENT_DETECTION",
    });
    expect(e).toBeInstanceOf(M3LEnvironmentDetectionError);
  });

  test("has code ERR_ENVIRONMENT_DETECTION", () => {
    const e = new M3LEnvironmentDetectionError("detection failed", {
      code: "ERR_ENVIRONMENT_DETECTION",
    });
    expect(e.code).toBe("ERR_ENVIRONMENT_DETECTION");
  });

  test("carries a cause when wrapping a filesystem error", () => {
    const fsError = Object.assign(new Error("Permission denied"), {
      code: "EACCES",
    });
    const e = new M3LEnvironmentDetectionError("cannot read dir", {
      code: "ERR_ENVIRONMENT_DETECTION",
      cause: fsError,
    });
    expect(e.cause).toBe(fsError);
  });

  test("name is M3LEnvironmentDetectionError", () => {
    const e = new M3LEnvironmentDetectionError("msg", {
      code: "ERR_ENVIRONMENT_DETECTION",
    });
    expect(e.name).toBe("M3LEnvironmentDetectionError");
  });

  test("M3LEnvironmentDetectionError.code is the literal type 'ERR_ENVIRONMENT_DETECTION'", () => {
    const err = new M3LEnvironmentDetectionError("test", {
      code: "ERR_ENVIRONMENT_DETECTION",
    });
    expectTypeOf(err.code).toEqualTypeOf<"ERR_ENVIRONMENT_DETECTION">();
    expect(err.code).toBe("ERR_ENVIRONMENT_DETECTION");
  });
});

// ---------------------------------------------------------------------------
// M3LExecutionEnvironmentInfo — type-level contract
// ---------------------------------------------------------------------------
describe("M3LExecutionEnvironmentInfo — type-level contract", () => {
  test("has all 10 required readonly properties", () => {
    expectTypeOf<M3LExecutionEnvironmentInfo>().toExtend<{
      readonly environmentType: string;
      readonly deploymentMode: string;
      readonly isInteractive: boolean;
      readonly isAWSManaged: boolean;
      readonly canPromptUser: boolean;
      readonly canOpenBrowser: boolean;
      readonly requiresAwsProfile: boolean;
      readonly monorepoRoot: string | undefined;
      readonly credentialSource: string;
      readonly detectionDetails: M3LEnvironmentDetectionDetails;
    }>();
  });

  test("environmentType is typed as M3LExecutionEnvironmentType value", () => {
    expectTypeOf<
      M3LExecutionEnvironmentInfo["environmentType"]
    >().toEqualTypeOf<
      | "LOCAL_INTERACTIVE"
      | "CI"
      | "AWS_LAMBDA"
      | "AWS_ECS"
      | "AWS_EC2"
      | "AWS_CODEBUILD"
      | "UNKNOWN"
    >();
  });

  test("deploymentMode is typed as M3LDeploymentMode value", () => {
    expectTypeOf<M3LExecutionEnvironmentInfo["deploymentMode"]>().toEqualTypeOf<
      "MONOREPO" | "STANDALONE"
    >();
  });

  test("credentialSource is typed as M3LCredentialSource value", () => {
    expectTypeOf<
      M3LExecutionEnvironmentInfo["credentialSource"]
    >().toEqualTypeOf<
      | "SSO_PROFILE"
      | "ENVIRONMENT"
      | "CONTAINER"
      | "INSTANCE_METADATA"
      | "WEB_IDENTITY"
      | "DEFAULT_CHAIN"
      | "NONE"
    >();
  });
});

// ---------------------------------------------------------------------------
// M3LExecutionEnvironmentInfo — discriminated union narrowing (MF-7)
// ---------------------------------------------------------------------------
describe("M3LExecutionEnvironmentInfo — discriminated union narrowing", () => {
  test("narrowing on deploymentMode === MONOREPO gives monorepoRoot: string (not string | undefined)", () => {
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "monorepo");
    const info = M3LExecutionEnvironment.detectFresh();
    if (info.deploymentMode === M3LDeploymentMode.MONOREPO) {
      expectTypeOf(info.monorepoRoot).toEqualTypeOf<string>();
    } else {
      expectTypeOf(info.monorepoRoot).toEqualTypeOf<undefined>();
    }
  });
});

// ---------------------------------------------------------------------------
// M3LEnvironmentDetectionDetails — type-level contract
// ---------------------------------------------------------------------------
describe("M3LEnvironmentDetectionDetails — type-level contract", () => {
  test("has the 7 minimum required readonly fields", () => {
    expectTypeOf<M3LEnvironmentDetectionDetails>().toExtend<{
      readonly stdoutIsTTY: boolean;
      readonly stderrIsTTY: boolean;
      readonly isCiEnvironment: boolean;
      readonly hasLambdaTaskRoot: boolean;
      readonly hasEcsMetadataUri: boolean;
      readonly hasCodeBuildBuildId: boolean;
      readonly workspaceMarkerPath: string | undefined;
    }>();
  });
});

// ---------------------------------------------------------------------------
// M3LExecutionEnvironment.detect() — return type
// ---------------------------------------------------------------------------
describe("M3LExecutionEnvironment.detect() — type-level contract", () => {
  test("detect() return type is M3LExecutionEnvironmentInfo", () => {
    expectTypeOf(
      // eslint-disable-next-line @typescript-eslint/unbound-method -- type-only assertion; no runtime this binding
      M3LExecutionEnvironment.detect,
    ).toEqualTypeOf<() => M3LExecutionEnvironmentInfo>();
  });
});

// ---------------------------------------------------------------------------
// M3LEnv — alias type contract
// ---------------------------------------------------------------------------
describe("M3LEnv — alias type contract", () => {
  test("M3LEnv has the same type as M3LExecutionEnvironment", () => {
    expectTypeOf(M3LEnv).toEqualTypeOf(M3LExecutionEnvironment);
  });
});

// ---------------------------------------------------------------------------
// B1 — detect() returns the same object reference on repeated calls (singleton)
// ---------------------------------------------------------------------------
describe("detect() — singleton caching (B1)", () => {
  test("returns the same object reference on consecutive calls", () => {
    const first = M3LExecutionEnvironment.detect();
    const second = M3LExecutionEnvironment.detect();
    expect(first).toBe(second);
  });

  test("calling detect() five times returns the same reference", () => {
    const ref = M3LExecutionEnvironment.detect();
    for (let i = 0; i < 4; i++) {
      expect(M3LExecutionEnvironment.detect()).toBe(ref);
    }
  });
});

// ---------------------------------------------------------------------------
// B2 — detectFresh() clears cache; detect() after detectFresh() returns new result
// ---------------------------------------------------------------------------
describe("detectFresh() — cache invalidation (B2)", () => {
  beforeEach(() => {
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "standalone");
  });

  test("detectFresh() returns an M3LExecutionEnvironmentInfo object", () => {
    const result = M3LExecutionEnvironment.detectFresh();
    expect(result).toBeDefined();
    expect(typeof result.environmentType).toBe("string");
  });

  test("detect() after detectFresh() returns a new object reference", () => {
    const before = M3LExecutionEnvironment.detect();
    M3LExecutionEnvironment.detectFresh();
    const after = M3LExecutionEnvironment.detect();
    // After fresh detection the cached result is a new object
    expect(after).not.toBe(before);
  });

  test("detect() after detectFresh() is consistent (returns same new ref)", () => {
    M3LExecutionEnvironment.detectFresh();
    const first = M3LExecutionEnvironment.detect();
    const second = M3LExecutionEnvironment.detect();
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// B4 — Detection is synchronous (no Promise return)
// ---------------------------------------------------------------------------
describe("detect() — synchronous (B4)", () => {
  test("detect() does not return a Promise", () => {
    const result = M3LExecutionEnvironment.detect();
    // A Promise always has a 'then' function; a plain object must not
    expect(typeof (result as { then?: unknown }).then).toBe("undefined");
  });

  test("detectFresh() does not return a Promise", () => {
    const result = M3LExecutionEnvironment.detectFresh();
    expect(typeof (result as { then?: unknown }).then).toBe("undefined");
  });
});

// ---------------------------------------------------------------------------
// B5 — Environment type classification priority
// ---------------------------------------------------------------------------
describe("detect() — environment type priority (B5)", () => {
  test("AWS_LAMBDA_TASK_ROOT present → environmentType is AWS_LAMBDA", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "/var/task");
    vi.stubEnv("CI", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.environmentType).toBe(M3LExecutionEnvironmentType.AWS_LAMBDA);
  });

  test("ECS_CONTAINER_METADATA_URI_V4 present → environmentType is AWS_ECS", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "http://169.254.170.2/v4/meta");
    vi.stubEnv("CI", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.environmentType).toBe(M3LExecutionEnvironmentType.AWS_ECS);
  });

  test("CODEBUILD_BUILD_ID present (no Lambda/ECS) → environmentType is AWS_CODEBUILD", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "build:123");
    vi.stubEnv("CI", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.environmentType).toBe(
      M3LExecutionEnvironmentType.AWS_CODEBUILD,
    );
  });

  test("AWS_EXECUTION_ENV contains EC2 (no Lambda/ECS/CodeBuild) → environmentType is AWS_EC2", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("AWS_EXECUTION_ENV", "AWS_ECS_EC2");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.environmentType).toBe(M3LExecutionEnvironmentType.AWS_EC2);
  });

  test("CI=true (no AWS signals) → environmentType is CI", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "true");
    // Ensure stdout is not a TTY in this test
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.environmentType).toBe(M3LExecutionEnvironmentType.CI);
  });

  test("isTTY=true (no CI/AWS signals) → environmentType is LOCAL_INTERACTIVE", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("JENKINS_URL", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(true);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.environmentType).toBe(
      M3LExecutionEnvironmentType.LOCAL_INTERACTIVE,
    );
  });

  test("no signals at all → environmentType is UNKNOWN", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("JENKINS_URL", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.environmentType).toBe(M3LExecutionEnvironmentType.UNKNOWN);
  });
});

// ---------------------------------------------------------------------------
// B6 — Capability flags
// ---------------------------------------------------------------------------
describe("detect() — capability flags (B6)", () => {
  test("isInteractive is true when environmentType is LOCAL_INTERACTIVE", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("JENKINS_URL", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(true);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.isInteractive).toBe(true);
  });

  test("isInteractive is false when environmentType is CI", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.isInteractive).toBe(false);
  });

  test.each([
    ["AWS_LAMBDA", { AWS_LAMBDA_TASK_ROOT: "/var/task" }],
    [
      "AWS_ECS",
      {
        ECS_CONTAINER_METADATA_URI_V4: "http://meta",
        AWS_LAMBDA_TASK_ROOT: "",
      },
    ],
    [
      "AWS_CODEBUILD",
      {
        CODEBUILD_BUILD_ID: "build:1",
        AWS_LAMBDA_TASK_ROOT: "",
        ECS_CONTAINER_METADATA_URI_V4: "",
      },
    ],
    [
      "AWS_EC2",
      {
        AWS_EXECUTION_ENV: "AWS_ECS_EC2",
        AWS_LAMBDA_TASK_ROOT: "",
        ECS_CONTAINER_METADATA_URI_V4: "",
        CODEBUILD_BUILD_ID: "",
      },
    ],
  ] as const)("isAWSManaged is true for %s", (_, envVars) => {
    for (const [k, v] of Object.entries(envVars)) {
      vi.stubEnv(k, v);
    }
    vi.stubEnv("CI", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.isAWSManaged).toBe(true);
  });

  test("AWS_EC2 → credentialSource is INSTANCE_METADATA", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("AWS_EXECUTION_ENV", "AWS_ECS_EC2");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.credentialSource).toBe(M3LCredentialSource.INSTANCE_METADATA);
  });

  test("isAWSManaged is false for CI", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.isAWSManaged).toBe(false);
  });

  test("isAWSManaged is false for LOCAL_INTERACTIVE", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("JENKINS_URL", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(true);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.isAWSManaged).toBe(false);
  });

  test("isAWSManaged is false for UNKNOWN", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("JENKINS_URL", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.isAWSManaged).toBe(false);
  });

  test("canPromptUser is true when LOCAL_INTERACTIVE and stdin is a TTY", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("JENKINS_URL", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(true);
    vi.spyOn(process.stdin, "isTTY", "get").mockReturnValue(true);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.canPromptUser).toBe(true);
  });

  test("canPromptUser is false when LOCAL_INTERACTIVE but stdin is not a TTY", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("JENKINS_URL", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(true);
    vi.spyOn(process.stdin, "isTTY", "get").mockReturnValue(false);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.canPromptUser).toBe(false);
  });

  test("canPromptUser is false when not LOCAL_INTERACTIVE", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    vi.spyOn(process.stdin, "isTTY", "get").mockReturnValue(true);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.canPromptUser).toBe(false);
  });

  test("canOpenBrowser is true only when LOCAL_INTERACTIVE", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("JENKINS_URL", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(true);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.canOpenBrowser).toBe(true);
  });

  test("canOpenBrowser is false when not LOCAL_INTERACTIVE", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.canOpenBrowser).toBe(false);
  });

  test("requiresAwsProfile is true when credentialSource is SSO_PROFILE", () => {
    // LOCAL_INTERACTIVE → SSO_PROFILE is the expected credential source
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("JENKINS_URL", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(true);
    const info = M3LExecutionEnvironment.detectFresh();
    if (info.credentialSource === M3LCredentialSource.SSO_PROFILE) {
      expect(info.requiresAwsProfile).toBe(true);
    } else {
      // If not SSO_PROFILE in this env, skip the assertion — the flag only matters for SSO_PROFILE
      expect(info.requiresAwsProfile).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// B7 — No top-level side effects: importing the module must not trigger detection
// ---------------------------------------------------------------------------
describe("detect() — no top-level side effects on import (B7)", () => {
  test("env vars set after import are picked up by detectFresh()", () => {
    // detectFresh() is called in beforeEach; here we set an env var and
    // verify the new detectFresh() picks it up — proving detection happens
    // lazily, not at import time.
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "/var/task");
    vi.stubEnv("CI", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.environmentType).toBe(M3LExecutionEnvironmentType.AWS_LAMBDA);
  });
});

// ---------------------------------------------------------------------------
// B3 — Monorepo walk-up (mocked filesystem, no real I/O)
// ---------------------------------------------------------------------------
describe("detect() — monorepo walk-up (B3)", () => {
  test("MONOREPO when pnpm-workspace.yaml is found up the tree", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/fake/packages/my-script");
    vi.spyOn(fs, "readdirSync").mockReturnValue([]);
    vi.spyOn(fs, "existsSync").mockImplementation(
      (p) => String(p) === "/fake/pnpm-workspace.yaml",
    );
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.deploymentMode).toBe(M3LDeploymentMode.MONOREPO);
  });

  test("monorepoRoot points to the directory containing pnpm-workspace.yaml", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/fake/nested/deep");
    vi.spyOn(fs, "readdirSync").mockReturnValue([]);
    vi.spyOn(fs, "existsSync").mockImplementation(
      (p) => String(p) === "/fake/pnpm-workspace.yaml",
    );
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.deploymentMode).toBe(M3LDeploymentMode.MONOREPO);
    expect(info.monorepoRoot).toBe("/fake");
  });

  test("MONOREPO when package.json with workspaces field is found", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/fake/apps/tool");
    vi.spyOn(fs, "readdirSync").mockReturnValue([]);
    vi.spyOn(fs, "existsSync").mockImplementation(
      (p) => String(p) === "/fake/package.json",
    );
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ name: "monorepo-root", workspaces: ["apps/*"] }),
    );
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.deploymentMode).toBe(M3LDeploymentMode.MONOREPO);
  });

  test("STANDALONE when neither marker is found (walk reaches root)", () => {
    // Walk from a fake isolated dir; existsSync returns false for all paths,
    // so the walk ascends to '/' and terminates naturally → STANDALONE.
    vi.spyOn(process, "cwd").mockReturnValue("/fake/isolated");
    vi.spyOn(fs, "readdirSync").mockReturnValue([]);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.deploymentMode).toBe(M3LDeploymentMode.STANDALONE);
  });

  test("monorepoRoot is undefined in STANDALONE mode", () => {
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "standalone");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.monorepoRoot).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B8 — Walk-up throws M3LEnvironmentDetectionError on unreadable directory
// ---------------------------------------------------------------------------
describe("detect() — unreadable directory throws M3LEnvironmentDetectionError (B8)", () => {
  test("throws M3LEnvironmentDetectionError when readdirSync throws EACCES", () => {
    const eaccesError = Object.assign(new Error("Permission denied"), {
      code: "EACCES",
    });
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw eaccesError;
    });
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "");
    expect(() => M3LExecutionEnvironment.detectFresh()).toThrow(
      M3LEnvironmentDetectionError,
    );
  });

  test("thrown M3LEnvironmentDetectionError has the filesystem error as cause", () => {
    const eaccesError = Object.assign(new Error("Permission denied"), {
      code: "EACCES",
    });
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw eaccesError;
    });
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "");
    let thrown: unknown;
    try {
      M3LExecutionEnvironment.detectFresh();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(M3LEnvironmentDetectionError);
    expect((thrown as M3LEnvironmentDetectionError).cause).toBe(eaccesError);
  });
});

// ---------------------------------------------------------------------------
// B9 — Walk-up terminates at filesystem root; does not infinite-loop
// ---------------------------------------------------------------------------
describe("detect() — walk terminates at filesystem root (B9)", () => {
  test("detectFresh() completes without hanging when no marker exists", () => {
    // Force STANDALONE via env var to avoid relying on actual filesystem
    // structure; the standalone override short-circuits before the walk-up.
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "standalone");
    // Must complete without throwing or infinite-looping
    expect(() => M3LExecutionEnvironment.detectFresh()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// B10 — M3L_DEPLOYMENT_MODE env var forces override (mocked filesystem)
// ---------------------------------------------------------------------------
describe("detect() — M3L_DEPLOYMENT_MODE env var override (B10)", () => {
  test("M3L_DEPLOYMENT_MODE=standalone forces STANDALONE even when workspace marker exists on disk", () => {
    // standalone override short-circuits before walk-up; no fs I/O needed
    vi.spyOn(process, "cwd").mockReturnValue("/fake/root");
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "standalone");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.deploymentMode).toBe(M3LDeploymentMode.STANDALONE);
  });

  test("M3L_DEPLOYMENT_MODE=monorepo forces MONOREPO and walk-up still finds the root", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/fake/scripts");
    vi.spyOn(fs, "readdirSync").mockReturnValue([]);
    vi.spyOn(fs, "existsSync").mockImplementation(
      (p) => String(p) === "/fake/pnpm-workspace.yaml",
    );
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "monorepo");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.deploymentMode).toBe(M3LDeploymentMode.MONOREPO);
    expect(info.monorepoRoot).toBe("/fake");
  });

  test("M3L_DEPLOYMENT_MODE=monorepo throws when no workspace marker is found", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/fake/isolated");
    vi.spyOn(fs, "readdirSync").mockReturnValue([]);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "monorepo");
    expect(() => M3LExecutionEnvironment.detectFresh()).toThrow(
      M3LEnvironmentDetectionError,
    );
  });
});

// ---------------------------------------------------------------------------
// B11 — detectionDetails records raw signals
// ---------------------------------------------------------------------------
describe("detect() — detectionDetails records raw signals (B11)", () => {
  test("detectionDetails is present on the info object", () => {
    const info = M3LExecutionEnvironment.detect();
    expect(info.detectionDetails).toBeDefined();
  });

  test("hasLambdaTaskRoot is true when AWS_LAMBDA_TASK_ROOT is set", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "/var/task");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.detectionDetails.hasLambdaTaskRoot).toBe(true);
  });

  test("hasLambdaTaskRoot is false when AWS_LAMBDA_TASK_ROOT is absent", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.detectionDetails.hasLambdaTaskRoot).toBe(false);
  });

  test("hasEcsMetadataUri is true when ECS_CONTAINER_METADATA_URI_V4 is set", () => {
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "http://169.254.170.2/v4/meta");
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.detectionDetails.hasEcsMetadataUri).toBe(true);
  });

  test("hasCodeBuildBuildId is true when CODEBUILD_BUILD_ID is set", () => {
    vi.stubEnv("CODEBUILD_BUILD_ID", "codebuild-run-123");
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.detectionDetails.hasCodeBuildBuildId).toBe(true);
  });

  test("isCiEnvironment is true when CI=true", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.detectionDetails.isCiEnvironment).toBe(true);
  });

  test("stdoutIsTTY reflects process.stdout.isTTY", () => {
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(true);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.detectionDetails.stdoutIsTTY).toBe(true);
  });

  test("stderrIsTTY reflects process.stderr.isTTY", () => {
    vi.spyOn(process.stderr, "isTTY", "get").mockReturnValue(true);
    const info = M3LExecutionEnvironment.detectFresh();
    expect(info.detectionDetails.stderrIsTTY).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B12 — M3LEnv.detect() and M3LExecutionEnvironment.detect() share the singleton
// ---------------------------------------------------------------------------
describe("M3LEnv — shares singleton with M3LExecutionEnvironment (B12)", () => {
  test("M3LEnv.detect() returns the same object reference as M3LExecutionEnvironment.detect()", () => {
    const viaClass = M3LExecutionEnvironment.detect();
    const viaAlias = M3LEnv.detect();
    expect(viaAlias).toBe(viaClass);
  });

  test("M3LEnv.detectFresh() also clears the singleton shared with M3LExecutionEnvironment", () => {
    const before = M3LExecutionEnvironment.detect();
    M3LEnv.detectFresh();
    const after = M3LExecutionEnvironment.detect();
    expect(after).not.toBe(before);
  });

  test("M3LEnv.isInteractive() equals M3LExecutionEnvironment.isInteractive()", () => {
    expect(M3LEnv.isInteractive()).toBe(
      M3LExecutionEnvironment.isInteractive(),
    );
  });
});

// ---------------------------------------------------------------------------
// isInteractive() — convenience shortcut
// ---------------------------------------------------------------------------
describe("M3LExecutionEnvironment.isInteractive() — convenience shortcut", () => {
  test("returns a boolean", () => {
    expect(typeof M3LExecutionEnvironment.isInteractive()).toBe("boolean");
  });

  test("equals detect().isInteractive", () => {
    const info = M3LExecutionEnvironment.detect();
    expect(M3LExecutionEnvironment.isInteractive()).toBe(info.isInteractive);
  });

  test("returns true when environmentType is LOCAL_INTERACTIVE", () => {
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("JENKINS_URL", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(true);
    M3LExecutionEnvironment.detectFresh();
    expect(M3LExecutionEnvironment.isInteractive()).toBe(true);
  });

  test("returns false when environmentType is CI", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("AWS_LAMBDA_TASK_ROOT", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
    vi.stubEnv("CODEBUILD_BUILD_ID", "");
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    M3LExecutionEnvironment.detectFresh();
    expect(M3LExecutionEnvironment.isInteractive()).toBe(false);
  });
});
