import { execFileSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import {
  fetchMergedPrNodes,
  parsePositiveInt,
  readMergeCommitBody,
  renderReport,
  toBackfillInput,
} from "../backfill-should-fix.mjs";
import { summarizeResults } from "../lib/should-fix-backfill.mjs";

/**
 * `fetchMergedPrNodes`'s injected `gh` seam type, derived rather than
 * re-declared — a signature drift fails typecheck here instead of silently
 * passing through a loosened stub type.
 */
type RunGhFn = Parameters<typeof fetchMergedPrNodes>[0];

/**
 * Builds the raw GraphQL JSON string `runGhFn` returns for one page of the
 * `pullRequests` connection — matches `MERGED_PRS_QUERY`'s response shape.
 */
function page(
  nodes: unknown[],
  hasNextPage: boolean,
  endCursor: string | null,
) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage, endCursor },
          nodes,
        },
      },
    },
  });
}

describe("fetchMergedPrNodes", () => {
  test("single page: returns all nodes, issues no cursor arg on the only call", () => {
    const runGhFn: RunGhFn = vi.fn(() =>
      page([{ number: 1 }, { number: 2 }], false, null),
    );

    const nodes = fetchMergedPrNodes(runGhFn, { pageSize: 25, limit: null });

    expect(nodes).toEqual([{ number: 1 }, { number: 2 }]);
    expect(runGhFn).toHaveBeenCalledTimes(1);
    const args = vi.mocked(runGhFn).mock.calls[0]?.[0] ?? [];
    expect(args.some((a) => a.startsWith("cursor="))).toBe(false);
  });

  test("multi-page pagination: cursor increments across calls, nodes concatenate in page order, onPage fires cumulative counts", () => {
    const runGhFn: RunGhFn = vi
      .fn()
      .mockReturnValueOnce(page([{ number: 1 }], true, "CURSOR_A"))
      .mockReturnValueOnce(page([{ number: 2 }], true, "CURSOR_B"))
      .mockReturnValueOnce(page([{ number: 3 }], false, null));
    const onPage = vi.fn();

    const nodes = fetchMergedPrNodes(runGhFn, {
      pageSize: 25,
      limit: null,
      onPage,
    });

    expect(nodes).toEqual([{ number: 1 }, { number: 2 }, { number: 3 }]);
    expect(runGhFn).toHaveBeenCalledTimes(3);

    const calls = vi.mocked(runGhFn).mock.calls;
    const firstArgs = calls[0]?.[0] ?? [];
    const secondArgs = calls[1]?.[0] ?? [];
    const thirdArgs = calls[2]?.[0] ?? [];
    expect(firstArgs.some((a) => a.startsWith("cursor="))).toBe(false);
    expect(secondArgs).toContain("cursor=CURSOR_A");
    expect(thirdArgs).toContain("cursor=CURSOR_B");

    expect(onPage).toHaveBeenNthCalledWith(1, 1);
    expect(onPage).toHaveBeenNthCalledWith(2, 2);
    expect(onPage).toHaveBeenNthCalledWith(3, 3);
  });

  test("limit truncation: stops paging once accumulated nodes reach the limit, then slices to exactly limit", () => {
    const runGhFn: RunGhFn = vi
      .fn()
      .mockReturnValueOnce(
        page([{ number: 1 }, { number: 2 }], true, "CURSOR_A"),
      )
      .mockReturnValueOnce(
        page([{ number: 3 }, { number: 4 }], true, "CURSOR_B"),
      );

    const nodes = fetchMergedPrNodes(runGhFn, { pageSize: 2, limit: 3 });

    expect(nodes).toEqual([{ number: 1 }, { number: 2 }, { number: 3 }]);
    // A third page (which would have hasNextPage: true forever) is never
    // requested — the loop's own length check against `limit` stopped it.
    expect(runGhFn).toHaveBeenCalledTimes(2);
  });

  test("throws with a message including the raw GraphQL error payload", () => {
    const errors = [{ message: "field 'pullRequests' is not defined" }];
    const runGhFn: RunGhFn = vi.fn(() => JSON.stringify({ errors }));

    let thrown: unknown;
    try {
      fetchMergedPrNodes(runGhFn, { pageSize: 25, limit: null });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(JSON.stringify(errors));
  });
});

describe("readMergeCommitBody", () => {
  test("returns the real commit message for a commit reachable in this checkout", () => {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const expected = execFileSync(
      "git",
      ["log", "-1", "--format=%B", headSha],
      { encoding: "utf8" },
    );

    const body = readMergeCommitBody(headSha);

    expect(body).not.toBeNull();
    expect(body).toBe(expected);
    expect(body?.length).toBeGreaterThan(0);
  });

  // The fail-open path readMergeCommitBody's own JSDoc documents: a
  // syntactically-plausible 40-hex oid that this history rewrite orphaned (or
  // that simply never existed) must return null, not throw or leak git's
  // "fatal: bad object" stderr.
  test("returns null (not throw) for a syntactically-plausible but nonexistent oid", () => {
    const fakeOid = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    expect(() => readMergeCommitBody(fakeOid)).not.toThrow();
    expect(readMergeCommitBody(fakeOid)).toBeNull();
  });
});

describe("toBackfillInput", () => {
  test("a fully-populated node maps every field, including truncation flags reflecting each connection's own pageInfo independently", () => {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const node = {
      number: 42,
      mergedAt: "2026-01-01T00:00:00Z",
      mergedBy: { login: "octocat" },
      autoMergeRequest: { enabledAt: "2026-01-01T00:00:00Z" },
      mergeCommit: { oid: headSha },
      files: {
        nodes: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        pageInfo: { hasNextPage: true },
      },
      comments: {
        nodes: [{ author: { login: "claude", __typename: "Bot" }, body: "hi" }],
        pageInfo: { hasNextPage: false },
      },
    };

    const result = toBackfillInput(node);

    expect(result.number).toBe(42);
    expect(result.mergedAt).toBe("2026-01-01T00:00:00Z");
    expect(result.mergedByLogin).toBe("octocat");
    expect(result.autoMergeUsed).toBe(true);
    expect(result.mergeCommitBody.length).toBeGreaterThan(0);
    expect(result.mergeCommitUnreachable).toBe(false);
    expect(result.filePaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.filesTruncated).toBe(true);
    expect(result.comments).toEqual([
      { login: "claude", isBot: true, body: "hi" },
    ]);
    expect(result.commentsTruncated).toBe(false);
  });

  test("commentsTruncated reflects the comments connection's own pageInfo even when filesTruncated is false", () => {
    const node = {
      number: 43,
      mergedAt: "2026-01-01T00:00:00Z",
      mergedBy: null,
      autoMergeRequest: null,
      mergeCommit: null,
      files: { nodes: [], pageInfo: { hasNextPage: false } },
      comments: { nodes: [], pageInfo: { hasNextPage: true } },
    };

    const result = toBackfillInput(node);

    expect(result.filesTruncated).toBe(false);
    expect(result.commentsTruncated).toBe(true);
  });

  test("autoMergeUsed is false when autoMergeRequest is null", () => {
    const node = {
      number: 44,
      mergedAt: "2026-01-01T00:00:00Z",
      mergedBy: null,
      autoMergeRequest: null,
      mergeCommit: null,
    };

    expect(toBackfillInput(node).autoMergeUsed).toBe(false);
  });

  // Forced deterministically: readMergeCommitBody genuinely fails to resolve
  // this made-up oid, so the mapping's own real behavior — not a mock — is
  // what produces mergeCommitUnreachable: true here.
  test("mergeCommitUnreachable is true when the mapped merge commit oid cannot be read locally", () => {
    const node = {
      number: 45,
      mergedAt: "2026-01-01T00:00:00Z",
      mergedBy: null,
      autoMergeRequest: null,
      mergeCommit: { oid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    };

    const result = toBackfillInput(node);

    expect(result.mergeCommitUnreachable).toBe(true);
    expect(result.mergeCommitBody).toBe("");
  });

  test("a node missing every optional field (files/comments absent, mergedBy null) still produces valid, non-throwing output with the documented fallbacks", () => {
    const node = {
      number: 46,
      mergedAt: "2026-01-01T00:00:00Z",
      mergedBy: null,
      autoMergeRequest: null,
      mergeCommit: null,
    };

    let result: ReturnType<typeof toBackfillInput> | undefined;
    expect(() => {
      result = toBackfillInput(node);
    }).not.toThrow();

    expect(result?.mergedByLogin).toBeNull();
    expect(result?.autoMergeUsed).toBe(false);
    expect(result?.filePaths).toEqual([]);
    expect(result?.filesTruncated).toBe(false);
    expect(result?.comments).toEqual([]);
    expect(result?.commentsTruncated).toBe(false);
  });

  test("a comment with a null author defaults login to empty string and isBot to false", () => {
    const node = {
      number: 47,
      mergedAt: "2026-01-01T00:00:00Z",
      mergedBy: null,
      autoMergeRequest: null,
      mergeCommit: null,
      comments: {
        nodes: [{ author: null, body: "orphaned comment" }],
        pageInfo: { hasNextPage: false },
      },
    };

    const result = toBackfillInput(node);

    expect(result.comments).toEqual([
      { login: "", isBot: false, body: "orphaned comment" },
    ]);
  });
});

describe("renderReport", () => {
  /**
   * `summarizeResults`'s own element parameter type, derived so a
   * `BackfillPrResult` field-shape drift fails typecheck rather than being
   * masked by a loosened fixture type.
   */
  type ResultInput = Parameters<typeof summarizeResults>[0][number];

  test("renders category rows, the candidates sentence, and fenced (not bare) PR-number lists with the uncertain marker", () => {
    const results: ResultInput[] = [
      {
        number: 10,
        category: "review-excluded",
        shouldFixCount: 0,
        mode: null,
        uncertain: false,
      },
      {
        number: 11,
        category: "acknowledged-footer",
        shouldFixCount: 2,
        mode: "manual",
        uncertain: false,
      },
      {
        number: 12,
        category: "acknowledged-footer",
        shouldFixCount: 1,
        mode: "auto-merge",
        uncertain: true,
      },
      {
        number: 13,
        category: "resolve-commit-heuristic",
        shouldFixCount: 1,
        mode: "manual",
        uncertain: false,
      },
      {
        number: 14,
        category: "multi-round-suppressed",
        shouldFixCount: 3,
        mode: "manual",
        uncertain: false,
      },
      {
        number: 15,
        category: "merged-unresolved",
        shouldFixCount: 1,
        mode: "manual",
        uncertain: false,
      },
    ];
    const summary = summarizeResults(results);

    const report = renderReport(results, summary, {
      today: "2026-09-07",
      fetchedAt: "2026-09-07T00:00:00.000Z",
    });

    expect(report).toContain("Total merged PRs examined: **6**");
    // candidateTotal = 6 total - 1 review-excluded - 0 no-review-posted = 5
    expect(report).toContain("Of 6 merged PRs, **5** were candidates");

    // Category table rows: label, count, percentage, auto-merge/manual split.
    expect(report).toContain(
      "| Should-fix posted, Acknowledged-Should-Fix: footer present | 2 | 33.3% | 1 | 1 |",
    );
    expect(report).toContain(
      "| Should-fix posted, no footer — a pre-ADR-0097 'resolve claude-pr-review findings' commit exists (weak evidence, not proof) | 1 | 16.7% | 0 | 1 |",
    );

    // Acknowledged list: fenced ```text block, NOT a bare "#NNN" line (would
    // be misread by the markdown linter as an ATX heading, MD018) — and the
    // uncertain result's number carries the † marker.
    expect(report).toContain("```text\n#11, #12†\n```");

    // Unresolved lists, one fenced block per category.
    expect(report).toContain("```text\n#13\n```");
    expect(report).toContain("```text\n#14\n```");
    expect(report).toContain("```text\n#15\n```");
  });

  test("zero-results edge case: percentages render 0.0%, not NaN% or a divide-by-zero artifact, and PR-number lists render 'None.'", () => {
    const results: ResultInput[] = [];
    const summary = summarizeResults(results);

    const report = renderReport(results, summary, {
      today: "2026-09-07",
      fetchedAt: "2026-09-07T00:00:00.000Z",
    });

    expect(report).toContain("Total merged PRs examined: **0**");
    expect(report).toContain("Of 0 merged PRs, **0** were candidates");
    expect(report).not.toContain("NaN%");
    // Every category row falls back to the summary.total > 0 ? ... : "0.0"
    // guard — assert at least one such row explicitly rather than merely the
    // absence of NaN%.
    expect(report).toContain(
      "| Should-fix posted, Acknowledged-Should-Fix: footer present | 0 | 0.0% | — | — |",
    );
    expect(report).toContain("```text\nNone.\n```");
  });
});

describe("parsePositiveInt", () => {
  test("parses a valid positive-integer string", () => {
    expect(parsePositiveInt("--limit", "42")).toBe(42);
  });

  test.each([undefined, "", "abc", "0", "-5", "1.5", "NaN", "Infinity"])(
    "MUTATION: rejects %j rather than forwarding it as a literal",
    (value) => {
      expect(() => parsePositiveInt("--limit", value)).toThrow(
        /not a positive integer/,
      );
    },
  );

  test("the error message names the offending flag and value", () => {
    expect(() => parsePositiveInt("--page-size", "0")).toThrow(
      /--page-size "0" is not a positive integer/,
    );
  });
});
