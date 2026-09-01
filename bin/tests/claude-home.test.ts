import { describe, expect, test } from "vitest";
import {
  projectSlug,
  resolveClaudeProjectDir,
} from "../../bin/lib/claude-home.mjs";

describe("projectSlug", () => {
  test("replaces every path separator with a hyphen", () => {
    expect(projectSlug("/home/u/workspaces/proj")).toBe(
      "-home-u-workspaces-proj",
    );
  });

  test("keeps the leading hyphen the absolute path's leading slash produces", () => {
    expect(projectSlug("/a")).toBe("-a");
  });

  test("leaves a path with no separators alone", () => {
    expect(projectSlug("proj")).toBe("proj");
  });
});

describe("resolveClaudeProjectDir", () => {
  test("builds ~/.claude/projects/<slug> from the checkout root", () => {
    expect(
      resolveClaudeProjectDir(
        () => "/home/u/workspaces/proj/.git\n",
        "/home/u",
      ),
    ).toBe("/home/u/.claude/projects/-home-u-workspaces-proj");
  });

  test("asks git for the COMMON dir, so every worktree shares one store", () => {
    const calls: string[][] = [];
    resolveClaudeProjectDir((args) => {
      calls.push(args);
      return "/home/u/workspaces/proj/.git\n";
    }, "/home/u");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--git-common-dir");
    expect(calls[0]).not.toContain("--git-dir");
  });

  test("a LINKED WORKTREE resolves to the MAIN checkout's store, not its own", () => {
    // What `git rev-parse --git-common-dir` returns from inside
    // proj-feature-x: the main checkout's .git, never proj-feature-x/.git.
    const fromWorktree = resolveClaudeProjectDir(
      () => "/home/u/workspaces/proj/.git\n",
      "/home/u",
    );
    const fromMain = resolveClaudeProjectDir(
      () => "/home/u/workspaces/proj/.git\n",
      "/home/u",
    );
    expect(fromWorktree).toBe(fromMain);
    expect(fromWorktree).not.toContain("feature-x");
  });

  test("tolerates git's trailing newline", () => {
    expect(resolveClaudeProjectDir(() => "/a/b/.git", "/h")).toBe(
      resolveClaudeProjectDir(() => "/a/b/.git\n", "/h"),
    );
  });
});
