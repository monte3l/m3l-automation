import { describe, expect, test, vi } from "vitest";
import {
  CHANGE_CATEGORIES,
  allChanged,
  classifyChangedPaths,
  resolveChangedPaths,
} from "../lib/changed-paths.mjs";

describe("CHANGE_CATEGORIES", () => {
  test("names exactly the 8 documented categories", () => {
    expect(CHANGE_CATEGORIES).toEqual([
      "ts",
      "deps",
      "scripts",
      "claude",
      "workflows",
      "docs",
      "md",
      "console",
    ]);
  });
});

describe("classifyChangedPaths", () => {
  test("sets ts true for a source TypeScript file", () => {
    const flags = classifyChangedPaths([
      "packages/m3l-common/src/core/errors/index.ts",
    ]);
    expect(flags.ts).toBe(true);
  });

  test("sets console true for a path under packages/m3l-console-web/", () => {
    const flags = classifyChangedPaths([
      "packages/m3l-console-web/src/App.tsx",
    ]);
    expect(flags.console).toBe(true);
  });

  test("sets console true for a path under packages/m3l-console-server/", () => {
    const flags = classifyChangedPaths([
      "packages/m3l-console-server/src/main.ts",
    ]);
    expect(flags.console).toBe(true);
  });

  test("sets console false for a path under an unrelated package", () => {
    const flags = classifyChangedPaths(["packages/m3l-common/src/index.ts"]);
    expect(flags.console).toBe(false);
  });

  test("sets ts true for a .tsx file", () => {
    const flags = classifyChangedPaths([
      "packages/m3l-console-web/src/App.tsx",
    ]);
    expect(flags.ts).toBe(true);
  });

  test("sets deps true for the root package.json", () => {
    const flags = classifyChangedPaths(["package.json"]);
    expect(flags.deps).toBe(true);
  });

  test("sets scripts true for a path under scripts/", () => {
    const flags = classifyChangedPaths([
      "scripts/s3-objects/src/steps/list-objects.ts",
    ]);
    expect(flags.scripts).toBe(true);
  });

  test("sets claude true for a path under .claude/", () => {
    const flags = classifyChangedPaths([".claude/rules/tests.md"]);
    expect(flags.claude).toBe(true);
  });

  test("sets workflows true for a path under .github/workflows/", () => {
    const flags = classifyChangedPaths([".github/workflows/ci.yml"]);
    expect(flags.workflows).toBe(true);
  });

  test("sets docs true for a path under docs/", () => {
    const flags = classifyChangedPaths(["docs/adr/0001-example.md"]);
    expect(flags.docs).toBe(true);
  });

  test("sets md true for any markdown file", () => {
    const flags = classifyChangedPaths(["packages/m3l-common/CHANGELOG.md"]);
    expect(flags.md).toBe(true);
  });

  test("sets ts true for the committed exports-map snapshot", () => {
    const flags = classifyChangedPaths([
      "packages/m3l-common/api-exports.json",
    ]);
    expect(flags.ts).toBe(true);
  });

  test("sets ts true for knip.json", () => {
    const flags = classifyChangedPaths(["knip.json"]);
    expect(flags.ts).toBe(true);
  });

  test("sets ts true for .jscpd.json", () => {
    const flags = classifyChangedPaths([".jscpd.json"]);
    expect(flags.ts).toBe(true);
  });

  test("sets md true for .markdownlint.json", () => {
    const flags = classifyChangedPaths([".markdownlint.json"]);
    expect(flags.md).toBe(true);
  });

  test("a path matching no predicate forces every category true (fail-open)", () => {
    // .gitignore matches none of the 8 predicates individually (not .ts,
    // not scripts/, not .claude/, not a listed workflows exact match, not
    // docs/, not .md, not packages/m3l-console-web//console-server/) — so
    // if this comes back all-true, it can only be the unclassified-path
    // safety net firing, not any predicate.
    const flags = classifyChangedPaths([".gitignore"]);
    for (const category of CHANGE_CATEGORIES) {
      expect(flags[category]).toBe(true);
    }
  });

  test("empty input returns all-false", () => {
    const flags = classifyChangedPaths([]);
    expect(flags).toEqual({
      ts: false,
      deps: false,
      scripts: false,
      claude: false,
      workflows: false,
      docs: false,
      md: false,
      console: false,
    });
  });

  test("CLAUDE.md sets both workflows and docs true", () => {
    const flags = classifyChangedPaths(["CLAUDE.md"]);
    expect(flags.workflows).toBe(true);
    expect(flags.docs).toBe(true);
  });

  test.each(["package.json", "pnpm-lock.yaml"])(
    "%s sets both ts and deps true",
    (path) => {
      const flags = classifyChangedPaths([path]);
      expect(flags.ts).toBe(true);
      expect(flags.deps).toBe(true);
    },
  );

  test("a nested package.json sets ts, deps, AND scripts true", () => {
    const flags = classifyChangedPaths(["scripts/s3-objects/package.json"]);
    expect(flags.ts).toBe(true);
    expect(flags.deps).toBe(true);
    expect(flags.scripts).toBe(true);
  });

  test("any bin/ change forces every category true, even for a path matching no predicate on its own", () => {
    // bin/lib/report.mjs matches none of the 8 predicates individually
    // (not .ts, not scripts/, not .claude/, not a listed workflows exact
    // match, not docs/, not .md, not packages/m3l-console-web//console-server/)
    // — so if this comes back all-true, it can only be the bin/ safety net
    // firing, not any predicate.
    const soloFlags = classifyChangedPaths(["bin/lib/report.mjs"]);
    for (const category of CHANGE_CATEGORIES) {
      expect(soloFlags[category]).toBe(true);
    }
  });

  test("the bin/ safety net applies to every category even when other changed paths match nothing", () => {
    const flags = classifyChangedPaths(["bin/lib/report.mjs", ".gitignore"]);
    for (const category of CHANGE_CATEGORIES) {
      expect(flags[category]).toBe(true);
    }
  });

  test("an unclassified path forces every category true even alongside a path that would otherwise classify narrowly", () => {
    // templates/script/foo.tmpl matches none of the 8 predicates individually
    // (not .ts, not scripts/, not .claude/, not a listed workflows exact
    // match, not docs/, not .md, not packages/m3l-console-web//console-server/),
    // while the .ts path alone would only ever set `ts` true — so if this
    // comes back all-true, it can only be the unclassified-path safety net
    // firing, not any predicate combination.
    const flags = classifyChangedPaths([
      "templates/script/foo.tmpl",
      "packages/m3l-common/src/core/errors/index.ts",
    ]);
    for (const category of CHANGE_CATEGORIES) {
      expect(flags[category]).toBe(true);
    }
  });
});

describe("allChanged", () => {
  test("returns every category set true", () => {
    const flags = allChanged();
    for (const category of CHANGE_CATEGORIES) {
      expect(flags[category]).toBe(true);
    }
  });

  test("the returned key set exactly matches CHANGE_CATEGORIES", () => {
    const flags = allChanged();
    expect(new Set(Object.keys(flags))).toEqual(new Set(CHANGE_CATEGORIES));
  });
});

describe("resolveChangedPaths", () => {
  test("splits git diff output into the expected path array and shells out with a three-dot range", () => {
    const execFileSync = vi
      .fn()
      .mockReturnValue(
        "packages/m3l-common/src/index.ts\ndocs/adr/0001-example.md\n",
      );

    const paths = resolveChangedPaths(
      { execFileSync },
      "/repo",
      "main",
      "feat/x",
    );

    expect(paths).toEqual([
      "packages/m3l-common/src/index.ts",
      "docs/adr/0001-example.md",
    ]);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "main...feat/x"],
      { cwd: "/repo", encoding: "utf8" },
    );
  });

  test("a trailing newline in the diff output does not produce a trailing empty-string element", () => {
    const execFileSync = vi.fn().mockReturnValue("single-file.ts\n");

    const paths = resolveChangedPaths(
      { execFileSync },
      "/repo",
      "base-ref",
      "head-ref",
    );

    expect(paths).toEqual(["single-file.ts"]);
    expect(paths).toHaveLength(1);
  });

  test("propagates a git failure rather than swallowing it", () => {
    const execFileSync = vi.fn().mockImplementation(() => {
      throw new Error("bad ref");
    });

    expect(() =>
      resolveChangedPaths({ execFileSync }, "/repo", "bogus", "also-bogus"),
    ).toThrow("bad ref");
  });
});
