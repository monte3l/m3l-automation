import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Mock setup for resolveImportedFiles / collectRuleFiles / collectSkillDescriptions
// (node:fs). Spread the actual fs so vi.spyOn can intercept individual methods
// (ESM namespace objects are non-writable by default — the spread makes them
// plain, writable object properties), following
// bin/tests/check-file-budget.test.ts.
// ---------------------------------------------------------------------------
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  MAX_RUNTIME_LINES,
  MAX_APPROX_TOKENS,
  MAX_TABLE_LINE_WIDTH,
  RULE_CEILING_BYTES,
  SKILL_DESC_WARN_CHARS,
  stripBlockComments,
  normalizeRuntimeContent,
  countRuntimeLines,
  estimateTokens,
  findWidePaddedTableLines,
  measure,
  findImportTokens,
  resolveImportedFiles,
  extractFrontmatterBody,
  extractRulePaths,
  extractFrontmatterField,
  globToRegExp,
  globToProbePath,
  collectRuleFiles,
  deriveScenarioTotals,
  checkRuleBudget,
  buildRuleBaseline,
  collectSkillDescriptions,
  parseClaudeMdRuleGlobs,
  diffRuleGlobParity,
} from "../check-context-budget.mjs";

// check-context-budget.mjs computes `root` via repoRoot(import.meta.url) from
// its own location (bin/check-context-budget.mjs), i.e. the repo root. This
// test file lives one directory deeper (bin/tests/), so the same repo root
// needs one extra dirname() hop from here.
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Minimal fake `Dirent` satisfying the shape the collectors read. */
function fakeDirent(name: string, kind: "file" | "dir") {
  return {
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
  };
}

describe("exported constants", () => {
  test("documented budget/ceiling values", () => {
    expect(MAX_RUNTIME_LINES).toBe(200);
    expect(MAX_APPROX_TOKENS).toBe(3000);
    expect(MAX_TABLE_LINE_WIDTH).toBe(200);
    expect(RULE_CEILING_BYTES).toBe(10_000);
    expect(SKILL_DESC_WARN_CHARS).toBe(1536);
  });
});

// ---------------------------------------------------------------------------
// Shared measurement primitives — same behavior/cases as
// bin/tests/check-claude-md-budget.test.ts, since this module started as a
// byte-identical copy of that script's functions.
// ---------------------------------------------------------------------------

describe("stripBlockComments", () => {
  test("strips a single block comment", () => {
    expect(stripBlockComments("before <!-- hidden --> after")).toBe(
      "before  after",
    );
  });

  test("strips multiple non-adjacent block comments", () => {
    expect(stripBlockComments("a <!-- one --> b <!-- two --> c")).toBe(
      "a  b  c",
    );
  });

  test("leaves content with no comments unchanged", () => {
    const text = "# Heading\n\nSome prose with no comments.\n";
    expect(stripBlockComments(text)).toBe(text);
  });

  test("strips a comment spanning multiple lines", () => {
    const text = [
      "before",
      "<!--",
      "this is a maintainer note",
      "spanning several lines",
      "-->",
      "after",
    ].join("\n");
    expect(stripBlockComments(text)).toBe("before\n\nafter");
  });

  test("loops to a fixed point to fully strip a marker reassembled by removing a nested comment", () => {
    const input = "before<!<!--nested-->--after-->tail";
    expect(stripBlockComments(input)).toBe("beforetail");
    expect(stripBlockComments(input)).not.toMatch(/<!--|--!?>/);
  });

  test("still strips two separate, well-formed comments unaffected by the fixed-point loop", () => {
    expect(stripBlockComments("<!-- a --> text <!-- b -->")).toBe(" text ");
  });
});

describe("normalizeRuntimeContent", () => {
  test("collapses 3+ blank lines to exactly 2 newlines", () => {
    expect(normalizeRuntimeContent("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("leaves a single blank line (2 newlines) alone", () => {
    expect(normalizeRuntimeContent("a\n\nb")).toBe("a\n\nb");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeRuntimeContent("\n\n  content  \n\n")).toBe("content");
  });

  test("returns empty string when content is only whitespace", () => {
    expect(normalizeRuntimeContent("   \n\n\t  ")).toBe("");
  });
});

describe("countRuntimeLines", () => {
  test("returns 0 for an empty string", () => {
    expect(countRuntimeLines("")).toBe(0);
  });

  test("returns 1 for a single line with no newline", () => {
    expect(countRuntimeLines("single line")).toBe(1);
  });

  test("returns N+1 lines for a string with N newlines", () => {
    expect(countRuntimeLines("a\nb\nc")).toBe(3);
    expect(countRuntimeLines("a\nb\nc\n")).toBe(4);
  });
});

describe("estimateTokens", () => {
  test("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("matches Math.ceil(length / 4) for a length exactly divisible by 4", () => {
    const text = "a".repeat(8);
    expect(estimateTokens(text)).toBe(2);
  });

  test("rounds up rather than truncating for a length not divisible by 4", () => {
    const text = "a".repeat(9);
    expect(estimateTokens(text)).toBe(3);
  });
});

describe("findWidePaddedTableLines", () => {
  test("returns table lines exceeding maxWidth", () => {
    const wide = `| ${"x".repeat(200)} |`;
    const normalized = ["short line", wide, "another short line"].join("\n");
    expect(findWidePaddedTableLines(normalized, 50)).toEqual([wide]);
  });

  test("excludes short table lines at or under the width", () => {
    const atLimit = "|" + "x".repeat(9); // length 10, at the limit
    expect(findWidePaddedTableLines(atLimit, 10)).toEqual([]);
  });

  test("excludes non-table lines even if they're long", () => {
    const longProse = "x".repeat(300);
    expect(findWidePaddedTableLines(longProse, 50)).toEqual([]);
  });

  test("only flags a line starting with | after trimStart, not one merely containing |", () => {
    const containsPipeButNotTableRow = `some prose with a | pipe character ${"x".repeat(
      100,
    )}`;
    const indentedTableRow = `   | ${"y".repeat(100)} |`;
    const normalized = [containsPipeButNotTableRow, indentedTableRow].join(
      "\n",
    );
    expect(findWidePaddedTableLines(normalized, 20)).toEqual([
      indentedTableRow,
    ]);
  });
});

// ---------------------------------------------------------------------------
// measure — new in this module, composes countRuntimeLines/estimateTokens
// ---------------------------------------------------------------------------

describe("measure", () => {
  test("returns 0 lines / 0 tokens for empty input", () => {
    expect(measure("")).toEqual({ lines: 0, tokens: 0 });
  });

  test("composes countRuntimeLines and estimateTokens for known input", () => {
    const normalized = "abcd\nefgh"; // 9 chars, 2 lines
    expect(measure(normalized)).toEqual({
      lines: countRuntimeLines(normalized),
      tokens: estimateTokens(normalized),
    });
    expect(measure(normalized)).toEqual({ lines: 2, tokens: 3 });
  });
});

// ---------------------------------------------------------------------------
// findImportTokens — the actual regression this function guards: it must NOT
// filter tokens that merely look like real imports; that filtering happens
// downstream in resolveImportedFiles via the filesystem.
// ---------------------------------------------------------------------------

describe("findImportTokens", () => {
  test("extracts a @path token adjacent to punctuation, stopping before it", () => {
    expect(findImportTokens("See @package.json for details.")).toEqual([
      "package.json",
    ]);
  });

  test("stops a token before trailing punctuation not part of the path charset", () => {
    expect(findImportTokens("(see @docs/adr/README.md)")).toEqual([
      "docs/adr/README.md",
    ]);
  });

  test("dedupes overlapping/duplicate tokens across multiple sentences to one entry", () => {
    const text = "@a.md and @a.md again, plus @b.md too";
    expect(findImportTokens(text)).toEqual(["a.md", "b.md"]);
  });

  test("returns every @token found, including ones that are NOT real imports (filtering happens in resolveImportedFiles, not here)", () => {
    const text =
      "Package @m3l-automation/m3l-common with @example and @version, checked via @arethetypeswrong/cli tool";
    expect(findImportTokens(text)).toEqual([
      "m3l-automation/m3l-common",
      "example",
      "version",
      "arethetypeswrong/cli",
    ]);
  });

  test("returns [] for text with no @ tokens", () => {
    expect(findImportTokens("no imports here")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveImportedFiles — fs-mocked
// ---------------------------------------------------------------------------

describe("resolveImportedFiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a token resolving to a real file is included with its content", () => {
    const fromRoot = "/fake/root";
    vi.spyOn(fs, "statSync").mockImplementation(((p: string) => {
      if (String(p) === join(fromRoot, "package.json")) {
        return { isFile: () => true } as unknown as fs.Stats;
      }
      throw new Error(`unexpected statSync call: ${String(p)}`);
    }) as typeof fs.statSync);
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: string) => {
      if (String(p) === join(fromRoot, "package.json")) return "PKG CONTENT";
      throw new Error(`unexpected readFileSync call: ${String(p)}`);
    }) as typeof fs.readFileSync);

    const result = resolveImportedFiles(
      "See @package.json for details.",
      fromRoot,
    );

    expect(result).toEqual([{ path: "package.json", content: "PKG CONTENT" }]);
  });

  test("a token whose statSync throws (ENOENT) is silently skipped, not an import", () => {
    const fromRoot = "/fake/root";
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      const error = new Error(
        "ENOENT: no such file or directory",
      ) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
    const readFileSyncSpy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(() => {
        throw new Error("readFileSync must not be called for a missing path");
      });

    const result = resolveImportedFiles("@notreal.md doesn't exist", fromRoot);

    expect(result).toEqual([]);
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });

  test("a token resolving to a directory (isFile() false) is skipped", () => {
    const fromRoot = "/fake/root";
    vi.spyOn(fs, "statSync").mockImplementation(
      () => ({ isFile: () => false }) as unknown as fs.Stats,
    );
    const readFileSyncSpy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(() => {
        throw new Error("readFileSync must not be called for a directory");
      });

    const result = resolveImportedFiles("@somedir token", fromRoot);

    expect(result).toEqual([]);
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });

  test("recursively resolves through hops: A -> @b.md -> @c.md", () => {
    const fromRoot = "/fake/root";
    const files: Record<string, string> = {
      [join(fromRoot, "b.md")]: "@c.md",
      [join(fromRoot, "c.md")]: "leaf, no further tokens",
    };
    vi.spyOn(fs, "statSync").mockImplementation(((p: string) => {
      if (String(p) in files)
        return { isFile: () => true } as unknown as fs.Stats;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }) as typeof fs.statSync);
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: string) => {
      const content = files[String(p)];
      if (content === undefined)
        throw new Error(`unexpected readFileSync call: ${String(p)}`);
      return content;
    }) as typeof fs.readFileSync);

    const result = resolveImportedFiles("@b.md", fromRoot);

    expect(result).toEqual([
      { path: "b.md", content: "@c.md" },
      { path: "c.md", content: "leaf, no further tokens" },
    ]);
  });

  test("a cycle (A references B, B references A) does not infinite-loop and does not duplicate the resolved path", () => {
    const fromRoot = "/fake/root";
    const files: Record<string, string> = {
      [join(fromRoot, "b.md")]: "@c.md",
      [join(fromRoot, "c.md")]: "@b.md",
    };
    vi.spyOn(fs, "statSync").mockImplementation(((p: string) => {
      if (String(p) in files)
        return { isFile: () => true } as unknown as fs.Stats;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }) as typeof fs.statSync);
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: string) => {
      const content = files[String(p)];
      if (content === undefined)
        throw new Error(`unexpected readFileSync call: ${String(p)}`);
      return content;
    }) as typeof fs.readFileSync);

    const result = resolveImportedFiles("@b.md", fromRoot);

    expect(result).toEqual([
      { path: "b.md", content: "@c.md" },
      { path: "c.md", content: "@b.md" },
    ]);
    expect(result.map((r) => r.path)).toEqual(["b.md", "c.md"]);
  });

  test("maxHops truncates resolution: a 2-hop chain with maxHops=1 stops after the first hop", () => {
    const fromRoot = "/fake/root";
    const files: Record<string, string> = {
      [join(fromRoot, "b.md")]: "@c.md",
      [join(fromRoot, "c.md")]: "leaf",
    };
    vi.spyOn(fs, "statSync").mockImplementation(((p: string) => {
      if (String(p) in files)
        return { isFile: () => true } as unknown as fs.Stats;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }) as typeof fs.statSync);
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: string) => {
      const content = files[String(p)];
      if (content === undefined)
        throw new Error(`unexpected readFileSync call: ${String(p)}`);
      return content;
    }) as typeof fs.readFileSync);

    const result = resolveImportedFiles("@b.md", fromRoot, 1);

    expect(result).toEqual([{ path: "b.md", content: "@c.md" }]);
    expect(result.some((r) => r.path === "c.md")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // [REGRESSION] path-traversal containment — a "@a/../../.." token must be
  // rejected because its resolved absolute path falls outside fromRoot, even
  // when that resolved path exists on disk. statSync always succeeds here so
  // the test proves the containment check runs BEFORE any filesystem access,
  // not that the filesystem check happens to fail for an unrelated reason.
  // -------------------------------------------------------------------------

  test("[REGRESSION] a token resolving outside fromRoot via ../ traversal is excluded, and statSync is never called for it", () => {
    const fromRoot = "/repo/root";
    const statSyncSpy = vi
      .spyOn(fs, "statSync")
      .mockReturnValue({ isFile: () => true } as unknown as fs.Stats);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("readFileSync must not be called for a traversal token");
    });

    const result = resolveImportedFiles(
      "@a/../../../../etc/passwd is a token",
      fromRoot,
    );

    expect(result).toEqual([]);
    expect(statSyncSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("passwd"),
    );
  });

  test("a normal in-root relative token still resolves through the same containment check (the fix does not reject legitimate imports)", () => {
    const fromRoot = "/repo/root";
    vi.spyOn(fs, "statSync").mockImplementation(((p: string) => {
      if (String(p) === join(fromRoot, "sub/dir/file.md")) {
        return { isFile: () => true } as unknown as fs.Stats;
      }
      throw new Error(`unexpected statSync call: ${String(p)}`);
    }) as typeof fs.statSync);
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: string) => {
      if (String(p) === join(fromRoot, "sub/dir/file.md")) return "SUB CONTENT";
      throw new Error(`unexpected readFileSync call: ${String(p)}`);
    }) as typeof fs.readFileSync);

    const result = resolveImportedFiles("@sub/dir/file.md is fine", fromRoot);

    expect(result).toEqual([
      { path: "sub/dir/file.md", content: "SUB CONTENT" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// extractFrontmatterBody
// ---------------------------------------------------------------------------

describe("extractFrontmatterBody", () => {
  test("returns the body between the first two --- lines", () => {
    const content = ["---", "paths:", '  - "foo/**"', "---", "# Body"].join(
      "\n",
    );
    expect(extractFrontmatterBody(content)).toBe('paths:\n  - "foo/**"');
  });

  test("returns null when there is no frontmatter block", () => {
    expect(extractFrontmatterBody("# Just a heading\n\nNo frontmatter.")).toBe(
      null,
    );
  });

  test("only matches the FIRST frontmatter block when --- appears again later in the body", () => {
    const content = [
      "---",
      "paths:",
      '  - "foo/**"',
      "---",
      "Some body text.",
      "",
      "---",
      "",
      "More text after a horizontal rule far below.",
    ].join("\n");
    expect(extractFrontmatterBody(content)).toBe('paths:\n  - "foo/**"');
  });
});

// ---------------------------------------------------------------------------
// extractRulePaths
// ---------------------------------------------------------------------------

describe("extractRulePaths", () => {
  test("parses multiple entries, quoted and unquoted", () => {
    const fmBody = 'paths:\n  - "packages/m3l-common/src/**"\n  - scripts/**\n';
    expect(extractRulePaths(fmBody)).toEqual([
      "packages/m3l-common/src/**",
      "scripts/**",
    ]);
  });

  test("a frontmatter body with no paths: key returns []", () => {
    expect(extractRulePaths('description: "no paths here"')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractFrontmatterField
// ---------------------------------------------------------------------------

describe("extractFrontmatterField", () => {
  test("an inline scalar returns the trimmed value", () => {
    const fmBody = "description: some text";
    expect(extractFrontmatterField(fmBody, "description")).toBe("some text");
  });

  test("a folded block scalar (>-) returns the space-joined, trimmed lines", () => {
    const fmBody = ["description: >-", "  line one", "  line two"].join("\n");
    expect(extractFrontmatterField(fmBody, "description")).toBe(
      "line one line two",
    );
  });

  test("a missing key returns an empty string", () => {
    expect(extractFrontmatterField("paths:\n  - foo/**", "description")).toBe(
      "",
    );
  });

  test("a blank line inside a folded block scalar is preserved as an empty segment before joining", () => {
    const fmBody = ["description: |-", "  line one", "", "  line two"].join(
      "\n",
    );
    expect(extractFrontmatterField(fmBody, "description")).toBe(
      "line one  line two",
    );
  });

  test("a block scalar's content stops at the next top-level key (column 0), not the rest of the frontmatter", () => {
    const fmBody = [
      "description: >-",
      "  line one",
      "  line two",
      "name: foo",
      "  not part of description",
    ].join("\n");
    expect(extractFrontmatterField(fmBody, "description")).toBe(
      "line one line two",
    );
  });
});

// ---------------------------------------------------------------------------
// globToRegExp — the exact globs this repo's .claude/rules/*.md files use
// ---------------------------------------------------------------------------

describe("globToRegExp", () => {
  test('"packages/m3l-common/src/**" matches a deep path under it but not a sibling package', () => {
    const re = globToRegExp("packages/m3l-common/src/**");
    expect(re.test("packages/m3l-common/src/anything/deep.ts")).toBe(true);
    expect(re.test("packages/other/src/x.ts")).toBe(false);
  });

  test('"**/*.test.ts" matches a .test.ts file but not a plain .ts file', () => {
    const re = globToRegExp("**/*.test.ts");
    expect(re.test("a/b/c.test.ts")).toBe(true);
    expect(re.test("a/b/c.ts")).toBe(false);
  });

  test('"packages/**/*.ts" matches a nested .ts file but not a .md file', () => {
    const re = globToRegExp("packages/**/*.ts");
    expect(re.test("packages/foo/bar/baz.ts")).toBe(true);
    expect(re.test("packages/foo/bar/baz.md")).toBe(false);
  });

  test('".claude/skills/**" matches a nested skill file', () => {
    const re = globToRegExp(".claude/skills/**");
    expect(re.test(".claude/skills/auditing/SKILL.md")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // [REGRESSION] zero-segment "**" matching — the OLD implementation joined a
  // "**" segment via a plain ".*" between fixed neighbors, which required at
  // least one intervening path segment to exist. A mid-path "**" (used by
  // .claude/rules/domain-knowledge.md's "packages/**/*.ts") therefore failed
  // to match a file directly inside the prefix directory, and a leading "**"
  // failed to match a bare top-level file with no leading "/" at all.
  // -------------------------------------------------------------------------

  test('[REGRESSION] "packages/**/*.ts" (used by .claude/rules/domain-knowledge.md) matches with zero intermediate directories', () => {
    const re = globToRegExp("packages/**/*.ts");
    expect(re.test("packages/foo.ts")).toBe(true);
  });

  test('[REGRESSION] "packages/**/*.ts" also still matches multiple intermediate directories', () => {
    const re = globToRegExp("packages/**/*.ts");
    expect(re.test("packages/a/b/foo.ts")).toBe(true);
  });

  test('[REGRESSION] "**/*.test.ts" matches a bare top-level file with no leading directory at all', () => {
    const re = globToRegExp("**/*.test.ts");
    expect(re.test("foo.test.ts")).toBe(true);
  });

  test('a trailing "**" ("packages/m3l-common/src/**") still matches a multi-directory-deep path (confirms the rewrite did not regress the working trailing case)', () => {
    const re = globToRegExp("packages/m3l-common/src/**");
    expect(re.test("packages/m3l-common/src/deep/nested/file.ts")).toBe(true);
  });

  test('[REGRESSION] "packages/**/*.ts" does NOT match a wrong top-level prefix', () => {
    const re = globToRegExp("packages/**/*.ts");
    expect(re.test("scripts/foo.ts")).toBe(false);
  });

  test('[REGRESSION] "packages/**/*.ts" does NOT match a file with the wrong extension', () => {
    const re = globToRegExp("packages/**/*.ts");
    expect(re.test("packages/foo.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// globToProbePath — regression test for the fixed last-dot-extension bug:
// the probe a glob derives must always self-match that same glob's regex.
// ---------------------------------------------------------------------------

describe("globToProbePath", () => {
  test("[REGRESSION] a compound extension glob (**/*.test.ts) produces a probe that self-matches", () => {
    const glob = "**/*.test.ts";
    const probe = globToProbePath(glob);
    expect(globToRegExp(glob).test(probe)).toBe(true);
  });

  test("a trailing whole-segment wildcard glob (packages/m3l-common/src/**) produces a self-matching probe", () => {
    const glob = "packages/m3l-common/src/**";
    const probe = globToProbePath(glob);
    expect(globToRegExp(glob).test(probe)).toBe(true);
  });

  test("a mid-path ** with a trailing extension glob (scripts/**/*.ts) produces a self-matching probe", () => {
    const glob = "scripts/**/*.ts";
    const probe = globToProbePath(glob);
    expect(globToRegExp(glob).test(probe)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkRuleBudget — mirrors bin/check-file-budget.mjs's checkBudget
// ---------------------------------------------------------------------------

describe("checkRuleBudget", () => {
  test("a file under its ceiling and not in baseline is not a violation", () => {
    const rules = [
      {
        name: "small.md",
        relPath: ".claude/rules/small.md",
        bytes: RULE_CEILING_BYTES - 1,
        globs: [],
      },
    ];
    expect(checkRuleBudget(rules, {})).toEqual([]);
  });

  test("a file over RULE_CEILING_BYTES and not in baseline is a violation with baselined: false", () => {
    const rules = [
      {
        name: "big.md",
        relPath: ".claude/rules/big.md",
        bytes: RULE_CEILING_BYTES + 1,
        globs: [],
      },
    ];
    expect(checkRuleBudget(rules, {})).toEqual([
      {
        path: ".claude/rules/big.md",
        bytes: RULE_CEILING_BYTES + 1,
        limit: RULE_CEILING_BYTES,
        baselined: false,
      },
    ]);
  });

  test("a file in the baseline at or under its recorded size is not a violation", () => {
    const rules = [
      {
        name: "steady.md",
        relPath: ".claude/rules/steady.md",
        bytes: 29_000,
        globs: [],
      },
    ];
    const baseline = { ".claude/rules/steady.md": 29_000 };
    expect(checkRuleBudget(rules, baseline)).toEqual([]);
  });

  test("a file in the baseline that grew past its recorded size is a violation with baselined: true and limit === baseline value", () => {
    const rules = [
      {
        name: "grown.md",
        relPath: ".claude/rules/grown.md",
        bytes: 30_000,
        globs: [],
      },
    ];
    const baseline = { ".claude/rules/grown.md": 29_000 };
    expect(checkRuleBudget(rules, baseline)).toEqual([
      {
        path: ".claude/rules/grown.md",
        bytes: 30_000,
        limit: 29_000,
        baselined: true,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildRuleBaseline
// ---------------------------------------------------------------------------

describe("buildRuleBaseline", () => {
  test("only files over RULE_CEILING_BYTES appear, keyed by relPath at their current bytes", () => {
    const rules = [
      {
        name: "big.md",
        relPath: ".claude/rules/big.md",
        bytes: RULE_CEILING_BYTES + 500,
        globs: [],
      },
      {
        name: "small.md",
        relPath: ".claude/rules/small.md",
        bytes: RULE_CEILING_BYTES,
        globs: [],
      },
    ];
    expect(buildRuleBaseline(rules)).toEqual({
      ".claude/rules/big.md": RULE_CEILING_BYTES + 500,
    });
  });

  test("result is key-sorted", () => {
    const rules = [
      {
        name: "z.md",
        relPath: ".claude/rules/z.md",
        bytes: RULE_CEILING_BYTES + 1,
        globs: [],
      },
      {
        name: "a.md",
        relPath: ".claude/rules/a.md",
        bytes: RULE_CEILING_BYTES + 1,
        globs: [],
      },
    ];
    expect(Object.keys(buildRuleBaseline(rules))).toEqual([
      ".claude/rules/a.md",
      ".claude/rules/z.md",
    ]);
  });

  test("a rule set with nothing over the ceiling produces {}", () => {
    const rules = [
      {
        name: "ok.md",
        relPath: ".claude/rules/ok.md",
        bytes: RULE_CEILING_BYTES - 1,
        globs: [],
      },
    ];
    expect(buildRuleBaseline(rules)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// deriveScenarioTotals — real-shaped globs from this repo's actual rule files
// ---------------------------------------------------------------------------

describe("deriveScenarioTotals", () => {
  test("a scenario exists whose rules contain BOTH matching rule names with bytes equal to their sum; results sorted descending; no scenario has an empty rules array", () => {
    const rules = [
      {
        name: "library-src.md",
        relPath: ".claude/rules/library-src.md",
        bytes: 5000,
        globs: ["packages/m3l-common/src/**"],
      },
      {
        name: "domain-knowledge.md",
        relPath: ".claude/rules/domain-knowledge.md",
        bytes: 3000,
        globs: ["packages/**/*.ts", "scripts/**/*.ts", "**/*.test.ts"],
      },
    ];

    const scenarios = deriveScenarioTotals(rules);

    // No scenario is ever empty — the probe for a rule's own glob must
    // always match that rule (the same self-consistency class as
    // globToProbePath's regression).
    expect(scenarios.every((s) => s.rules.length > 0)).toBe(true);

    // Sorted by bytes descending.
    for (let i = 1; i < scenarios.length; i++) {
      const previous = scenarios[i - 1];
      const current = scenarios[i];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      expect(previous?.bytes).toBeGreaterThanOrEqual(current?.bytes ?? 0);
    }

    const combined = scenarios.find(
      (s) =>
        s.rules.includes("library-src.md") &&
        s.rules.includes("domain-knowledge.md"),
    );
    expect(combined).toBeDefined();
    expect(combined?.bytes).toBe(8000);
    // The combined scenario is the largest one (sorted descending, first).
    expect(scenarios[0]).toBe(combined);
  });
});

describe("parseClaudeMdRuleGlobs", () => {
  test("parses a bullet with multiple globs into an ordered array keyed by filename", () => {
    const result = parseClaudeMdRuleGlobs(
      "- `packages/m3l-common/src/**`, `scripts/**` → `refactoring.md` — behavior-preserving changes\n",
    );
    expect(result.get("refactoring.md")).toEqual([
      "packages/m3l-common/src/**",
      "scripts/**",
    ]);
  });

  test("returns an empty map when no bullet matches the expected shape", () => {
    const result = parseClaudeMdRuleGlobs(
      "Just prose, no rule-glob bullets here.\n- an unrelated bullet\n",
    );
    expect(result.size).toBe(0);
  });
});

describe("diffRuleGlobParity", () => {
  test("no mismatch when a rule's documented globs equal its frontmatter globs (any order)", () => {
    const claudeMdGlobs = new Map([
      ["tests.md", ["**/*.test.ts", "**/tests/**"]],
    ]);
    const rules = [
      {
        name: "tests.md",
        relPath: ".claude/rules/tests.md",
        bytes: 100,
        globs: ["**/tests/**", "**/*.test.ts"],
      },
    ];
    expect(diffRuleGlobParity(claudeMdGlobs, rules)).toEqual([]);
  });

  test("flags a rule whose documented globs omit one the frontmatter declares", () => {
    const claudeMdGlobs = new Map([["refactoring.md", ["scripts/**"]]]);
    const rules = [
      {
        name: "refactoring.md",
        relPath: ".claude/rules/refactoring.md",
        bytes: 100,
        globs: ["scripts/**", "**/*.test.ts"],
      },
    ];
    const mismatches = diffRuleGlobParity(claudeMdGlobs, rules);
    expect(mismatches).toEqual([
      {
        rule: "refactoring.md",
        documented: ["scripts/**"],
        actual: ["scripts/**", "**/*.test.ts"],
      },
    ]);
  });

  test("a rule with no CLAUDE.md bullet at all is skipped, not flagged", () => {
    const claudeMdGlobs = new Map<string, string[]>();
    const rules = [
      {
        name: "undocumented.md",
        relPath: ".claude/rules/undocumented.md",
        bytes: 100,
        globs: ["**/*.ts"],
      },
    ];
    expect(diffRuleGlobParity(claudeMdGlobs, rules)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectRuleFiles — fs-mocked
// ---------------------------------------------------------------------------

describe("collectRuleFiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rulesDir = "/fake/.claude/rules";

  test("only .md files are collected; results are shaped correctly and sorted by name", () => {
    const librarySrcContent = [
      "---",
      "paths:",
      '  - "packages/m3l-common/src/**"',
      "---",
      "# Library src rules",
    ].join("\n");
    const testsContent = [
      "---",
      "paths:",
      '  - "**/tests/**"',
      '  - "*.test.ts"',
      "---",
      "# Tests rules",
    ].join("\n");

    vi.spyOn(fs, "existsSync").mockImplementation(
      (p) => String(p) === rulesDir,
    );
    vi.spyOn(fs, "readdirSync").mockImplementation(((current: string) => {
      if (String(current) === rulesDir) {
        return [
          fakeDirent("tests.md", "file"),
          fakeDirent("library-src.md", "file"),
          fakeDirent("README.txt", "file"), // non-.md, must be skipped
          fakeDirent("subdir", "dir"), // not a file, must be skipped
        ];
      }
      throw new Error(`unexpected readdirSync call: ${String(current)}`);
    }) as unknown as typeof fs.readdirSync);
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: string) => {
      const path = String(p);
      if (path === join(rulesDir, "tests.md")) return testsContent;
      if (path === join(rulesDir, "library-src.md")) return librarySrcContent;
      throw new Error(`unexpected readFileSync call: ${path}`);
    }) as typeof fs.readFileSync);

    const result = collectRuleFiles(rulesDir);

    expect(result).toEqual([
      {
        name: "library-src.md",
        relPath: relative(root, join(rulesDir, "library-src.md")),
        bytes: Buffer.byteLength(librarySrcContent, "utf8"),
        globs: ["packages/m3l-common/src/**"],
      },
      {
        name: "tests.md",
        relPath: relative(root, join(rulesDir, "tests.md")),
        bytes: Buffer.byteLength(testsContent, "utf8"),
        globs: ["**/tests/**", "*.test.ts"],
      },
    ]);
    // sorted by name (library-src.md before tests.md)
    expect(result.map((r) => r.name)).toEqual(["library-src.md", "tests.md"]);
  });

  test("a directory that doesn't exist returns []", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const readdirSyncSpy = vi.spyOn(fs, "readdirSync");

    expect(collectRuleFiles(rulesDir)).toEqual([]);
    expect(readdirSyncSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// collectSkillDescriptions — fs-mocked
// ---------------------------------------------------------------------------

describe("collectSkillDescriptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const skillsDir = "/fake/.claude/skills";

  test("only directories are considered (a stray top-level file is skipped)", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const path = String(p);
      return (
        path === skillsDir || path === join(skillsDir, "auditing", "SKILL.md")
      );
    });
    vi.spyOn(fs, "readdirSync").mockImplementation(((current: string) => {
      if (String(current) === skillsDir) {
        return [
          fakeDirent("README.md", "file"), // stray file, must be skipped
          fakeDirent("auditing", "dir"),
        ];
      }
      throw new Error(`unexpected readdirSync call: ${String(current)}`);
    }) as unknown as typeof fs.readdirSync);
    const skillMdContent = ["---", "description: audit things", "---"].join(
      "\n",
    );
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: string) => {
      const path = String(p);
      if (path === join(skillsDir, "auditing", "SKILL.md"))
        return skillMdContent;
      throw new Error(`unexpected readFileSync call: ${path}`);
    }) as typeof fs.readFileSync);

    const result = collectSkillDescriptions(skillsDir);

    expect(result).toEqual([
      { name: "auditing", chars: "audit things".length },
    ]);
  });

  test("a directory without a SKILL.md inside is skipped, not an error", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const path = String(p);
      if (path === skillsDir) return true;
      if (path === join(skillsDir, "no-skill-md", "SKILL.md")) return false;
      return false;
    });
    vi.spyOn(fs, "readdirSync").mockImplementation(((current: string) => {
      if (String(current) === skillsDir) {
        return [fakeDirent("no-skill-md", "dir")];
      }
      throw new Error(`unexpected readdirSync call: ${String(current)}`);
    }) as unknown as typeof fs.readdirSync);
    const readFileSyncSpy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(() => {
        throw new Error("readFileSync must not be called without a SKILL.md");
      });

    expect(collectSkillDescriptions(skillsDir)).toEqual([]);
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });

  test("chars matches the extracted description's length; results sorted by name", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const path = String(p);
      return (
        path === skillsDir ||
        path === join(skillsDir, "zebra", "SKILL.md") ||
        path === join(skillsDir, "alpha", "SKILL.md")
      );
    });
    vi.spyOn(fs, "readdirSync").mockImplementation(((current: string) => {
      if (String(current) === skillsDir) {
        return [fakeDirent("zebra", "dir"), fakeDirent("alpha", "dir")];
      }
      throw new Error(`unexpected readdirSync call: ${String(current)}`);
    }) as unknown as typeof fs.readdirSync);
    const zebraDesc = "zebra description text";
    const alphaDesc = "alpha description, a bit longer than zebra's";
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: string) => {
      const path = String(p);
      if (path === join(skillsDir, "zebra", "SKILL.md"))
        return `---\ndescription: ${zebraDesc}\n---`;
      if (path === join(skillsDir, "alpha", "SKILL.md"))
        return `---\ndescription: ${alphaDesc}\n---`;
      throw new Error(`unexpected readFileSync call: ${path}`);
    }) as typeof fs.readFileSync);

    const result = collectSkillDescriptions(skillsDir);

    expect(result).toEqual([
      { name: "alpha", chars: alphaDesc.length },
      { name: "zebra", chars: zebraDesc.length },
    ]);
  });

  test("a missing skills directory returns []", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const readdirSyncSpy = vi.spyOn(fs, "readdirSync");

    expect(collectSkillDescriptions(skillsDir)).toEqual([]);
    expect(readdirSyncSpy).not.toHaveBeenCalled();
  });
});
