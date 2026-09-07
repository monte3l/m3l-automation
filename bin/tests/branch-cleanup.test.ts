import { describe, expect, test } from "vitest";
import {
  PROTECTED_BRANCHES,
  validateDeletable,
  validateWorktreeSafe,
  deleteBranch,
} from "../lib/branch-cleanup.mjs";
import { parseWorktreeList } from "../lib/worktree-prune.mjs";

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

describe("validateWorktreeSafe", () => {
  // A worktree layout with two linked worktrees, one attached to a branch,
  // one detached — real `parseWorktreeList` output, not a hand-built array
  // (.claude/rules/tests.md: exercise the real collaborator). Directory names
  // follow ADR-0014's `m3l-automation-<slug>` convention except the last,
  // deliberately non-conventional one.
  const porcelain = [
    "worktree /home/u/m3l-automation",
    "HEAD aaaaaaa",
    "branch refs/heads/main",
    "",
    "worktree /home/u/m3l-automation-other-task",
    "HEAD bbbbbbb",
    "branch refs/heads/feat/other-task",
    "",
    "worktree /home/u/scratch",
    "HEAD ccccccc",
    "detached",
    "",
  ].join("\n");
  const records = parseWorktreeList(porcelain);

  const mainLocation = {
    kind: "main" as const,
    mainCheckout: "/home/u/m3l-automation",
    here: "/home/u/m3l-automation",
    slug: null,
  };

  test("refuses when the branch is attached to a DIFFERENT linked worktree", () => {
    expect(
      validateWorktreeSafe({
        branch: "feat/other-task",
        location: mainLocation,
        records,
      }),
    ).toEqual({
      ok: false,
      refusal: {
        kind: "attached",
        worktreePath: "/home/u/m3l-automation-other-task",
        slug: "other-task",
      },
    });
  });

  test("reports a null slug when the attached worktree's directory name is non-conventional", () => {
    // The scratch record is detached in the fixture above; attach a
    // synthetic branch to it to exercise the null-slug reporting path in
    // isolation from the detached-HEAD case covered separately below.
    const scratchAttached = records.map((r) =>
      r.path === "/home/u/scratch" ? { ...r, branch: "feat/x" } : r,
    );
    expect(
      validateWorktreeSafe({
        branch: "feat/x",
        location: mainLocation,
        records: scratchAttached,
      }),
    ).toEqual({
      ok: false,
      refusal: {
        kind: "attached",
        worktreePath: "/home/u/scratch",
        slug: null,
      },
    });
  });

  test("refuses when cwd is the worktree named for the branch's own slug, even though the worktree record no longer names that branch (the orphan case, issue #1004)", () => {
    // /home/u/m3l-automation-other-task really is checked out on
    // feat/other-task in the fixture — this proves the STANDING-IN check
    // fires from the location's own slug, independent of worktreeForBranch,
    // by asking about a branch the attached-worktree lookup cannot see at
    // all (it names a different branch than the one this worktree is
    // actually on).
    const location = {
      kind: "worktree" as const,
      mainCheckout: "/home/u/m3l-automation",
      here: "/home/u/m3l-automation-other-task",
      slug: "other-task",
    };
    expect(
      validateWorktreeSafe({
        branch: "chore/other-task",
        location,
        records,
      }),
    ).toEqual({
      ok: false,
      refusal: {
        kind: "standing-in",
        worktreePath: "/home/u/m3l-automation-other-task",
        slug: "other-task",
      },
    });
  });

  test("passes for an unattached branch when standing in an UNRELATED worktree — the check:staleness compatibility case", () => {
    const location = {
      kind: "worktree" as const,
      mainCheckout: "/home/u/m3l-automation",
      here: "/home/u/m3l-automation-other-task",
      slug: "other-task",
    };
    expect(
      validateWorktreeSafe({
        branch: "feat/unrelated-stale-branch",
        location,
        records,
      }),
    ).toEqual({ ok: true, refusal: null });
  });

  test("passes for an unattached branch from the main checkout", () => {
    expect(
      validateWorktreeSafe({
        branch: "feat/unrelated-stale-branch",
        location: mainLocation,
        records,
      }),
    ).toEqual({ ok: true, refusal: null });
  });

  test("a detached-HEAD worktree standing in a conventionally-named matching directory still refuses", () => {
    // worktreeForBranch structurally cannot see this case — the scratch
    // record is detached (branch: null), so it never matches "feat/scratch"
    // by branch name. Only the standing-in check (keyed off the location's
    // OWN slug, not the worktree record's branch field) catches it — which
    // is exactly why validateWorktreeSafe checks both independently.
    const location = {
      kind: "worktree" as const,
      mainCheckout: "/home/u/m3l-automation",
      here: "/home/u/m3l-automation-scratch",
      slug: "scratch",
    };
    expect(
      validateWorktreeSafe({
        branch: "feat/scratch",
        location,
        records,
      }),
    ).toEqual({
      ok: false,
      refusal: {
        kind: "standing-in",
        worktreePath: "/home/u/m3l-automation-scratch",
        slug: "scratch",
      },
    });
  });

  test("a non-conventional worktree directory (slug: null) gets no orphan protection from the standing-in check", () => {
    // Documented limit, not a bug: a hand-made `git worktree add ../scratch`
    // has no slug to compare against a branch's slug, so this check cannot
    // catch the orphan case for it. worktreeForBranch also can't help here
    // (the fixture's scratch record is detached). This is the one gap the
    // guard leaves open.
    const location = {
      kind: "worktree" as const,
      mainCheckout: "/home/u/m3l-automation",
      here: "/home/u/scratch",
      slug: null,
    };
    expect(
      validateWorktreeSafe({
        branch: "feat/scratch",
        location,
        records,
      }),
    ).toEqual({ ok: true, refusal: null });
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

  test("returns deleted:false, kept:true when runGit throws an Error, surfacing the injected error text and cause", () => {
    const runGit = () => {
      throw new Error("not fully merged");
    };
    const result = deleteBranch("feat/unmerged", { runGit });
    expect(result.deleted).toBe(false);
    expect(result.kept).toBe(true);
    expect(result.message).toContain("not fully merged");
    expect(result.message).toBe(
      "Kept branch feat/unmerged (not fully merged). Delete manually with " +
        "`git branch -D feat/unmerged` once you're sure, or investigate " +
        "the error above if this branch name looks wrong.",
    );
    expect(result).toMatchObject({ cause: "not fully merged" });
  });

  // [KNOWN BUG regression] Prior to the fix, every deleteBranch failure — no
  // matter its actual git error — collapsed into the same fixed "not merged
  // into its base, or checked out in another worktree" message, hiding
  // which failure actually happened (claude[bot] Must-fix on PR #857). This
  // asserts two distinct injected failures now produce two distinct,
  // distinguishable results.
  test("distinguishes a nonexistent-branch failure from an unmerged-branch failure via cause/message", () => {
    const unmerged = deleteBranch("feat/unmerged", {
      runGit: () => {
        throw new Error("not fully merged");
      },
    });
    const missing = deleteBranch("feat/typo", {
      runGit: () => {
        throw new Error("error: branch 'feat/typo' not found");
      },
    });

    if (unmerged.kept !== true || missing.kept !== true) {
      throw new Error("expected both deleteBranch calls to be kept:true");
    }

    expect(missing.cause).toBe("error: branch 'feat/typo' not found");
    expect(missing.message).toContain("error: branch 'feat/typo' not found");
    expect(missing.cause).not.toBe(unmerged.cause);
    expect(missing.message).not.toBe(unmerged.message);
  });

  test("prefers a trimmed cause.stderr over cause.message when runGit throws an execFileSync-shaped error", () => {
    const runGit = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- simulates the shape of a Node execFileSync error, which is not necessarily `instanceof Error` and carries a `.stderr` string
      throw {
        message: "Command failed",
        stderr: "error: branch 'feat/missing' not found\n",
      };
    };
    const result = deleteBranch("feat/missing", { runGit });
    expect(result.deleted).toBe(false);
    if (result.kept !== true) {
      throw new Error("expected deleteBranch to return kept:true");
    }
    expect(result.cause).toBe("error: branch 'feat/missing' not found");
    expect(result.message).toContain("error: branch 'feat/missing' not found");
    expect(result.message).not.toContain("Command failed");
  });

  test("falls back to String(cause) when the thrown value has no stderr and is not an Error", () => {
    const runGit = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- proves the unknown-throw channel is still normalized to a string
      throw "boom";
    };
    const result = deleteBranch("feat/weird", { runGit });
    if (result.kept !== true) {
      throw new Error("expected deleteBranch to return kept:true");
    }
    expect(result.cause).toBe("boom");
    expect(result.message).toContain("boom");
  });
});
