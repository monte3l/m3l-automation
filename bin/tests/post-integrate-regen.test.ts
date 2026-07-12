import { describe, expect, test } from "vitest";
import {
  regenerationCommands,
  runRegeneration,
  dirtyFiles,
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
