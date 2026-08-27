import { afterEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";

// Spread the actual fs so vi.spyOn can intercept individual methods (ESM
// namespace objects are non-writable by default — the spread makes them
// plain, writable object properties), following
// bin/tests/check-file-budget.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  readHandoff,
  formatHandoff,
} from "../../.claude/hooks/reinject-compact-handoff.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readHandoff", () => {
  test("returns null when the file doesn't exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    expect(readHandoff("/repo/tmp/compact-handoff.json")).toBeNull();
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  test("returns the parsed object for valid JSON", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ branch: "feat/x", worktree: "/repo" }),
    );

    expect(readHandoff("/repo/tmp/compact-handoff.json")).toEqual({
      branch: "feat/x",
      worktree: "/repo",
    });
  });

  test("returns null, not throws, for malformed JSON content", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("{ this is not json");

    expect(() => readHandoff("/repo/tmp/compact-handoff.json")).not.toThrow();
    expect(readHandoff("/repo/tmp/compact-handoff.json")).toBeNull();
  });
});

describe("formatHandoff", () => {
  test("includes the branch and worktree", () => {
    const result = formatHandoff({
      branch: "feat/compact-handoff-hooks",
      worktree: "/repo/root",
    });

    expect(result).toContain("feat/compact-handoff-hooks");
    expect(result).toContain("/repo/root");
  });

  test("includes the last-commit line with a 12-char-truncated SHA and signature when present", () => {
    const result = formatHandoff({
      branch: "feat/x",
      worktree: "/repo",
      lastCommit: { sha: "0123456789abcdef", signature: "G" },
    });

    expect(result).toContain("Last commit");
    expect(result).toContain("0123456789ab");
    expect(result).not.toContain("0123456789abcdef");
    expect(result).toContain("G");
  });

  test("omits the last-commit line and never prints 'undefined' when lastCommit is absent", () => {
    const result = formatHandoff({
      branch: "feat/x",
      worktree: "/repo",
    });

    expect(result).not.toContain("Last commit");
    expect(result).not.toContain("undefined");
  });

  test("falls back to a '?' signature when signature is legitimately absent from an otherwise-valid lastCommit", () => {
    const result = formatHandoff({
      branch: "feat/x",
      worktree: "/repo",
      lastCommit: { sha: "abc123" },
    });

    expect(result).toContain("Last commit");
    expect(result).toContain("abc123");
    expect(result).toContain("signature: `?`");
    expect(result).not.toContain("undefined");
  });

  test.each([
    ["sha is a number, not a string", { sha: 42 }],
    ["lastCommit is not an object at all", true],
    ["lastCommit is an object missing sha entirely", {}],
  ])(
    "does not throw and omits the last-commit line when lastCommit is malformed: %s",
    (_description, lastCommit) => {
      const handoff = { branch: "feat/x", worktree: "/repo", lastCommit };

      expect(() => formatHandoff(handoff)).not.toThrow();

      const result = formatHandoff(handoff);
      expect(result).not.toContain("Last commit");
      expect(result).not.toContain("undefined");
    },
  );

  test("lists up to the first 10 uncommitted entries plus a '(+N more)' suffix", () => {
    const uncommittedFiles = Array.from(
      { length: 12 },
      (_unused, i) => `M file${i}.ts`,
    );

    const result = formatHandoff({
      branch: "feat/x",
      worktree: "/repo",
      uncommittedFiles,
    });

    expect(result).toContain("Uncommitted (12)");
    expect(result).toContain("(+2 more)");
    expect(result).toContain("file0.ts");
    expect(result).toContain("file9.ts");
    expect(result).not.toContain("file10.ts");
    expect(result).not.toContain("file11.ts");
  });

  test("omits the uncommitted line entirely when the array is empty", () => {
    const result = formatHandoff({
      branch: "feat/x",
      worktree: "/repo",
      uncommittedFiles: [],
    });

    expect(result).not.toContain("Uncommitted");
  });

  test("includes a 'Scratchpad journal(s)' line only when journals is a non-empty array", () => {
    const withJournals = formatHandoff({
      branch: "feat/x",
      worktree: "/repo",
      journals: ["tmp/journal-a.md", "tmp/journal-b.md"],
    });
    const withoutJournals = formatHandoff({
      branch: "feat/x",
      worktree: "/repo",
    });
    const withEmptyJournals = formatHandoff({
      branch: "feat/x",
      worktree: "/repo",
      journals: [],
    });

    expect(withJournals).toContain("Scratchpad journal(s)");
    expect(withJournals).toContain("tmp/journal-a.md");
    expect(withoutJournals).not.toContain("Scratchpad journal(s)");
    expect(withEmptyJournals).not.toContain("Scratchpad journal(s)");
  });

  test("always ends with the re-verify-against-current-git-status reminder line", () => {
    const minimal = formatHandoff({ branch: "", worktree: "" });
    const full = formatHandoff({
      branch: "feat/x",
      worktree: "/repo",
      lastCommit: { sha: "0123456789abcdef", signature: "N" },
      uncommittedFiles: ["M a.ts"],
      journals: ["tmp/journal-a.md"],
    });

    for (const result of [minimal, full]) {
      const lines = result.split("\n");
      const lastLine = lines[lines.length - 1] ?? "";
      expect(lastLine.toLowerCase()).toContain("re-verify");
      expect(lastLine.toLowerCase()).toContain("git status");
    }
  });
});
