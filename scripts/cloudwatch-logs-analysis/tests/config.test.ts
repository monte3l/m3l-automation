import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  ANALYSIS_OPERATIONS,
  configParameters,
  configValidators,
  MAX_DEPTH_DEFAULT,
  RUNBOOK_DIR_DEFAULT,
} from "../src/config.js";

/**
 * Contract: `docs/reference/scripts/cloudwatch-logs-analysis.md`,
 * "Configuration schema". This smoke test asserts the DECLARATION and the
 * cross-parameter validators only — never resolution or coercion, which are
 * the library's own tested pipeline.
 */

/** Builds a raw `Core.M3LConfig` store directly, bypassing provider resolution. */
function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) config.set(key, value);
  return config;
}

/** Runs every declared validator, returning the first failure message. */
function firstFailure(config: Core.M3LConfig): string | undefined {
  for (const validator of configValidators) {
    const result = validator(config);
    if (result !== true) return result;
  }
  return undefined;
}

describe("cloudwatch-logs-analysis config declaration", () => {
  it("declares every parameter via M3LConfigParameter with a unique name", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(new Set(names).size).toBe(names.length);
    for (const parameter of configParameters) {
      expect(parameter).toBeInstanceOf(Core.M3LConfigParameter);
    }
  });

  it("declares exactly the thirteen parameters named in the contract table", () => {
    expect(new Set(configParameters.map((p) => p.getName()))).toEqual(
      new Set([
        "operation",
        Core.AWS_PROFILE_PARAM_NAME,
        "alarm",
        "triggeredAt",
        "runbookDir",
        "source",
        "leadMinutes",
        "lagMinutes",
        "severityLadder",
        "maxDepth",
        "interactive",
        "output",
        "format",
      ]),
    );
  });

  it("declares aws.profile without required:true, so the offline operations need no credentials", () => {
    const profile = configParameters.find(
      (parameter) => parameter.getName() === Core.AWS_PROFILE_PARAM_NAME,
    );
    expect(profile).toBeDefined();
    expect(profile?.isRequired()).toBe(false);
  });

  it("declares no parameter as required:true — requiredness is per-operation", () => {
    expect(configParameters.filter((p) => p.isRequired())).toEqual([]);
  });

  it("defaults runbookDir, maxDepth, operation, interactive and format only", () => {
    const withDefaults = configParameters
      .filter((parameter) => parameter.getDefaultValue() !== undefined)
      .map((parameter) => parameter.getName());
    expect(new Set(withDefaults)).toEqual(
      new Set(["operation", "runbookDir", "maxDepth", "interactive", "format"]),
    );
  });

  it("leaves the preset-override parameters undefaulted, so absent means 'the preset decides'", () => {
    for (const name of ["leadMinutes", "lagMinutes", "severityLadder"]) {
      const parameter = configParameters.find((p) => p.getName() === name);
      expect(parameter?.getDefaultValue()).toBeUndefined();
    }
  });

  it("exposes the declared defaults as named constants the steps read back", () => {
    const runbookDir = configParameters.find(
      (parameter) => parameter.getName() === "runbookDir",
    );
    const maxDepth = configParameters.find(
      (parameter) => parameter.getName() === "maxDepth",
    );
    expect(runbookDir?.getDefaultValue()).toBe(RUNBOOK_DIR_DEFAULT);
    expect(maxDepth?.getDefaultValue()).toBe(MAX_DEPTH_DEFAULT);
  });

  it("declares the four operations the dispatcher handles", () => {
    expect([...ANALYSIS_OPERATIONS]).toEqual([
      "analyze",
      "validate",
      "explain",
      "convert",
    ]);
  });
});

describe("'operation' — declared ADR-0055 operations", () => {
  const operation = configParameters.find(
    (parameter) => parameter.getName() === "operation",
  );

  /** Resolves `operation` against a single raw value, via an in-memory provider. */
  async function resolveOperation(raw: string): Promise<unknown> {
    if (operation === undefined) {
      throw new Error("expected the 'operation' parameter to be declared");
    }
    const reader = new Core.M3LConfigReader([
      new Core.M3LInMemoryConfigProvider({ operation: raw }),
    ]);
    return operation.getValueAsync(reader);
  }

  it("rejects a value outside the declared operation set", async () => {
    await expect(resolveOperation("frobnicate")).rejects.toBeInstanceOf(
      Core.M3LConfigValidationError,
    );
  });

  /**
   * Hand-authored — deliberately NOT re-derived from
   * `ANALYSIS_OPERATION_DECLARATIONS` (the src export under test), so a typo
   * in that export's `requiredParameters` is caught rather than compared
   * against itself.
   */
  const EXPECTED_REQUIRED_PARAMETERS: ReadonlyArray<
    readonly [string, readonly string[]]
  > = [
    ["analyze", [Core.AWS_PROFILE_PARAM_NAME, "alarm", "triggeredAt"]],
    ["validate", []],
    ["explain", ["alarm"]],
    ["convert", ["source"]],
  ];

  function expectedRequiredParametersFor(name: string): readonly string[] {
    const found = EXPECTED_REQUIRED_PARAMETERS.find(
      ([opName]) => opName === name,
    );
    if (found === undefined) {
      throw new Error(
        `test fixture error: no hand-authored requirement table entry for '${name}'`,
      );
    }
    return found[1];
  }

  it("round-trips getOperations() against the hand-authored requirement table", () => {
    expect(operation).toBeDefined();
    const operations = operation?.getOperations();
    expect(operations).toBeDefined();
    if (operations === undefined) return;

    expect(operations.map((op) => op.name)).toEqual([...ANALYSIS_OPERATIONS]);

    for (const op of operations) {
      expect(op.description.trim().length).toBeGreaterThan(0);
      expect(op.requiredParameters ?? []).toEqual(
        expectedRequiredParametersFor(op.name),
      );
    }
  });

  it("names only declared parameters in every operation's requiredParameters", () => {
    const operations = operation?.getOperations();
    expect(operations).toBeDefined();
    if (operations === undefined) return;

    const declaredNames = new Set(
      configParameters.map((parameter) => parameter.getName()),
    );
    for (const op of operations) {
      for (const required of op.requiredParameters ?? []) {
        expect(declaredNames.has(required)).toBe(true);
      }
    }
  });

  it("'validate' declares no required parameters, so it passes every validator (vacuous pass)", () => {
    const operations = operation?.getOperations();
    const validate = operations?.find((op) => op.name === "validate");
    expect(validate?.requiredParameters ?? []).toEqual([]);
    expect(
      firstFailure(buildConfig({ operation: "validate" })),
    ).toBeUndefined();
  });
});

describe("configValidators (cross-parameter requiredness)", () => {
  it("accepts a fully specified analyze run", () => {
    expect(
      firstFailure(
        buildConfig({
          operation: "analyze",
          [Core.AWS_PROFILE_PARAM_NAME]: "example-profile",
          alarm: "example-gateway-5xx",
          triggeredAt: "2026-08-23T14:32:00Z",
        }),
      ),
    ).toBeUndefined();
  });

  it.each([[Core.AWS_PROFILE_PARAM_NAME], ["alarm"], ["triggeredAt"]])(
    "rejects an analyze run missing %s",
    (missing) => {
      const values: Record<string, unknown> = {
        operation: "analyze",
        [Core.AWS_PROFILE_PARAM_NAME]: "example-profile",
        alarm: "example-gateway-5xx",
        triggeredAt: "2026-08-23T14:32:00Z",
      };
      delete values[missing];
      expect(firstFailure(buildConfig(values))).toContain(missing);
    },
  );

  it("accepts a validate run with no alarm, no profile and no timestamp", () => {
    expect(
      firstFailure(buildConfig({ operation: "validate" })),
    ).toBeUndefined();
  });

  it("requires only alarm for explain", () => {
    expect(firstFailure(buildConfig({ operation: "explain" }))).toContain(
      "alarm",
    );
    expect(
      firstFailure(buildConfig({ operation: "explain", alarm: "example" })),
    ).toBeUndefined();
  });

  it("requires only source for convert", () => {
    expect(firstFailure(buildConfig({ operation: "convert" }))).toContain(
      "source",
    );
    expect(
      firstFailure(buildConfig({ operation: "convert", source: "a.md" })),
    ).toBeUndefined();
  });

  it("enforces analyze's requirements when operation is explicitly 'analyze'", () => {
    expect(firstFailure(buildConfig({ operation: "analyze" }))).toContain(
      "analyze",
    );
  });

  // deriveOperationValidators' per-parameter check vacuously passes
  // (`typeof current !== "string" → return true`) whenever the selector
  // value itself is absent from the store — it carries no fallback of its
  // own. Real behaviour is unchanged, because `operation` is declared with
  // `defaultValue: "analyze"` and M3LScript's config loader resolves every
  // declared default into the store BEFORE any validator runs — running the
  // built script with no `--operation` yields
  // `'aws.profile' is required for operation(s): analyze`. This test builds
  // a raw M3LConfig store directly, bypassing that default resolution, so it
  // observes the validator's own (correct) vacuous-pass behavior rather than
  // the pipeline's end-to-end one.
  it("vacuously passes at the raw-store level when operation is absent — the declared defaultValue, not this validator, supplies 'analyze' in the real M3LScript pipeline", () => {
    expect(firstFailure(buildConfig({}))).toBeUndefined();
  });

  it("rejects a triggeredAt that is not an ISO-8601 timestamp", () => {
    expect(
      firstFailure(
        buildConfig({ operation: "validate", triggeredAt: "yesterday" }),
      ),
    ).toContain("ISO-8601");
  });

  it("accepts an absent triggeredAt for an operation that does not need one", () => {
    expect(
      firstFailure(buildConfig({ operation: "validate" })),
    ).toBeUndefined();
  });
});
