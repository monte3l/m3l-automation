import { describe, expect, test } from "vitest";
import {
  parseWorktreeList,
  mergedBranches,
  goneUpstreamBranches,
  isMergedDetached,
  fetchPrune,
  classifyWorktrees,
} from "../lib/worktree-prune.mjs";

describe("parseWorktreeList", () => {
  test("parses the main checkout plus a branched worktree", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo-feat",
      "HEAD def456",
      "branch refs/heads/feat/x",
      "",
    ].join("\n");
    expect(parseWorktreeList(porcelain)).toEqual([
      {
        path: "/repo",
        head: "abc123",
        branch: "main",
        detached: false,
        flags: [],
      },
      {
        path: "/repo-feat",
        head: "def456",
        branch: "feat/x",
        detached: false,
        flags: [],
      },
    ]);
  });

  test("parses a detached worktree", () => {
    const porcelain = [
      "worktree /repo-detached",
      "HEAD 789abc",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(porcelain)).toEqual([
      {
        path: "/repo-detached",
        head: "789abc",
        branch: null,
        detached: true,
        flags: [],
      },
    ]);
  });

  test("captures bare, locked, and prunable flags without swallowing HEAD", () => {
    const porcelain = [
      "worktree /repo-gone",
      "HEAD deadbeef",
      "branch refs/heads/feat/gone",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    const [w] = parseWorktreeList(porcelain);
    expect(w?.head).toBe("deadbeef");
    expect(w?.flags).toContain(
      "prunable gitdir file points to non-existent location",
    );
  });

  test("handles multiple worktrees in one listing", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD 111",
      "branch refs/heads/main",
      "",
      "worktree /repo-a",
      "HEAD 222",
      "branch refs/heads/feat/a",
      "",
      "worktree /repo-b",
      "HEAD 333",
      "branch refs/heads/feat/b",
      "",
    ].join("\n");
    expect(parseWorktreeList(porcelain)).toHaveLength(3);
  });
});

describe("mergedBranches", () => {
  test("parses branch --merged output into a set", () => {
    const runGit = () => "main\nfeat/merged\n";
    expect(mergedBranches(runGit)).toEqual(new Set(["main", "feat/merged"]));
  });

  test("returns an empty set when nothing is merged", () => {
    const runGit = () => "";
    expect(mergedBranches(runGit)).toEqual(new Set());
  });
});

describe("goneUpstreamBranches", () => {
  test("selects branches whose upstream reports [gone]", () => {
    const runGit = () =>
      [
        "main\t",
        "feat/squashed\t[gone]",
        "feat/behind\t[behind 2]",
        "feat/ahead-and-gone\t[gone]",
      ].join("\n");
    expect(goneUpstreamBranches(runGit)).toEqual(
      new Set(["feat/squashed", "feat/ahead-and-gone"]),
    );
  });

  test("excludes a branch that was never pushed (no upstream at all)", () => {
    const runGit = () => "feat/never-pushed\t";
    expect(goneUpstreamBranches(runGit)).toEqual(new Set());
  });
});

describe("isMergedDetached", () => {
  test("true when merge-base --is-ancestor succeeds", () => {
    const runGit = () => "";
    expect(isMergedDetached("abc123", runGit)).toBe(true);
  });

  test("false when merge-base --is-ancestor throws (not an ancestor)", () => {
    const runGit = () => {
      throw new Error("not an ancestor");
    };
    expect(isMergedDetached("abc123", runGit)).toBe(false);
  });
});

describe("fetchPrune", () => {
  test("reports ok on success", () => {
    const runGit = () => "";
    expect(fetchPrune(runGit)).toEqual({ ok: true, error: null });
  });

  test("captures the error message on failure instead of throwing", () => {
    const runGit = () => {
      throw new Error("could not resolve host");
    };
    expect(() => fetchPrune(runGit)).not.toThrow();
    expect(fetchPrune(runGit)).toEqual({
      ok: false,
      error: "could not resolve host",
    });
  });
});

describe("classifyWorktrees", () => {
  const isMergedDetachedFn = (sha: string) => sha === "merged-sha";

  test("flags a branch merged by ancestry", () => {
    const records = [
      {
        path: "/repo-feat",
        head: "sha1",
        branch: "feat/x",
        detached: false,
        flags: [],
      },
    ];
    const result = classifyWorktrees({
      records,
      mainPath: "/repo",
      here: "/repo",
      mergedSet: new Set(["feat/x"]),
      goneSet: new Set(),
      isMergedDetachedFn,
    });
    expect(result).toEqual([{ record: records[0], reasons: ["merged"] }]);
  });

  test("flags a squash-merged branch via [gone] upstream, not ancestry", () => {
    const records = [
      {
        path: "/repo-feat",
        head: "sha1",
        branch: "feat/squashed",
        detached: false,
        flags: [],
      },
    ];
    const result = classifyWorktrees({
      records,
      mainPath: "/repo",
      here: "/repo",
      mergedSet: new Set(), // NOT in the ancestry-merged set — squash merge
      goneSet: new Set(["feat/squashed"]),
      isMergedDetachedFn,
    });
    expect(result).toEqual([
      { record: records[0], reasons: ["upstream gone"] },
    ]);
  });

  test("flags a prunable worktree regardless of branch state", () => {
    const records = [
      {
        path: "/repo-deleted",
        head: "sha1",
        branch: "feat/y",
        detached: false,
        flags: ["prunable gitdir file points to non-existent location"],
      },
    ];
    const result = classifyWorktrees({
      records,
      mainPath: "/repo",
      here: "/repo",
      mergedSet: new Set(),
      goneSet: new Set(),
      isMergedDetachedFn,
    });
    expect(result).toEqual([{ record: records[0], reasons: ["prunable"] }]);
  });

  test("flags a detached worktree whose HEAD is merged into main", () => {
    const records = [
      {
        path: "/repo-detached",
        head: "merged-sha",
        branch: null,
        detached: true,
        flags: [],
      },
    ];
    const result = classifyWorktrees({
      records,
      mainPath: "/repo",
      here: "/repo",
      mergedSet: new Set(),
      goneSet: new Set(),
      isMergedDetachedFn,
    });
    expect(result).toEqual([
      { record: records[0], reasons: ["detached at merged commit"] },
    ]);
  });

  test("does not flag a detached worktree whose HEAD is not merged", () => {
    const records = [
      {
        path: "/repo-detached",
        head: "unmerged-sha",
        branch: null,
        detached: true,
        flags: [],
      },
    ];
    const result = classifyWorktrees({
      records,
      mainPath: "/repo",
      here: "/repo",
      mergedSet: new Set(),
      goneSet: new Set(),
      isMergedDetachedFn,
    });
    expect(result).toEqual([]);
  });

  test("accumulates multiple reasons for the same worktree", () => {
    const records = [
      {
        path: "/repo-feat",
        head: "sha1",
        branch: "feat/z",
        detached: false,
        flags: ["prunable gitdir file points to non-existent location"],
      },
    ];
    const result = classifyWorktrees({
      records,
      mainPath: "/repo",
      here: "/repo",
      mergedSet: new Set(["feat/z"]),
      goneSet: new Set(["feat/z"]),
      isMergedDetachedFn,
    });
    expect(result[0]?.reasons).toEqual(["prunable", "merged", "upstream gone"]);
  });

  test("never flags the main checkout", () => {
    const records = [
      {
        path: "/repo",
        head: "sha0",
        branch: "main",
        detached: false,
        flags: [],
      },
    ];
    const result = classifyWorktrees({
      records,
      mainPath: "/repo",
      here: "/somewhere-else",
      mergedSet: new Set(["main"]),
      goneSet: new Set(),
      isMergedDetachedFn,
    });
    expect(result).toEqual([]);
  });

  test("never flags the caller's current worktree, even if merged", () => {
    const records = [
      {
        path: "/repo-feat",
        head: "sha1",
        branch: "feat/x",
        detached: false,
        flags: [],
      },
    ];
    const result = classifyWorktrees({
      records,
      mainPath: "/repo",
      here: "/repo-feat",
      mergedSet: new Set(["feat/x"]),
      goneSet: new Set(),
      isMergedDetachedFn,
    });
    expect(result).toEqual([]);
  });

  test("ignores a never-pushed, unmerged branch (no candidate reasons)", () => {
    const records = [
      {
        path: "/repo-wip",
        head: "sha1",
        branch: "feat/wip",
        detached: false,
        flags: [],
      },
    ];
    const result = classifyWorktrees({
      records,
      mainPath: "/repo",
      here: "/repo",
      mergedSet: new Set(),
      goneSet: new Set(),
      isMergedDetachedFn,
    });
    expect(result).toEqual([]);
  });
});
