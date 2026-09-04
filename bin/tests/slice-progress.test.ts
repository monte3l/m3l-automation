import { afterEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup for currentBranch (node:child_process), mirroring
// bin/tests/write-compact-handoff.test.ts's runGit/currentBranch pattern
// exactly: a vi.hoisted vi.fn() backing a vi.mock factory.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: h.execFileSync,
}));

import {
  SLICE_PROGRESS_REL_PATH,
  currentBranch,
  parseSetArgs,
  buildSliceEntry,
} from "../slice-progress.mjs";

afterEach(() => {
  h.execFileSync.mockReset();
});

describe("SLICE_PROGRESS_REL_PATH", () => {
  test("is the documented tmp/slice-progress.json path", () => {
    expect(SLICE_PROGRESS_REL_PATH).toBe("tmp/slice-progress.json");
  });
});

describe("currentBranch", () => {
  test("returns the trimmed git output", () => {
    h.execFileSync.mockReturnValue("feat/slice-progress-widget\n");

    expect(currentBranch("/repo")).toBe("feat/slice-progress-widget");
  });

  test("returns empty string, not throws, when execFileSync throws", () => {
    h.execFileSync.mockImplementation(() => {
      throw new Error("not a git repository");
    });

    expect(() => currentBranch("/repo")).not.toThrow();
    expect(currentBranch("/repo")).toBe("");
  });
});

describe("parseSetArgs", () => {
  test("errors when both --page and --wave are given", () => {
    const readPage = () => "## Landing plan";
    const result = parseSetArgs(
      ["--page", "docs/reference/core/x.md", "--wave", "V9"],
      readPage,
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("not both"),
    });
  });

  test("errors with a usage message when neither --page nor --wave is given", () => {
    const readPage = () => null;
    const result = parseSetArgs([], readPage);

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("Usage:");
  });

  test("errors when --page's readPage returns null (unreadable page)", () => {
    const readPage = () => null;
    const result = parseSetArgs(
      ["--page", "docs/reference/core/x.md"],
      readPage,
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("does not exist or is unreadable"),
    });
  });

  test("errors when --page's text has no '## Landing plan' heading", () => {
    const readPage = () => "# Some module\n\nNo landing plan here.\n";
    const result = parseSetArgs(
      ["--page", "docs/reference/core/x.md"],
      readPage,
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('no "## Landing plan" heading'),
    });
  });

  test("succeeds with { page } when --page's text has the Landing plan heading", () => {
    const readPage = () => "# Some module\n\n## Landing plan\n\n- step one\n";
    const result = parseSetArgs(
      ["--page", "docs/reference/core/x.md"],
      readPage,
    );

    expect(result).toEqual({
      ok: true,
      entry: { page: "docs/reference/core/x.md" },
    });
  });

  test("errors when --wave's --current/--total are not integers", () => {
    const readPage = () => null;
    const result = parseSetArgs(
      ["--wave", "V9", "--current", "abc", "--total", "4"],
      readPage,
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("integer"),
    });
  });

  test("errors when --current is greater than --total", () => {
    const readPage = () => null;
    const result = parseSetArgs(
      ["--wave", "V9", "--current", "5", "--total", "4"],
      readPage,
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("<= total"),
    });
  });

  test("succeeds with { wave, current, total } for a valid literal-mode invocation", () => {
    const readPage = () => null;
    const result = parseSetArgs(
      ["--wave", "V9", "--current", "2", "--total", "4"],
      readPage,
    );

    expect(result).toEqual({
      ok: true,
      entry: { wave: "V9", current: 2, total: 4 },
    });
  });

  test("includes label in the entry when --label is given", () => {
    const readPage = () => null;
    const result = parseSetArgs(
      [
        "--wave",
        "V9",
        "--current",
        "2",
        "--total",
        "4",
        "--label",
        "V9 slice progress",
      ],
      readPage,
    );

    expect(result).toEqual({
      ok: true,
      entry: { wave: "V9", current: 2, total: 4, label: "V9 slice progress" },
    });
  });
});

describe("buildSliceEntry", () => {
  test("propagates a parseSetArgs error unchanged", () => {
    const readPage = () => null;
    const resolveBranch = () => "feat/x";

    const result = buildSliceEntry([], readPage, resolveBranch);

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("Usage:");
  });

  test("errors when resolveBranch() returns '', even if parseSetArgs succeeded", () => {
    const readPage = () => null;
    const resolveBranch = () => "";

    const result = buildSliceEntry(
      ["--wave", "V9", "--current", "2", "--total", "4"],
      readPage,
      resolveBranch,
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(
        "Could not resolve the current git branch",
      ),
    });
  });

  test("stamps branch and an ISO updatedAt on success", () => {
    const readPage = () => null;
    const resolveBranch = () => "feat/slice-progress-widget";

    const result = buildSliceEntry(
      ["--wave", "V9", "--current", "2", "--total", "4"],
      readPage,
      resolveBranch,
    );

    expect(result.ok).toBe(true);
    const entry = (result as { ok: true; entry: Record<string, unknown> })
      .entry;
    expect(entry).toMatchObject({
      wave: "V9",
      current: 2,
      total: 4,
      branch: "feat/slice-progress-widget",
    });
    expect(typeof entry["updatedAt"]).toBe("string");
    expect(() => new Date(entry["updatedAt"] as string)).not.toThrow();
    expect(Number.isNaN(new Date(entry["updatedAt"] as string).getTime())).toBe(
      false,
    );
  });
});
