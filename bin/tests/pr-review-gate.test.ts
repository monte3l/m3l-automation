import { describe, expect, test } from "vitest";
import {
  REVIEW_GATE_WORKFLOW_PATH,
  describeWorkflowGateChange,
  parseReviewedSha,
  parseVerdict,
  parseVerdictFile,
  resolveVerdict,
} from "../../bin/lib/pr-review-gate.mjs";

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
