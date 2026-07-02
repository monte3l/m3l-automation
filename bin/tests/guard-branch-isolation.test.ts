import { describe, expect, test } from "vitest";
import {
  isProtectedPath,
  isMainOrDetachedOnMain,
  defaultGitFor,
} from "../../.claude/hooks/guard-branch-isolation.mjs";

describe("isProtectedPath", () => {
  test("protects package and script src trees and any tests dir", () => {
    expect(isProtectedPath("packages/m3l-common/src/core/foo.ts")).toBe(true);
    expect(isProtectedPath("scripts/my-job/src/main.ts")).toBe(true);
    expect(isProtectedPath("packages/m3l-common/tests/foo.test.ts")).toBe(true);
    expect(isProtectedPath("bin/tests/x.test.ts")).toBe(true);
  });

  test("leaves docs, config, and tooling writable", () => {
    expect(isProtectedPath("docs/adr/0015-signed-commits.md")).toBe(false);
    expect(isProtectedPath(".claude/hooks/foo.mjs")).toBe(false);
    expect(isProtectedPath("bin/check-hooks.mjs")).toBe(false);
    expect(isProtectedPath("packages/m3l-common/package.json")).toBe(false);
  });

  test("matches paths inside .claude/worktrees/ native worktrees", () => {
    expect(
      isProtectedPath(
        ".claude/worktrees/feat-foo/packages/m3l-common/src/core/index.ts",
      ),
    ).toBe(true);
    expect(
      isProtectedPath(".claude/worktrees/feat-foo/tests/foo.test.ts"),
    ).toBe(true);
    expect(
      isProtectedPath(
        "/abs/path/.claude/worktrees/feat-foo/packages/m3l-common/src/core/index.ts",
      ),
    ).toBe(true);
  });
});

describe("isMainOrDetachedOnMain", () => {
  test("blocks when the branch is main", () => {
    const git = (args: string[]) =>
      args.includes("--abbrev-ref") ? "main" : "";
    expect(isMainOrDetachedOnMain(git)).toBe(true);
  });

  test("allows an ordinary feature branch", () => {
    const git = (args: string[]) =>
      args.includes("--abbrev-ref") ? "feat/x" : "";
    expect(isMainOrDetachedOnMain(git)).toBe(false);
  });

  test("blocks a detached HEAD sitting on the main commit", () => {
    const git = (args: string[]) => {
      if (args.includes("--abbrev-ref")) return "HEAD";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123";
      if (args[0] === "rev-parse" && args[1] === "main") return "abc123";
      return "";
    };
    expect(isMainOrDetachedOnMain(git)).toBe(true);
  });

  test("allows a detached HEAD that is NOT the main commit", () => {
    const git = (args: string[]) => {
      if (args.includes("--abbrev-ref")) return "HEAD";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123";
      if (args[0] === "rev-parse" && args[1] === "main") return "def456";
      return "";
    };
    expect(isMainOrDetachedOnMain(git)).toBe(false);
  });

  test("does not block when git is unavailable (empty output)", () => {
    expect(isMainOrDetachedOnMain(() => "")).toBe(false);
  });
});

describe("defaultGitFor", () => {
  test("returns a callable runner that fails gracefully for a nonexistent path", () => {
    const git = defaultGitFor("/nonexistent/__guard_test__");
    expect(typeof git).toBe("function");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("");
  });
});

describe("worktree-aware branch resolution", () => {
  test("allows write when the file's git context is a worktree on a feature branch", () => {
    const git = (args: string[]) =>
      args.includes("--abbrev-ref") ? "feat/foo" : "";
    expect(isMainOrDetachedOnMain(git)).toBe(false);
  });

  test("blocks write when the file's git context is a worktree accidentally on main", () => {
    const git = (args: string[]) =>
      args.includes("--abbrev-ref") ? "main" : "";
    expect(
      isProtectedPath(
        ".claude/worktrees/accidentally-main/packages/m3l-common/src/core/foo.ts",
      ) && isMainOrDetachedOnMain(git),
    ).toBe(true);
  });

  test("allows detached HEAD in a worktree when it is NOT the main commit", () => {
    const git = (args: string[]) => {
      if (args.includes("--abbrev-ref")) return "HEAD";
      if (args[1] === "HEAD") return "abc123";
      if (args[1] === "main") return "def456";
      return "";
    };
    expect(isMainOrDetachedOnMain(git)).toBe(false);
  });
});
