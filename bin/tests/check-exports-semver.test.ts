import { describe, expect, test } from "vitest";
import {
  classifyExportsDelta,
  hasBreakingMarker,
  parseArgs,
} from "../../bin/check-exports-semver.mjs";

const base = {
  ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
  "./core": {
    types: "./dist/core/index.d.ts",
    default: "./dist/core/index.js",
  },
  "./aws": { types: "./dist/aws/index.d.ts", default: "./dist/aws/index.js" },
};

describe("classifyExportsDelta", () => {
  test("identical maps have no delta", () => {
    expect(classifyExportsDelta(base, { ...base })).toEqual({
      breaking: [],
      additive: [],
    });
  });

  test("a removed entry is breaking", () => {
    const head = { ".": base["."], "./core": base["./core"] };
    const { breaking, additive } = classifyExportsDelta(base, head);
    expect(breaking).toEqual(["./aws (removed)"]);
    expect(additive).toEqual([]);
  });

  test("a retyped entry is breaking", () => {
    const head = {
      ...base,
      "./core": {
        types: "./dist/core/index.d.ts",
        default: "./dist/core/main.js",
      },
    };
    expect(classifyExportsDelta(base, head).breaking).toEqual([
      "./core (retyped)",
    ]);
  });

  test("key order within an entry does not count as a retype", () => {
    const head = {
      ...base,
      ".": { default: "./dist/index.js", types: "./dist/index.d.ts" },
    };
    expect(classifyExportsDelta(base, head)).toEqual({
      breaking: [],
      additive: [],
    });
  });

  test("a new entry is additive, not breaking", () => {
    const head = { ...base, "./extra": { default: "./dist/extra.js" } };
    const { breaking, additive } = classifyExportsDelta(base, head);
    expect(breaking).toEqual([]);
    expect(additive).toEqual(["./extra (added)"]);
  });

  test("a null base makes every head key additive", () => {
    const { breaking, additive } = classifyExportsDelta(null, base);
    expect(breaking).toEqual([]);
    expect(additive).toEqual(
      [".", "./core", "./aws"].map((k) => `${k} (added)`),
    );
  });
});

describe("hasBreakingMarker", () => {
  test("detects a BREAKING CHANGE footer", () => {
    expect(
      hasBreakingMarker(
        "feat: drop aws entry\n\nBREAKING CHANGE: removed ./aws",
      ),
    ).toBe(true);
  });

  test("detects the hyphenated BREAKING-CHANGE spelling", () => {
    expect(hasBreakingMarker("fix: x\n\nBREAKING-CHANGE: y")).toBe(true);
  });

  test("detects a ! subject with a scope", () => {
    expect(hasBreakingMarker("feat(core)!: retype the barrel")).toBe(true);
  });

  test("a plain non-breaking commit is not marked", () => {
    expect(hasBreakingMarker("feat: add a new helper\n\nfix: tidy up")).toBe(
      false,
    );
  });
});

describe("parseArgs", () => {
  test("reads --base and --head", () => {
    expect(parseArgs(["--base", "abc", "--head", "def"])).toEqual({
      base: "abc",
      head: "def",
    });
  });

  test("missing flags are undefined", () => {
    expect(parseArgs([])).toEqual({ base: undefined, head: undefined });
  });
});
