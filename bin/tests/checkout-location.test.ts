import { describe, expect, test } from "vitest";
import {
  branchSlug,
  classifyCheckout,
  resolveCheckoutLocation,
  slugFromWorktreeDir,
  worktreeForBranch,
} from "../../bin/lib/checkout-location.mjs";
import { parseWorktreeList } from "../../bin/lib/worktree-prune.mjs";

describe("slugFromWorktreeDir", () => {
  test("extracts the slug from a conventional worktree dir name", () => {
    expect(slugFromWorktreeDir("m3l-automation-foo")).toBe("foo");
  });

  test("preserves internal hyphens in a multi-word slug", () => {
    expect(slugFromWorktreeDir("m3l-automation-a-b-c")).toBe("a-b-c");
  });

  test("returns null for the main checkout's own directory name", () => {
    expect(slugFromWorktreeDir("m3l-automation")).toBeNull();
  });

  test("returns null for a name with the prefix but no slug", () => {
    expect(slugFromWorktreeDir("m3l-automation-")).toBeNull();
  });

  test("returns null for a non-conventional worktree directory name", () => {
    expect(slugFromWorktreeDir("scratch")).toBeNull();
  });
});

describe("branchSlug", () => {
  test("strips a single <kind>/ prefix", () => {
    expect(branchSlug("feat/x")).toBe("x");
  });

  test("returns the branch unchanged when it has no prefix", () => {
    expect(branchSlug("x")).toBe("x");
  });

  test("only strips the first slash, keeping any nested ones", () => {
    expect(branchSlug("feat/a/b")).toBe("a/b");
  });
});

describe("classifyCheckout", () => {
  test("identical paths classify as the main checkout, with no slug", () => {
    expect(
      classifyCheckout("/home/u/m3l-automation", "/home/u/m3l-automation"),
    ).toEqual({
      kind: "main",
      mainCheckout: "/home/u/m3l-automation",
      here: "/home/u/m3l-automation",
      slug: null,
    });
  });

  test("a differing conventional worktree path classifies with its slug", () => {
    expect(
      classifyCheckout(
        "/home/u/m3l-automation",
        "/home/u/m3l-automation-core-json",
      ),
    ).toEqual({
      kind: "worktree",
      mainCheckout: "/home/u/m3l-automation",
      here: "/home/u/m3l-automation-core-json",
      slug: "core-json",
    });
  });

  test("a non-conventional worktree directory classifies as worktree with a null slug — never as main", () => {
    const result = classifyCheckout(
      "/home/u/m3l-automation",
      "/home/u/scratch",
    );
    expect(result.kind).toBe("worktree");
    expect(result.slug).toBeNull();
  });

  test("normalizes a trailing slash before comparing", () => {
    expect(
      classifyCheckout("/home/u/m3l-automation/", "/home/u/m3l-automation")
        .kind,
    ).toBe("main");
  });
});

describe("resolveCheckoutLocation", () => {
  test("asks git for --git-common-dir and --show-toplevel, never --git-dir", () => {
    const calls: string[][] = [];
    resolveCheckoutLocation({
      runGit: (args) => {
        calls.push(args);
        return args.includes("--show-toplevel")
          ? "/home/u/m3l-automation"
          : "/home/u/m3l-automation/.git";
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.includes("--git-common-dir"))).toBe(true);
    expect(calls.some((c) => c.includes("--git-dir"))).toBe(false);
    expect(calls.some((c) => c.includes("--show-toplevel"))).toBe(true);
  });

  test("classifies the main checkout from git output", () => {
    const result = resolveCheckoutLocation({
      runGit: (args) =>
        args.includes("--show-toplevel")
          ? "/home/u/m3l-automation"
          : "/home/u/m3l-automation/.git",
    });
    expect(result).toEqual({
      kind: "main",
      mainCheckout: "/home/u/m3l-automation",
      here: "/home/u/m3l-automation",
      slug: null,
    });
  });

  test("classifies a linked worktree from git output", () => {
    const result = resolveCheckoutLocation({
      runGit: (args) =>
        args.includes("--show-toplevel")
          ? "/home/u/m3l-automation-core-json"
          : "/home/u/m3l-automation/.git",
    });
    expect(result).toEqual({
      kind: "worktree",
      mainCheckout: "/home/u/m3l-automation",
      here: "/home/u/m3l-automation-core-json",
      slug: "core-json",
    });
  });

  test("propagates a throwing git runner rather than swallowing it", () => {
    expect(() =>
      resolveCheckoutLocation({
        runGit: () => {
          throw new Error("not a git repository");
        },
      }),
    ).toThrow("not a git repository");
  });
});

describe("worktreeForBranch", () => {
  const porcelain = [
    "worktree /home/u/m3l-automation",
    "HEAD aaaaaaa",
    "branch refs/heads/main",
    "",
    "worktree /home/u/m3l-automation-core-json",
    "HEAD bbbbbbb",
    "branch refs/heads/feat/core-json",
    "",
    "worktree /home/u/scratch",
    "HEAD ccccccc",
    "detached",
    "",
  ].join("\n");
  const records = parseWorktreeList(porcelain);

  test("finds the worktree record attached to a branch, with its slug", () => {
    expect(worktreeForBranch("feat/core-json", records)).toEqual({
      path: "/home/u/m3l-automation-core-json",
      slug: "core-json",
    });
  });

  test("returns null for a branch attached to no worktree", () => {
    expect(worktreeForBranch("feat/unattached", records)).toBeNull();
  });

  test("returns null for a branch only reachable via a detached worktree", () => {
    // The detached record's `branch` field is null, so it never matches a
    // branch name lookup regardless of what HEAD happens to point at.
    expect(
      worktreeForBranch(
        "main",
        records.filter((r) => r.detached),
      ),
    ).toBeNull();
  });

  test("reports a null slug for a non-conventional worktree directory", () => {
    const scratchOnly = records.filter((r) => r.path.endsWith("/scratch"));
    // The scratch record is detached (no branch), so attach a synthetic
    // branch to exercise the slug-derivation path in isolation.
    const withBranch = scratchOnly.map((r) => ({ ...r, branch: "feat/x" }));
    expect(worktreeForBranch("feat/x", withBranch)).toEqual({
      path: "/home/u/scratch",
      slug: null,
    });
  });
});
