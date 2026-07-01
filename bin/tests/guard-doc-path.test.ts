import * as path from "node:path";

import { describe, expect, test } from "vitest";
import { resolveFilePath } from "../../.claude/hooks/guard-doc-counts.mjs";
import { fakeRoot } from "../../packages/m3l-common/tests/helpers/fake-path.js";

describe("resolveFilePath", () => {
  const projectDir = fakeRoot("home", "user", "project");

  test("absolute path is returned unchanged", () => {
    const absPath = fakeRoot("absolute", "path", "to", "file.ts");
    expect(resolveFilePath(absPath, projectDir)).toBe(absPath);
  });

  test("relative path is resolved against projectDir", () => {
    expect(resolveFilePath("src/index.ts", projectDir)).toBe(
      path.join(projectDir, "src", "index.ts"),
    );
  });

  test("dot-relative path is resolved against projectDir", () => {
    expect(resolveFilePath("./docs/README.md", projectDir)).toBe(
      path.join(projectDir, "docs", "README.md"),
    );
  });

  test("absolute path in a different tree is returned unchanged (the #21 bug)", () => {
    // Before the fix the hook was receiving absolute Claude Code paths but
    // treating them as relative, producing a double-prefixed path like
    // /project//abs/path/to/file. Absolute paths must pass through unchanged.
    const absPath = fakeRoot(
      "tmp",
      "claude",
      "workspace",
      "docs",
      "reference",
      "core",
      "errors.md",
    );
    expect(resolveFilePath(absPath, projectDir)).toBe(absPath);
  });

  test("empty file path resolves to projectDir itself", () => {
    expect(resolveFilePath("", projectDir)).toBe(projectDir);
  });
});
