import { describe, expect, test } from "vitest";
import {
  findCommonJsHits,
  isGuardedFilePath,
} from "../../.claude/hooks/guard-no-commonjs.mjs";

describe("isGuardedFilePath", () => {
  test("guards TypeScript and JavaScript source files", () => {
    expect(isGuardedFilePath("packages/m3l-common/src/core/foo.ts")).toBe(true);
    expect(isGuardedFilePath("bin/check-doc-exports.mjs")).toBe(true);
    expect(isGuardedFilePath("scripts/json-etl/src/config.tsx")).toBe(true);
  });

  test("ignores non-source files", () => {
    expect(isGuardedFilePath("README.md")).toBe(false);
    expect(isGuardedFilePath("package.json")).toBe(false);
  });

  test("ignores files under .claude/hooks/, on POSIX or Windows paths", () => {
    expect(isGuardedFilePath("/repo/.claude/hooks/guard-no-commonjs.mjs")).toBe(
      false,
    );
    const winPath = [
      "C:",
      "repo",
      ".claude",
      "hooks",
      "guard-no-commonjs.mjs",
    ].join(String.fromCharCode(92));
    expect(isGuardedFilePath(winPath)).toBe(false);
  });
});

describe("findCommonJsHits", () => {
  test("clean ESM content returns no hits", () => {
    expect(findCommonJsHits("export const x = 1;")).toEqual([]);
  });

  test("flags require(...)", () => {
    expect(findCommonJsHits("const fs = require('fs');")).not.toEqual([]);
  });

  test("flags module.exports", () => {
    expect(findCommonJsHits("module.exports = { foo };")).not.toEqual([]);
  });

  test("flags a bare exports.<name> assignment", () => {
    expect(findCommonJsHits("exports.foo = require('./bar');")).not.toEqual([]);
  });

  test("flags __dirname and __filename", () => {
    expect(findCommonJsHits("const d = __dirname;")).not.toEqual([]);
    expect(findCommonJsHits("const f = __filename;")).not.toEqual([]);
  });

  // Regression: a kebab-case filename ending in "-exports.<ext>" is a bare
  // mention, not a CommonJS assignment — it must not be flagged.
  test("does NOT flag a mention of a *-exports.mjs filename", () => {
    expect(
      findCommonJsHits('"check:doc-exports": "node bin/check-doc-exports.mjs"'),
    ).toEqual([]);
    expect(
      findCommonJsHits('import { x } from "./bin/check-doc-exports.mjs";'),
    ).toEqual([]);
    expect(findCommonJsHits("// see bin/check-doc-exports.mjs")).toEqual([]);
  });
});
