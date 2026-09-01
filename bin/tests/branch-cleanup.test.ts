import { describe, expect, test } from "vitest";
import {
  PROTECTED_BRANCHES,
  validateDeletable,
  deleteBranch,
} from "../lib/branch-cleanup.mjs";

describe("PROTECTED_BRANCHES", () => {
  test("contains main", () => {
    expect(PROTECTED_BRANCHES.has("main")).toBe(true);
  });
});

describe("validateDeletable", () => {
  test("allows an ordinary branch that isn't current and isn't protected", () => {
    expect(validateDeletable("feat/done-thing", "main")).toEqual({
      ok: true,
      reason: null,
    });
  });

  test("refuses an empty string branch name", () => {
    const result = validateDeletable("", "main");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no branch name given");
  });

  test("refuses a non-string branch value", () => {
    // @ts-expect-error exercising the runtime guard
    const result = validateDeletable(undefined, "main");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no branch name given");
  });

  test("refuses main specifically, with the exact reason string", () => {
    expect(validateDeletable("main", "feat/x")).toEqual({
      ok: false,
      reason: 'refusing to delete protected branch "main"',
    });
  });

  test("refuses the currently checked-out branch, with the exact reason string", () => {
    expect(validateDeletable("feat/x", "feat/x")).toEqual({
      ok: false,
      reason:
        '"feat/x" is the currently checked-out branch — switch to main ' +
        "(or another branch) first",
    });
  });

  test("refuses a non-main branch that also happens to be current (both conditions independently refuse)", () => {
    const result = validateDeletable("feat/current", "feat/current");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      '"feat/current" is the currently checked-out branch — switch to ' +
        "main (or another branch) first",
    );
  });
});

describe("deleteBranch", () => {
  test("calls the injected runGit with a safe -d delete when force is omitted", () => {
    const calls: unknown[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      return "";
    };
    deleteBranch("feat/done-thing", { runGit });
    expect(calls).toEqual([["branch", "-d", "feat/done-thing"]]);
  });

  test("calls the injected runGit with a forced -D delete when force is true", () => {
    const calls: unknown[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      return "";
    };
    deleteBranch("feat/done-thing", { force: true, runGit });
    expect(calls).toEqual([["branch", "-D", "feat/done-thing"]]);
  });

  test("returns deleted:true, kept:false on a successful delete", () => {
    const runGit = () => "";
    expect(deleteBranch("feat/done-thing", { runGit })).toEqual({
      deleted: true,
      kept: false,
      message: "Deleted branch feat/done-thing.",
    });
  });

  test("returns deleted:false, kept:true when runGit throws, with a manual-fallback message", () => {
    const runGit = () => {
      throw new Error("not fully merged");
    };
    const result = deleteBranch("feat/unmerged", { runGit });
    expect(result.deleted).toBe(false);
    expect(result.kept).toBe(true);
    expect(result.message).toBe(
      "Kept branch feat/unmerged (not merged into its base, or checked " +
        "out in another worktree). Delete manually with `git branch -D " +
        "feat/unmerged` once you're sure.",
    );
  });
});
