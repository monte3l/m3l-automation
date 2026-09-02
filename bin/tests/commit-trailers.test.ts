import { describe, expect, test } from "vitest";
import { commitsWithForbiddenTrailers } from "../lib/commit-trailers.mjs";

describe("commitsWithForbiddenTrailers", () => {
  test("returns no offenders when no commit body contains a forbidden trailer", () => {
    const bodies: Record<string, string> = {
      sha1: "fix: do the thing\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n",
      sha2: "chore: bump deps\n",
    };
    const runGit = (args: string[]) => {
      const sha = args[args.length - 1] ?? "";
      return bodies[sha] ?? "";
    };

    expect(commitsWithForbiddenTrailers(["sha1", "sha2"], runGit)).toEqual([]);
  });

  test("flags a commit whose body ends with a forbidden Claude-Session trailer, excluding Co-Authored-By", () => {
    const body =
      "feat: add widget\n\n" +
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n" +
      "Claude-Session: https://claude.ai/code/session_01ABC";
    const runGit = (args: string[]) => {
      const sha = args[args.length - 1] ?? "";
      return sha === "sha1" ? body : "";
    };

    const result = commitsWithForbiddenTrailers(["sha1"], runGit);

    expect(result).toEqual([
      {
        sha: "sha1",
        lines: ["Claude-Session: https://claude.ai/code/session_01ABC"],
      },
    ]);
    const [offender] = result;
    expect(offender?.lines).not.toContain(
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
    );
  });

  test("collects every occurrence of a forbidden trailer in a squash-merge body", () => {
    const body = [
      "chore: squash merge",
      "",
      "Claude-Session: https://claude.ai/code/session_01AAA",
      "some other line",
      "Claude-Session: https://claude.ai/code/session_01BBB",
      "Claude-Session: https://claude.ai/code/session_01CCC",
    ].join("\n");
    const runGit = () => body;

    const result = commitsWithForbiddenTrailers(["shaSquash"], runGit);

    expect(result).toHaveLength(1);
    expect(result[0]?.lines).toHaveLength(3);
  });

  test("returns only the offending commits, in the same relative order as the input shas", () => {
    const bodies: Record<string, string> = {
      shaClean1: "docs: update readme\n",
      shaBad: "feat: x\n\nClaude-Session: https://claude.ai/code/session_01XYZ",
      shaClean2: "test: add coverage\n",
    };
    const runGit = (args: string[]) => {
      const sha = args[args.length - 1] ?? "";
      return bodies[sha] ?? "";
    };

    const result = commitsWithForbiddenTrailers(
      ["shaClean1", "shaBad", "shaClean2"],
      runGit,
    );

    expect(result.map((offender) => offender.sha)).toEqual(["shaBad"]);
    expect(result).toEqual([
      {
        sha: "shaBad",
        lines: ["Claude-Session: https://claude.ai/code/session_01XYZ"],
      },
    ]);
  });

  test("returns an empty array without calling runGit when shas is empty", () => {
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      return "";
    };

    expect(commitsWithForbiddenTrailers([], runGit)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("calls runGit with the exact show --no-patch --format=%B args for a given sha", () => {
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      return "";
    };

    commitsWithForbiddenTrailers(["deadbeef"], runGit);

    expect(calls).toEqual([["show", "--no-patch", "--format=%B", "deadbeef"]]);
  });
});
