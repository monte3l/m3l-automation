import { describe, expect, test } from "vitest";
import {
  extractRules,
  findRedPhaseDisables,
  RED_PHASE_RULES,
} from "../../.claude/hooks/guard-eslint-disable-red.mjs";

describe("extractRules", () => {
  test("empty string returns empty array", () => {
    expect(extractRules("")).toEqual([]);
  });

  test("single rule", () => {
    expect(extractRules("import-x/no-unresolved")).toEqual([
      "import-x/no-unresolved",
    ]);
  });

  test("two rules separated by comma", () => {
    expect(extractRules("rule-a, rule-b")).toEqual(["rule-a", "rule-b"]);
  });

  test("strips -- reason comment", () => {
    expect(
      extractRules("import-x/no-unresolved -- module missing in RED"),
    ).toEqual(["import-x/no-unresolved"]);
  });

  test("strips trailing */ from block-comment inline form", () => {
    expect(extractRules("import-x/no-unresolved */")).toEqual([
      "import-x/no-unresolved",
    ]);
  });

  test("multi-rule with newline separator", () => {
    expect(extractRules("rule-a\nrule-b")).toEqual(["rule-a", "rule-b"]);
  });
});

describe("findRedPhaseDisables", () => {
  test("no directives → empty", () => {
    expect(findRedPhaseDisables("const x = 1;")).toEqual([]);
  });

  test("inline disable-next-line with red rule", () => {
    const content = "// eslint-disable-next-line import-x/no-unresolved";
    expect(findRedPhaseDisables(content)).toEqual([["import-x/no-unresolved"]]);
  });

  test("inline disable-line with red rule", () => {
    const content =
      "import foo from './foo.js'; // eslint-disable-line @typescript-eslint/no-unsafe-call";
    expect(findRedPhaseDisables(content)).toEqual([
      ["@typescript-eslint/no-unsafe-call"],
    ]);
  });

  test("block disable with red rule", () => {
    const content = "/* eslint-disable import-x/no-unresolved */";
    expect(findRedPhaseDisables(content)).toEqual([["import-x/no-unresolved"]]);
  });

  test("bare block disable (no rule list) → all red rules", () => {
    const content = "/* eslint-disable */";
    const result = findRedPhaseDisables(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.arrayContaining(RED_PHASE_RULES));
    expect(result[0]).toHaveLength(RED_PHASE_RULES.length);
  });

  test("block disable with multi-rule including one red rule", () => {
    const content =
      "/* eslint-disable prefer-const, @typescript-eslint/no-unsafe-assignment */";
    expect(findRedPhaseDisables(content)).toEqual([
      ["@typescript-eslint/no-unsafe-assignment"],
    ]);
  });

  test("non-red rule is not flagged", () => {
    const content = "// eslint-disable-next-line prefer-const";
    expect(findRedPhaseDisables(content)).toEqual([]);
  });

  test("multiple red directives in one file → one entry per directive", () => {
    const content = [
      "// eslint-disable-next-line import-x/no-unresolved",
      "// eslint-disable-next-line @typescript-eslint/no-unsafe-call",
    ].join("\n");
    expect(findRedPhaseDisables(content)).toHaveLength(2);
  });

  test("only-throw-error (intentional error-channel rule) is NOT flagged", () => {
    const content =
      "// eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional";
    expect(findRedPhaseDisables(content)).toEqual([]);
  });

  test("disable-next-line with reason comment still matches", () => {
    const content =
      "// eslint-disable-next-line import-x/no-unresolved -- RED phase";
    expect(findRedPhaseDisables(content)).toEqual([["import-x/no-unresolved"]]);
  });
});
