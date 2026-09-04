/**
 * Tests for `src/runs/report.ts` — `createRunReportReader` (X7d, ADR-0070),
 * the read side of the run-report addressing seam.
 *
 * These run against a REAL temporary directory rather than a mocked
 * `node:fs`. The whole point of this module is what the filesystem actually
 * does — a missing directory, a symlink at the final component, a file whose
 * size disagrees with expectations — and a mocked `fs` would only ever
 * confirm the mock's own beliefs about those.
 *
 * The literal-drift guard against `M3LRunReporter` lives here too: this
 * module duplicates the report's file name, and a duplicate nobody checks is
 * a permanent silent 404.
 *
 * @packageDocumentation
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Core } from "@m3l-automation/m3l-common";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  createRunReportReader,
  RUN_REPORT_FILE_NAME,
} from "../src/runs/report.js";

/** The one temporary runs-output root each test gets its own copy of. */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "m3l-runs-report-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Writes `report` where a real spawned child would: under this run's own
 * output directory, inside one timestamp-named subdirectory.
 *
 * `timestamp` mirrors `runDirectoryName`'s output shape (ISO-8601 with `:`
 * replaced by `-`) but is not derived from it — the reader deliberately does
 * NOT parse or validate the directory name, only that there is exactly one,
 * so pinning the format here would assert a coupling the code does not have.
 */
async function writeReport(
  runId: string,
  report: unknown,
  timestamp = "2026-09-02T10-14-02.000Z",
): Promise<string> {
  const dir = join(root, runId, timestamp);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, RUN_REPORT_FILE_NAME);
  await writeFile(filePath, JSON.stringify(report), "utf8");
  return filePath;
}

/** Invokes `read` and returns whatever it threw, or `undefined`. */
async function readAndCatch(runId: string): Promise<unknown> {
  const reader = createRunReportReader({ root });
  try {
    await reader.read(runId);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("RUN_REPORT_FILE_NAME — the mirrored literal", () => {
  // MIRRORED LITERAL GUARD. `runs/` may not import `m3l-common`'s
  // `internal/`, and the public `M3LRunReporter` exposes its file name only
  // through `resolveReportPath`, which needs the CHILD's own `startedAt` —
  // the one value this reader does not have. So the name is duplicated, and
  // this asserts the duplicate against what the reporter really writes.
  // Mutation-tested: changing either side to "report.json" fails here.
  test("matches the file name M3LRunReporter actually writes", () => {
    const reporter = new Core.M3LRunReporter({
      paths: { getOutputDir: () => "/out" },
    });
    const written = reporter.resolveReportPath(
      new Date("2026-09-02T10:14:02.000Z"),
    );

    expect(written.endsWith(`/${RUN_REPORT_FILE_NAME}`)).toBe(true);
  });
});

describe("createRunReportReader — the happy path", () => {
  test("returns the parsed report from the run's single timestamp directory", async () => {
    await writeReport("run-1", { outcome: "success", steps: 3 });
    const reader = createRunReportReader({ root });

    expect(await reader.read("run-1")).toEqual({
      outcome: "success",
      steps: 3,
    });
  });

  test("reads the report regardless of what the timestamp directory is named", async () => {
    // The reader finds the ONE directory; it never parses the name. If it
    // ever started to, this fails — which is the point: the child owns that
    // name and the console must not encode assumptions about its format.
    await writeReport(
      "run-2",
      { outcome: "partial" },
      "whatever-the-child-chose",
    );
    const reader = createRunReportReader({ root });

    expect(await reader.read("run-2")).toEqual({ outcome: "partial" });
  });
});

describe("createRunReportReader — the ordinary 'no report' states", () => {
  // INVARIANT: all three of these are a queued/running/dead-early run, not a
  // fault. The route turns each into a 404; none may throw.
  test("returns undefined when the run has no output directory at all", async () => {
    const reader = createRunReportReader({ root });

    expect(await reader.read("never-spawned")).toBeUndefined();
  });

  test("returns undefined when the output directory holds no timestamp directory", async () => {
    await mkdir(join(root, "run-3"), { recursive: true });
    const reader = createRunReportReader({ root });

    expect(await reader.read("run-3")).toBeUndefined();
  });

  test("returns undefined when the timestamp directory holds no report file", async () => {
    await mkdir(join(root, "run-4", "2026-09-02T10-14-02.000Z"), {
      recursive: true,
    });
    const reader = createRunReportReader({ root });

    expect(await reader.read("run-4")).toBeUndefined();
  });

  test("ignores a stray FILE beside the timestamp directory", async () => {
    await writeReport("run-5", { outcome: "success" });
    await writeFile(join(root, "run-5", "notes.txt"), "stray", "utf8");
    const reader = createRunReportReader({ root });

    expect(await reader.read("run-5")).toEqual({ outcome: "success" });
  });
});

describe("createRunReportReader — refusals", () => {
  // INVARIANT: two timestamp directories under one run id means something
  // other than this run wrote there. Serving the newest would hand an
  // operator another execution's report while looking entirely successful,
  // so this is a fault, never a guess. Mutation-tested: replacing the throw
  // with `timestampDirs[0]` makes this pass while serving the wrong report.
  test("refuses a run whose output directory holds two timestamp directories", async () => {
    await writeReport("run-6", { which: "first" }, "2026-09-02T10-14-02.000Z");
    await writeReport("run-6", { which: "second" }, "2026-09-02T11-14-02.000Z");

    const thrown = await readAndCatch("run-6");

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
    expect((thrown as M3LConsoleError).message).toContain("2 output");
  });

  test.each([
    ["../escape", "a traversal segment"],
    ["a/b", "a path separator"],
    ["dot.dot", "a dot"],
    ["", "an empty id"],
  ])("rejects %s (%s) before touching the filesystem", async (runId) => {
    const thrown = await readAndCatch(runId);

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("rejects a run id over the length cap", async () => {
    const thrown = await readAndCatch("a".repeat(129));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).message).toContain("128");
  });

  // INVARIANT: a symlink planted at the report path must not be followed out
  // of the tree. Mutation-tested: dropping `O_NOFOLLOW` from the open flags
  // makes this resolve the outside file and return its contents instead.
  test("refuses a symlinked report file rather than following it", async () => {
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify({ secret: true }), "utf8");
    const dir = join(root, "run-7", "2026-09-02T10-14-02.000Z");
    await mkdir(dir, { recursive: true });
    await symlink(outside, join(dir, RUN_REPORT_FILE_NAME));

    const thrown = await readAndCatch("run-7");

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
  });

  test("refuses a report that is not valid JSON", async () => {
    const dir = join(root, "run-8", "2026-09-02T10-14-02.000Z");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, RUN_REPORT_FILE_NAME), "{not json", "utf8");

    const thrown = await readAndCatch("run-8");

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
    expect((thrown as M3LConsoleError).message).toContain("not valid JSON");
  });

  test("refuses a report path that resolves to a directory", async () => {
    await mkdir(
      join(root, "run-9", "2026-09-02T10-14-02.000Z", RUN_REPORT_FILE_NAME),
      { recursive: true },
    );

    const thrown = await readAndCatch("run-9");

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
  });

  // CONTRACT PIN (passes today; this is coverage, not RED). `listRunDirectory`
  // (report.ts:172-175) documents that only a MISSING directory reads as "no
  // report" — a permission error, an ENOTDIR, or any other `readdir` failure
  // must reach the operator as a fault. Before this test, that non-ENOENT
  // throw arm (report.ts:186) had no test exercising it. A regular FILE
  // sitting where the run's own output directory should be makes `readdir`
  // fail with ENOTDIR, which must not be swallowed the same way ENOENT is.
  test("refuses when the run's directory entry is a file, not a directory (ENOTDIR)", async () => {
    await writeFile(join(root, "run-10"), "not a directory", "utf8");

    const thrown = await readAndCatch("run-10");

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
  });

  // CONTRACT PIN (passes today; this is coverage, not RED). `readCappedFile`
  // (report.ts:198-207) documents that `O_NOFOLLOW` makes a symlink at the
  // report path's final component fail with `ELOOP` rather than being
  // followed out of the tree, and its catch clause re-throws any non-ENOENT
  // errno as a fault rather than "no report". Unlike the symlink-to-a-file
  // case above (which points OUTSIDE the tree and already exercises this
  // same rethrow), this pins a symlink whose target is ITSELF: `O_NOFOLLOW`
  // rejects any symlink at the final path component before ever resolving
  // where it points, so the self-referential case fails identically.
  test("refuses a self-referential symlinked report file (ELOOP)", async () => {
    const dir = join(root, "run-11", "2026-09-02T10-14-02.000Z");
    await mkdir(dir, { recursive: true });
    const reportPath = join(dir, RUN_REPORT_FILE_NAME);
    await symlink(reportPath, reportPath);

    const thrown = await readAndCatch("run-11");

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
  });
});
