import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "../src/config.js";

// The mandatory config-declaration smoke test (ADR-0022 §8). Importing the
// schema is itself an assertion: M3LConfigParameter validates a declared
// defaultValue eagerly in its constructor, so a default that violates its own
// validator fails this file at import time.
describe("s3-objects config declaration", () => {
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
});
