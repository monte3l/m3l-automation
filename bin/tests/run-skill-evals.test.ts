import { describe, expect, test } from "vitest";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  VERDICT_SCHEMA,
  buildGradedPrompt,
  parseVerdictEnvelope,
} from "../../bin/run-skill-evals.mjs";

describe("DEFAULT_MODEL and DEFAULT_EFFORT", () => {
  test("pin the model/effort documented for this workflow script", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5");
    expect(DEFAULT_EFFORT).toBe("medium");
  });
});

describe("VERDICT_SCHEMA", () => {
  test("declares the structured verdict object shape", () => {
    expect(VERDICT_SCHEMA.type).toBe("object");
    expect(VERDICT_SCHEMA.properties).toHaveProperty("pass");
    expect(VERDICT_SCHEMA.properties).toHaveProperty("unmet_expectations");
    expect(VERDICT_SCHEMA.properties).toHaveProperty("reasoning");
    expect(VERDICT_SCHEMA.required).toEqual([
      "pass",
      "unmet_expectations",
      "reasoning",
    ]);
    expect(VERDICT_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("buildGradedPrompt", () => {
  test("includes the original prompt, expected output, numbered expectations, and the grading marker", () => {
    const evalCase = {
      prompt: "Write a haiku about pnpm.",
      expected_output: "A three-line haiku mentioning pnpm.",
      expectations: [
        "mentions pnpm by name",
        "has exactly three lines",
        "reads as a haiku",
      ],
    };

    const built = buildGradedPrompt(evalCase);

    expect(built).toContain(evalCase.prompt);
    expect(built).toContain(evalCase.expected_output);
    expect(built).toContain("EVAL GRADING");
    expect(built).toContain("1. mentions pnpm by name");
    expect(built).toContain("2. has exactly three lines");
    expect(built).toContain("3. reads as a haiku");
  });

  test("does not throw and omits numbered lines when expectations is empty", () => {
    const evalCase = {
      prompt: "Do a thing.",
      expected_output: "A thing was done.",
      expectations: [],
    };

    let built = "";
    expect(() => {
      built = buildGradedPrompt(evalCase);
    }).not.toThrow();

    expect(built).toContain(evalCase.prompt);
    expect(built).toContain(evalCase.expected_output);
    expect(built).toContain("EVAL GRADING");
    expect(built).not.toMatch(/^1\. /m);
  });
});

describe("parseVerdictEnvelope", () => {
  test("parses a successful envelope into a verdict with cost", () => {
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      total_cost_usd: 0.15,
      structured_output: {
        pass: true,
        unmet_expectations: [],
        reasoning: "looks good",
      },
    });

    expect(parseVerdictEnvelope(stdout)).toEqual({
      pass: true,
      unmet_expectations: [],
      reasoning: "looks good",
      costUsd: 0.15,
    });
  });

  test("returns an error when stdout is not valid JSON", () => {
    const result = parseVerdictEnvelope("not json");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain(
      "did not return valid JSON",
    );
    expect(result).not.toHaveProperty("pass");
  });

  test("returns an error when the envelope reports is_error true", () => {
    const stdout = JSON.stringify({
      is_error: true,
      subtype: "error_max_turns",
      structured_output: {
        pass: false,
        unmet_expectations: [],
        reasoning: "",
      },
    });

    const result = parseVerdictEnvelope(stdout);
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("pass");
  });

  test("returns an error when structured_output is absent", () => {
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      total_cost_usd: 0.01,
    });

    const result = parseVerdictEnvelope(stdout);
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("pass");
  });

  test("defaults unmet_expectations and reasoning when structured_output omits them", () => {
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      total_cost_usd: 0.02,
      structured_output: {
        pass: true,
      },
    });

    expect(parseVerdictEnvelope(stdout)).toEqual({
      pass: true,
      unmet_expectations: [],
      reasoning: "",
      costUsd: 0.02,
    });
  });
});
