import { describe, expect, test } from "vitest";
import {
  REVIEW_GATE_WORKFLOW_PATH,
  buildDeltaPatch,
  collectShouldFixRounds,
  countReviewComments,
  countShouldFixFindings,
  describeShouldFixAckOutcome,
  describeWorkflowGateChange,
  hasShouldFixAcknowledgment,
  parseMustFixSection,
  parseReviewedSha,
  parseShouldFixSection,
  parseVerdict,
  parseVerdictFile,
  planShouldFixAckRanges,
  resolveVerdict,
  selectShouldFixComment,
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

describe("parseShouldFixSection", () => {
  test("extracts the bullet text of a real Should-fix section followed by other sections", () => {
    const body = [
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
      "- PASS",
    ].join("\n");
    expect(parseShouldFixSection(body)).toBe(
      "- `src/bar.ts:5` — consider renaming (clarity).",
    );
  });

  test("returns null when Should-fix is the empty-tier placeholder", () => {
    const body = [
      "### Should-fix",
      "",
      "_None._",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    expect(parseShouldFixSection(body)).toBeNull();
  });

  test("returns null when no Should-fix heading exists", () => {
    expect(
      parseShouldFixSection("## Claude PR Review — some title\n\nLooks fine."),
    ).toBeNull();
  });

  // The Should-fix heading here has no following `###` heading — only the
  // trailing claude-review-sha marker — so the lookahead must stop at the
  // `<!--` comment rather than swallowing it into the captured text.
  test("extracts a Should-fix section that is the last section before the trailing sha comment", () => {
    const body = [
      "### Should-fix",
      "",
      "- `src/bar.ts:5` — consider renaming (clarity).",
      "",
      "<!-- claude-review-sha: abc1234 -->",
    ].join("\n");
    expect(parseShouldFixSection(body)).toBe(
      "- `src/bar.ts:5` — consider renaming (clarity).",
    );
  });

  test("captures every bullet, not just the first, when Should-fix has multiple items", () => {
    const body = [
      "### Should-fix",
      "",
      "- `src/bar.ts:5` — consider renaming (clarity).",
      "- `src/baz.ts:12` — extract the duplicated guard (readability).",
      "",
      "### Nits",
      "",
      "_None._",
    ].join("\n");
    expect(parseShouldFixSection(body)).toBe(
      [
        "- `src/bar.ts:5` — consider renaming (clarity).",
        "- `src/baz.ts:12` — extract the duplicated guard (readability).",
      ].join("\n"),
    );
  });

  test("matches a lowercase should-fix heading", () => {
    const body = [
      "### should-fix",
      "",
      "- `src/bar.ts:5` — consider renaming (clarity).",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    expect(parseShouldFixSection(body)).toBe(
      "- `src/bar.ts:5` — consider renaming (clarity).",
    );
  });

  test("does not confuse a Must-fix section with a Should-fix section when both are present", () => {
    const body = [
      "### Must-fix",
      "",
      "- `src/foo.ts:10` — missing null check (safety).",
      "",
      "### Should-fix",
      "",
      "- `src/bar.ts:5` — consider renaming (clarity).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
    ].join("\n");
    expect(parseShouldFixSection(body)).toBe(
      "- `src/bar.ts:5` — consider renaming (clarity).",
    );
  });
});

describe("countShouldFixFindings", () => {
  test("counts multiple bullets in a real section", () => {
    const section = [
      "- `src/bar.ts:5` — consider renaming (clarity).",
      "- `src/baz.ts:12` — extract the duplicated guard (readability).",
      "- `src/qux.ts:1` — add a doc comment (documentation).",
    ].join("\n");
    expect(countShouldFixFindings(section)).toBe(3);
  });

  test("counts a single bullet correctly", () => {
    expect(
      countShouldFixFindings("- `src/bar.ts:5` — consider renaming (clarity)."),
    ).toBe(1);
  });

  test("returns 0 for null input", () => {
    expect(countShouldFixFindings(null)).toBe(0);
  });

  test("returns 0 for an empty string", () => {
    expect(countShouldFixFindings("")).toBe(0);
  });

  test("counts bullets whether the marker is - or *", () => {
    const section = [
      "- `src/bar.ts:5` — consider renaming (clarity).",
      "* `src/baz.ts:12` — extract the duplicated guard (readability).",
    ].join("\n");
    expect(countShouldFixFindings(section)).toBe(2);
  });

  // The actual call pattern the CLI wrapper uses: parse the section out of
  // a full comment body, then feed the result straight into the counter.
  test("counts findings end-to-end from a full comment body via parseShouldFixSection", () => {
    const body = [
      "### Must-fix",
      "",
      "_None._",
      "",
      "### Should-fix",
      "",
      "- `src/bar.ts:5` — consider renaming (clarity).",
      "- `src/baz.ts:12` — extract the duplicated guard (readability).",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    const section = parseShouldFixSection(body);
    expect(countShouldFixFindings(section)).toBe(2);
  });

  // An indented bullet is a sub-point under the finding above it, not a
  // second finding — mirrors why the regex is anchored to column zero in
  // bin/lib/pr-review-gate.mjs.
  test("does not count an indented sub-bullet as its own finding", () => {
    const section = [
      "- `src/foo.ts:10` — missing null check (safety).",
      "  - context: only reachable via the retry path",
      "- `src/bar.ts:5` — consider renaming (clarity).",
    ].join("\n");
    expect(countShouldFixFindings(section)).toBe(2);
  });
});

describe("hasShouldFixAcknowledgment", () => {
  test("detects an Acknowledged-Should-Fix footer on its own line", () => {
    expect(
      hasShouldFixAcknowledgment(
        "fix: tidy up\n\nAcknowledged-Should-Fix: deferring the rename for now",
      ),
    ).toBe(true);
  });

  test("detects the footer in the middle of a multi-commit concatenated log", () => {
    const commitLog = [
      "feat: add the new helper",
      "",
      "fix: adjust a call site\n\nAcknowledged-Should-Fix: deferred to a follow-up",
      "",
      "docs: update the reference page",
    ].join("\n\n");
    expect(hasShouldFixAcknowledgment(commitLog)).toBe(true);
  });

  test("returns false when no such footer appears anywhere in the log", () => {
    expect(
      hasShouldFixAcknowledgment("feat: add a new helper\n\nfix: tidy up"),
    ).toBe(false);
  });

  // The words "should" and "fix" appearing separately in prose must not
  // false-positive — only the literal footer key counts.
  test("does not false-positive on loose text merely containing the words should and fix", () => {
    expect(
      hasShouldFixAcknowledgment(
        "fix: patch the parser\n\nwe should fix this footer parsing eventually",
      ),
    ).toBe(false);
  });

  test("is case-insensitive on the footer key itself", () => {
    expect(
      hasShouldFixAcknowledgment(
        "fix: tidy up\n\nacknowledged-should-fix: deferring for now",
      ),
    ).toBe(true);
  });
});

describe("selectShouldFixComment", () => {
  // The core regression this function exists for: round 2 is a re-review
  // whose Should-fix section is suppressed to the empty-tier placeholder per
  // REVIEW.md's "Re-review convergence" rule (only a count in the summary
  // line, no re-listed bullets) — but it still parses a real Verdict, so a
  // naive "most recent comment" strategy would pick it and silently stop
  // enforcing acknowledgment of round 1's still-outstanding findings.
  test("prefers an earlier comment with real Should-fix bullets over a later re-review's suppressed _None._", () => {
    const round1 = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — consider extracting this branch (clarity).",
      "- `src/bar.ts:5` — missing a doc comment (documentation).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
    ].join("\n");
    const round2 = [
      "### Should-fix",
      "",
      "_None._",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    expect(selectShouldFixComment([round1, round2])).toBe(round1);
  });

  test("returns the sole comment when it is alone in the array and carries Should-fix findings", () => {
    const body = [
      "### Should-fix",
      "",
      "- `src/bar.ts:5` — consider renaming (clarity).",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    expect(selectShouldFixComment([body])).toBe(body);
  });

  // Mirrors countReviewComments' own guard against claude-assistant.yml's
  // unrestricted @claude-mention reply landing under the same claude[bot]
  // identity — it must never be selected even when it precedes a real review.
  test("never selects an unrelated non-review reply that precedes a real review comment", () => {
    const reply = "Thanks for the ping! Happy to help.";
    const review = [
      "### Should-fix",
      "",
      "- `src/bar.ts:5` — consider renaming (clarity).",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    expect(selectShouldFixComment([reply, review])).toBe(review);
  });

  test("returns null when no body in the array parses a verdict at all", () => {
    const reply = "Thanks for the ping! Happy to help.";
    expect(selectShouldFixComment([reply])).toBeNull();
  });

  test("returns null for an empty array", () => {
    expect(selectShouldFixComment([])).toBeNull();
  });

  // Ties break toward the later body per the JSDoc — both candidates carry
  // the same Should-fix count here (zero), so the choice of which literal
  // body wins doesn't change countShouldFixFindings downstream, but the
  // function's own tie-break behavior is still an assertable contract.
  test("breaks a tied Should-fix count toward the later comment in the array", () => {
    const first = [
      "### Should-fix",
      "",
      "_None._",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    const second = [
      "### Should-fix",
      "",
      "_None._",
      "",
      "### Verdict",
      "",
      "- PASS — nothing further to add.",
    ].join("\n");
    expect(selectShouldFixComment([first, second])).toBe(second);
  });

  // Realistic multi-round PR: round 1 raises 3 Should-fix findings, and every
  // subsequent re-review round suppresses them to the empty-tier placeholder
  // without ever raising new ones — round 1 must still win regardless of how
  // many suppressed rounds follow it.
  test("selects round 1 as the max across a three-round sequence where every later round is suppressed", () => {
    const round1 = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — consider extracting this branch (clarity).",
      "- `src/bar.ts:5` — missing a doc comment (documentation).",
      "- `src/baz.ts:1` — rename for clarity (readability).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
    ].join("\n");
    const round2 = [
      "### Should-fix",
      "",
      "_None._",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
    ].join("\n");
    const round3 = [
      "### Should-fix",
      "",
      "_None._",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    expect(selectShouldFixComment([round1, round2, round3])).toBe(round1);
  });
});

describe("collectShouldFixRounds", () => {
  test("keeps every round with findings, each with its own sha, section, and count", () => {
    const round1Bullets = [
      "- `src/foo.ts:10` — consider extracting this branch (clarity).",
      "- `src/bar.ts:5` — missing a doc comment (documentation).",
    ];
    const round1 = [
      "### Should-fix",
      "",
      ...round1Bullets,
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: aaaa111 -->",
    ].join("\n");
    const round2Bullets = [
      "- `src/baz.ts:1` — rename for clarity (readability).",
    ];
    const round2 = [
      "### Should-fix",
      "",
      ...round2Bullets,
      "",
      "### Verdict",
      "",
      "- PASS",
      "",
      "<!-- claude-review-sha: bbbb222 -->",
    ].join("\n");
    const round3 = [
      "### Should-fix",
      "",
      "_None._",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    expect(collectShouldFixRounds([round1, round2, round3])).toEqual([
      { round: 1, sha: "aaaa111", count: 2, section: round1Bullets.join("\n") },
      { round: 2, sha: "bbbb222", count: 1, section: round2Bullets.join("\n") },
    ]);
  });

  // The core regression this function exists for (issue #1193 / PR #1190):
  // round 1 and round 2 raise the SAME count of findings but DIFFERENT
  // findings — selectShouldFixComment's "pick one loudest round" would
  // silently discard whichever round didn't win the tie-break. This function
  // must keep both, each bound to its own reviewed sha.
  test("keeps two rounds with the same finding count but different findings as separate entries", () => {
    const round1Bullets = [
      "- `src/notify.ts:42` — group-send falls back to per-recipient sends silently on partial failure (behavior).",
      "- `docs/reference/notes.md:10` — the Notes count in the docs disagrees with the implementation (accuracy).",
    ];
    const round1 = [
      "### Should-fix",
      "",
      ...round1Bullets,
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: 1111aaa -->",
    ].join("\n");
    const round2Bullets = [
      "- `src/spawn-win32.ts:88` — spawning with `detached: true` on win32 carries an extra process-group cost not called out (performance).",
      "- `src/parse.ts:120` — this `catch` block has no test coverage (testing).",
    ];
    const round2 = [
      "### Should-fix",
      "",
      ...round2Bullets,
      "",
      "### Verdict",
      "",
      "- PASS",
      "",
      "<!-- claude-review-sha: 2222bbb -->",
    ].join("\n");
    const result = collectShouldFixRounds([round1, round2]);
    expect(result).toEqual([
      { round: 1, sha: "1111aaa", count: 2, section: round1Bullets.join("\n") },
      { round: 2, sha: "2222bbb", count: 2, section: round2Bullets.join("\n") },
    ]);
  });

  test("a non-verdict reply interleaved between two real rounds does not consume a round ordinal", () => {
    const round1 = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — consider extracting this branch (clarity).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
    ].join("\n");
    const reply = "Thanks for the ping! Happy to help.";
    const round2 = [
      "### Should-fix",
      "",
      "- `src/bar.ts:5` — missing a doc comment (documentation).",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    const result = collectShouldFixRounds([round1, reply, round2]);
    expect(result).toHaveLength(2);
    expect(result[1]?.round).toBe(2);
  });

  test("a body with Should-fix bullets but no claude-review-sha marker gets sha: null, not dropped", () => {
    const body = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — consider extracting this branch (clarity).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
    ].join("\n");
    expect(collectShouldFixRounds([body])).toEqual([
      {
        round: 1,
        sha: null,
        count: 1,
        section:
          "- `src/foo.ts:10` — consider extracting this branch (clarity).",
      },
    ]);
  });

  test("two bodies sharing the same claude-review-sha marker (an edited/re-posted comment) collapse to one entry, keeping the larger count", () => {
    const bodyA = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — consider extracting this branch (clarity).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: cafe1234 -->",
    ].join("\n");
    const bodyBBullets = [
      "- `src/foo.ts:10` — consider extracting this branch (clarity).",
      "- `src/bar.ts:5` — missing a doc comment (documentation).",
      "- `src/baz.ts:1` — rename for clarity (readability).",
    ];
    const bodyB = [
      "### Should-fix",
      "",
      ...bodyBBullets,
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: cafe1234 -->",
    ].join("\n");
    const result = collectShouldFixRounds([bodyA, bodyB]);
    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(3);
    expect(result[0]?.sha).toBe("cafe1234");
  });

  // Regression for the dedup fix: a later duplicate for the same sha can win
  // on count, but must NOT overwrite the kept entry's `round` — the ordinal
  // must stay the FIRST-seen one, matching the entry's fixed array position,
  // or a failure message could read "Round 2" for the array's first entry.
  test("a later duplicate that wins on count keeps the FIRST-seen round ordinal, not its own", () => {
    const round1 = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — consider extracting this branch (clarity).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: cafe1234 -->",
    ].join("\n");
    const round2Bullets = [
      "- `src/foo.ts:10` — consider extracting this branch (clarity).",
      "- `src/bar.ts:5` — missing a doc comment (documentation).",
      "- `src/baz.ts:1` — rename for clarity (readability).",
    ];
    const round2 = [
      "### Should-fix",
      "",
      ...round2Bullets,
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: cafe1234 -->",
    ].join("\n");
    const round3 = [
      "### Should-fix",
      "",
      "- `src/qux.ts:1` — extract this constant (clarity).",
      "",
      "### Verdict",
      "",
      "- PASS",
      "",
      "<!-- claude-review-sha: beef5678 -->",
    ].join("\n");
    const result = collectShouldFixRounds([round1, round2, round3]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      round: 1,
      sha: "cafe1234",
      count: 3,
      section: round2Bullets.join("\n"),
    });
    expect(result[1]).toEqual({
      round: 3,
      sha: "beef5678",
      count: 1,
      section: "- `src/qux.ts:1` — extract this constant (clarity).",
    });
  });

  test("returns an empty array for an empty input array", () => {
    expect(collectShouldFixRounds([])).toEqual([]);
  });

  test("returns an empty array when every body is a non-verdict reply or has zero findings", () => {
    const reply = "Thanks for the ping! Happy to help.";
    const suppressed = [
      "### Should-fix",
      "",
      "_None._",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    expect(collectShouldFixRounds([reply, suppressed])).toEqual([]);
  });
});

describe("planShouldFixAckRanges", () => {
  test("a usable sha not equal to head produces an unscoped, non-empty range", () => {
    const round = { round: 1, sha: "sha1", count: 2, section: "- a finding" };
    const result = planShouldFixAckRanges([round], {
      base: "base1",
      head: "head1",
      shaStatus: { sha1: "usable" },
    });
    expect(result).toEqual([
      {
        round,
        from: "sha1",
        to: "head1",
        degraded: false,
        degradeReason: null,
        empty: false,
      },
    ]);
  });

  test("a usable sha equal to head produces an empty range — the round that just posted its own finding", () => {
    const round = { round: 1, sha: "sha1", count: 2, section: "- a finding" };
    const result = planShouldFixAckRanges([round], {
      base: "base1",
      head: "sha1",
      shaStatus: { sha1: "usable" },
    });
    expect(result).toEqual([
      {
        round,
        from: "sha1",
        to: "sha1",
        degraded: false,
        degradeReason: null,
        empty: true,
      },
    ]);
  });

  test("an unreachable sha degrades to the full base..head range with a reason naming the round and sha", () => {
    const round = { round: 1, sha: "sha1", count: 2, section: "- a finding" };
    const result = planShouldFixAckRanges([round], {
      base: "base1",
      head: "head1",
      shaStatus: { sha1: "unreachable" },
    });
    expect(result).toHaveLength(1);
    const plan = result[0];
    expect(plan?.from).toBe("base1");
    expect(plan?.to).toBe("head1");
    expect(plan?.degraded).toBe(true);
    expect(plan?.empty).toBe(false);
    expect(plan?.degradeReason).not.toBeNull();
    expect(plan?.degradeReason).toContain("round 1");
    expect(plan?.degradeReason).toContain("sha1");
  });

  test("a missing sha degrades the same shape as unreachable, but with a distinct reason wording", () => {
    const round = { round: 1, sha: "sha1", count: 2, section: "- a finding" };
    const unreachable = planShouldFixAckRanges([round], {
      base: "base1",
      head: "head1",
      shaStatus: { sha1: "unreachable" },
    })[0];
    const missing = planShouldFixAckRanges([round], {
      base: "base1",
      head: "head1",
      shaStatus: { sha1: "missing" },
    })[0];
    expect(missing?.from).toBe("base1");
    expect(missing?.to).toBe("head1");
    expect(missing?.degraded).toBe(true);
    expect(missing?.degradeReason).not.toBeNull();
    expect(missing?.degradeReason).not.toBe(unreachable?.degradeReason);
  });

  test("a null sha degrades to base..head with a reason mentioning the missing marker", () => {
    const round = { round: 1, sha: null, count: 1, section: "- a finding" };
    const result = planShouldFixAckRanges([round], {
      base: "base1",
      head: "head1",
      shaStatus: {},
    });
    const plan = result[0];
    expect(plan?.from).toBe("base1");
    expect(plan?.to).toBe("head1");
    expect(plan?.degraded).toBe(true);
    expect(plan?.degradeReason).toContain("no claude-review-sha marker");
  });

  test("plans two rounds independently, preserving input order (one usable, one degraded)", () => {
    const roundUsable = { round: 1, sha: "shaU", count: 1, section: "- a" };
    const roundDegraded = { round: 2, sha: "shaD", count: 1, section: "- b" };
    const result = planShouldFixAckRanges([roundUsable, roundDegraded], {
      base: "base1",
      head: "head1",
      shaStatus: { shaU: "usable", shaD: "missing" },
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.round).toBe(roundUsable);
    expect(result[0]?.degraded).toBe(false);
    expect(result[0]?.from).toBe("shaU");
    expect(result[1]?.round).toBe(roundDegraded);
    expect(result[1]?.degraded).toBe(true);
    expect(result[1]?.from).toBe("base1");
  });
});

describe("describeShouldFixAckOutcome", () => {
  test("every evaluation acknowledged produces ok: true with no unacknowledged entries or messages", () => {
    const round = { round: 1, sha: "sha1", count: 2, section: "- a finding" };
    const evaluation = {
      round,
      from: "sha1",
      to: "head1",
      degraded: false,
      degradeReason: null,
      empty: false,
      acknowledged: true,
    };
    const result = describeShouldFixAckOutcome([evaluation]);
    expect(result.ok).toBe(true);
    expect(result.unacknowledged).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.summary.length).toBeGreaterThan(0);
  });

  test("an unacknowledged, non-empty-range evaluation produces one message naming the round, sha, range, and section text", () => {
    const round = {
      round: 1,
      sha: "sha1",
      count: 2,
      section: "- `src/foo.ts:10` — a real finding (rule).",
    };
    const evaluation = {
      round,
      from: "sha1",
      to: "head1",
      degraded: false,
      degradeReason: null,
      empty: false,
      acknowledged: false,
    };
    const result = describeShouldFixAckOutcome([evaluation]);
    expect(result.ok).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toContain("Round 1");
    expect(result.messages[0]).toContain("sha1");
    expect(result.messages[0]).toContain("sha1..head1");
    expect(result.messages[0]).toContain(round.section);
  });

  test("an unacknowledged, empty-range evaluation gets a distinct message conveying no commit exists yet", () => {
    const round = {
      round: 1,
      sha: "sha1",
      count: 2,
      section: "- `src/foo.ts:10` — a real finding (rule).",
    };
    const nonEmptyEvaluation = {
      round,
      from: "sha1",
      to: "head1",
      degraded: false,
      degradeReason: null,
      empty: false,
      acknowledged: false,
    };
    const emptyEvaluation = {
      round,
      from: "sha1",
      to: "sha1",
      degraded: false,
      degradeReason: null,
      empty: true,
      acknowledged: false,
    };
    const nonEmptyMessage = describeShouldFixAckOutcome([nonEmptyEvaluation])
      .messages[0];
    const emptyMessage = describeShouldFixAckOutcome([emptyEvaluation])
      .messages[0];
    expect(emptyMessage).not.toBe(nonEmptyMessage);
    expect(emptyMessage).toContain("no commit exists");
  });

  test("a degraded but acknowledged evaluation appears in degraded, not in unacknowledged, and keeps ok true", () => {
    const round = { round: 1, sha: "sha1", count: 1, section: "- a finding" };
    const evaluation = {
      round,
      from: "base1",
      to: "head1",
      degraded: true,
      degradeReason:
        "round 1's reviewed commit sha1 is not present in this checkout",
      empty: false,
      acknowledged: true,
    };
    const result = describeShouldFixAckOutcome([evaluation]);
    expect(result.degraded).toEqual([evaluation]);
    expect(result.unacknowledged).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("an empty input array reads as nothing to acknowledge", () => {
    const result = describeShouldFixAckOutcome([]);
    expect(result).toEqual({
      ok: true,
      unacknowledged: [],
      degraded: [],
      messages: [],
      summary: result.summary,
    });
    expect(result.summary).toContain("nothing to acknowledge");
  });

  test("a mix of one acknowledged and one unacknowledged evaluation reports only the unacknowledged one", () => {
    const roundA = { round: 1, sha: "sha1", count: 1, section: "- a finding" };
    const roundB = { round: 2, sha: "sha2", count: 1, section: "- b finding" };
    const acknowledgedEvaluation = {
      round: roundA,
      from: "sha1",
      to: "head1",
      degraded: false,
      degradeReason: null,
      empty: false,
      acknowledged: true,
    };
    const unacknowledgedEvaluation = {
      round: roundB,
      from: "sha2",
      to: "head1",
      degraded: false,
      degradeReason: null,
      empty: false,
      acknowledged: false,
    };
    const result = describeShouldFixAckOutcome([
      acknowledgedEvaluation,
      unacknowledgedEvaluation,
    ]);
    expect(result.unacknowledged).toEqual([unacknowledgedEvaluation]);
    expect(result.messages).toHaveLength(1);
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
