import { describe, expect, test } from "vitest";
import {
  regenerationCommands,
  runRegeneration,
  dirtyFiles,
  isLockfileDirty,
  isOnMainBranch,
} from "../post-integrate-regen.mjs";

describe("regenerationCommands", () => {
  test("runs gen-reference-index, gen-doc-counts, then check-doc-provenance --update, in order", () => {
    const commands = regenerationCommands();
    expect(commands).toEqual([
      ["node", ["bin/gen-reference-index.mjs"]],
      ["node", ["bin/gen-doc-counts.mjs"]],
      ["node", ["bin/check-doc-provenance.mjs", "--update"]],
    ]);
  });

  test("appends pnpm install only when the lockfile is dirty", () => {
    const commands = regenerationCommands(true);
    expect(commands).toHaveLength(4);
    expect(commands[3]).toEqual(["pnpm", ["install"]]);
  });

  test("defaults to not dirty (no pnpm install)", () => {
    expect(regenerationCommands(false)).toHaveLength(3);
  });

  test("appends gen-commit-stats only when on main", () => {
    const commands = regenerationCommands(false, true);
    expect(commands).toHaveLength(4);
    expect(commands[3]).toEqual(["node", ["bin/gen-commit-stats.mjs"]]);
  });

  test("defaults to off-main (no gen-commit-stats)", () => {
    expect(regenerationCommands(false, false)).toHaveLength(3);
  });

  test("orders gen-commit-stats before the conditional pnpm install", () => {
    const commands = regenerationCommands(true, true);
    expect(commands).toHaveLength(5);
    expect(commands[3]).toEqual(["node", ["bin/gen-commit-stats.mjs"]]);
    expect(commands[4]).toEqual(["pnpm", ["install"]]);
  });
});

describe("runRegeneration", () => {
  test("runs all three commands when each succeeds", () => {
    const calls: [string, string[]][] = [];
    const runCmd = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
    };

    const warnings = runRegeneration(runCmd);

    expect(warnings).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  test("never throws — a failing command becomes a warning, and the rest still run", () => {
    const calls: [string, string[]][] = [];
    const runCmd = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      if (args[0] === "bin/gen-doc-counts.mjs") {
        throw new Error("stale sidecar");
      }
    };

    let warnings: string[] = [];
    expect(() => {
      warnings = runRegeneration(runCmd);
    }).not.toThrow();

    // all three still attempted despite the middle one failing
    expect(calls).toHaveLength(3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /bin\/gen-doc-counts\.mjs failed: stale sidecar/,
    );
  });

  test("collects one warning per failing command", () => {
    const runCmd = () => {
      throw new Error("boom");
    };

    const warnings = runRegeneration(runCmd);

    expect(warnings).toHaveLength(3);
  });

  test("threads lockfileDirty through to run pnpm install as the fourth command", () => {
    const calls: [string, string[]][] = [];
    const runCmd = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
    };

    const warnings = runRegeneration(runCmd, true);

    expect(warnings).toEqual([]);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual(["pnpm", ["install"]]);
  });

  test("threads onMain through to run gen-commit-stats as the fourth command", () => {
    const calls: [string, string[]][] = [];
    const runCmd = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
    };

    const warnings = runRegeneration(runCmd, false, true);

    expect(warnings).toEqual([]);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual(["node", ["bin/gen-commit-stats.mjs"]]);
  });
});

describe("dirtyFiles", () => {
  test("parses porcelain status lines into repo-relative paths", () => {
    const runGit = () =>
      " M docs/reference/catalog.json\n?? docs/reference/symbol-map.json\nA  docs/implementation-status.md\n";

    expect(dirtyFiles(runGit)).toEqual([
      "docs/reference/catalog.json",
      "docs/reference/symbol-map.json",
      "docs/implementation-status.md",
    ]);
  });

  test("returns an empty array on a clean tree", () => {
    const runGit = () => "";
    expect(dirtyFiles(runGit)).toEqual([]);
  });
});

describe("isLockfileDirty", () => {
  test("true when pnpm-lock.yaml has a porcelain status line", () => {
    const runGit = (args: string[]) => {
      expect(args).toEqual(["status", "--porcelain", "--", "pnpm-lock.yaml"]);
      return " M pnpm-lock.yaml\n";
    };
    expect(isLockfileDirty(runGit)).toBe(true);
  });

  test("false when scoped status output is empty", () => {
    const runGit = () => "";
    expect(isLockfileDirty(runGit)).toBe(false);
  });

  test("false when scoped status output is only whitespace", () => {
    const runGit = () => "\n";
    expect(isLockfileDirty(runGit)).toBe(false);
  });
});

describe("isOnMainBranch", () => {
  test("true when HEAD's branch is main", () => {
    const runGit = (args: string[]) => {
      expect(args).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
      return "main\n";
    };
    expect(isOnMainBranch(runGit)).toBe(true);
  });

  test("false on a feature branch", () => {
    const runGit = () => "feat/automate-commit-stats-badges\n";
    expect(isOnMainBranch(runGit)).toBe(false);
  });

  test("false on a detached HEAD", () => {
    const runGit = () => "HEAD\n";
    expect(isOnMainBranch(runGit)).toBe(false);
  });
});
