import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "../src/config.js";

// The mandatory config-declaration smoke test (ADR-0022 §8). Importing the
// schema is itself an assertion: M3LConfigParameter validates a declared
// defaultValue eagerly in its constructor, so a default that violates its own
// validator fails this file at import time.
describe("agent-operator config declaration", () => {
  it("declares at least one parameter", () => {
    expect(configParameters.length).toBeGreaterThan(0);
  });

  it("declares every parameter via M3LConfigParameter with a unique name", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(new Set(names).size).toBe(names.length);
    for (const parameter of configParameters) {
      expect(parameter).toBeInstanceOf(Core.M3LConfigParameter);
    }
  });

  it("declares exactly the two PR-1 operations on the `command` parameter", () => {
    const command = configParameters.find(
      (parameter) => parameter.getName() === "command",
    );
    expect(command).toBeDefined();
    const operationNames = (command?.getOperations() ?? []).map(
      (operation) => operation.name,
    );
    // PR 1 is offline-only: no generic ask/prompt operation exists, because
    // that would let model output choose the workload (see config.ts's
    // deliberate-absence comment).
    expect(operationNames).toEqual(["health-check", "explain-policy"]);
  });

  it("declares at least one schema-level cross-parameter validator", () => {
    expect(configValidators.length).toBeGreaterThan(0);
  });

  it("declares exactly aws.profile, command, and modelId as required", () => {
    const requiredNames = configParameters
      .filter((parameter) => parameter.isRequired())
      .map((parameter) => parameter.getName())
      .sort();
    expect(requiredNames).toEqual(
      [Core.AWS_PROFILE_PARAM_NAME, "command", "modelId"].sort(),
    );
  });

  // Deliberate absences (see config.ts's comment): budgets are policy-file
  // fields, `dryRun` is the ADR-0054 context flag read once in main.ts, and
  // this workload never calls confirmDestructive so it needs neither
  // `yes` nor `yesSensitive`. Widening any of these on argv would let an
  // operator escape the declared, diffable policy file.
  it.each(["dryRun", "yes", "yesSensitive"])(
    "never declares a '%s' parameter",
    (name) => {
      expect(
        configParameters.some((parameter) => parameter.getName() === name),
      ).toBe(false);
    },
  );

  it("never declares a budget* parameter — budgets are policy-file fields", () => {
    const budgetLike = configParameters.filter((parameter) =>
      /^budget/i.test(parameter.getName()),
    );
    expect(budgetLike).toEqual([]);
  });
});
