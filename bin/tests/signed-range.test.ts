import { describe, expect, test } from "vitest";
import {
  parseGitPush,
  outgoingCommits,
  unsignedCommits,
  commitSignatureCode,
  VALID_SIGNATURE_CODES,
} from "../lib/signed-range.mjs";

describe("parseGitPush", () => {
  test("recognises a plain push", () => {
    expect(parseGitPush("git push")).toEqual({ isPush: true, dryRun: false });
  });

  test("recognises push with remote and flags", () => {
    expect(parseGitPush("git push -u origin HEAD")).toEqual({
      isPush: true,
      dryRun: false,
    });
  });

  test("skips git global options before the subcommand", () => {
    expect(parseGitPush("git -c user.name=x push origin main")).toEqual({
      isPush: true,
      dryRun: false,
    });
  });

  test("flags a dry run so it is not blocked", () => {
    expect(parseGitPush("git push --dry-run")).toEqual({
      isPush: true,
      dryRun: true,
    });
    expect(parseGitPush("git push -n origin main").dryRun).toBe(true);
  });

  test("finds the push in a chained command", () => {
    expect(parseGitPush("pnpm build && git push origin feat/x").isPush).toBe(
      true,
    );
  });

  test("does not treat other git subcommands as a push", () => {
    expect(parseGitPush("git commit -m 'push it'")).toEqual({
      isPush: false,
      dryRun: false,
    });
    expect(parseGitPush("git status")).toEqual({
      isPush: false,
      dryRun: false,
    });
  });

  test("ignores non-string input", () => {
    // @ts-expect-error exercising the runtime guard
    expect(parseGitPush(undefined)).toEqual({ isPush: false, dryRun: false });
  });
});

describe("outgoingCommits", () => {
  test("uses the first base that resolves", () => {
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      if (args[1] === "@{upstream}..HEAD") throw new Error("no upstream");
      if (args[1] === "origin/main..HEAD") return "sha1\nsha2\n";
      throw new Error("unexpected");
    };
    expect(outgoingCommits(runGit)).toEqual(["sha1", "sha2"]);
    // it tried upstream first, then fell back to origin/main
    expect(calls[0]?.[1]).toBe("@{upstream}..HEAD");
    expect(calls[1]?.[1]).toBe("origin/main..HEAD");
  });

  test("falls back to HEAD when no base resolves", () => {
    const runGit = (args: string[]) => {
      if (args[0] === "rev-parse") return "headsha\n";
      throw new Error("no base");
    };
    expect(outgoingCommits(runGit)).toEqual(["headsha"]);
  });

  test("returns empty when even HEAD cannot be read", () => {
    const runGit = () => {
      throw new Error("no repo");
    };
    expect(outgoingCommits(runGit)).toEqual([]);
  });
});

describe("commitSignatureCode / unsignedCommits", () => {
  const codes: Record<string, string> = {
    good: "G",
    unknownKey: "U",
    none: "N",
    bad: "B",
  };
  const runGit = (args: string[]) => {
    const sha = args[args.length - 1] ?? "";
    return `${codes[sha] ?? "N"}\n`;
  };

  test("reads a trimmed %G? code", () => {
    expect(commitSignatureCode("good", runGit)).toBe("G");
  });

  test("accepts G and U, rejects everything else", () => {
    expect([...VALID_SIGNATURE_CODES]).toEqual(["G", "U"]);
    const bad = unsignedCommits(["good", "unknownKey", "none", "bad"], runGit);
    expect(bad.map((b) => b.sha)).toEqual(["none", "bad"]);
    expect(bad.map((b) => b.code)).toEqual(["N", "B"]);
  });

  test("treats an unreadable commit as unverified (code E)", () => {
    const throwing = () => {
      throw new Error("bad object");
    };
    expect(unsignedCommits(["x"], throwing)).toEqual([{ sha: "x", code: "E" }]);
  });

  test("a fully signed range yields no offenders", () => {
    expect(unsignedCommits(["good", "unknownKey"], runGit)).toEqual([]);
  });
});
