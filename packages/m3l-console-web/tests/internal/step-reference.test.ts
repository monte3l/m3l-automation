import { describe, expect, test } from "vitest";

import { M3LStepReferenceError } from "@m3l-automation/m3l-common/core";

import type { M3LTreePathSegment } from "../../src/internal/step-reference.js";
import { buildStepReference } from "../../src/internal/step-reference.js";

describe("buildStepReference", () => {
  test.each([
    ["an empty path", 1, [], "step-1.output"],
    [
      "a single ident-safe string segment",
      1,
      ["Queues"],
      "step-1.output.Queues",
    ],
    ["a single numeric segment", 1, [0], "step-1.output[0]"],
    [
      "a mixed nested path of property and index segments",
      1,
      ["Queues", 0, "QueueUrl"],
      "step-1.output.Queues[0].QueueUrl",
    ],
    [
      "a string segment that is not ident-safe (contains a colon)",
      2,
      ["aws:cloudformation:stack"],
      'step-2.output["aws:cloudformation:stack"]',
    ],
    ["an ordinal other than 1", 7, ["result"], "step-7.output.result"],
  ] satisfies ReadonlyArray<
    [string, number, readonly M3LTreePathSegment[], string]
  >)(
    "produces the reference text for %s",
    (_label, ordinal, path, expected) => {
      expect(buildStepReference(ordinal, path)).toBe(expected);
    },
  );

  test("throws when the path names a dangerous property (prototype-pollution guard)", () => {
    expect(() => buildStepReference(1, ["__proto__"])).toThrow();
  });

  test("throws M3LStepReferenceError (propagated from formatStepReference unchanged) for a dangerous property name", () => {
    let thrown: unknown;
    try {
      buildStepReference(1, ["__proto__"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LStepReferenceError);
  });

  test("throws for ordinal 0 (grammar requires ordinal >= 1)", () => {
    expect(() => buildStepReference(0, ["result"])).toThrow();
  });
});
