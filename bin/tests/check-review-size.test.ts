import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  SOFT_TARGET_BYTES,
  filterForReview,
  isIgnoredPath,
  parseArgs,
  parseMaxReviewableBytes,
  splitDiffByFile,
  suggestSplitAxis,
} from "../../bin/check-review-size.mjs";

const scriptPath = fileURLToPath(
  new URL("../check-review-size.mjs", import.meta.url),
);

// A fixed, already-merged commit range (PR #639) that mixes reviewable
// bin/**/*.mjs|*.ts files with one ignored docs/plans/IMPLEMENTATION.md
// file — deterministic regardless of when this test runs, unlike the live
// working tree's diff.
const FIXED_BASE = "85846a698f29615743832810b4474c2eec6d5c18";
const FIXED_HEAD = "d82e052026ce8e23962a97a21382f381767217f3";

/** Build a single-file unified diff block's text (no trailing newline). */
function makeDiffText(path: string, hunkBodyLines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 000..111 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    ...hunkBodyLines,
  ].join("\n");
}

describe("SOFT_TARGET_BYTES", () => {
  test("is the ADR-0072 authoring target of 75,000", () => {
    expect(SOFT_TARGET_BYTES).toBe(75_000);
  });
});

describe("parseMaxReviewableBytes", () => {
  test("extracts the constant from the workflow env block", () => {
    const workflowText = [
      "jobs:",
      "  review:",
      "    env:",
      "      MAX_REVIEWABLE_BYTES: 300000",
    ].join("\n");
    expect(parseMaxReviewableBytes(workflowText)).toBe(300_000);
  });

  test("returns null when the constant is absent", () => {
    expect(parseMaxReviewableBytes("jobs:\n  review:\n    env: {}")).toBeNull();
  });
});

describe("isIgnoredPath", () => {
  test.each([
    ["a Markdown file anywhere", "packages/m3l-common/README.md", true],
    ["a docs/** path", "docs/adr/0072-review-size.md", true],
    ["a non-Markdown docs/** path", "docs/assets/diagram.png", true],
    [".github/dependabot.yml exactly", ".github/dependabot.yml", true],
    ["pnpm-lock.yaml exactly", "pnpm-lock.yaml", true],
    [
      "a reviewable src path",
      "packages/m3l-common/src/core/foo/index.ts",
      false,
    ],
  ])("%s -> %s", (_label, path, expected) => {
    expect(isIgnoredPath(path)).toBe(expected);
  });
});

describe("splitDiffByFile", () => {
  test("empty input yields no blocks", () => {
    expect(splitDiffByFile("")).toEqual([]);
  });

  test("a single-file diff yields one block", () => {
    const text = makeDiffText("packages/m3l-common/src/foo.ts", [
      "-old line",
      "+new line",
    ]);
    const blocks = splitDiffByFile(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      path: "packages/m3l-common/src/foo.ts",
      ignored: false,
    });
    expect(blocks[0]?.text).toContain("+new line");
  });

  test("a multi-file diff attributes each hunk to its own block", () => {
    const fileA = makeDiffText("packages/m3l-common/src/a.ts", ["+a change"]);
    const fileB = makeDiffText("docs/notes.md", ["+b change"]);
    const text = [fileA, fileB].join("\n");
    const blocks = splitDiffByFile(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      path: "packages/m3l-common/src/a.ts",
      ignored: false,
    });
    expect(blocks[0]?.text).toContain("+a change");
    expect(blocks[0]?.text).not.toContain("+b change");
    expect(blocks[1]).toMatchObject({ path: "docs/notes.md", ignored: true });
    expect(blocks[1]?.text).toContain("+b change");
  });

  test("lines before the first header are dropped", () => {
    const text = [
      "some preamble that git diff never emits",
      makeDiffText("packages/m3l-common/src/a.ts", ["+content"]),
    ].join("\n");
    const blocks = splitDiffByFile(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).not.toContain("preamble");
    expect(blocks[0]?.text.startsWith("diff --git")).toBe(true);
  });

  test("a hunk line that merely contains 'diff --git' is not mistaken for a new header", () => {
    // A real unified-diff content line always starts with +, -, space, or @@ —
    // never with the literal "diff --git" at column 0. Prefixing the fake
    // header text with "+" simulates an added line whose payload happens to
    // read like a header, which must stay inside the current file's block.
    const text = makeDiffText("packages/m3l-common/src/a.ts", [
      "+diff --git a/fake b/fake",
      "+real content",
    ]);
    const blocks = splitDiffByFile(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.path).toBe("packages/m3l-common/src/a.ts");
    expect(blocks[0]?.text).toContain("+diff --git a/fake b/fake");
    expect(blocks[0]?.text).toContain("+real content");
  });
});

describe("filterForReview", () => {
  test("keeps only the header + omission marker for an ignored file", () => {
    const blocks = splitDiffByFile(
      makeDiffText("docs/notes.md", ["+secret plan text"]),
    );
    const { filteredText, perFile } = filterForReview(blocks);
    expect(filteredText).not.toContain("secret plan text");
    expect(filteredText).toContain(
      "diff --git a/docs/notes.md b/docs/notes.md",
    );
    expect(filteredText).toContain("(diff omitted");
    expect(perFile).toEqual([
      {
        path: "docs/notes.md",
        bytes: Buffer.byteLength(filteredText, "utf8"),
        ignored: true,
      },
    ]);
  });

  test("keeps the full text unchanged for a reviewable file", () => {
    const path = "packages/m3l-common/src/core/foo/index.ts";
    const blocks = splitDiffByFile(makeDiffText(path, ["+kept content"]));
    const { filteredText, perFile } = filterForReview(blocks);
    expect(filteredText).toContain("+kept content");
    expect(filteredText.endsWith("\n")).toBe(true);
    expect(perFile).toHaveLength(1);
    expect(perFile[0]?.path).toBe(path);
    expect(perFile[0]?.bytes).toBeGreaterThan(0);
    expect(perFile[0]?.ignored).toBe(false);
  });

  test("combines ignored and reviewable files, only omitting the ignored one", () => {
    const reviewablePath = "packages/m3l-common/src/core/foo/index.ts";
    const ignoredText = makeDiffText("docs/notes.md", ["+omit me"]);
    const reviewableText = makeDiffText(reviewablePath, ["+keep me"]);
    const blocks = splitDiffByFile([ignoredText, reviewableText].join("\n"));
    const { filteredText, perFile } = filterForReview(blocks);
    expect(filteredText).not.toContain("omit me");
    expect(filteredText).toContain("keep me");
    expect(perFile).toHaveLength(2);
    const ignoredEntry = perFile.find((f) => f.path === "docs/notes.md");
    const reviewableEntry = perFile.find((f) => f.path === reviewablePath);
    expect(ignoredEntry).toMatchObject({
      path: "docs/notes.md",
      ignored: true,
    });
    expect(ignoredEntry?.bytes).toBeGreaterThan(0);
    expect(reviewableEntry).toMatchObject({
      path: reviewablePath,
      ignored: false,
    });
    expect(reviewableEntry?.bytes).toBeGreaterThan(0);
  });
});

describe("parseArgs", () => {
  test("reads --base and --head", () => {
    expect(parseArgs(["--base", "abc", "--head", "def"])).toEqual({
      base: "abc",
      head: "def",
    });
  });

  test("missing flags are undefined", () => {
    expect(parseArgs([])).toEqual({ base: undefined, head: undefined });
  });
});

describe("suggestSplitAxis", () => {
  test("suggests docs vs. code when the block set mixes ignored and reviewable files", () => {
    const blocks = splitDiffByFile(
      [
        makeDiffText("docs/notes.md", ["+doc change"]),
        makeDiffText("packages/m3l-common/src/core/foo.ts", ["+code change"]),
      ].join("\n"),
    );
    expect(suggestSplitAxis(blocks)).toMatch(/^docs vs\. code/);
  });

  test("suggests a commit boundary when all reviewable files share one top-level segment", () => {
    const blocks = splitDiffByFile(
      [
        makeDiffText("packages/m3l-common/src/core/foo.ts", ["+a"]),
        makeDiffText("packages/m3l-common/src/core/bar.ts", ["+b"]),
      ].join("\n"),
    );
    expect(suggestSplitAxis(blocks)).toMatch(/^commit boundary/);
  });

  test("suggests a path cluster split naming each top-level segment when reviewable files span more than one", () => {
    const blocks = splitDiffByFile(
      [
        makeDiffText("packages/m3l-common/src/core/foo.ts", ["+a"]),
        makeDiffText("scripts/some-script/src/index.ts", ["+b"]),
      ].join("\n"),
    );
    const axis = suggestSplitAxis(blocks);
    expect(axis).toMatch(/^path cluster/);
    expect(axis).toContain("packages");
    expect(axis).toContain("scripts");
  });
});

describe("oversized-diff detection (the gate's actual purpose)", () => {
  test("a large single-file reviewable diff exceeds SOFT_TARGET_BYTES", () => {
    // ~800 lines of ~110 bytes each ~= 88,000 bytes, comfortably over the
    // 75,000-byte soft target with margin for the header/hunk overhead.
    const hunkBodyLines = Array.from(
      { length: 800 },
      (_, i) => `+line ${i} ${"x".repeat(100)}`,
    );
    const blocks = splitDiffByFile(
      makeDiffText("packages/m3l-common/src/core/big.ts", hunkBodyLines),
    );
    const { filteredText } = filterForReview(blocks);
    const reviewableBytes = Buffer.byteLength(filteredText, "utf8");
    expect(reviewableBytes).toBeGreaterThan(SOFT_TARGET_BYTES);
  });

  test("a small single-file reviewable diff stays under SOFT_TARGET_BYTES", () => {
    const blocks = splitDiffByFile(
      makeDiffText("packages/m3l-common/src/core/small.ts", [
        "-const x = 1;",
        "+const x = 2;",
      ]),
    );
    const { filteredText } = filterForReview(blocks);
    const reviewableBytes = Buffer.byteLength(filteredText, "utf8");
    expect(reviewableBytes).toBeLessThan(SOFT_TARGET_BYTES);
  });

  test("an ignored large file does not count toward the reviewable total", () => {
    const hunkBodyLines = Array.from(
      { length: 800 },
      (_, i) => `+doc line ${i} ${"x".repeat(100)}`,
    );
    const blocks = splitDiffByFile(
      makeDiffText("docs/huge-notes.md", hunkBodyLines),
    );
    const { filteredText } = filterForReview(blocks);
    const reviewableBytes = Buffer.byteLength(filteredText, "utf8");
    expect(reviewableBytes).toBeLessThan(SOFT_TARGET_BYTES);
  });
});

describe("CLI --json perFile breakdown (F24)", () => {
  test("emits a perFile array of {path, bytes, ignored} for a fixed commit range", () => {
    const stdout = execFileSync(
      "node",
      [scriptPath, "--json", "--base", FIXED_BASE, "--head", FIXED_HEAD],
      { encoding: "utf8" },
    );
    const payload = JSON.parse(stdout) as {
      perFile: { path: string; bytes: number; ignored: boolean }[];
    };

    expect(Array.isArray(payload.perFile)).toBe(true);
    expect(payload.perFile.length).toBeGreaterThan(1);
    for (const entry of payload.perFile) {
      expect(typeof entry.path).toBe("string");
      expect(entry.bytes).toBeGreaterThan(0);
      expect(typeof entry.ignored).toBe("boolean");
    }

    const docsEntry = payload.perFile.find(
      (f) => f.path === "docs/plans/IMPLEMENTATION.md",
    );
    expect(docsEntry?.ignored).toBe(true);
    const reviewableEntry = payload.perFile.find(
      (f) => f.path === "bin/gen-project-hub.mjs",
    );
    expect(reviewableEntry?.ignored).toBe(false);

    // Descending by bytes, matching the human-mode top-5 sort.
    const bytesInOrder = payload.perFile.map((f) => f.bytes);
    const sortedDescending = [...bytesInOrder].sort((a, b) => b - a);
    expect(bytesInOrder).toEqual(sortedDescending);
  });
});
