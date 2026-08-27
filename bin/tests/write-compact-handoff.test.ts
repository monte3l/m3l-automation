import { afterEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Mock setup for findScratchJournals (node:fs) and runGit/execFileSync
// (node:child_process), following bin/tests/check-file-budget.test.ts.
// ---------------------------------------------------------------------------
//
// Spread the actual fs so vi.spyOn can intercept individual methods (ESM
// namespace objects are non-writable by default — the spread makes them
// plain, writable object properties).
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

const h = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: h.execFileSync,
}));

import {
  runGit,
  currentBranch,
  currentWorktree,
  lastCommitInfo,
  uncommittedFiles,
  findScratchJournals,
  buildHandoff,
} from "../../.claude/hooks/write-compact-handoff.mjs";

/** Minimal fake `Dirent` satisfying the shape `findScratchJournals` reads. */
function fakeDirent(name: string, kind: "file" | "dir") {
  return {
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  h.execFileSync.mockReset();
});

describe("runGit", () => {
  test("trims only trailing whitespace, preserving a leading space", () => {
    h.execFileSync.mockReturnValue("  some output  \n");

    expect(runGit(["status"], "/repo")).toBe("  some output");
  });

  test("returns null, not throws, when execFileSync throws", () => {
    h.execFileSync.mockImplementation(() => {
      throw new Error("not a git repository");
    });

    expect(() => runGit(["status"], "/repo")).not.toThrow();
    expect(runGit(["status"], "/repo")).toBeNull();
  });
});

describe("currentBranch", () => {
  test("returns the git output", () => {
    h.execFileSync.mockReturnValue("feat/compact-handoff-hooks\n");

    expect(currentBranch("/repo")).toBe("feat/compact-handoff-hooks");
  });

  test("returns empty string when git fails", () => {
    h.execFileSync.mockImplementation(() => {
      throw new Error("no git");
    });

    expect(currentBranch("/repo")).toBe("");
  });
});

describe("currentWorktree", () => {
  test("returns git's rev-parse --show-toplevel output", () => {
    h.execFileSync.mockReturnValue("/repo/root\n");

    expect(currentWorktree("/repo/sub")).toBe("/repo/root");
  });

  test("falls back to the passed cwd when git fails", () => {
    h.execFileSync.mockImplementation(() => {
      throw new Error("no git");
    });

    expect(currentWorktree("/fallback/cwd")).toBe("/fallback/cwd");
  });
});

describe("lastCommitInfo", () => {
  test("parses a '<sha>\\t<sig>' formatted line", () => {
    h.execFileSync.mockReturnValue("abcdef1234567890\tG\n");

    expect(lastCommitInfo("/repo")).toEqual({
      sha: "abcdef1234567890",
      signature: "G",
    });
  });

  test("returns null when git output is null", () => {
    h.execFileSync.mockImplementation(() => {
      throw new Error("no git");
    });

    expect(lastCommitInfo("/repo")).toBeNull();
  });

  test("returns null when git output is empty", () => {
    h.execFileSync.mockReturnValue("");

    expect(lastCommitInfo("/repo")).toBeNull();
  });

  // NOTE: `runGit` trims only TRAILING whitespace from its output
  // (`execFileSync(...).replace(/\s+$/, "")`), never leading — so an
  // all-whitespace raw value (tabs/newlines only, no other content)
  // collapses entirely to "" and degenerates into the already-covered
  // empty-raw-output branch below, rather than exercising the `!sha` guard.
  test("returns null when git output is only whitespace (degenerates to the empty-output branch)", () => {
    h.execFileSync.mockReturnValue("\t\n");

    expect(lastCommitInfo("/repo")).toBeNull();
  });

  test("defaults signature to 'N' when missing entirely", () => {
    h.execFileSync.mockReturnValue("abcdef1234567890\n");

    expect(lastCommitInfo("/repo")).toEqual({
      sha: "abcdef1234567890",
      signature: "N",
    });
  });
});

describe("uncommittedFiles", () => {
  test("splits porcelain output into non-empty lines, preserving each line's leading status-code space", () => {
    // runGit only trims TRAILING whitespace from the whole stdout string, so
    // a leading-whitespace status code (e.g. " M" = modified in the
    // worktree only) is preserved on every line, including the first.
    h.execFileSync.mockReturnValue(" M foo.ts\n A bar.ts\n?? baz.ts\n");

    expect(uncommittedFiles("/repo")).toEqual([
      " M foo.ts",
      " A bar.ts",
      "?? baz.ts",
    ]);
  });

  test("returns [] for empty output", () => {
    h.execFileSync.mockReturnValue("");

    expect(uncommittedFiles("/repo")).toEqual([]);
  });

  test("returns [] when git fails (null output)", () => {
    h.execFileSync.mockImplementation(() => {
      throw new Error("no git");
    });

    expect(uncommittedFiles("/repo")).toEqual([]);
  });
});

describe("findScratchJournals", () => {
  test("returns [] when tmp/ doesn't exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(findScratchJournals("/repo")).toEqual([]);
  });

  test("returns only .md files whose name contains 'journal' (case-insensitive)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      fakeDirent("journal-foo.md", "file"),
      fakeDirent("JOURNAL-bar.md", "file"),
      fakeDirent("notes.md", "file"),
      fakeDirent("journal-baz.txt", "file"),
      fakeDirent("journal-dir", "dir"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake Dirent[] fixture for readdirSync
    ] as any);

    expect(findScratchJournals("/repo")).toEqual([
      "tmp/JOURNAL-bar.md",
      "tmp/journal-foo.md",
    ]);
  });

  test("returns tmp/<name> prefixed paths, sorted", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      fakeDirent("journal-z.md", "file"),
      fakeDirent("journal-a.md", "file"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake Dirent[] fixture for readdirSync
    ] as any);

    expect(findScratchJournals("/repo")).toEqual([
      "tmp/journal-a.md",
      "tmp/journal-z.md",
    ]);
  });

  test("returns [], not throws, when readdirSync throws", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    expect(() => findScratchJournals("/repo")).not.toThrow();
    expect(findScratchJournals("/repo")).toEqual([]);
  });
});

describe("buildHandoff", () => {
  test("assembles branch, worktree, lastCommit, uncommittedFiles, journals, capturedAt", () => {
    h.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return "feat/handoff\n";
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return "/repo/root\n";
      }
      if (args[0] === "log") return "abcdef1234567890\tG\n";
      if (args[0] === "status") return " M file1.ts\n A file2.ts\n";
      throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
    });
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      fakeDirent("journal-a.md", "file"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake Dirent[] fixture for readdirSync
    ] as any);

    const handoff = buildHandoff("/repo/sub");
    const capturedAt = handoff["capturedAt"];

    expect(handoff).toEqual({
      capturedAt,
      branch: "feat/handoff",
      worktree: "/repo/root",
      lastCommit: { sha: "abcdef1234567890", signature: "G" },
      uncommittedFiles: [" M file1.ts", " A file2.ts"],
      journals: ["tmp/journal-a.md"],
    });
    expect(Object.keys(handoff).sort()).toEqual(
      [
        "branch",
        "capturedAt",
        "journals",
        "lastCommit",
        "uncommittedFiles",
        "worktree",
      ].sort(),
    );
    expect(() => new Date(capturedAt as string).toISOString()).not.toThrow();
    expect(new Date(capturedAt as string).toISOString()).toBe(capturedAt);
  });
});
