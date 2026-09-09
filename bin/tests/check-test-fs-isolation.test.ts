import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { findMissingCleanup } from "../lib/test-fs-isolation.mjs";
import {
  listCandidateTestFiles,
  runTestFsIsolationCheck,
} from "../check-test-fs-isolation.mjs";

// findMissingCleanup and listCandidateTestFiles are pure, so they are driven
// with synthetic source/path fixtures rather than the live repo —
// `.claude/rules/tests.md` requires exactly this of a `bin/` checker, because
// a gate exercised only against today's tree proves nothing about tomorrow's
// violation (a new test file created without a matching teardown).

// check-test-fs-isolation.mjs computes `root` as
// `dirname(dirname(fileURLToPath(import.meta.url)))` from its own location
// (bin/check-test-fs-isolation.mjs), i.e. the repo root. This test file
// lives one directory deeper (bin/tests/), so the same repo root needs one
// extra `dirname`.
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`check-test-fs-isolation.test.ts: expected ${what}`);
  }
  return value;
}

interface FakeReporter {
  errors: string[];
  succeeded: string[];
  finishedWith: Record<string, unknown>;
  error: (message: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
  change: (
    kind: "updated" | "created" | "removed",
    file: string,
    note?: string,
  ) => void;
  succeed: (message: string) => void;
  finish: (extra?: Record<string, unknown>) => Record<string, unknown>;
}

function createFakeReporter(): FakeReporter {
  const reporter: FakeReporter = {
    errors: [],
    succeeded: [],
    finishedWith: {},
    error(message) {
      reporter.errors.push(message);
    },
    warn() {
      // Not exercised by this gate's success/failure paths — present only
      // to satisfy the injected reporter's full shape.
    },
    info() {
      // Not exercised by this gate's success/failure paths — present only
      // to satisfy the injected reporter's full shape.
    },
    change() {
      // Not exercised by this gate's success/failure paths — present only
      // to satisfy the injected reporter's full shape.
    },
    succeed(message) {
      reporter.succeeded.push(message);
    },
    finish(extra = {}) {
      reporter.finishedWith = extra;
      return { ...extra };
    },
  };
  return reporter;
}

describe("findMissingCleanup", () => {
  test("no mkdtemp/mkdtempSync call at all — nothing to check", () => {
    expect(
      findMissingCleanup(
        "import { readFileSync } from 'node:fs';\nreadFileSync('/x');\n",
      ),
    ).toBe(false);
  });

  test("mkdtemp(...) present and rm(...) present — cleanup found", () => {
    const source =
      "const dir = await mkdtemp(join(tmpdir(), 'x-'));\n" +
      "await rm(dir, { recursive: true, force: true });\n";
    expect(findMissingCleanup(source)).toBe(false);
  });

  test("mkdtempSync(...) present and rmSync(...) present — cleanup found", () => {
    const source =
      "const dir = mkdtempSync(join(tmpdir(), 'x-'));\n" +
      "rmSync(dir, { recursive: true, force: true });\n";
    expect(findMissingCleanup(source)).toBe(false);
  });

  test("mkdtemp(...) present with NO rm/rmSync anywhere — the actual violation", () => {
    const source = "const dir = await mkdtemp(join(tmpdir(), 'x-'));\n";
    expect(findMissingCleanup(source)).toBe(true);
  });

  test("mkdtempSync(...) present with NO rm/rmSync anywhere — the actual violation", () => {
    const source = "const dir = mkdtempSync(join(tmpdir(), 'x-'));\n";
    expect(findMissingCleanup(source)).toBe(true);
  });

  test("a longer identifier containing 'rm' as a substring is not a real rm()/rmSync() call", () => {
    // The exact word-boundary edge case the regex must get right: `confirm(`
    // and `alarmSync(` both contain the substring "rm(" / "rmSync(" but
    // neither IS a call to `rm`/`rmSync` — the file still lacks a real
    // cleanup call and must be reported as a violation.
    const source =
      "const dir = await mkdtemp(join(tmpdir(), 'x-'));\n" +
      "confirm('did you mean to skip cleanup?');\n" +
      "alarmSync(1000);\n";
    expect(findMissingCleanup(source)).toBe(true);
  });
});

describe("listCandidateTestFiles", () => {
  test("includes *.test.ts and *.test.tsx files", () => {
    const files = listCandidateTestFiles(
      () => "src/foo.test.ts\0src/bar.test.tsx\0",
    );
    expect(files).toEqual(["src/foo.test.ts", "src/bar.test.tsx"]);
  });

  test("includes files under a tests/ directory with a .ts/.tsx extension", () => {
    const files = listCandidateTestFiles(
      () =>
        "packages/m3l-common/tests/foo.ts\0packages/m3l-common/tests/bar.tsx\0",
    );
    expect(files).toEqual([
      "packages/m3l-common/tests/foo.ts",
      "packages/m3l-common/tests/bar.tsx",
    ]);
  });

  test("excludes anything under a tests/integration/ segment", () => {
    const files = listCandidateTestFiles(
      () =>
        "packages/m3l-common/tests/integration/foo.ts\0" +
        "packages/m3l-common/tests/integration/nested/bar.tsx\0",
    );
    expect(files).toEqual([]);
  });

  test("excludes non-test files — a .ts file not under tests/ and not ending .test.ts", () => {
    const files = listCandidateTestFiles(
      () => "packages/m3l-common/src/index.ts\0README.md\0",
    );
    expect(files).toEqual([]);
  });

  test("mixed candidates: only the matching subset is returned", () => {
    const files = listCandidateTestFiles(
      () =>
        "src/foo.test.ts\0" +
        "src/index.ts\0" +
        "packages/m3l-common/tests/helper.ts\0" +
        "packages/m3l-common/tests/integration/live.ts\0" +
        "README.md\0",
    );
    expect(files).toEqual([
      "src/foo.test.ts",
      "packages/m3l-common/tests/helper.ts",
    ]);
  });
});

describe("runTestFsIsolationCheck", () => {
  function seams(
    tracked: string[],
    contents: Record<string, string> = {},
  ): {
    runGit: () => string;
    readFile: (path: string) => string;
  } {
    return {
      runGit: () => tracked.join("\0") + (tracked.length > 0 ? "\0" : ""),
      readFile: (path: string) =>
        required(contents[path], `contents for ${path}`),
    };
  }

  test("happy path: every candidate file has cleanup — ok, one succeed(), no error()", () => {
    const reporter = createFakeReporter();
    const outcome = runTestFsIsolationCheck({
      ...seams(["packages/m3l-common/tests/a.test.ts"], {
        "packages/m3l-common/tests/a.test.ts":
          "const dir = await mkdtemp(join(tmpdir(), 'x-'));\n" +
          "await rm(dir, { recursive: true, force: true });\n",
      }),
      reporter,
    });

    expect(outcome).toMatchObject({ ok: true, findings: [], scanned: 1 });
    expect(reporter.errors).toEqual([]);
    expect(reporter.succeeded).toHaveLength(1);
  });

  test("violation path: a candidate missing cleanup fails, naming the file", () => {
    const reporter = createFakeReporter();
    const outcome = runTestFsIsolationCheck({
      ...seams(["packages/m3l-common/tests/leaky.test.ts"], {
        "packages/m3l-common/tests/leaky.test.ts":
          "const dir = await mkdtemp(join(tmpdir(), 'x-'));\n",
      }),
      reporter,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.findings).toHaveLength(1);
    expect(required(outcome.findings[0], "finding")).toContain(
      "packages/m3l-common/tests/leaky.test.ts",
    );
    expect(reporter.errors).toHaveLength(1);
    expect(required(reporter.errors[0], "error")).toContain(
      "packages/m3l-common/tests/leaky.test.ts",
    );
  });

  test("empty candidate list fails rather than reporting a clean scan of nothing", () => {
    const reporter = createFakeReporter();
    const outcome = runTestFsIsolationCheck({
      runGit: () => "",
      readFile: () => "",
      reporter,
    });

    expect(outcome).toMatchObject({ ok: false, findings: [], scanned: 0 });
    expect(required(reporter.errors[0], "error")).toMatch(
      /refusing to report a clean scan of nothing/,
    );
  });

  test("a file that throws on readFile is reported as an error, never skipped silently, and scanning continues", () => {
    const reporter = createFakeReporter();
    const outcome = runTestFsIsolationCheck({
      runGit: () =>
        "packages/m3l-common/tests/unreadable.test.ts\0" +
        "packages/m3l-common/tests/clean.test.ts\0",
      readFile: (path) => {
        if (path === "packages/m3l-common/tests/unreadable.test.ts") {
          throw new Error("EACCES: permission denied");
        }
        return (
          "const dir = await mkdtemp(join(tmpdir(), 'x-'));\n" +
          "await rm(dir, { recursive: true, force: true });\n"
        );
      },
      reporter,
    });

    expect(outcome.ok).toBe(false);
    const finding = required(
      outcome.findings.find((entry) =>
        entry.includes("packages/m3l-common/tests/unreadable.test.ts"),
      ),
      "finding",
    );
    expect(finding).toMatch(/EACCES/);
    expect(finding).toMatch(/Not skipping silently/);
    // The remaining candidate (clean.test.ts) was still scanned — the
    // unreadable file did not abort the whole run.
    expect(outcome.scanned).toBe(2);
  });

  test("every finish() payload carries findings and scanned regardless of outcome", () => {
    const scenarios: {
      runGit: () => string;
      readFile: (path: string) => string;
    }[] = [
      seams(["packages/m3l-common/tests/a.test.ts"], {
        "packages/m3l-common/tests/a.test.ts":
          "const dir = await mkdtemp(join(tmpdir(), 'x-'));\n" +
          "await rm(dir, { recursive: true, force: true });\n",
      }),
      seams(["packages/m3l-common/tests/leaky.test.ts"], {
        "packages/m3l-common/tests/leaky.test.ts":
          "const dir = await mkdtemp(join(tmpdir(), 'x-'));\n",
      }),
      { runGit: () => "", readFile: () => "" },
    ];

    for (const scenario of scenarios) {
      const reporter = createFakeReporter();
      runTestFsIsolationCheck({ ...scenario, reporter });
      expect(reporter.finishedWith).toHaveProperty("findings");
      expect(reporter.finishedWith).toHaveProperty("scanned");
    }
  });

  test("live corpus: the real gate against the real repo currently passes", () => {
    // Not a synthetic fixture — this is the proof the gate is green against
    // the actual codebase today, using the same execFileSync git call and
    // readFileSync the script itself uses (not a hand-rolled duplicate of
    // its git-listing logic).
    const reporter = createFakeReporter();
    const outcome = runTestFsIsolationCheck({
      runGit: (args: string[]) =>
        execFileSync("git", args, {
          encoding: "utf8",
          cwd: root,
          maxBuffer: 32 * 1024 * 1024,
        }),
      readFile: (path: string) => readFileSync(join(root, path), "utf8"),
      reporter,
    });

    expect(outcome.ok).toBe(true);
    expect(reporter.errors).toEqual([]);
  });
});
