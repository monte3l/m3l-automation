import { describe, expect, test } from "vitest";
import {
  REVIEW_GATE_WORKFLOW_PATH,
  buildDeltaPatch,
  countReviewComments,
  describeWorkflowGateChange,
  parseMustFixSection,
  parseReviewedSha,
  parseVerdict,
  parseVerdictFile,
  resolveVerdict,
} from "../../bin/lib/pr-review-gate.mjs";
import { filterPatch } from "../../bin/lib/pr-diff-filter.mjs";

describe("parseVerdict", () => {
  test("reads a PASS bullet under the Verdict heading", () => {
    const body = [
      "### Verdict",
      "",
      "- PASS — all Must-fix items resolved.",
      "",
      "<!-- claude-review-sha: abc1234 -->",
    ].join("\n");
    expect(parseVerdict(body)).toBe("PASS");
  });

  test("reads a FAIL bullet under the Verdict heading", () => {
    const body = ["### Verdict", "", "- FAIL — one Must-fix remains."].join(
      "\n",
    );
    expect(parseVerdict(body)).toBe("FAIL");
  });

  // The defect this function replaces a bare word-search for: a FAIL whose
  // one-line reason happens to contain the substring "pass" was previously
  // read as a PASS by `grep -A2 '^### Verdict' | grep -qiw 'PASS'`, and
  // Enforce tested PASS before FAIL, so the false positive won outright.
  test("does not read FAIL as PASS when the reason contains the word pass", () => {
    const body = [
      "### Verdict",
      "",
      "- FAIL — this does not pass the export check.",
    ].join("\n");
    expect(parseVerdict(body)).toBe("FAIL");
  });

  test("is not fooled by an unrelated PASS mentioned elsewhere in the body", () => {
    const body = [
      "### Should-fix",
      "",
      "- `src/foo.ts:1` — consider whether this test should PASS on retry.",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
    ].join("\n");
    expect(parseVerdict(body)).toBe("FAIL");
  });

  test("returns null when no Verdict heading exists", () => {
    expect(
      parseVerdict("## Claude PR Review — some title\n\nLooks fine."),
    ).toBeNull();
  });

  test("returns null when the Verdict heading has no parseable bullet", () => {
    const body = ["### Verdict", "", "- Unclear, needs another look."].join(
      "\n",
    );
    expect(parseVerdict(body)).toBeNull();
  });
});

describe("parseReviewedSha", () => {
  test("reads the marker's SHA", () => {
    const body = "...\n<!-- claude-review-sha: deadbeef -->";
    expect(parseReviewedSha(body)).toBe("deadbeef");
  });

  test("returns null when no marker is present", () => {
    expect(parseReviewedSha("no marker here")).toBeNull();
  });

  // The prompt requires the marker to be the comment's LAST line; the sed
  // expressions this replaces took the FIRST match via `head -n1`, so a
  // SHA quoted or restated earlier in the body (e.g. discussing a prior
  // round) would incorrectly win over the real, final marker.
  test("takes the LAST marker when more than one is present", () => {
    const body = [
      "Discussing the prior round's marker",
      "<!-- claude-review-sha: 1111111 -->",
      "for context.",
      "",
      "### Verdict",
      "",
      "- PASS",
      "",
      "<!-- claude-review-sha: 2222222 -->",
    ].join("\n");
    expect(parseReviewedSha(body)).toBe("2222222");
  });
});

describe("describeWorkflowGateChange", () => {
  test("reports includesWorkflowFile=false when the workflow is absent", () => {
    const status = describeWorkflowGateChange([
      "packages/m3l-common/src/core/index.ts",
    ]);
    expect(status.includesWorkflowFile).toBe(false);
    expect(status.otherReviewableFiles).toEqual([
      "packages/m3l-common/src/core/index.ts",
    ]);
  });

  test("reports includesWorkflowFile=true with an empty other-files list when it's the sole change", () => {
    const status = describeWorkflowGateChange([REVIEW_GATE_WORKFLOW_PATH]);
    expect(status.includesWorkflowFile).toBe(true);
    expect(status.otherReviewableFiles).toEqual([]);
  });

  test("reports every other reviewable file when the workflow change is mixed with others", () => {
    const status = describeWorkflowGateChange([
      "bin/lib/pr-review-gate.mjs",
      REVIEW_GATE_WORKFLOW_PATH,
      "bin/pr-review-gate.mjs",
    ]);
    expect(status.includesWorkflowFile).toBe(true);
    expect(status.otherReviewableFiles).toEqual([
      "bin/lib/pr-review-gate.mjs",
      "bin/pr-review-gate.mjs",
    ]);
  });
});

describe("parseVerdictFile", () => {
  test("parses a bare PASS with no SHA", () => {
    expect(parseVerdictFile("PASS")).toEqual({ verdict: "PASS", sha: null });
  });

  test("parses a bare FAIL with trailing whitespace", () => {
    expect(parseVerdictFile("FAIL\n")).toEqual({
      verdict: "FAIL",
      sha: null,
    });
  });

  test("parses a PASS stamped with a SHA", () => {
    expect(parseVerdictFile("PASS abc1234")).toEqual({
      verdict: "PASS",
      sha: "abc1234",
    });
  });

  test("returns nulls for unparseable content", () => {
    expect(parseVerdictFile("maybe?")).toEqual({ verdict: null, sha: null });
  });

  test("returns nulls for empty content", () => {
    expect(parseVerdictFile("")).toEqual({ verdict: null, sha: null });
  });
});

describe("resolveVerdict", () => {
  const HEAD = "a".repeat(40);

  test("trusts an unstamped PASS unconditionally", () => {
    expect(resolveVerdict("PASS", HEAD)).toMatchObject({ verdict: "PASS" });
  });

  test("trusts an unstamped FAIL unconditionally", () => {
    expect(resolveVerdict("FAIL", HEAD)).toMatchObject({ verdict: "FAIL" });
  });

  test("accepts a stamped verdict whose SHA matches head", () => {
    expect(resolveVerdict(`PASS ${HEAD}`, HEAD)).toMatchObject({
      verdict: "PASS",
    });
  });

  // The gap this closes: before a SHA was required on the primary path, a
  // stale verdict file — left over from an earlier commit, or written by a
  // step whose `if:` fired unexpectedly — was indistinguishable from a
  // fresh one at enforcement time.
  test("rejects a stamped verdict whose SHA does not match head", () => {
    const result = resolveVerdict(`PASS ${"b".repeat(40)}`, HEAD);
    expect(result.verdict).toBeNull();
    expect(result.reason).toMatch(/stale/i);
  });

  test("reports a missing/empty file as no verdict", () => {
    expect(resolveVerdict("", HEAD).verdict).toBeNull();
    expect(resolveVerdict("   \n", HEAD).verdict).toBeNull();
  });

  test("reports unparseable content as no verdict", () => {
    expect(resolveVerdict("not a verdict", HEAD).verdict).toBeNull();
  });
});

describe("parseMustFixSection", () => {
  test("extracts the bullet text of a real Must-fix section followed by other sections", () => {
    const body = [
      "### Must-fix",
      "",
      "- `src/foo.ts:10` — missing null check (safety).",
      "",
      "### Should-fix",
      "",
      "- `src/bar.ts:5` — consider renaming (clarity).",
      "",
      "### Nits",
      "",
      "_None._",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
    ].join("\n");
    expect(parseMustFixSection(body)).toBe(
      "- `src/foo.ts:10` — missing null check (safety).",
    );
  });

  test("returns null when Must-fix is the empty-tier placeholder", () => {
    const body = [
      "### Must-fix",
      "",
      "_None._",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    expect(parseMustFixSection(body)).toBeNull();
  });

  test("returns null when no Must-fix heading exists", () => {
    expect(
      parseMustFixSection("## Claude PR Review — some title\n\nLooks fine."),
    ).toBeNull();
  });

  // The Must-fix heading here has no following `###` heading — only the
  // trailing claude-review-sha marker — so the lookahead must stop at the
  // `<!--` comment rather than swallowing it into the captured text.
  test("extracts a Must-fix section that is the last section before the trailing sha comment", () => {
    const body = [
      "### Must-fix",
      "",
      "- `src/foo.ts:10` — missing null check (safety).",
      "",
      "<!-- claude-review-sha: abc1234 -->",
    ].join("\n");
    expect(parseMustFixSection(body)).toBe(
      "- `src/foo.ts:10` — missing null check (safety).",
    );
  });

  test("captures every bullet, not just the first, when Must-fix has multiple items", () => {
    const body = [
      "### Must-fix",
      "",
      "- `src/foo.ts:10` — missing null check (safety).",
      "- `src/bar.ts:22` — unhandled rejection (reliability).",
      "",
      "### Should-fix",
      "",
      "_None._",
    ].join("\n");
    expect(parseMustFixSection(body)).toBe(
      [
        "- `src/foo.ts:10` — missing null check (safety).",
        "- `src/bar.ts:22` — unhandled rejection (reliability).",
      ].join("\n"),
    );
  });

  test("matches a lowercase must-fix heading", () => {
    const body = [
      "### must-fix",
      "",
      "- `src/foo.ts:10` — missing null check (safety).",
      "",
      "### Verdict",
      "",
      "- FAIL",
    ].join("\n");
    expect(parseMustFixSection(body)).toBe(
      "- `src/foo.ts:10` — missing null check (safety).",
    );
  });
});

describe("buildDeltaPatch", () => {
  test("emits the diff/---/+++ headers plus the patch content for a single file", () => {
    const result = buildDeltaPatch({
      files: [
        {
          filename: "src/foo.ts",
          patch: "@@ -1,1 +1,1 @@\n-old\n+new",
        },
      ],
    });
    expect(result).toBe(
      [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );
  });

  test("emits every file's block in input order", () => {
    const result = buildDeltaPatch({
      files: [
        { filename: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+A" },
        { filename: "src/b.ts", patch: "@@ -1 +1 @@\n-b\n+B" },
      ],
    });
    expect(result).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-a",
        "+A",
        "diff --git a/src/b.ts b/src/b.ts",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -1 +1 @@",
        "-b",
        "+B",
      ].join("\n"),
    );
  });

  test("substitutes the omission placeholder when patch is absent but changes is confirmed zero (e.g. a pure rename)", () => {
    const result = buildDeltaPatch({
      files: [{ filename: "assets/image.png", changes: 0 }],
    });
    expect(result).toBe(
      [
        "diff --git a/assets/image.png b/assets/image.png",
        "--- a/assets/image.png",
        "+++ b/assets/image.png",
        "(diff omitted — GitHub's compare API reported no content change for this file)",
      ].join("\n"),
    );
  });

  test("treats an empty-string patch the same as an absent one when changes is confirmed zero", () => {
    const result = buildDeltaPatch({
      files: [{ filename: "src/empty.ts", patch: "", changes: 0 }],
    });
    expect(result).toBe(
      [
        "diff --git a/src/empty.ts b/src/empty.ts",
        "--- a/src/empty.ts",
        "+++ b/src/empty.ts",
        "(diff omitted — GitHub's compare API reported no content change for this file)",
      ].join("\n"),
    );
  });

  // Security-relevant regression: a missing patch with no `changes` field at
  // all (or a non-numeric one) must NOT be treated as safe-to-placeholder —
  // GitHub omits `patch` for binary files and for files over its per-file
  // patch size cap, and the response gives no way to tell those apart from
  // "nothing changed" without `changes` explicitly confirming it. Silently
  // placeholdering here would hide real reviewable content from a delta
  // re-review.
  test("[security] does not silently omit a file with no patch and no changes confirmation — forces a fallback instead", () => {
    const result = buildDeltaPatch({
      files: [{ filename: "assets/image.png" }],
    });
    expect(result).toBeNull();
  });

  test("treats an empty-string patch with no changes field as unsafe to placeholder, forcing a fallback", () => {
    const result = buildDeltaPatch({
      files: [{ filename: "src/empty.ts", patch: "" }],
    });
    expect(result).toBeNull();
  });

  // The actual security-relevant regression this fix targets: a file GitHub
  // reports as having real textual changes (`changes` is a positive number)
  // but withholds the patch for (binary, or over the per-file size cap) must
  // never be silently hidden behind a tiny placeholder — the reviewer would
  // never see it, and the reviewable-byte size gate would never catch it.
  test("[security] does not silently omit a large or binary file with real changes — forces a fallback instead", () => {
    const result = buildDeltaPatch({
      files: [{ filename: "assets/huge-binary.bin", changes: 5000 }],
    });
    expect(result).toBeNull();
  });

  test("returns null as soon as one unsafe file is found, even with safe files around it", () => {
    const result = buildDeltaPatch({
      files: [
        { filename: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+A" },
        { filename: "assets/huge-binary.bin", changes: 5000 },
        { filename: "src/b.ts", patch: "@@ -1 +1 @@\n-b\n+B" },
      ],
    });
    expect(result).toBeNull();
  });

  test("returns null when files.length hits the compare API's 300-file cap, regardless of per-file content", () => {
    const files = Array.from({ length: 300 }, (_unused, index) => ({
      filename: `f${index}.ts`,
      patch: "@@ -1 +1 @@\n-a\n+A",
    }));
    expect(buildDeltaPatch({ files })).toBeNull();
  });

  test("processes normally at 299 files, one under the cap — confirms an exact boundary, not an approximation", () => {
    const files = Array.from({ length: 299 }, (_unused, index) => ({
      filename: `f${index}.ts`,
      changes: 0,
    }));
    const result = buildDeltaPatch({ files });
    expect(result).not.toBeNull();
    expect(
      result?.split("\n").filter((line) => line.startsWith("diff --git")),
    ).toHaveLength(299);
  });

  test("headers an added file's --- line with /dev/null", () => {
    const result = buildDeltaPatch({
      files: [
        {
          filename: "src/new-file.ts",
          status: "added",
          patch: "@@ -0,0 +1,1 @@\n+new",
        },
      ],
    });
    expect(result).toBe(
      [
        "diff --git a/src/new-file.ts b/src/new-file.ts",
        "--- /dev/null",
        "+++ b/src/new-file.ts",
        "@@ -0,0 +1,1 @@",
        "+new",
      ].join("\n"),
    );
  });

  test("headers a removed file's +++ line with /dev/null", () => {
    const result = buildDeltaPatch({
      files: [
        {
          filename: "src/old-file.ts",
          status: "removed",
          patch: "@@ -1,1 +0,0 @@\n-gone",
        },
      ],
    });
    expect(result).toBe(
      [
        "diff --git a/src/old-file.ts b/src/old-file.ts",
        "--- a/src/old-file.ts",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        "-gone",
      ].join("\n"),
    );
  });

  test("headers a renamed file with both the previous and new filename", () => {
    const result = buildDeltaPatch({
      files: [
        {
          filename: "new/path.ts",
          status: "renamed",
          previous_filename: "old/path.ts",
          patch: "@@ -1,1 +1,1 @@\n-old content\n+new content",
        },
      ],
    });
    expect(result).toBe(
      [
        "diff --git a/old/path.ts b/new/path.ts",
        "--- a/old/path.ts",
        "+++ b/new/path.ts",
        "@@ -1,1 +1,1 @@",
        "-old content",
        "+new content",
      ].join("\n"),
    );
  });

  test("returns an empty string when files is absent entirely", () => {
    expect(buildDeltaPatch({})).toBe("");
  });

  test("returns an empty string when files is an empty array", () => {
    expect(buildDeltaPatch({ files: [] })).toBe("");
  });

  // Regression test: buildDeltaPatch's output must remain parseable by
  // pr-diff-filter.mjs's filterPatch(), since the delta-review path feeds one
  // straight into the other. A reviewable code file's patch content must
  // survive unchanged; a file matching the existing ignore set (a doc, the
  // lockfile) must keep its header but have its body replaced by
  // filterPatch's own omission marker, not buildDeltaPatch's.
  test("round-trips through filterPatch: ignored files get filterPatch's marker, reviewable files pass through unchanged", () => {
    const deltaPatch = buildDeltaPatch({
      files: [
        {
          filename: "packages/m3l-common/src/core/foo.ts",
          patch: "@@ -1,1 +1,1 @@\n-old\n+new",
        },
        {
          filename: "docs/guide.md",
          patch: "@@ -1,1 +1,1 @@\n-old docs\n+new docs",
        },
        {
          filename: "pnpm-lock.yaml",
          patch: "@@ -1,1 +1,1 @@\n-old lock\n+new lock",
        },
      ],
    });

    expect(deltaPatch).not.toBeNull();
    const filtered = filterPatch(deltaPatch ?? "");

    expect(filtered).toContain(
      "diff --git a/packages/m3l-common/src/core/foo.ts b/packages/m3l-common/src/core/foo.ts",
    );
    expect(filtered).toContain("-old\n+new");

    expect(filtered).toContain("diff --git a/docs/guide.md b/docs/guide.md");
    expect(filtered).not.toContain("-old docs");
    expect(filtered).not.toContain("+new docs");

    expect(filtered).toContain("diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml");
    expect(filtered).not.toContain("-old lock");
    expect(filtered).not.toContain("+new lock");
  });
});

describe("countReviewComments", () => {
  test("counts every body when all parse a verdict", () => {
    const bodies = [
      ["### Verdict", "", "- PASS"].join("\n"),
      ["### Verdict", "", "- FAIL — a Must-fix remains."].join("\n"),
      ["### Verdict", "", "- PASS — all Must-fix items resolved."].join("\n"),
    ];
    expect(countReviewComments(bodies)).toBe(3);
  });

  // Mirrors the identity gap in this module's file header: claude-assistant.yml
  // replies to any @claude mention under the same claude[bot] login, with no
  // actor allowlist — a login-only filter would count that reply as a review
  // round. Filtering on "parses a verdict" scopes the count correctly.
  test("counts only the bodies that parse a real verdict, ignoring unrelated claude[bot] replies", () => {
    const bodies = [
      ["### Verdict", "", "- FAIL — one Must-fix remains."].join("\n"),
      "Thanks for the ping! Happy to help with that separately.",
      "## Claude PR Review — some title\n\nLooks fine.",
      ["### Verdict", "", "- PASS"].join("\n"),
    ];
    expect(countReviewComments(bodies)).toBe(2);
  });

  test("returns 0 for an empty array", () => {
    expect(countReviewComments([])).toBe(0);
  });

  // The same false-positive fixture parseVerdict's own tests use: a FAIL
  // whose bullet reason happens to contain the word "pass" still parses as a
  // real (anchored) FAIL verdict, so it IS counted — the word-search bug this
  // replaces would have misread it as PASS, not dropped it.
  test("counts a FAIL bullet whose reason text happens to contain the word pass", () => {
    const bodies = [
      ["### Verdict", "", "- FAIL — this does not pass the export check."].join(
        "\n",
      ),
    ];
    expect(countReviewComments(bodies)).toBe(1);
  });

  // A body that mentions "PASS" outside the anchored `### Verdict` bullet
  // form (e.g. inside a Should-fix note) carries no parseable verdict at
  // all, so it must not be counted.
  test("does not count a body that merely mentions PASS outside the Verdict section", () => {
    const noVerdictAtAll = [
      "### Should-fix",
      "",
      "- `src/foo.ts:1` — consider whether this test should PASS on retry.",
    ].join("\n");
    expect(countReviewComments([noVerdictAtAll])).toBe(0);
  });
});
