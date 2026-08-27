// Unit tests for the pure helpers exported by bin/spoke-recovery.mjs
// (parseJournalEntries, outstandingPending, recommend). These are imported
// directly — no CLI invocation, no spawning git/vitest, no process.exit —
// exercising exactly the guarded-export seam the module's own header comment
// describes (the process.argv[1] guard keeps main() from running on import).
import { describe, expect, test } from "vitest";
import {
  globToRegExp,
  matchesExpected,
  outstandingPending,
  parseJournalEntries,
  recommend,
  summarizeDiffStatTotalLines,
} from "../spoke-recovery.mjs";

// bin/spoke-recovery.mjs's HOLLOW_WORK_LINE_THRESHOLD constant is not
// exported (module-private), so this mirrors its current value (3) for the
// recommend() hollowWorkCaveat tests below — keep in sync with the module if
// that constant ever changes.
const HOLLOW_WORK_LINE_THRESHOLD = 3;

type Entry = ReturnType<typeof parseJournalEntries>[number];

/** Build a journal entry fixture directly, bypassing text parsing. */
function entry(
  text: string,
  status: Entry["status"],
  marker: Entry["marker"] = "bullet",
): Entry {
  return { text, status, marker };
}

describe("parseJournalEntries", () => {
  test("checkbox done ('- [x] a') parses as a done checkbox entry", () => {
    expect(parseJournalEntries("- [x] a")).toEqual([
      { text: "a", status: "done", marker: "checkbox" },
    ]);
  });

  test("checkbox pending ('- [ ] b') parses as a pending checkbox entry", () => {
    expect(parseJournalEntries("- [ ] b")).toEqual([
      { text: "b", status: "pending", marker: "checkbox" },
    ]);
  });

  test("checkbox with uppercase X is still done", () => {
    expect(parseJournalEntries("- [X] c")).toEqual([
      { text: "c", status: "done", marker: "checkbox" },
    ]);
  });

  test("asterisk checkbox bullets are recognized the same as hyphen bullets", () => {
    expect(parseJournalEntries("* [x] d")).toEqual([
      { text: "d", status: "done", marker: "checkbox" },
    ]);
  });

  test("freeform 'DONE' bullet (no checkbox) classifies as done", () => {
    expect(parseJournalEntries("- DONE: wrote the tests")).toEqual([
      { text: "DONE: wrote the tests", status: "done", marker: "bullet" },
    ]);
  });

  test("freeform 'TASK COMPLETE' bullet classifies as done", () => {
    expect(parseJournalEntries("- Task complete: shipped the handler")).toEqual(
      [
        {
          text: "Task complete: shipped the handler",
          status: "done",
          marker: "bullet",
        },
      ],
    );
  });

  test("a checkmark glyph (✓) classifies as done even without the word", () => {
    expect(parseJournalEntries("- ✓ wired the export")).toEqual([
      { text: "✓ wired the export", status: "done", marker: "bullet" },
    ]);
  });

  test("a 'Next:' bullet classifies as pending", () => {
    expect(parseJournalEntries("- Next: write the failure-path test")).toEqual([
      {
        text: "Next: write the failure-path test",
        status: "pending",
        marker: "bullet",
      },
    ]);
  });

  test.each([
    [
      "- Not done yet: still writing the failure-path test",
      "Not done yet: still writing the failure-path test",
    ],
    ["- Isn't done: waiting on review", "Isn't done: waiting on review"],
    [
      "- Not yet done: wiring up the recommend branch",
      "Not yet done: wiring up the recommend branch",
    ],
  ])(
    "a negated completion claim ('%s') classifies as pending, not done, even though it contains 'done'",
    (line, expectedText) => {
      expect(parseJournalEntries(line)).toEqual([
        { text: expectedText, status: "pending", marker: "bullet" },
      ]);
    },
  );

  test("numbered-list bullets are recognized with the same classification rules", () => {
    expect(parseJournalEntries("1. Blocked on missing fixture")).toEqual([
      {
        text: "Blocked on missing fixture",
        status: "pending",
        marker: "bullet",
      },
    ]);
  });

  test("a bullet with neither a done nor pending keyword classifies as unknown", () => {
    expect(parseJournalEntries("- Reviewed the diff")).toEqual([
      { text: "Reviewed the diff", status: "unknown", marker: "bullet" },
    ]);
  });

  test("non-bullet noise (headings, prose, blank lines) is silently skipped", () => {
    const content = [
      "# Spoke journal",
      "",
      "This is just a prose paragraph explaining context.",
      "- [x] the only real entry",
      "",
      "Some trailing prose.",
    ].join("\n");
    expect(parseJournalEntries(content)).toEqual([
      { text: "the only real entry", status: "done", marker: "checkbox" },
    ]);
  });

  test("parses a multi-line journal into an ordered list preserving source order", () => {
    const content = [
      "- [x] read the contract",
      "- [ ] write the happy path",
      "- Next: write the failure path",
      "- DONE: happy path test written",
    ].join("\n");
    expect(parseJournalEntries(content)).toEqual([
      { text: "read the contract", status: "done", marker: "checkbox" },
      { text: "write the happy path", status: "pending", marker: "checkbox" },
      {
        text: "Next: write the failure path",
        status: "pending",
        marker: "bullet",
      },
      {
        text: "DONE: happy path test written",
        status: "done",
        marker: "bullet",
      },
    ]);
  });
});

describe("outstandingPending", () => {
  test("a pending entry AFTER the last done entry is outstanding", () => {
    const entries = [
      entry("read contract", "done"),
      entry("write failure path test", "pending"),
    ];
    expect(outstandingPending(entries)).toEqual([
      entry("write failure path test", "pending"),
    ]);
  });

  test("a stale pending entry BEFORE a later done entry is excluded", () => {
    const entries = [
      entry("write happy path", "pending"),
      entry("happy path written", "done"),
    ];
    expect(outstandingPending(entries)).toEqual([]);
  });

  test("mixed: stale pending before the last done is excluded, pending after it is kept", () => {
    const entries = [
      entry("write happy path", "pending"),
      entry("happy path written", "done"),
      entry("write failure path", "pending"),
    ];
    expect(outstandingPending(entries)).toEqual([
      entry("write failure path", "pending"),
    ]);
  });

  test("all entries done → no outstanding pendings", () => {
    const entries = [entry("step one", "done"), entry("step two", "done")];
    expect(outstandingPending(entries)).toEqual([]);
  });

  test("no done entry at all → every pending entry is outstanding", () => {
    const entries = [
      entry("started step one", "pending"),
      entry("blocked on step two", "pending"),
    ];
    expect(outstandingPending(entries)).toEqual(entries);
  });

  test("an empty entries array → empty result", () => {
    expect(outstandingPending([])).toEqual([]);
  });

  test("'unknown'-classified entries never count as outstanding", () => {
    const entries = [
      entry("read the diff", "unknown"),
      entry("something still open", "pending"),
    ];
    expect(outstandingPending(entries)).toEqual([
      entry("something still open", "pending"),
    ]);
  });

  test("a negated-done entry parsed after the last done entry surfaces as outstanding", () => {
    const content = [
      "- [x] wrote the parser",
      "- Not yet done: wire up the recommend branch",
    ].join("\n");
    const entries = parseJournalEntries(content);
    expect(outstandingPending(entries)).toEqual([
      {
        text: "Not yet done: wire up the recommend branch",
        status: "pending",
        marker: "bullet",
      },
    ]);
  });
});

describe("summarizeDiffStatTotalLines", () => {
  test("a realistic multi-file summary line sums insertions and deletions", () => {
    expect(
      summarizeDiffStatTotalLines(
        "5 files changed, 12 insertions(+), 3 deletions(-)",
      ),
    ).toBe(15);
  });

  test("insertions only, no deletions clause", () => {
    expect(summarizeDiffStatTotalLines("1 file changed, 2 insertions(+)")).toBe(
      2,
    );
  });

  test("deletions only, no insertions clause", () => {
    expect(summarizeDiffStatTotalLines("1 file changed, 1 deletion(-)")).toBe(
      1,
    );
  });

  test("singular grammar ('1 insertion(+), 1 deletion(-)') is matched the same as the plural forms", () => {
    expect(
      summarizeDiffStatTotalLines(
        "1 file changed, 1 insertion(+), 1 deletion(-)",
      ),
    ).toBe(2);
  });

  test("only the LAST (summary) line is parsed, not per-file stat lines above it", () => {
    const raw = [
      " a.ts | 3 +--",
      " b.ts | 1 +",
      " 2 files changed, 3 insertions(+), 1 deletion(-)",
    ].join("\n");
    expect(summarizeDiffStatTotalLines(raw)).toBe(4);
  });

  test("empty string input returns null", () => {
    expect(summarizeDiffStatTotalLines("")).toBeNull();
  });

  test("a string with no recognizable summary line returns null", () => {
    expect(summarizeDiffStatTotalLines("   \n  ")).toBeNull();
    expect(
      summarizeDiffStatTotalLines("fatal: not a git repository"),
    ).toBeNull();
  });
});

describe("recommend", () => {
  test("disk.verified:false → action 'unverifiable', rationale explains why and includes the git error", () => {
    const result = recommend(
      { entries: [entry("wrote the tests", "done")] },
      {
        modified: ["packages/m3l-common/tests/foo.test.ts"],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: false,
        error: "not a git repository",
      },
      null,
    );
    expect(result.action).toBe("unverifiable");
    expect(result.punchList).toEqual([]);
    expect(result.rationale).toContain("could not be verified");
    expect(result.rationale).toContain("not a git repository");
  });

  test("disk.verified:false with a null error still recommends 'unverifiable' (no error text required)", () => {
    const result = recommend(
      { entries: [entry("wrote the tests", "done")] },
      {
        modified: [],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: false,
        error: null,
      },
      null,
    );
    expect(result.action).toBe("unverifiable");
    expect(result.rationale).toContain("could not be verified");
  });

  test("unverifiable disk state takes precedence over the no-modified-files contradiction", () => {
    const result = recommend(
      { entries: [entry("wrote the tests", "done")] },
      {
        // modified: [] would, on its own, trigger the "NO modified files"
        // redispatch branch below — verified:false must be checked first.
        modified: [],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: false,
        error: "git status --porcelain failed",
      },
      null,
    );
    expect(result.action).toBe("unverifiable");
    expect(result.rationale).not.toContain("contradicts the journal");
  });

  test("empty journal entries → redispatch with no punch-list", () => {
    const result = recommend(
      { entries: [] },
      {
        modified: [],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: true,
        error: null,
      },
      null,
    );
    expect(result.action).toBe("redispatch");
    expect(result.punchList).toEqual([]);
    expect(result.rationale).toContain("no parseable progress markers");
  });

  test("journal shows progress but disk has NO modified files → redispatch (on-disk contradiction)", () => {
    const result = recommend(
      { entries: [entry("wrote the tests", "done")] },
      {
        modified: [],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: true,
        error: null,
      },
      null,
    );
    expect(result.action).toBe("redispatch");
    expect(result.punchList).toEqual([]);
    expect(result.rationale).toContain("NO");
    expect(result.rationale).toContain("contradicts the journal");
  });

  test("expected-given-but-all-untouched contradiction → redispatch even though other files changed", () => {
    const result = recommend(
      { entries: [entry("wrote the tests", "done")] },
      {
        modified: ["some/unrelated/file.ts"],
        untouchedExpected: ["src/a.ts", "src/b.ts"],
        expectedGiven: true,
        expectedTotal: 2,
        verified: true,
        error: null,
      },
      null,
    );
    expect(result.action).toBe("redispatch");
    expect(result.punchList).toEqual([]);
    expect(result.rationale).toContain("NONE of the --expected paths");
  });

  test("partial verified progress + matching disk state → resume with the outstanding punch-list", () => {
    const result = recommend(
      {
        entries: [
          entry("read contract", "done"),
          entry("write failure path test", "pending"),
        ],
      },
      {
        modified: ["packages/m3l-common/tests/foo.test.ts"],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: true,
        error: null,
      },
      null,
    );
    expect(result.action).toBe("resume");
    expect(result.punchList).toEqual(["write failure path test"]);
    expect(result.rationale).toContain("Resume the SAME spoke");
  });

  test("all done, nothing outstanding, disk corroborates → none", () => {
    const result = recommend(
      { entries: [entry("everything shipped", "done")] },
      {
        modified: ["packages/m3l-common/tests/foo.test.ts"],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: true,
        error: null,
      },
      null,
    );
    expect(result.action).toBe("none");
    expect(result.punchList).toEqual([]);
    expect(result.rationale).toContain("no recovery action needed");
    expect(result.rationale).not.toContain("targeted test run passed");
  });

  test("all done + a passing tests result → none, rationale mentions the passing test run", () => {
    const result = recommend(
      { entries: [entry("everything shipped", "done")] },
      {
        modified: ["packages/m3l-common/tests/foo.test.ts"],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: true,
        error: null,
      },
      {
        command: "pnpm vitest run --reporter=json foo",
        pass: true,
        total: 3,
        passed: 3,
        failed: 0,
        raw: "",
      },
    );
    expect(result.action).toBe("none");
    expect(result.rationale).toContain("targeted test run passed");
  });

  test("no outstanding pendings but a failing tests result → resume with a fix-failing-tests punch-list", () => {
    const result = recommend(
      { entries: [entry("everything shipped", "done")] },
      {
        modified: ["packages/m3l-common/tests/foo.test.ts"],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: true,
        error: null,
      },
      {
        command: "pnpm vitest run --reporter=json foo",
        pass: false,
        total: 3,
        passed: 2,
        failed: 1,
        raw: "1 failing",
      },
    );
    expect(result.action).toBe("resume");
    expect(result.punchList).toEqual([
      "Fix failing tests: pnpm vitest run --reporter=json foo",
    ]);
    expect(result.rationale).toContain("targeted test run failed");
  });

  test("outstanding pendings AND a failing tests result → punch-list uses the pendings, not the fallback message", () => {
    const result = recommend(
      {
        entries: [
          entry("read contract", "done"),
          entry("write failure path test", "pending"),
        ],
      },
      {
        modified: ["packages/m3l-common/tests/foo.test.ts"],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: true,
        error: null,
      },
      {
        command: "pnpm vitest run --reporter=json foo",
        pass: false,
        total: 3,
        passed: 2,
        failed: 1,
        raw: "1 failing",
      },
    );
    expect(result.action).toBe("resume");
    expect(result.punchList).toEqual(["write failure path test"]);
  });

  test("no outstanding pendings but some --expected paths still untouched → resume, punch-list names them", () => {
    const result = recommend(
      { entries: [entry("everything I logged is done", "done")] },
      {
        modified: ["packages/m3l-common/tests/foo.test.ts"],
        untouchedExpected: ["packages/m3l-common/src/core/bar/index.ts"],
        expectedGiven: true,
        expectedTotal: 2,
        verified: true,
        error: null,
      },
      null,
    );
    expect(result.action).toBe("resume");
    expect(result.punchList).toEqual([
      "Not yet touched on disk: packages/m3l-common/src/core/bar/index.ts",
    ]);
    expect(result.rationale).toContain("resume the SAME spoke");
  });

  test("resume + diffStatTotalLines at the hollow-work threshold → rationale carries the caveat", () => {
    const result = recommend(
      {
        entries: [
          entry("read contract", "done"),
          entry("write failure path test", "pending"),
        ],
      },
      {
        modified: ["packages/m3l-common/tests/foo.test.ts"],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: true,
        error: null,
        diffStatTotalLines: HOLLOW_WORK_LINE_THRESHOLD,
      },
      null,
    );
    expect(result.action).toBe("resume");
    expect(result.rationale).toContain("Caveat");
    expect(result.rationale).toContain("hollow-work");
  });

  test("resume + diffStatTotalLines comfortably above the threshold → no caveat in the rationale", () => {
    const result = recommend(
      {
        entries: [
          entry("read contract", "done"),
          entry("write failure path test", "pending"),
        ],
      },
      {
        modified: ["packages/m3l-common/tests/foo.test.ts"],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: true,
        error: null,
        diffStatTotalLines: HOLLOW_WORK_LINE_THRESHOLD + 100,
      },
      null,
    );
    expect(result.action).toBe("resume");
    expect(result.rationale).not.toContain("Caveat");
    expect(result.rationale).not.toContain("hollow-work");
  });

  test("resume + diffStatTotalLines omitted (undefined) → no caveat, matching every pre-existing fixture's shape", () => {
    const result = recommend(
      {
        entries: [
          entry("read contract", "done"),
          entry("write failure path test", "pending"),
        ],
      },
      {
        modified: ["packages/m3l-common/tests/foo.test.ts"],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: true,
        error: null,
        // diffStatTotalLines deliberately omitted — proves the new optional
        // field is backward-compatible with every existing disk fixture in
        // this file that never sets it.
      },
      null,
    );
    expect(result.action).toBe("resume");
    expect(result.rationale).not.toContain("Caveat");
    expect(result.rationale).not.toContain("hollow-work");
  });

  test("action 'none' + diffStatTotalLines at the hollow-work threshold → rationale still carries the caveat", () => {
    const result = recommend(
      { entries: [entry("everything shipped", "done")] },
      {
        modified: ["packages/m3l-common/tests/foo.test.ts"],
        untouchedExpected: [],
        expectedGiven: false,
        expectedTotal: 0,
        verified: true,
        error: null,
        diffStatTotalLines: HOLLOW_WORK_LINE_THRESHOLD,
      },
      null,
    );
    expect(result.action).toBe("none");
    expect(result.rationale).toContain("Caveat");
    expect(result.rationale).toContain("hollow-work");
  });
});

describe("globToRegExp", () => {
  test("a literal (wildcard-free) pattern anchors to an exact match", () => {
    const regex = globToRegExp("src/a.ts");
    expect(regex.test("src/a.ts")).toBe(true);
    expect(regex.test("src/a.ts.bak")).toBe(false);
    expect(regex.test("other/src/a.ts")).toBe(false);
  });

  test("a single '*' matches within one path segment only", () => {
    const regex = globToRegExp("src/*.ts");
    expect(regex.test("src/a.ts")).toBe(true);
    expect(regex.test("src/sub/a.ts")).toBe(false);
  });

  test("'**' matches across multiple path segments", () => {
    const regex = globToRegExp("src/**/*.ts");
    expect(regex.test("src/a.ts")).toBe(false);
    expect(regex.test("src/sub/dir/a.ts")).toBe(true);
  });

  test("regex-special characters in the pattern are escaped, not treated as regex syntax", () => {
    const regex = globToRegExp("src/a+b.ts");
    expect(regex.test("src/a+b.ts")).toBe(true);
    // If '+' were left as a regex quantifier ("one or more 'a's") this would
    // wrongly match — proving it was escaped to a literal '+' instead.
    expect(regex.test("src/aab.ts")).toBe(false);
  });
});

describe("matchesExpected", () => {
  test("an exact literal match", () => {
    expect(matchesExpected("src/a.ts", "src/a.ts")).toBe(true);
  });

  test("a non-match against an unrelated literal path", () => {
    expect(matchesExpected("src/other.ts", "src/a.ts")).toBe(false);
  });

  test("a wildcard-free directory pattern matches a file inside that directory", () => {
    expect(
      matchesExpected(
        "packages/m3l-common/src/core/retry/index.ts",
        "packages/m3l-common/src/core/retry",
      ),
    ).toBe(true);
  });

  test("a wildcard-free pattern does NOT fall back to a directory-prefix match when the pattern contains '*'", () => {
    expect(matchesExpected("src/sub/a.ts", "src/*.ts")).toBe(false);
  });

  test("a single-segment glob matches a file directly in that segment", () => {
    expect(matchesExpected("src/a.ts", "src/*.ts")).toBe(true);
  });

  test("a '**' glob matches nested files across segments", () => {
    expect(matchesExpected("src/sub/dir/a.ts", "src/**/*.ts")).toBe(true);
  });

  test("a Windows-style backslash path is normalized before matching", () => {
    expect(matchesExpected("src\\a.ts", "src/a.ts")).toBe(true);
  });
});
