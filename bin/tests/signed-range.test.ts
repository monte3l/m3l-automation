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
  test("excludes only the two remote refs when both resolve, never probing local main", () => {
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        // Both remote refs resolve; `main` would also resolve here if it
        // were ever probed, so a false pass on "not called" is ruled out.
        return "deadbeef\n";
      }
      if (args[0] === "rev-list") return "sha1\nsha2\n";
      throw new Error(`unexpected call: ${args.join(" ")}`);
    };

    expect(outgoingCommits(runGit)).toEqual(["sha1", "sha2"]);

    // `main` must never be probed once a remote ref already resolved — the
    // old (buggy) behavior unioned it in regardless, which is the exact
    // regression this fix targets.
    const mainProbe = calls.find(
      (args) =>
        args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "main",
    );
    expect(mainProbe).toBeUndefined();

    const revListCall = calls.find((args) => args[0] === "rev-list");
    expect(revListCall).toBeDefined();
    const notIndex = revListCall?.indexOf("--not") ?? -1;
    expect(notIndex).toBeGreaterThan(-1);
    expect(revListCall?.slice(notIndex + 1)).toEqual([
      "@{upstream}",
      "origin/main",
    ]);
  });

  test("does not exclude local main when a remote ref already resolves, even if main equals HEAD", () => {
    // Regression: on branch `main` with unpushed local commits, `@{upstream}`
    // and `origin/main` both resolve to the same old published tip, while
    // local `main` IS `HEAD`. If `main` were unioned into the exclude set
    // regardless, `--not main` would erase every outgoing commit and the
    // signature guard would silently vet nothing.
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        if (args[3] === "@{upstream}" || args[3] === "origin/main") {
          return "oldtip\n";
        }
        throw new Error("unexpected probe");
      }
      if (args[0] === "rev-list") return "sha1\nsha2\n";
      throw new Error(`unexpected call: ${args.join(" ")}`);
    };

    expect(outgoingCommits(runGit)).toEqual(["sha1", "sha2"]);

    const revListCall = calls.find((args) => args[0] === "rev-list");
    expect(revListCall).toBeDefined();
    expect(revListCall).not.toContain("main");
  });

  test("falls back to local main as a last resort when neither remote ref resolves", () => {
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        if (args[3] === "main") return "localtip\n";
        throw new Error("no remote ref");
      }
      if (args[0] === "rev-list") return "sha4\n";
      throw new Error(`unexpected call: ${args.join(" ")}`);
    };

    expect(outgoingCommits(runGit)).toEqual(["sha4"]);

    const revListCall = calls.find((args) => args[0] === "rev-list");
    expect(revListCall).toBeDefined();
    const notIndex = revListCall?.indexOf("--not") ?? -1;
    expect(notIndex).toBeGreaterThan(-1);
    expect(revListCall?.slice(notIndex + 1)).toEqual(["main"]);
  });

  test("excludes only the bases that actually resolve", () => {
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        if (args[3] === "@{upstream}") throw new Error("no upstream");
        return "deadbeef\n";
      }
      if (args[0] === "rev-list") return "sha3\n";
      throw new Error(`unexpected call: ${args.join(" ")}`);
    };

    expect(outgoingCommits(runGit)).toEqual(["sha3"]);

    const revListCall = calls.find((args) => args[0] === "rev-list");
    expect(revListCall).toBeDefined();
    const notIndex = revListCall?.indexOf("--not") ?? -1;
    expect(revListCall?.slice(notIndex + 1)).toEqual(["origin/main"]);
    expect(revListCall).not.toContain("@{upstream}");

    // `origin/main` already resolved, so `main` must not be probed at all.
    const mainProbe = calls.find(
      (args) =>
        args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "main",
    );
    expect(mainProbe).toBeUndefined();
  });

  test("falls back to HEAD when no base resolves", () => {
    const runGit = (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        throw new Error("no base");
      }
      if (args[0] === "rev-parse") return "headsha\n";
      throw new Error(`unexpected call: ${args.join(" ")}`);
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
