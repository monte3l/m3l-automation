/**
 * Tests for bin/lib/promotion-stamps.mjs — the pure-function module that
 * validates the `promoted →` stamp convention's two arms: a docs/logs/*.md
 * stamp's target must exist, and a docs/logs/<name>.md citation inside a
 * scanned harness file must resolve.
 *
 * bin/check-promotion-stamps.mjs (the CLI runner) is NOT imported here: it
 * executes its full CLI body unconditionally at module load with no
 * separately exported functions. This file follows the established
 * convention (see bin/tests/check-logs-index.test.ts) of exercising only the
 * exported, side-effect-free lib functions.
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  LOGS_DIR,
  RENAMED_TARGETS,
  SCAN_GLOBS,
  checkDanglingCitations,
  checkDeadTargets,
  checkPromotionStamps,
  checkStaleAliases,
  collectCitations,
  collectStamps,
  parseLogCitations,
  parseLogStamps,
  resolveScanGlobs,
} from "../lib/promotion-stamps.mjs";

interface FakeFs {
  readdir: (dir: string) => string[];
  exists: (path: string) => boolean;
}

interface Stamp {
  target: string;
  line: number;
}

interface Finding {
  message: string;
  file: string;
}

// ---------------------------------------------------------------------------
// LOGS_DIR / RENAMED_TARGETS
// ---------------------------------------------------------------------------

describe("LOGS_DIR", () => {
  test("is 'docs/logs'", () => {
    expect(LOGS_DIR).toBe("docs/logs");
  });

  test("type is string", () => {
    expectTypeOf(LOGS_DIR).toEqualTypeOf<string>();
  });
});

describe("RENAMED_TARGETS", () => {
  test("is a non-empty Map<string, string>", () => {
    expect(RENAMED_TARGETS).toBeInstanceOf(Map);
    expect(RENAMED_TARGETS.size).toBeGreaterThan(0);
    for (const [oldPath, newPath] of RENAMED_TARGETS) {
      expect(typeof oldPath).toBe("string");
      expect(typeof newPath).toBe("string");
    }
  });

  test("carries the three known renames", () => {
    expect(RENAMED_TARGETS.get(".claude/agents/submodule-implementer.md")).toBe(
      ".claude/agents/code-implementer.md",
    );
    expect(RENAMED_TARGETS.get(".claude/skills/sync-docs/SKILL.md")).toBe(
      ".claude/skills/syncing-docs/SKILL.md",
    );
    expect(
      RENAMED_TARGETS.get(
        ".claude/skills/vitest-coverage-types-mocks/SKILL.md",
      ),
    ).toBe(".claude/skills/vitest-testing/SKILL.md");
  });
});

// ---------------------------------------------------------------------------
// SCAN_GLOBS
// ---------------------------------------------------------------------------

describe("SCAN_GLOBS", () => {
  test("is exactly the four documented reverse-arm scan roots", () => {
    expect(SCAN_GLOBS).toEqual([
      ".claude/rules/*.md",
      ".claude/agents/*.md",
      ".claude/skills/*/SKILL.md",
      "CLAUDE.md",
    ]);
  });

  test("type is string[]", () => {
    expectTypeOf(SCAN_GLOBS).toEqualTypeOf<string[]>();
  });
});

// ---------------------------------------------------------------------------
// resolveScanGlobs
// ---------------------------------------------------------------------------

describe("resolveScanGlobs", () => {
  test("resolves a `dir/*.md` glob to every matching file in that directory", () => {
    const fs: FakeFs = {
      readdir: (dir) =>
        dir === "dir" ? ["z.md", "a.md", "notes.txt", "b.mdx"] : [],
      // Not under test here — every candidate resolves.
      exists: () => true,
    };

    expect(resolveScanGlobs(["dir/*.md"], fs)).toEqual([
      "dir/a.md",
      "dir/z.md",
    ]);
  });

  test("resolves a `dir/*/file.md` glob by expanding each subdirectory then checking existence", () => {
    const fs: FakeFs = {
      readdir: (dir) => (dir === "dir" ? ["skillA", "skillB", "skillC"] : []),
      exists: (path) =>
        path === "dir/skillA/file.md" || path === "dir/skillB/file.md",
    };

    expect(resolveScanGlobs(["dir/*/file.md"], fs)).toEqual([
      "dir/skillA/file.md",
      "dir/skillB/file.md",
    ]);
  });

  test("checks a bare literal path (no `*`) via exists only, never calling readdir", () => {
    const readdir = () => {
      throw new Error("readdir must not be called for a literal path");
    };

    expect(
      resolveScanGlobs(["CLAUDE.md"], { readdir, exists: () => true }),
    ).toEqual(["CLAUDE.md"]);
    expect(
      resolveScanGlobs(["CLAUDE.md"], { readdir, exists: () => false }),
    ).toEqual([]);
  });

  test("returns results sorted", () => {
    const fs: FakeFs = {
      readdir: (dir) => (dir === "dir" ? ["z.md", "a.md", "m.md"] : []),
      exists: () => true,
    };

    expect(resolveScanGlobs(["dir/*.md"], fs)).toEqual([
      "dir/a.md",
      "dir/m.md",
      "dir/z.md",
    ]);
  });

  test("resolves all four real SCAN_GLOBS entries at once, combining results", () => {
    const fs: FakeFs = {
      readdir: (dir) => {
        if (dir === ".claude/rules")
          return ["z-rule.md", "a-rule.md", "note.txt"];
        if (dir === ".claude/agents") return ["agent-b.md", "not-agent.json"];
        if (dir === ".claude/skills") return ["skillA", "skillB"];
        return [];
      },
      exists: (path) =>
        [
          ".claude/rules/a-rule.md",
          ".claude/rules/z-rule.md",
          ".claude/agents/agent-b.md",
          ".claude/skills/skillA/SKILL.md",
          "CLAUDE.md",
        ].includes(path),
      // .claude/skills/skillB/SKILL.md deliberately absent from the list
      // above, proving the combined call still filters non-existent entries.
    };

    expect(resolveScanGlobs(SCAN_GLOBS, fs)).toEqual([
      ".claude/agents/agent-b.md",
      ".claude/rules/a-rule.md",
      ".claude/rules/z-rule.md",
      ".claude/skills/skillA/SKILL.md",
      "CLAUDE.md",
    ]);
  });

  test("return type is string[]", () => {
    expectTypeOf(
      resolveScanGlobs([], { readdir: () => [], exists: () => true }),
    ).toEqualTypeOf<string[]>();
  });
});

// ---------------------------------------------------------------------------
// parseLogStamps
// ---------------------------------------------------------------------------

describe("parseLogStamps", () => {
  test("extracts a single bare target", () => {
    const text = "- A lesson. _(promoted → .claude/rules/tests.md)_";
    expect(parseLogStamps(text)).toEqual([
      { target: ".claude/rules/tests.md", line: 1 },
    ] satisfies Stamp[]);
  });

  test("splits a comma-separated multi-target stamp into one entry per target", () => {
    const text =
      "_(promoted → .claude/skills/implementing-scripts/SKILL.md, .claude/rules/scripts.md)_";
    expect(parseLogStamps(text)).toEqual([
      { target: ".claude/skills/implementing-scripts/SKILL.md", line: 1 },
      { target: ".claude/rules/scripts.md", line: 1 },
    ] satisfies Stamp[]);
  });

  test("splits a semicolon-separated stamp, skipping a non-path part", () => {
    const text =
      "### 5. A flake _(promoted → .claude/rules/tests.md; filed → IMPLEMENTATION.md F15)_";
    // "filed → IMPLEMENTATION.md F15" splits to a part whose leading token is
    // "filed" (not path-shaped) — skipped, not misread as a second target.
    expect(parseLogStamps(text)).toEqual([
      { target: ".claude/rules/tests.md", line: 1 },
    ] satisfies Stamp[]);
  });

  test("strips backticks around a target", () => {
    const text = "_(promoted → `.claude/rules/library-src.md`)_";
    expect(parseLogStamps(text)).toEqual([
      { target: ".claude/rules/library-src.md", line: 1 },
    ] satisfies Stamp[]);
  });

  test("takes only the leading token before a `§ Section` pointer", () => {
    const text = "_(promoted → CLAUDE.md § Forbidden Patterns)_";
    expect(parseLogStamps(text)).toEqual([
      { target: "CLAUDE.md", line: 1 },
    ] satisfies Stamp[]);
  });

  test("takes only the leading token when trailing prose follows an em-dash", () => {
    const text =
      '_(promoted → docs/contributing/subagent-context-management.md — the new "Recover" subsection names `bin/spoke-recovery.mjs` as the automated first step)_';
    expect(parseLogStamps(text)).toEqual([
      { target: "docs/contributing/subagent-context-management.md", line: 1 },
    ] satisfies Stamp[]);
  });

  test("resolves a stamp wrapped across two lines (prettier-wrapped body)", () => {
    const text = [
      "recovery started from it. _(promoted →",
      "  CLAUDE.md)_",
    ].join("\n");
    expect(parseLogStamps(text)).toEqual([
      { target: "CLAUDE.md", line: 1 },
    ] satisfies Stamp[]);
  });

  test("resolves two adjacent stamps on one line as two entries", () => {
    const text =
      "_(promoted → docs/contributing/contributing.md)_ _(promoted → .claude/skills/resolving-merge-conflicts/SKILL.md)_";
    expect(parseLogStamps(text)).toEqual([
      { target: "docs/contributing/contributing.md", line: 1 },
      { target: ".claude/skills/resolving-merge-conflicts/SKILL.md", line: 1 },
    ] satisfies Stamp[]);
  });

  test("yields nothing for a prose-only body", () => {
    const text = "_(promoted → see Lessons learned below)_";
    expect(parseLogStamps(text)).toEqual([]);
  });

  test("resolves a bare dotfile target (e.g. .gitignore)", () => {
    const text = "_(promoted → .gitignore)_";
    expect(parseLogStamps(text)).toEqual([
      { target: ".gitignore", line: 1 },
    ] satisfies Stamp[]);
  });

  test("computes a 1-indexed line number for a stamp on a later line", () => {
    const text = [
      "line one",
      "line two",
      "- lesson. _(promoted → CLAUDE.md)_",
    ].join("\n");
    expect(parseLogStamps(text)).toEqual([
      { target: "CLAUDE.md", line: 3 },
    ] satisfies Stamp[]);
  });

  test("resolves a multi-dot bare filename target (e.g. eslint.config.js)", () => {
    const text = "_(promoted → eslint.config.js)_";
    expect(parseLogStamps(text)).toEqual([
      { target: "eslint.config.js", line: 1 },
    ] satisfies Stamp[]);
  });

  test("documents that a nested `)_` inside the stamp body truncates the capture early (STAMP_RE is not balanced-paren aware)", () => {
    const text = "_(promoted → CLAUDE.md (see note)_ trailing)_";
    // Truncates at the first literal ")_" — "(see note)_" — not the real closer.
    expect(parseLogStamps(text)).toEqual([
      { target: "CLAUDE.md", line: 1 },
    ] satisfies Stamp[]);
  });

  test("skips an empty part from a doubled separator without producing a malformed entry", () => {
    const text = "_(promoted → a.md,,b.md)_";
    expect(parseLogStamps(text)).toEqual([
      { target: "a.md", line: 1 },
      { target: "b.md", line: 1 },
    ] satisfies Stamp[]);
  });

  test("return type is Stamp[]", () => {
    expectTypeOf(parseLogStamps("")).toEqualTypeOf<Stamp[]>();
  });
});

// ---------------------------------------------------------------------------
// collectStamps
// ---------------------------------------------------------------------------

describe("collectStamps", () => {
  test("tags each stamp with its source log filename", () => {
    const logs = [
      { file: "2026-01-01-a.md", text: "_(promoted → CLAUDE.md)_" },
      { file: "2026-01-02-b.md", text: "_(promoted → .gitignore)_" },
    ];
    expect(collectStamps(logs)).toEqual([
      { log: "2026-01-01-a.md", target: "CLAUDE.md", line: 1 },
      { log: "2026-01-02-b.md", target: ".gitignore", line: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// checkDeadTargets
// ---------------------------------------------------------------------------

describe("checkDeadTargets", () => {
  test("no findings when every target exists", () => {
    const stamps = [{ log: "a.md", target: "CLAUDE.md", line: 3 }];
    expect(checkDeadTargets(stamps, () => true)).toEqual([]);
  });

  test("no findings for a target resolved through RENAMED_TARGETS", () => {
    const stamps = [
      {
        log: "a.md",
        target: ".claude/agents/submodule-implementer.md",
        line: 3,
      },
    ];
    // exists() returns false for the old path — it only resolves via the map.
    expect(checkDeadTargets(stamps, () => false)).toEqual([]);
  });

  test("reports a target that neither exists nor is in RENAMED_TARGETS", () => {
    const stamps = [{ log: "2026-01-01-a.md", target: "nope.md", line: 7 }];
    const findings = checkDeadTargets(stamps, () => false) as Finding[];
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("2026-01-01-a.md:7");
    expect(finding?.message).toContain("nope.md");
    expect(finding?.file).toBe(`${LOGS_DIR}/2026-01-01-a.md`);
  });

  test("return type is Finding[]", () => {
    expectTypeOf(checkDeadTargets([], () => true)).toEqualTypeOf<Finding[]>();
  });
});

// ---------------------------------------------------------------------------
// checkStaleAliases
// ---------------------------------------------------------------------------

describe("checkStaleAliases", () => {
  test("no findings when every alias's current path exists", () => {
    expect(checkStaleAliases(() => true)).toEqual([]);
  });

  test("reports every alias when no current path exists", () => {
    const findings = checkStaleAliases(() => false);
    expect(findings).toHaveLength(RENAMED_TARGETS.size);
    for (const finding of findings as Finding[]) {
      expect(finding.file).toBe("bin/lib/promotion-stamps.mjs");
      expect(finding.message).toContain("RENAMED_TARGETS maps");
    }
  });
});

// ---------------------------------------------------------------------------
// parseLogCitations / collectCitations
// ---------------------------------------------------------------------------

describe("parseLogCitations", () => {
  test("extracts a docs/logs/<name>.md citation with its line number", () => {
    const text = [
      "intro",
      "see (`docs/logs/2026-08-14-aws-rds-data.md`).",
    ].join("\n");
    expect(parseLogCitations(text)).toEqual([
      { logFile: "2026-08-14-aws-rds-data.md", line: 2 },
    ]);
  });

  test("extracts two citations from a markdown link's text and href both containing the path", () => {
    const text =
      "[`docs/logs/README.md`](../../../docs/logs/README.md): scope note.";
    expect(parseLogCitations(text)).toEqual([
      { logFile: "README.md", line: 1 },
      { logFile: "README.md", line: 1 },
    ]);
  });

  test("returns [] when no citation is present", () => {
    expect(parseLogCitations("no logs mentioned here")).toEqual([]);
  });
});

describe("collectCitations", () => {
  test("tags each citation with its source file path", () => {
    const scannedFiles = [
      {
        path: ".claude/rules/tests.md",
        text: "(`docs/logs/2026-01-01-a.md`).",
      },
    ];
    expect(collectCitations(scannedFiles)).toEqual([
      { path: ".claude/rules/tests.md", logFile: "2026-01-01-a.md", line: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// checkDanglingCitations
// ---------------------------------------------------------------------------

describe("checkDanglingCitations", () => {
  test("no findings when every cited log exists", () => {
    const citations = [
      { path: ".claude/rules/tests.md", logFile: "2026-01-01-a.md", line: 4 },
    ];
    expect(
      checkDanglingCitations(citations, new Set(["2026-01-01-a.md"])),
    ).toEqual([]);
  });

  test("reports a citation naming a log that doesn't exist on disk", () => {
    const citations = [
      {
        path: ".claude/rules/tests.md",
        logFile: "2020-01-01-nope.md",
        line: 4,
      },
    ];
    const findings = checkDanglingCitations(citations, new Set()) as Finding[];
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding).toBeDefined();
    expect(finding?.message).toContain(".claude/rules/tests.md:4");
    expect(finding?.message).toContain("2020-01-01-nope.md");
    expect(finding?.file).toBe(".claude/rules/tests.md");
  });

  test("return type is Finding[]", () => {
    expectTypeOf(checkDanglingCitations([], new Set())).toEqualTypeOf<
      Finding[]
    >();
  });
});

// ---------------------------------------------------------------------------
// checkPromotionStamps (composition, integration smoke)
// ---------------------------------------------------------------------------

describe("checkPromotionStamps", () => {
  test("returns [] for a clean corpus", () => {
    const findings = checkPromotionStamps({
      stamps: [{ log: "a.md", target: "CLAUDE.md", line: 1 }],
      citations: [{ path: ".claude/rules/tests.md", logFile: "a.md", line: 1 }],
      exists: () => true,
      existingLogFiles: new Set(["a.md"]),
    });
    expect(findings).toEqual([]);
  });

  test("returns one finding of each kind when both arms have a violation", () => {
    const findings = checkPromotionStamps({
      stamps: [{ log: "2026-01-01-a.md", target: "gone.md", line: 5 }],
      citations: [
        {
          path: ".claude/rules/tests.md",
          logFile: "2020-01-01-nope.md",
          line: 9,
        },
      ],
      exists: () => false,
      existingLogFiles: new Set(),
    });

    // Dead target (1) + stale aliases (RENAMED_TARGETS.size, since exists()
    // is false for every path) + dangling citation (1).
    expect(findings).toHaveLength(2 + RENAMED_TARGETS.size);

    const deadTarget = findings.find((f) => f.message.includes("gone.md"));
    expect(deadTarget).toBeDefined();

    const dangling = findings.find((f) =>
      f.message.includes("2020-01-01-nope.md"),
    );
    expect(dangling).toBeDefined();
  });

  test("return type is Finding[]", () => {
    expectTypeOf(
      checkPromotionStamps({
        stamps: [],
        citations: [],
        exists: () => true,
        existingLogFiles: new Set(),
      }),
    ).toEqualTypeOf<Finding[]>();
  });
});
