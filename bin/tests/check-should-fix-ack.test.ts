import { describe, expect, test } from "vitest";
import { evaluateShouldFixAck, parseArgs } from "../check-should-fix-ack.mjs";

describe("parseArgs", () => {
  test("reads --repo, --pr, --base, and --head", () => {
    expect(
      parseArgs([
        "--repo",
        "owner/repo",
        "--pr",
        "42",
        "--base",
        "abc",
        "--head",
        "def",
      ]),
    ).toEqual({
      repo: "owner/repo",
      pr: "42",
      base: "abc",
      head: "def",
    });
  });

  test("reads all four flags regardless of order", () => {
    expect(
      parseArgs([
        "--head",
        "def",
        "--base",
        "abc",
        "--pr",
        "42",
        "--repo",
        "owner/repo",
      ]),
    ).toEqual({
      repo: "owner/repo",
      pr: "42",
      base: "abc",
      head: "def",
    });
  });

  test("missing flags are undefined", () => {
    expect(parseArgs([])).toEqual({
      repo: undefined,
      pr: undefined,
      base: undefined,
      head: undefined,
    });
  });

  test("partial flags leave the rest undefined", () => {
    expect(parseArgs(["--repo", "owner/repo", "--pr", "42"])).toEqual({
      repo: "owner/repo",
      pr: "42",
      base: undefined,
      head: undefined,
    });
  });
});

describe("evaluateShouldFixAck", () => {
  test("no Should-fix findings at all short-circuits before ever calling readCommitLog", () => {
    const body = [
      "### Should-fix",
      "",
      "_None._",
      "",
      "### Verdict",
      "",
      "- PASS",
    ].join("\n");
    let calls = 0;
    const readCommitLog = (from: string, to: string) => {
      calls += 1;
      return `${from}..${to}`;
    };
    const result = evaluateShouldFixAck({
      bodies: [body],
      base: "base1",
      head: "head1",
      classifySha: () => "usable",
      readCommitLog,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(0);
  });

  test("no Should-fix findings from an entirely empty bodies array also short-circuits", () => {
    let calls = 0;
    const result = evaluateShouldFixAck({
      bodies: [],
      base: "base1",
      head: "head1",
      classifySha: () => "usable",
      readCommitLog: () => {
        calls += 1;
        return "";
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(0);
  });

  test("one round with a footer present in its own reviewed-sha..head range passes", () => {
    const body = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — a real finding (rule).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: 1111abc -->",
    ].join("\n");
    const result = evaluateShouldFixAck({
      bodies: [body],
      base: "base1",
      head: "head1",
      classifySha: () => "usable",
      readCommitLog: (from, to) =>
        from === "1111abc" && to === "head1"
          ? "fix: address feedback\n\nAcknowledged-Should-Fix: fixed"
          : "",
    });
    expect(result.ok).toBe(true);
  });

  // THE CORE REGRESSION FIXTURE (issue #1193 / PR #1190): round 1 raised a
  // group-send fallback bug and a Notes-count dispute, answered by a footer.
  // Round 2 raised two DIFFERENT, unrelated findings (a win32 `detached`
  // cost and an untested `catch`) against a LATER reviewed commit that has
  // no footer of its own yet. Before the per-round-binding fix, a single
  // whole-PR base..head presence check would see round 1's footer anywhere
  // in the range and vacuously pass round 2's unrelated findings too.
  test("round 2's unrelated findings are not satisfied by round 1's already-acknowledged footer", () => {
    const round1 = [
      "### Should-fix",
      "",
      "- `src/notify.ts:42` — group-send falls back to per-recipient sends silently on partial failure (behavior).",
      "- `docs/reference/notes.md:10` — the Notes count in the docs disagrees with the implementation (accuracy).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: 1111aaa -->",
    ].join("\n");
    const round2 = [
      "### Should-fix",
      "",
      "- `src/spawn-win32.ts:88` — spawning with `detached: true` on win32 carries an extra process-group cost not called out (performance).",
      "- `src/parse.ts:120` — this `catch` block has no test coverage (testing).",
      "",
      "### Verdict",
      "",
      "- PASS",
      "",
      "<!-- claude-review-sha: 2222bbb -->",
    ].join("\n");
    const result = evaluateShouldFixAck({
      bodies: [round1, round2],
      base: "base1",
      // A third, later commit — simulating a push on top of round 2's
      // reviewed commit that does not itself carry an acknowledgment.
      head: "head3",
      classifySha: () => "usable",
      readCommitLog: (from, to) => {
        if (from === "1111aaa" && to === "head3") {
          return "fix: address round 1\n\nAcknowledged-Should-Fix: fixed";
        }
        if (from === "2222bbb" && to === "head3") {
          return "chore: unrelated commit";
        }
        return "";
      },
    });
    expect(result.ok).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toContain("Round 2");
    expect(result.messages[0]).toContain("2 Should-fix finding(s)");
    expect(result.messages[0]).not.toContain("group-send");
    expect(result.messages[0]).not.toContain("Notes count");
  });

  test("a round whose reviewed sha equals head has an empty range and fails without ever calling readCommitLog", () => {
    const body = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — a real finding (rule).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: cafe123 -->",
    ].join("\n");
    let calls = 0;
    const result = evaluateShouldFixAck({
      bodies: [body],
      base: "base1",
      head: "cafe123",
      classifySha: () => "usable",
      readCommitLog: () => {
        calls += 1;
        return "";
      },
    });
    expect(result.ok).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toContain("no commit exists");
    expect(calls).toBe(0);
  });

  test("a degraded round (unreachable sha) whose base..head range carries the footer still passes, with a warning", () => {
    const body = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — a real finding (rule).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: facade1 -->",
    ].join("\n");
    const result = evaluateShouldFixAck({
      bodies: [body],
      base: "base1",
      head: "head1",
      classifySha: () => "unreachable",
      readCommitLog: (from, to) =>
        from === "base1" && to === "head1"
          ? "fix: address feedback\n\nAcknowledged-Should-Fix: fixed"
          : "",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("round 1");
    expect(result.warnings[0]).toContain("not an ancestor");
  });

  test("a degraded round with no footer in the fallback range still fails, and still carries a warning", () => {
    const body = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — a real finding (rule).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: facade1 -->",
    ].join("\n");
    const result = evaluateShouldFixAck({
      bodies: [body],
      base: "base1",
      head: "head1",
      classifySha: () => "unreachable",
      readCommitLog: () => "chore: unrelated commit",
    });
    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.messages).toHaveLength(1);
  });

  test("a round with no claude-review-sha marker never calls classifySha (only non-null shas do)", () => {
    const body = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — a real finding (rule).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
    ].join("\n");
    let shaCalls = 0;
    const result = evaluateShouldFixAck({
      bodies: [body],
      base: "base1",
      head: "head1",
      classifySha: () => {
        shaCalls += 1;
        return "usable";
      },
      readCommitLog: () => "",
    });
    expect(shaCalls).toBe(0);
    expect(result.ok).toBe(false);
  });

  test("two rounds sharing the same reviewed sha classify it exactly once", () => {
    const bodyA = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — a real finding (rule).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: beef1234 -->",
    ].join("\n");
    const bodyB = [
      "### Should-fix",
      "",
      "- `src/foo.ts:10` — a real finding (rule).",
      "- `src/bar.ts:5` — another real finding (rule).",
      "",
      "### Verdict",
      "",
      "- FAIL — a Must-fix remains.",
      "",
      "<!-- claude-review-sha: beef1234 -->",
    ].join("\n");
    let shaCalls = 0;
    evaluateShouldFixAck({
      bodies: [bodyA, bodyB],
      base: "base1",
      head: "head1",
      classifySha: () => {
        shaCalls += 1;
        return "usable";
      },
      readCommitLog: () => "",
    });
    expect(shaCalls).toBe(1);
  });
});
