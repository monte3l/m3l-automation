import { describe, expect, test } from "vitest";
import {
  classifyPr,
  isReviewExcludedFileSet,
  summarizeResults,
} from "../../bin/lib/should-fix-backfill.mjs";

/**
 * Builds a synthetic `claude[bot]`-shaped review comment body, matching
 * REVIEW.md's Output format template (`### Must-fix` / `### Should-fix` /
 * `### Nits` / `### Verdict`, `_None._` for an empty tier). Each tier
 * defaults to empty so a test only has to spell out the section it cares
 * about — mirrors `bin/tests/pr-review-gate.test.ts`'s inline fixture
 * arrays, but as a reusable builder since `classifyPr` composes several of
 * `pr-review-gate.mjs`'s parsers together per call.
 */
function buildReviewComment({
  mustFix = [],
  shouldFix = [],
  nits = [],
  verdict = "PASS",
}: {
  mustFix?: string[];
  shouldFix?: string[];
  nits?: string[];
  verdict?: string;
} = {}) {
  const section = (items: string[]) =>
    items.length === 0
      ? "_None._"
      : items.map((item) => `- ${item}`).join("\n");
  return [
    "### Must-fix",
    "",
    section(mustFix),
    "",
    "### Should-fix",
    "",
    section(shouldFix),
    "",
    "### Nits",
    "",
    section(nits),
    "",
    "### Verdict",
    "",
    `- ${verdict}`,
  ].join("\n");
}

/**
 * Convenience: a `claude[bot]`-shaped Should-fix comment carrying exactly
 * `count` synthetic findings, verdict fixed to FAIL (unrelated to what
 * `classifyPr` reads, but keeps fixtures self-consistent with a real
 * "findings posted" round).
 */
function shouldFixComment(count: number) {
  return buildReviewComment({
    shouldFix: Array.from(
      { length: count },
      (_unused, index) => `finding ${index}`,
    ),
    verdict: count === 0 ? "PASS" : "FAIL",
  });
}

/**
 * Wraps a comment body as a `BackfillPrComment` the module's own
 * `isReviewBotComment()` helper recognizes as the review bot — GraphQL's
 * `login: "claude"` plus `author.__typename === "Bot"` (`isBot: true`), NOT
 * REST's `"claude[bot]"` login. Every fixture that needs to be seen as a
 * real bot-authored review comment should go through this single helper, so
 * a future GraphQL-shape change only needs updating in one place.
 */
function botComment(body: string) {
  return { login: "claude", isBot: true, body };
}

/**
 * A base `BackfillPrInput`-shaped object with sane, reviewable-by-default
 * values — every test overrides only the fields it's exercising.
 */
function buildPr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 1,
    mergedAt: "2026-01-01T00:00:00Z",
    mergedByLogin: "octocat",
    autoMergeUsed: false,
    mergeCommitBody: "fix: unrelated commit message\n",
    filePaths: ["src/foo.ts"],
    filesTruncated: false,
    comments: [],
    commentsTruncated: false,
    ...overrides,
  };
}

describe("isReviewExcludedFileSet", () => {
  test("is true when every path matches REVIEW.md's exclusions", () => {
    expect(
      isReviewExcludedFileSet([
        "README.md",
        "docs/guide.md",
        ".github/dependabot.yml",
        "pnpm-lock.yaml",
      ]),
    ).toBe(true);
  });

  test("is false when any path is reviewable", () => {
    expect(
      isReviewExcludedFileSet(["README.md", "src/index.ts", "docs/guide.md"]),
    ).toBe(false);
  });

  // Deliberate choice per the JSDoc: no files fetched proves nothing about
  // exclusion, so an empty list must not vacuously read as "all excluded".
  test("is false for an empty list", () => {
    expect(isReviewExcludedFileSet([])).toBe(false);
  });
});

describe("classifyPr", () => {
  test("review-excluded: every changed file matches REVIEW.md's exclusions, not truncated", () => {
    const pr = buildPr({
      filePaths: ["README.md", "docs/guide.md", ".github/dependabot.yml"],
      filesTruncated: false,
    });
    const result = classifyPr(pr as never);
    expect(result.category).toBe("review-excluded");
    expect(result.shouldFixCount).toBe(0);
    expect(result.mode).toBeNull();
    expect(result.uncertain).toBe(false);
  });

  // The documented "fail toward candidate" behavior: a truncated files page
  // means exclusion cannot be trusted, so a PR whose FETCHED paths all
  // happen to be excluded must NOT be classified review-excluded — it falls
  // through to the normal comment-based classification instead, and gets
  // flagged uncertain so a human can spot-check it.
  test("does not classify as review-excluded when the files list is truncated, even if every fetched path is excluded — falls through and is flagged uncertain", () => {
    const pr = buildPr({
      filePaths: ["README.md", "docs/guide.md"],
      filesTruncated: true,
      comments: [],
    });
    const result = classifyPr(pr as never);
    expect(result.category).not.toBe("review-excluded");
    expect(result.uncertain).toBe(true);
  });

  test("no-review-posted: a review-bot comment exists but parses no Verdict line", () => {
    const pr = buildPr({
      comments: [botComment("Thanks for the ping! Taking a look shortly.")],
    });
    const result = classifyPr(pr as never);
    expect(result.category).toBe("no-review-posted");
    expect(result.shouldFixCount).toBe(0);
    expect(result.mode).toBeNull();
  });

  test("no-should-fix: a reviewed comment with zero Should-fix bullets", () => {
    const pr = buildPr({
      comments: [botComment(buildReviewComment({ verdict: "PASS" }))],
    });
    const result = classifyPr(pr as never);
    expect(result.category).toBe("no-should-fix");
    expect(result.shouldFixCount).toBe(0);
    expect(result.mode).toBeNull();
  });

  test("acknowledged-footer: merge commit body carries Acknowledged-Should-Fix:", () => {
    const pr = buildPr({
      comments: [botComment(shouldFixComment(2))],
      mergeCommitBody:
        "fix: address review feedback\n\nAcknowledged-Should-Fix: deferring the rename for now",
    });
    const result = classifyPr(pr as never);
    expect(result.category).toBe("acknowledged-footer");
    expect(result.shouldFixCount).toBe(2);
    expect(result.mode).toBe("manual");
  });

  describe("resolve-commit-heuristic", () => {
    // The bare pre-ADR-0097 convention (RESOLVE_COMMIT_RE's non-scoped arm).
    test("matches the bare 'resolve claude-pr-review findings' commit-subject convention", () => {
      const pr = buildPr({
        comments: [botComment(shouldFixComment(1))],
        mergeCommitBody: "fix: resolve claude-pr-review findings\n",
      });
      const result = classifyPr(pr as never);
      expect(result.category).toBe("resolve-commit-heuristic");
      expect(result.shouldFixCount).toBe(1);
    });

    // The must-fix-scoped variant RESOLVE_COMMIT_RE's `(\s+must-fix)?` group
    // also matches — historically the convention was scoped to Must-fix
    // findings specifically, which is exactly why this category's own JSDoc
    // calls it "weak evidence, not proof" for a Should-fix finding.
    test("matches the must-fix-scoped 'resolve claude-pr-review must-fix findings' variant", () => {
      const pr = buildPr({
        comments: [botComment(shouldFixComment(1))],
        mergeCommitBody: "fix: resolve claude-pr-review must-fix findings\n",
      });
      const result = classifyPr(pr as never);
      expect(result.category).toBe("resolve-commit-heuristic");
      expect(result.shouldFixCount).toBe(1);
    });
  });

  // REVIEW.md's "Re-review convergence" rule suppresses fresh Should-fix
  // bullets after round 1 — round 2 posting a verdict with zero findings is
  // NOT proof the finding was fixed, so the result must still report round
  // 1's count (the MAX across rounds), not silently drop to 0.
  test("multi-round-suppressed: takes the MAX Should-fix count across rounds, not the last round's suppressed count", () => {
    const pr = buildPr({
      comments: [
        botComment(shouldFixComment(3)),
        botComment(shouldFixComment(0)),
      ],
    });
    const result = classifyPr(pr as never);
    expect(result.category).toBe("multi-round-suppressed");
    expect(result.shouldFixCount).toBe(3);
  });

  test("merged-unresolved: exactly one review round posted findings, no footer, no resolve-commit", () => {
    const pr = buildPr({
      comments: [botComment(shouldFixComment(1))],
    });
    const result = classifyPr(pr as never);
    expect(result.category).toBe("merged-unresolved");
    expect(result.shouldFixCount).toBe(1);
  });

  describe("mode", () => {
    test("is auto-merge when autoMergeUsed is true", () => {
      const pr = buildPr({
        autoMergeUsed: true,
        comments: [botComment(shouldFixComment(1))],
      });
      expect(classifyPr(pr as never).mode).toBe("auto-merge");
    });

    test("is manual when autoMergeUsed is false", () => {
      const pr = buildPr({
        autoMergeUsed: false,
        comments: [botComment(shouldFixComment(1))],
      });
      expect(classifyPr(pr as never).mode).toBe("manual");
    });

    test.each([
      [
        "review-excluded",
        buildPr({ filePaths: ["README.md"], filesTruncated: false }),
      ],
      ["no-review-posted", buildPr({ comments: [] })],
      [
        "no-should-fix",
        buildPr({
          comments: [botComment(buildReviewComment({ verdict: "PASS" }))],
        }),
      ],
    ])("is null for the non-Should-fix category %s", (expectedCategory, pr) => {
      const result = classifyPr(pr as never);
      expect(result.category).toBe(expectedCategory);
      expect(result.mode).toBeNull();
    });
  });

  // Mirrors the same ambiguity countReviewComments' own JSDoc documents:
  // claude-assistant.yml replies to ANY @claude mention under the same bot
  // identity with no actor allowlist, so a differently-logged-in commenter
  // must never contribute to the selected Should-fix count — even one
  // crafted to look like a real review with a huge finding count.
  test("a comment from a different login never contributes to the selected Should-fix count, even with a parseable verdict and a huge finding count", () => {
    const pr = buildPr({
      comments: [
        { login: "someone-else[bot]", isBot: true, body: shouldFixComment(50) },
      ],
    });
    const result = classifyPr(pr as never);
    expect(result.category).toBe("no-review-posted");
    expect(result.shouldFixCount).toBe(0);
  });

  // The exact edge case isBot exists to guard against: a hypothetical human
  // account literally named "claude" must not be mistaken for the review
  // bot just because its login string matches — isReviewBotComment() also
  // requires author.__typename === "Bot" (isBot: true), which this fixture
  // deliberately omits (isBot defaults to false/absent for a human author).
  test("a comment whose login is 'claude' but isBot is false is not treated as a review-bot comment", () => {
    const pr = buildPr({
      comments: [{ login: "claude", isBot: false, body: shouldFixComment(50) }],
    });
    const result = classifyPr(pr as never);
    expect(result.category).toBe("no-review-posted");
    expect(result.shouldFixCount).toBe(0);
  });
});

describe("summarizeResults", () => {
  function buildResult(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      number: 1,
      category: "merged-unresolved",
      shouldFixCount: 1,
      mode: "manual",
      uncertain: false,
      ...overrides,
    };
  }

  test("tallies byCategory correctly across a small mixed list", () => {
    const results = [
      buildResult({ number: 1, category: "review-excluded", mode: null }),
      buildResult({ number: 2, category: "merged-unresolved" }),
      buildResult({ number: 3, category: "merged-unresolved" }),
      buildResult({ number: 4, category: "acknowledged-footer" }),
    ];
    const summary = summarizeResults(results as never);
    expect(summary.total).toBe(4);
    expect(summary.byCategory).toEqual({
      "review-excluded": 1,
      "merged-unresolved": 2,
      "acknowledged-footer": 1,
    });
  });

  // Only the four Should-fix-positive categories carry a non-null mode;
  // review-excluded/no-review-posted/no-should-fix results are excluded from
  // modeByCategory entirely, not tallied under a bogus "null" bucket.
  test("tallies modeByCategory only for the four Should-fix-positive categories", () => {
    const results = [
      buildResult({ number: 1, category: "review-excluded", mode: null }),
      buildResult({ number: 2, category: "no-review-posted", mode: null }),
      buildResult({ number: 3, category: "no-should-fix", mode: null }),
      buildResult({
        number: 4,
        category: "merged-unresolved",
        mode: "manual",
      }),
      buildResult({
        number: 5,
        category: "merged-unresolved",
        mode: "auto-merge",
      }),
      buildResult({
        number: 6,
        category: "acknowledged-footer",
        mode: "manual",
      }),
    ];
    const summary = summarizeResults(results as never);
    expect(summary.modeByCategory).toEqual({
      "merged-unresolved": { "auto-merge": 1, manual: 1 },
      "acknowledged-footer": { "auto-merge": 0, manual: 1 },
    });
    expect(summary.modeByCategory["review-excluded"]).toBeUndefined();
    expect(summary.modeByCategory["no-review-posted"]).toBeUndefined();
    expect(summary.modeByCategory["no-should-fix"]).toBeUndefined();
  });

  test("counts uncertainCount correctly when some results have uncertain: true", () => {
    const results = [
      buildResult({ number: 1, uncertain: true }),
      buildResult({ number: 2, uncertain: false }),
      buildResult({ number: 3, uncertain: true }),
    ];
    const summary = summarizeResults(results as never);
    expect(summary.uncertainCount).toBe(2);
  });
});
