import { describe, expect, test } from "vitest";
import {
  IGNORE_REASONS,
  OMISSION_MARKERS,
  filterChangedFiles,
  filterPatch,
  ignoreReason,
  isIgnored,
} from "../../bin/lib/pr-diff-filter.mjs";

/** A minimal but structurally real `diff --git` entry for `path`. */
function entry(path: string, body = "+added line"): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,2 @@",
    " context",
    body,
  ].join("\n");
}

describe("ignoreReason", () => {
  test.each([
    ["README.md", IGNORE_REASONS.GATE],
    ["docs/adr/0001-thing.md", IGNORE_REASONS.GATE],
    ["docs/reference/catalog.json", IGNORE_REASONS.GATE],
    [".github/dependabot.yml", IGNORE_REASONS.GATE],
    ["pnpm-lock.yaml", IGNORE_REASONS.LOCKFILE],
  ])("classifies %s as %s", (path, reason) => {
    expect(ignoreReason(path)).toBe(reason);
  });

  test.each([
    ["packages/m3l-common/src/core/index.ts"],
    ["bin/lib/pr-diff-filter.mjs"],
    [".github/workflows/claude-pr-review.yml"],
    // Not the lockfile itself: only the exact repo-root path is ignored.
    ["packages/m3l-common/pnpm-lock.yaml"],
    // `docs` as a path *segment* elsewhere must stay reviewable.
    ["packages/m3l-common/src/docs/loader.ts"],
  ])("treats %s as reviewable", (path) => {
    expect(ignoreReason(path)).toBeNull();
    expect(isIgnored(path)).toBe(false);
  });

  // The lockfile is the case that had actually drifted: the guard step ignored
  // it, the patch filter omitted it, and the changed-file filter did not — so
  // the reviewer was handed a list naming the one file the patch suppressed.
  test("pnpm-lock.yaml is ignored, and distinguishably so", () => {
    expect(isIgnored("pnpm-lock.yaml")).toBe(true);
    expect(ignoreReason("pnpm-lock.yaml")).not.toBe(IGNORE_REASONS.GATE);
  });
});

describe("filterChangedFiles", () => {
  test("keeps only reviewable paths, in input order", () => {
    const input = [
      "packages/m3l-common/src/a.ts",
      "docs/b.md",
      "README.md",
      "pnpm-lock.yaml",
      ".github/dependabot.yml",
      "bin/c.mjs",
    ].join("\n");

    expect(filterChangedFiles(input)).toEqual([
      "packages/m3l-common/src/a.ts",
      "bin/c.mjs",
    ]);
  });

  test("drops blank lines rather than emitting empty entries", () => {
    expect(filterChangedFiles("\n\nsrc/a.ts\n\n")).toEqual(["src/a.ts"]);
  });

  test("returns an empty list for a docs-only change", () => {
    expect(filterChangedFiles("docs/a.md\nREADME.md\n")).toEqual([]);
  });
});

describe("filterPatch", () => {
  test("passes a reviewable file through untouched", () => {
    const patch = `${entry("src/a.ts")}\n`;
    expect(filterPatch(patch)).toBe(patch);
  });

  test("replaces an ignored file's body with the gate marker", () => {
    const result = filterPatch(`${entry("docs/a.md")}\n`);

    expect(result).toBe(
      [
        "diff --git a/docs/a.md b/docs/a.md",
        ...OMISSION_MARKERS[IGNORE_REASONS.GATE],
        "",
      ].join("\n"),
    );
    // The header survives, so the reviewer still sees that the file changed.
    expect(result).toContain("diff --git a/docs/a.md");
    expect(result).not.toContain("+added line");
  });

  test("gives pnpm-lock.yaml its own marker, not the gate one", () => {
    const result = filterPatch(`${entry("pnpm-lock.yaml")}\n`);

    expect(result).toContain(OMISSION_MARKERS[IGNORE_REASONS.LOCKFILE][0]);
    expect(result).not.toContain(OMISSION_MARKERS[IGNORE_REASONS.GATE][0]);
  });

  test("resumes copying at the next reviewable file after an omission", () => {
    const patch = [
      entry("docs/skipped.md", "+docs body"),
      entry("src/kept.ts", "+kept body"),
    ].join("\n");

    const result = filterPatch(`${patch}\n`);

    expect(result).not.toContain("+docs body");
    expect(result).toContain("+kept body");
    expect(result).toContain("diff --git a/src/kept.ts");
  });

  test("handles an omitted file as the final entry", () => {
    const patch = [entry("src/kept.ts", "+kept"), entry("docs/last.md")].join(
      "\n",
    );

    const result = filterPatch(`${patch}\n`);

    expect(result).toContain("+kept");
    expect(result).not.toContain("+added line");
    expect(result.endsWith("\n")).toBe(true);
  });

  test("returns empty for empty input rather than a bare newline", () => {
    expect(filterPatch("")).toBe("");
  });

  test("newline-terminates its output exactly once", () => {
    const result = filterPatch(`${entry("src/a.ts")}\n\n\n`);
    expect(result.endsWith("\n")).toBe(true);
    expect(result.endsWith("\n\n")).toBe(false);
  });

  // Mirrors `path = $3` in the awk this replaced: a line that merely mentions
  // the header text mid-diff must not be mistaken for a real file header.
  test("only treats a line-initial `diff --git ` as a header", () => {
    const patch = ["diff --git a/src/a.ts b/src/a.ts", "+diff --git a/x b/x"];
    expect(filterPatch(`${patch.join("\n")}\n`)).toBe(`${patch.join("\n")}\n`);
  });
});
