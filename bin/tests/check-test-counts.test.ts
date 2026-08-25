import { afterEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Mock setup for collectTests (node:child_process + node:fs)
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: h.spawnSync,
}));

// Spread the actual fs so vi.spyOn can intercept individual methods
// (ESM namespace objects are non-writable by default — the spread makes them
// plain, writable object properties, following the pattern in
// bin/tests/reference-index.test.ts).
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  collectTests,
  countsByFile,
  diffCounts,
  findUncountedFiles,
  formatCollectFailure,
  formatMismatch,
  parseRecordedCounts,
} from "../../bin/check-test-counts.mjs";

// ---------------------------------------------------------------------------
// countsByFile
// ---------------------------------------------------------------------------

describe("countsByFile", () => {
  test("counts entries per file and strips .test.ts from the submodule name", () => {
    const collected = [
      { file: "/repo/packages/m3l-common/tests/polling.test.ts" },
      { file: "/repo/packages/m3l-common/tests/polling.test.ts" },
      { file: "/repo/packages/m3l-common/tests/retry.test.ts" },
    ];
    const result = countsByFile(collected);
    expect(result.get("polling")).toBe(2);
    expect(result.get("retry")).toBe(1);
  });

  test("skips entries without a file field", () => {
    const collected = [
      { file: "/repo/packages/m3l-common/tests/polling.test.ts" },
      {},
      { file: "" },
    ];
    const result = countsByFile(collected);
    expect(result.size).toBe(1);
    expect(result.get("polling")).toBe(1);
  });

  test("returns an empty map for undefined input", () => {
    expect(countsByFile(undefined).size).toBe(0);
  });

  test("returns an empty map for an empty array", () => {
    expect(countsByFile([]).size).toBe(0);
  });

  test("counts individual entries, not a length field", () => {
    // Providing three distinct entries for the same file should yield 3,
    // proving the function increments per-entry rather than reading .length once.
    const entry = { file: "/repo/packages/m3l-common/tests/config.test.ts" };
    const result = countsByFile([entry, entry, entry]);
    expect(result.get("config")).toBe(3);
  });

  test("handles multiple files simultaneously", () => {
    const collected = [
      { file: "/a/tests/alpha.test.ts" },
      { file: "/a/tests/beta.test.ts" },
      { file: "/a/tests/alpha.test.ts" },
      { file: "/a/tests/gamma.test.ts" },
    ];
    const result = countsByFile(collected);
    expect(result.get("alpha")).toBe(2);
    expect(result.get("beta")).toBe(1);
    expect(result.get("gamma")).toBe(1);
    expect(result.size).toBe(3);
  });

  test("keys a nested tests/ path as everything after the last /tests/ segment", () => {
    const collected = [
      { file: "/repo/packages/m3l-common/tests/foo/bar.test.ts" },
    ];
    const result = countsByFile(collected);
    expect(result.get("foo/bar")).toBe(1);
    expect(result.has("bar")).toBe(false);
  });

  test("keeps two files sharing a basename in different tests/ subdirectories as distinct entries, not summed into one", () => {
    const collected = [
      { file: "/a/tests/shared/thing.test.ts" },
      { file: "/a/tests/other/thing.test.ts" },
      { file: "/a/tests/other/thing.test.ts" },
    ];
    const result = countsByFile(collected);
    expect(result.get("shared/thing")).toBe(1);
    expect(result.get("other/thing")).toBe(2);
    expect(result.has("thing")).toBe(false);
    expect(result.size).toBe(2);
  });

  test("falls back to the whole normalized path (minus .test.ts) when there is no /tests/ segment", () => {
    const collected = [{ file: "/repo/no-marker-here/polling.test.ts" }];
    const result = countsByFile(collected);
    expect(result.get("/repo/no-marker-here/polling")).toBe(1);
    expect(result.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// parseRecordedCounts
// ---------------------------------------------------------------------------

// Helper to build a well-formed ✅ pipe row with 10 columns (9 separators).
// Column layout: "" | Submodule | Spec | Planned | Symbols | Status | Tests | Reviewed | Notes | ""
function makeRow(submodule: string, status: string, notes: string): string {
  return `| ${submodule} | spec | planned | symbols | ${status} | tests | reviewed | ${notes} |`;
}

describe("parseRecordedCounts", () => {
  test("extracts the recorded count from a valid ✅ row", () => {
    const md = makeRow("polling", "✅", "42 tests, some notes");
    const result = parseRecordedCounts(md);
    expect(result.get("polling")).toBe(42);
  });

  test("accepts submodule names that contain digits (s3, ec2, rds-data)", () => {
    const lines = [
      makeRow("s3", "✅", "10 tests"),
      makeRow("ec2", "✅", "20 tests"),
      makeRow("rds-data", "✅", "5 tests"),
    ].join("\n");
    const result = parseRecordedCounts(lines);
    expect(result.get("s3")).toBe(10);
    expect(result.get("ec2")).toBe(20);
    expect(result.get("rds-data")).toBe(5);
  });

  test("skips a non-✅ row", () => {
    const md = makeRow("polling", "🔄", "42 tests");
    expect(parseRecordedCounts(md).size).toBe(0);
  });

  test("skips a separator row", () => {
    const md = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
    expect(parseRecordedCounts(md).size).toBe(0);
  });

  test("skips a row with fewer than 9 columns (e.g. the barrels table)", () => {
    // Barrels table has only 3 data columns → 5 total when split by |.
    const md = "| barrels | ✅ | 7 tests |";
    expect(parseRecordedCounts(md).size).toBe(0);
  });

  test("skips a row whose submodule name is Title-Case (header row guard)", () => {
    const md = makeRow("Polling", "✅", "42 tests");
    expect(parseRecordedCounts(md).size).toBe(0);
  });

  test("skips a ✅ row with no 'N tests' phrase in the Notes column", () => {
    const md = makeRow("polling", "✅", "some notes without count");
    expect(parseRecordedCounts(md).size).toBe(0);
  });

  test("skips lines that do not start with |", () => {
    const md = [
      "## Some Heading",
      makeRow("polling", "✅", "10 tests"),
      "plain text row",
    ].join("\n");
    const result = parseRecordedCounts(md);
    expect(result.size).toBe(1);
    expect(result.get("polling")).toBe(10);
  });

  test("parses multiple valid rows from a realistic table", () => {
    const md = [
      "| Submodule | Spec | Planned | Symbols | Status | Tests | Reviewed | Notes |",
      "| --------- | ---- | ------- | ------- | ------ | ----- | -------- | ----- |",
      makeRow("polling", "✅", "12 tests"),
      makeRow("retry", "✅", "7 tests"),
      makeRow("config", "🔄", "99 tests"),
    ].join("\n");
    const result = parseRecordedCounts(md);
    expect(result.size).toBe(2);
    expect(result.get("polling")).toBe(12);
    expect(result.get("retry")).toBe(7);
    expect(result.has("config")).toBe(false);
  });

  test("returns an empty map for an empty string", () => {
    expect(parseRecordedCounts("").size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diffCounts
// ---------------------------------------------------------------------------

describe("diffCounts", () => {
  test("produces matches when all recorded counts agree with actual", () => {
    const recorded = new Map([
      ["polling", 10],
      ["retry", 5],
    ]);
    const actual = new Map([
      ["polling", 10],
      ["retry", 5],
    ]);
    const { matches, mismatches } = diffCounts(recorded, actual);
    expect(mismatches).toHaveLength(0);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.submodule)).toEqual(
      expect.arrayContaining(["polling", "retry"]),
    );
  });

  test("yields a mismatch with both counts when recorded and actual differ", () => {
    const recorded = new Map([["polling", 10]]);
    const actual = new Map([["polling", 12]]);
    const { mismatches } = diffCounts(recorded, actual);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toEqual({
      submodule: "polling",
      recorded: 10,
      actual: 12,
    });
  });

  test("yields actual: null when the submodule is absent from the collected map", () => {
    const recorded = new Map([["polling", 10]]);
    const actual = new Map<string, number>();
    const { mismatches } = diffCounts(recorded, actual);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toEqual({
      submodule: "polling",
      recorded: 10,
      actual: null,
    });
  });

  test("ignores extra entries in actual that are not in recorded", () => {
    const recorded = new Map([["polling", 10]]);
    const actual = new Map([
      ["polling", 10],
      ["unrecorded", 99],
    ]);
    const { matches, mismatches } = diffCounts(recorded, actual);
    expect(mismatches).toHaveLength(0);
    expect(matches).toHaveLength(1);
  });

  test("handles empty recorded map", () => {
    const actual = new Map([["polling", 10]]);
    const { matches, mismatches } = diffCounts(new Map(), actual);
    expect(matches).toHaveLength(0);
    expect(mismatches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findUncountedFiles
// ---------------------------------------------------------------------------

describe("findUncountedFiles", () => {
  test("returns an empty result when every actual key has a matching recorded entry", () => {
    const recorded = new Map([
      ["polling", 10],
      ["retry", 5],
    ]);
    const actual = new Map([
      ["polling", 10],
      ["retry", 5],
    ]);
    expect(findUncountedFiles(recorded, actual)).toEqual([]);
  });

  test("returns each actual-only key with its correct count", () => {
    const recorded = new Map([["polling", 10]]);
    const actual = new Map([
      ["polling", 10],
      ["polling-edge-cases", 3],
    ]);
    expect(findUncountedFiles(recorded, actual)).toEqual([
      { key: "polling-edge-cases", count: 3 },
    ]);
  });

  test("never returns a key present in both maps, even when the counts differ", () => {
    // findUncountedFiles only cares about presence, not value equality —
    // a mismatched-but-shared key is diffCounts's concern, not this function's.
    const recorded = new Map([["polling", 10]]);
    const actual = new Map([["polling", 999]]);
    expect(findUncountedFiles(recorded, actual)).toEqual([]);
  });

  test("sorts the result alphabetically by key regardless of input order", () => {
    const recorded = new Map<string, number>();
    const actual = new Map([
      ["zebra", 1],
      ["alpha", 2],
      ["mango", 3],
    ]);
    const result = findUncountedFiles(recorded, actual);
    expect(result.map((r) => r.key)).toEqual(["alpha", "mango", "zebra"]);
  });

  test("returns an empty array for an empty actual map", () => {
    const recorded = new Map([["polling", 10]]);
    expect(findUncountedFiles(recorded, new Map())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatMismatch
// ---------------------------------------------------------------------------

describe("formatMismatch", () => {
  test("mentions the expected file path when actual is null (missing test file)", () => {
    const msg = formatMismatch({
      submodule: "polling",
      recorded: 10,
      actual: null,
    });
    expect(msg).toContain("packages/m3l-common/tests/polling.test.ts");
  });

  test("includes the submodule name when actual is null", () => {
    const msg = formatMismatch({
      submodule: "polling",
      recorded: 10,
      actual: null,
    });
    expect(msg).toContain("polling");
  });

  test("states both recorded and actual counts in the drift branch", () => {
    const msg = formatMismatch({ submodule: "retry", recorded: 5, actual: 8 });
    expect(msg).toContain("5");
    expect(msg).toContain("8");
    expect(msg).toContain("retry");
  });

  test("suggests updating the Notes column on count drift", () => {
    const msg = formatMismatch({ submodule: "retry", recorded: 5, actual: 8 });
    expect(msg).toContain("docs/implementation-status.md");
  });
});

// ---------------------------------------------------------------------------
// formatCollectFailure
// ---------------------------------------------------------------------------

// spawnSync's ENOBUFS error is a NodeJS.ErrnoException — an Error with a `code`.
function makeEnobufsError() {
  return Object.assign(new Error("spawnSync node ENOBUFS"), {
    code: "ENOBUFS",
  });
}

describe("formatCollectFailure", () => {
  test("never contains the old 'fix failing tests' misattribution text", () => {
    const scenarios = [
      { status: 1, signal: null },
      { status: null, signal: "SIGKILL" },
      { status: 1, error: new Error("spawn fail") },
      { status: null, signal: "SIGTERM", error: makeEnobufsError() },
    ];
    for (const res of scenarios) {
      expect(formatCollectFailure(res)).not.toContain("fix failing tests");
    }
  });

  test("names the signal and clarifies it is NOT a test or count failure", () => {
    const msg = formatCollectFailure({ status: null, signal: "SIGKILL" });
    expect(msg).toContain("SIGKILL");
    expect(msg.toLowerCase()).toMatch(/not a test/);
  });

  // Regression guard for the ENOBUFS branch reordering: a plain SIGKILL with no
  // error attached (a real OOM kill) must still route through the memory message.
  test("a plain SIGKILL with no error attached still reports memory exhaustion", () => {
    const msg = formatCollectFailure({ status: null, signal: "SIGKILL" });
    expect(msg).toContain("usually memory");
    expect(msg).not.toContain("ENOBUFS");
  });

  // Task F16 — spawnSync sets BOTH signal and error.code === "ENOBUFS" when the
  // child's output exceeds the buffer ceiling. The ENOBUFS branch must win over
  // the generic signal branch, or a buffer limit gets reported as memory
  // exhaustion (the exact misattribution class F15 was filed to remove).
  test("an ENOBUFS-shaped kill (signal + error.code) reports a buffer ceiling, not memory exhaustion", () => {
    const msg = formatCollectFailure({
      status: null,
      signal: "SIGTERM",
      error: makeEnobufsError(),
    });
    expect(msg.toUpperCase()).toContain("ENOBUFS");
    expect(msg.toLowerCase()).toContain("buffer");
    expect(msg).not.toContain("usually memory");
    expect(msg.toLowerCase()).toMatch(/not a test/);
  });

  test("reports the exit code on a plain non-zero status", () => {
    const msg = formatCollectFailure({ status: 2, signal: null });
    expect(msg).toContain("2");
  });

  test("surfaces the spawn error message when res.error is set", () => {
    const msg = formatCollectFailure({
      status: 1,
      signal: null,
      error: new Error("ENOENT: no such file"),
    });
    expect(msg).toContain("ENOENT: no such file");
  });

  // Task 2.1 — res.error branch is ordered BEFORE the exit-code branch.
  // When spawn itself cannot start (status is null, error is set), the message
  // must lead with "could not be spawned" and must NOT say "exit null" (which
  // was the misleading wording before the ordering fix).
  test("when spawn cannot start (error set, status null), leads with 'could not be spawned' not 'exit null'", () => {
    const msg = formatCollectFailure({
      status: null,
      signal: null,
      error: new Error("ENOENT: pnpm not found"),
    });
    expect(msg).toContain("could not be spawned");
    expect(msg).not.toContain("exit null");
  });

  test("includes the stderr tail when present", () => {
    const msg = formatCollectFailure({
      status: 1,
      signal: null,
      stderr: "some error output",
    });
    expect(msg).toContain("some error output");
  });

  test("includes the stdout tail when present", () => {
    const msg = formatCollectFailure({
      status: 1,
      signal: null,
      stdout: "some stdout output",
    });
    expect(msg).toContain("some stdout output");
  });

  test("includes both stderr and stdout tails when both are non-empty", () => {
    const msg = formatCollectFailure({
      status: 1,
      signal: null,
      stderr: "err line",
      stdout: "out line",
    });
    expect(msg).toContain("err line");
    expect(msg).toContain("out line");
  });

  test("limits output to tailLines lines (drops older lines)", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${String(i)}`);
    const stderr = lines.join("\n");
    // tailLines=3 should keep only last 3 lines
    const msg = formatCollectFailure({ status: 1, signal: null, stderr }, 3);
    expect(msg).toContain("line-9");
    expect(msg).toContain("line-8");
    expect(msg).toContain("line-7");
    // older lines should not appear
    expect(msg).not.toContain("line-0");
    expect(msg).not.toContain("line-1");
  });

  test("reports 'no output' when both stderr and stdout are empty", () => {
    const msg = formatCollectFailure({
      status: 1,
      signal: null,
      stderr: "",
      stdout: "",
    });
    expect(msg.toLowerCase()).toContain("no output");
  });

  test("reports 'no output' when both streams are omitted", () => {
    const msg = formatCollectFailure({ status: 1, signal: null });
    expect(msg.toLowerCase()).toContain("no output");
  });
});

// ---------------------------------------------------------------------------
// collectTests
// ---------------------------------------------------------------------------

describe("collectTests", () => {
  afterEach(() => {
    // vi.restoreAllMocks undoes vi.spyOn spies set inside each test.
    // h.spawnSync.mockReset clears call history and mockReturnValue on the
    // plain vi.fn() that vi.mock's factory holds — restoreAllMocks does not
    // reach it (it is not a spy, it is a standalone vi.fn()).
    vi.restoreAllMocks();
    h.spawnSync.mockReset();
  });

  test("happy path: returns ok:true with the collected array when spawn succeeds and report is a valid JSON array", () => {
    const fakeDir = "/tmp/m3l-test-counts-happy";
    vi.spyOn(fs, "mkdtempSync").mockReturnValue(fakeDir);
    vi.spyOn(fs, "rmSync").mockReturnValue(undefined);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      '[{"file":"/repo/packages/m3l-common/tests/polling.test.ts"},{"file":"/repo/packages/m3l-common/tests/retry.test.ts"}]',
    );
    h.spawnSync.mockReturnValue({ status: 0, signal: null });

    const result = collectTests();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collectTests to succeed");
    expect(result.collected).toEqual([
      { file: "/repo/packages/m3l-common/tests/polling.test.ts" },
      { file: "/repo/packages/m3l-common/tests/retry.test.ts" },
    ]);
  });

  test("spawn failure (res.error set): returns ok:false whose message comes from formatCollectFailure", () => {
    const fakeDir = "/tmp/m3l-test-counts-spawn-err";
    vi.spyOn(fs, "mkdtempSync").mockReturnValue(fakeDir);
    vi.spyOn(fs, "rmSync").mockReturnValue(undefined);
    h.spawnSync.mockReturnValue({
      status: null,
      signal: null,
      error: new Error("ENOENT: pnpm not found"),
    });

    const result = collectTests();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected collectTests to fail");
    // message routes through formatCollectFailure's res.error branch
    expect(result.message).toContain("could not be spawned");
    expect(result.message).not.toContain("exit null");
  });

  test("non-zero exit (status: 1): returns ok:false", () => {
    const fakeDir = "/tmp/m3l-test-counts-nonzero";
    vi.spyOn(fs, "mkdtempSync").mockReturnValue(fakeDir);
    vi.spyOn(fs, "rmSync").mockReturnValue(undefined);
    h.spawnSync.mockReturnValue({ status: 1, signal: null });

    const result = collectTests();

    expect(result.ok).toBe(false);
  });

  test("readFileSync throws: returns ok:false with the cause message included", () => {
    const fakeDir = "/tmp/m3l-test-counts-read-err";
    vi.spyOn(fs, "mkdtempSync").mockReturnValue(fakeDir);
    vi.spyOn(fs, "rmSync").mockReturnValue(undefined);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT: collected.json not found");
    });
    h.spawnSync.mockReturnValue({ status: 0, signal: null });

    expect(() => collectTests()).not.toThrow();
    const result = collectTests();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected collectTests to fail");
    expect(result.message).toContain("ENOENT: collected.json not found");
  });

  test("malformed JSON report: returns ok:false without throwing", () => {
    const fakeDir = "/tmp/m3l-test-counts-json-err";
    vi.spyOn(fs, "mkdtempSync").mockReturnValue(fakeDir);
    vi.spyOn(fs, "rmSync").mockReturnValue(undefined);
    vi.spyOn(fs, "readFileSync").mockReturnValue("not-valid-json{{{");
    h.spawnSync.mockReturnValue({ status: 0, signal: null });

    expect(() => collectTests()).not.toThrow();
    const result = collectTests();
    expect(result.ok).toBe(false);
  });

  // Task 1 + Task 2: non-array report is a branch added after the first pass.
  // Asserts the guard does not let a bare "not iterable" TypeError from
  // countsByFile propagate three frames up.
  test("non-array report (object/null/number): returns ok:false mentioning output format changed, never throws TypeError", () => {
    const scenarios = [
      '{"type":"object"}', // parsed as object
      "null", // parsed as null
      "42", // parsed as number
    ];
    for (const payload of scenarios) {
      vi.restoreAllMocks();
      h.spawnSync.mockReset();

      vi.spyOn(fs, "mkdtempSync").mockReturnValue(
        "/tmp/m3l-test-counts-nonarray",
      );
      vi.spyOn(fs, "rmSync").mockReturnValue(undefined);
      vi.spyOn(fs, "readFileSync").mockReturnValue(payload);
      h.spawnSync.mockReturnValue({ status: 0, signal: null });

      expect(() => collectTests()).not.toThrow(TypeError);
      const result = collectTests();
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected collectTests to fail");
      expect(result.message).toContain("output format changed");
    }
  });

  // Task 2: mkdtempSync-throws path now returns {ok:false} instead of propagating.
  test("mkdtempSync throws: returns ok:false with 'Could not create a temp directory' message", () => {
    vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
      throw new Error("EPERM: operation not permitted");
    });

    expect(() => collectTests()).not.toThrow();
    const result = collectTests();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected collectTests to fail");
    expect(result.message).toContain("Could not create a temp directory");
  });

  // Task 2: rmSync in finally is wrapped in its own try/catch so a cleanup
  // failure cannot replace the primary return value.  Even when rmSync throws,
  // collectTests must return the original result (ok or not-ok) rather than
  // re-throwing.
  test("rmSync throws in finally: still returns the original ok:true result, does not throw", () => {
    vi.spyOn(fs, "mkdtempSync").mockReturnValue("/tmp/m3l-test-counts-rmsync");
    vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("EBUSY: cleanup failed");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      '[{"file":"/repo/packages/m3l-common/tests/polling.test.ts"}]',
    );
    h.spawnSync.mockReturnValue({ status: 0, signal: null });

    expect(() => collectTests()).not.toThrow();
    const result = collectTests();
    expect(result.ok).toBe(true);
  });

  test("rmSync throws in finally during a spawn failure: still returns the original ok:false result", () => {
    vi.spyOn(fs, "mkdtempSync").mockReturnValue(
      "/tmp/m3l-test-counts-rmsync-fail",
    );
    vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("EBUSY: cleanup failed");
    });
    h.spawnSync.mockReturnValue({ status: 1, signal: null });

    expect(() => collectTests()).not.toThrow();
    const result = collectTests();
    expect(result.ok).toBe(false);
  });
});
