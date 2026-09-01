import { describe, expect, test } from "vitest";
import {
  INDEX_BYTE_CAP,
  INDEX_LINE_CAP,
  MEMORY_TYPES,
  SWEEP_BACKLOG_THRESHOLD,
  SWEEP_STALENESS_THRESHOLD_DAYS,
  checkFrontmatter,
  checkIndexBudget,
  checkIndexReconciliation,
  checkMemoryStore,
  checkWikilinks,
  evaluateSweepFreshness,
  parseIndexEntries,
  parseMemoryFrontmatter,
  parseSweepHeader,
  readMemoryStore,
  resolveMemoryDir,
  runRetrospectiveCheck,
} from "../../bin/check-retrospective.mjs";
import { createReporter } from "../../bin/lib/report.mjs";

const encoder = new TextEncoder();

/** A well-formed memory file, the baseline every mutation case departs from. */
function memory(
  name: string,
  overrides: { type?: string; body?: string; description?: string } = {},
): { path: string; contents: string; bytes: Uint8Array } {
  const contents =
    `---\n` +
    `name: ${name}\n` +
    `description: ${overrides.description ?? `about ${name}`}\n` +
    `metadata:\n` +
    `  node_type: memory\n` +
    `  type: ${overrides.type ?? "project"}\n` +
    `---\n\n` +
    `${overrides.body ?? "The durable fact."}\n`;
  return { path: `${name}.md`, contents, bytes: encoder.encode(contents) };
}

/** A MEMORY.md indexing exactly the given slugs. */
function index(slugs: string[]): string {
  return (
    slugs.map((slug) => `- [${slug}](${slug}.md) — hook`).join("\n") + "\n"
  );
}

/** A clean two-memory store — the fixture a mutation is applied to. */
function cleanStore() {
  return {
    indexContents: index(["alpha", "beta"]),
    files: [memory("alpha"), memory("beta")],
  };
}

describe("the clean baseline", () => {
  test("a well-formed store produces no findings at all", () => {
    expect(checkMemoryStore(cleanStore())).toEqual([]);
  });
});

describe("parseIndexEntries", () => {
  test("extracts every link target in document order", () => {
    expect(parseIndexEntries(index(["alpha", "beta"]))).toEqual([
      "alpha.md",
      "beta.md",
    ]);
  });

  test("ignores prose that is not a list entry", () => {
    expect(
      parseIndexEntries("Some [inline link](nope.md) in a paragraph.\n"),
    ).toEqual([]);
  });
});

describe("parseMemoryFrontmatter", () => {
  test("reads name, description and the nested metadata.type", () => {
    expect(parseMemoryFrontmatter(memory("alpha").contents)).toEqual({
      name: "alpha",
      description: "about alpha",
      type: "project",
    });
  });

  test("strips surrounding quotes from a quoted description", () => {
    const contents = `---\nname: a\ndescription: "quoted"\nmetadata:\n  type: user\n---\n`;
    expect(parseMemoryFrontmatter(contents).description).toBe("quoted");
  });

  test("does not mistake a sibling key ending in 'type' for metadata.type", () => {
    const contents = `---\nname: a\ndescription: d\nmetadata:\n  node_type: memory\n---\n`;
    expect(parseMemoryFrontmatter(contents).type).toBeNull();
  });

  test("returns nulls rather than throwing on a file with no frontmatter", () => {
    expect(parseMemoryFrontmatter("just prose\n")).toEqual({
      name: null,
      description: null,
      type: null,
    });
  });
});

// MUTATION: remove a file from the index / remove an indexed file from disk.
describe("checkIndexReconciliation", () => {
  test("clean when both sides agree", () => {
    expect(
      checkIndexReconciliation(
        ["alpha.md", "beta.md"],
        ["alpha.md", "beta.md"],
      ),
    ).toEqual([]);
  });

  test("MUTATION: a file dropped from MEMORY.md is reported as an orphan", () => {
    const findings = checkIndexReconciliation(
      ["alpha.md"],
      ["alpha.md", "beta.md"],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("beta.md");
    expect(findings[0]).toContain("never recalled");
  });

  test("MUTATION: an index entry whose file is gone is reported as dangling", () => {
    const findings = checkIndexReconciliation(
      ["alpha.md", "gone.md"],
      ["alpha.md"],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("gone.md");
    expect(findings[0]).toContain("does not exist");
  });

  test("reports both directions independently when both have drifted", () => {
    expect(checkIndexReconciliation(["gone.md"], ["orphan.md"])).toHaveLength(
      2,
    );
  });

  test("compares by basename, so a path-prefixed index entry still matches", () => {
    expect(checkIndexReconciliation(["./alpha.md"], ["alpha.md"])).toEqual([]);
  });
});

// MUTATION: corrupt a file with the exact bytes that corrupted the real store.
describe("control-byte scanning (the check:control-chars blind spot)", () => {
  test("MUTATION: a literal NUL in a memory file is reported", () => {
    const store = cleanStore();
    const corrupt = `---\nname: beta\ndescription: d\nmetadata:\n  type: project\n---\n\nregex \x00 here\n`;
    store.files[1] = {
      path: "beta.md",
      contents: corrupt,
      bytes: encoder.encode(corrupt),
    };

    const findings = checkMemoryStore(store);
    expect(findings.some((f) => f.includes("literal control byte"))).toBe(true);
    expect(findings.some((f) => f.includes("beta.md"))).toBe(true);
  });

  test("MUTATION: the real-world 0x00 + 0x1f pair is reported", () => {
    const store = cleanStore();
    const corrupt = `---\nname: beta\ndescription: d\nmetadata:\n  type: project\n---\n\n\`/[\x00-\x1f-]/g\`\n`;
    store.files[1] = {
      path: "beta.md",
      contents: corrupt,
      bytes: encoder.encode(corrupt),
    };
    expect(
      checkMemoryStore(store).some((f) => f.includes("2 literal control byte")),
    ).toBe(true);
  });

  test("a control character written as an escape SEQUENCE is not a finding", () => {
    const store = cleanStore();
    const escaped = String.raw`regex /[\x00-\x1f]/g`;
    const contents = memory("beta", { body: escaped }).contents;
    store.files[1] = {
      path: "beta.md",
      contents,
      bytes: encoder.encode(contents),
    };
    expect(checkMemoryStore(store)).toEqual([]);
  });
});

// MUTATION: strip each required frontmatter field, and typo the type.
describe("checkFrontmatter", () => {
  test("clean for a well-formed file", () => {
    expect(checkFrontmatter([memory("alpha")])).toEqual([]);
  });

  test.each([...MEMORY_TYPES])("accepts the documented type %s", (type) => {
    expect(checkFrontmatter([memory("alpha", { type })])).toEqual([]);
  });

  test("MUTATION: a type outside the four documented values is reported", () => {
    const findings = checkFrontmatter([memory("alpha", { type: "projekt" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("projekt");
    expect(findings[0]).toContain("unreachable");
  });

  test("MUTATION: a missing description is reported", () => {
    const contents = `---\nname: alpha\nmetadata:\n  type: project\n---\n`;
    const findings = checkFrontmatter([{ path: "alpha.md", contents }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("no `description:`");
  });

  test("MUTATION: a missing name is reported", () => {
    const contents = `---\ndescription: d\nmetadata:\n  type: project\n---\n`;
    expect(checkFrontmatter([{ path: "alpha.md", contents }])[0]).toContain(
      "no `name:`",
    );
  });

  test("MUTATION: a missing metadata.type is reported", () => {
    const contents = `---\nname: alpha\ndescription: d\n---\n`;
    expect(checkFrontmatter([{ path: "alpha.md", contents }])[0]).toContain(
      "no `metadata.type:`",
    );
  });

  test("collapses several problems in one file into a single finding", () => {
    expect(
      checkFrontmatter([{ path: "a.md", contents: "prose\n" }]),
    ).toHaveLength(1);
  });
});

// MUTATION: point a wikilink at a slug no memory declares.
describe("checkWikilinks", () => {
  const names = new Set(["alpha", "beta"]);

  test("clean when every link resolves", () => {
    expect(
      checkWikilinks([memory("alpha", { body: "see [[beta]]" })], names),
    ).toEqual([]);
  });

  test("MUTATION: a link to a non-existent memory is reported", () => {
    const findings = checkWikilinks(
      [memory("alpha", { body: "see [[build-pipeline]]" })],
      names,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("[[build-pipeline]]");
  });

  test("does NOT report a zsh [[ -o login ]] test as a broken link", () => {
    expect(
      checkWikilinks(
        [memory("alpha", { body: "guarded by `[[ -o login ]]` in .zshrc" })],
        names,
      ),
    ).toEqual([]);
  });

  test("does not report a bash [[ -f file ]] test either", () => {
    expect(
      checkWikilinks([memory("alpha", { body: "`[[ -f x ]] && y`" })], names),
    ).toEqual([]);
  });

  test("deduplicates a slug linked twice in one file", () => {
    const findings = checkWikilinks(
      [memory("alpha", { body: "[[ghost]] and again [[ghost]]" })],
      names,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("1 memor");
  });
});

// MUTATION: grow MEMORY.md past the warn ratio and past the cap.
describe("checkIndexBudget", () => {
  test("silent well under both caps", () => {
    expect(checkIndexBudget("- [a](a.md)\n")).toEqual([]);
  });

  test("MUTATION: over the line cap is reported as a breach", () => {
    const findings = checkIndexBudget("x\n".repeat(INDEX_LINE_CAP + 10));
    expect(findings.some((f) => f.includes("over the"))).toBe(true);
    expect(findings.some((f) => f.includes("lines"))).toBe(true);
  });

  test("MUTATION: at 80% of the line cap is reported as approaching", () => {
    const findings = checkIndexBudget("x\n".repeat(INDEX_LINE_CAP * 0.8));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("% of the");
    expect(findings[0]).not.toContain("over the");
  });

  test("MUTATION: over the byte cap is reported even with few lines", () => {
    const findings = checkIndexBudget("x".repeat(INDEX_BYTE_CAP + 1));
    expect(findings.some((f) => f.includes("bytes"))).toBe(true);
    expect(findings.some((f) => f.includes("over the"))).toBe(true);
  });

  test("counts BYTES, not characters, for a multi-byte index", () => {
    const findings = checkIndexBudget("é".repeat(INDEX_BYTE_CAP - 100));
    expect(findings.some((f) => f.includes("over the"))).toBe(true);
  });
});

describe("parseSweepHeader", () => {
  test("reads last-swept and logs-considered", () => {
    expect(
      parseSweepHeader(
        "<!-- retrospective: last-swept=2026-09-01 logs-considered=112 -->\n",
      ),
    ).toEqual({ lastSwept: "2026-09-01", logsConsidered: 112 });
  });

  test("returns null when the header is absent", () => {
    expect(parseSweepHeader("# Tracker\n")).toBeNull();
  });

  test("surfaces a non-numeric logs-considered as null rather than NaN", () => {
    expect(
      parseSweepHeader(
        "<!-- retrospective: last-swept=unset logs-considered=none -->",
      ),
    ).toEqual({ lastSwept: "unset", logsConsidered: null });
  });
});

describe("evaluateSweepFreshness", () => {
  const now = new Date("2026-09-01T00:00:00Z");

  test("clean when swept recently with no backlog", () => {
    expect(
      evaluateSweepFreshness(
        { lastSwept: "2026-08-30", logsConsidered: 112 },
        112,
        now,
      ),
    ).toEqual([]);
  });

  test("MUTATION: a missing header is reported", () => {
    expect(evaluateSweepFreshness(null, 112, now)[0]).toContain("no parseable");
  });

  test("MUTATION: last-swept=unset warns immediately, never reads as fresh", () => {
    const findings = evaluateSweepFreshness(
      { lastSwept: "unset", logsConsidered: 112 },
      112,
      now,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("never been swept");
  });

  test("MUTATION: a backlog at the cadence threshold is reported", () => {
    const findings = evaluateSweepFreshness(
      { lastSwept: "2026-08-30", logsConsidered: 112 },
      112 + SWEEP_BACKLOG_THRESHOLD,
      now,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("have not been swept");
    expect(findings[0]).toContain("/promoting-work-log-lessons");
  });

  test("a backlog one under the threshold stays silent", () => {
    expect(
      evaluateSweepFreshness(
        { lastSwept: "2026-08-30", logsConsidered: 112 },
        112 + SWEEP_BACKLOG_THRESHOLD - 1,
        now,
      ),
    ).toEqual([]);
  });

  test("MUTATION: a sweep older than the staleness threshold is reported", () => {
    const stale = new Date(now);
    stale.setUTCDate(stale.getUTCDate() + SWEEP_STALENESS_THRESHOLD_DAYS + 1);
    const findings = evaluateSweepFreshness(
      { lastSwept: "2026-09-01", logsConsidered: 112 },
      112,
      stale,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("over the");
  });

  test("MUTATION: an unparseable date is reported, not silently treated as fresh", () => {
    expect(
      evaluateSweepFreshness(
        { lastSwept: "last-tuesday", logsConsidered: 112 },
        112,
        now,
      )[0],
    ).toContain("not a parseable");
  });

  test("MUTATION: a non-numeric logs-considered is reported", () => {
    expect(
      evaluateSweepFreshness(
        { lastSwept: "2026-08-30", logsConsidered: null },
        112,
        now,
      )[0],
    ).toContain("backlog cannot be computed");
  });

  test("reports backlog AND staleness together when both apply", () => {
    expect(
      evaluateSweepFreshness(
        { lastSwept: "unset", logsConsidered: 0 },
        112,
        now,
      ),
    ).toHaveLength(2);
  });
});

describe("resolveMemoryDir", () => {
  test("is the shared project dir plus memory/", () => {
    expect(
      resolveMemoryDir(() => "/home/u/workspaces/proj/.git\n", "/home/u"),
    ).toBe("/home/u/.claude/projects/-home-u-workspaces-proj/memory");
  });

  test("asks git for the COMMON dir, so a worktree shares one store", () => {
    const calls: string[][] = [];
    resolveMemoryDir((args) => {
      calls.push(args);
      return "/home/u/workspaces/proj/.git\n";
    }, "/home/u");
    expect(calls[0]).toContain("--git-common-dir");
    expect(calls[0]).not.toContain("--git-dir");
  });
});

describe("readMemoryStore", () => {
  const files: Record<string, string> = {
    "/store/MEMORY.md": index(["alpha"]),
    "/store/alpha.md": memory("alpha").contents,
    "/store/notes.txt": "ignored",
  };
  const fs = {
    readdir: () => Object.keys(files).map((p) => p.slice("/store/".length)),
    readFile: (path: string) => Buffer.from(files[path] ?? "", "utf8"),
  };

  test("reads every .md except MEMORY.md, and keeps raw bytes", () => {
    const store = readMemoryStore("/store", fs as never);
    expect(store.files.map((f) => f.path)).toEqual(["alpha.md"]);
    expect(store.files.at(0)?.bytes).toBeInstanceOf(Uint8Array);
    expect(store.indexContents).toContain("alpha");
  });

  test("skips non-markdown files", () => {
    expect(
      readMemoryStore("/store", fs as never).files.some((f) =>
        f.path.endsWith(".txt"),
      ),
    ).toBe(false);
  });
});

describe("runRetrospectiveCheck", () => {
  const now = new Date("2026-09-01T00:00:00Z");
  const freshTracker =
    "<!-- retrospective: last-swept=2026-08-30 logs-considered=112 -->\n";

  function run(overrides: Record<string, unknown> = {}) {
    const reporter = createReporter(true);
    const outcome = runRetrospectiveCheck({
      memoryDir: "/store",
      readMemory: () => cleanStore(),
      readTracker: () => freshTracker,
      countLogs: () => 112,
      now,
      reporter,
      ...overrides,
    });
    return { outcome, reporter };
  }

  test("ok on a healthy store and an in-cadence sweep", () => {
    const { outcome } = run();
    expect(outcome.ok).toBe(true);
    expect(outcome.findings).toEqual([]);
    expect(outcome.scanned).toBe(2);
  });

  test("THE CI CONDITION: an absent memory store warns and does not throw", () => {
    const { outcome } = run({
      readMemory: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.findings).toEqual([]);
    expect(outcome.scanned).toBe(0);
  });

  test("an absent tracker warns rather than failing the section", () => {
    const { outcome } = run({
      readTracker: () => {
        throw new Error("ENOENT");
      },
    });
    expect(outcome.ok).toBe(true);
  });

  test("MUTATION: a defect in the store makes the outcome not ok", () => {
    const { outcome } = run({
      readMemory: () => ({
        indexContents: index(["alpha"]),
        files: [memory("alpha"), memory("beta")],
      }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.some((f: string) => f.includes("beta.md"))).toBe(
      true,
    );
  });

  test("routes every finding through the reporter as a WARNING, never an error", () => {
    const { outcome, reporter } = run({
      readTracker: () =>
        "<!-- retrospective: last-swept=unset logs-considered=0 -->\n",
    });
    const payload = reporter.finish();
    expect(outcome.ok).toBe(false);
    expect(payload["errors"]).toEqual([]);
    expect(payload["warnings"]).not.toHaveLength(0);
    // report.ok stays true: this gate never blocks a push.
    expect(payload["ok"]).toBe(true);
  });

  test("both sections contribute findings to one list", () => {
    const { outcome } = run({
      readMemory: () => ({
        indexContents: index(["alpha"]),
        files: [memory("alpha"), memory("beta")],
      }),
      readTracker: () =>
        "<!-- retrospective: last-swept=unset logs-considered=0 -->\n",
    });
    expect(outcome.findings.length).toBeGreaterThanOrEqual(2);
  });
});
