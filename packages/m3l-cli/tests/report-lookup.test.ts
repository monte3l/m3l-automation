/**
 * Tests for src/run/report-lookup.ts — scans the managed output directory for
 * the timestamp-named run subdirectory matching a spawned script's observed
 * run window, and projects its `run-report.json` to an allowlisted scalar
 * summary (ADR-0063, m3l-cli "run --json" V2 slice 2).
 *
 * The CLI (parent process) cannot compute the report's path directly: the
 * directory name is derived from the CHILD's own `startedAt`, never
 * communicated back through any other channel. `locateRunReport` scans for a
 * matching, in-window, timestamp-named subdirectory instead.
 */
import * as fs from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — mirrors packages/m3l-common's
// exporters.test.ts / script.test.ts pattern, and this package's own
// discover.test.ts / cache.test.ts / spawn.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { locateRunReport } from "../src/run/report-lookup.js";
import type { M3LCliRunReportLookupOptions } from "../src/run/report-lookup.js";
// `envelope.ts` is a sibling module under test-authorship in parallel; it does
// not exist yet either during this RED phase, so this import is expected to
// fail to resolve alongside `report-lookup.js` itself.
import type { M3LCliRunReportLookup } from "../src/run/envelope.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const OUTPUT_DIR = "/data/output";
const SCRIPT_NAME = "import-users";
const REPORT_FILE = "run-report.json";
const STARTED_AT = new Date("2026-07-24T10:00:00.000Z");
const FINISHED_AT = new Date("2026-07-24T11:00:00.000Z");

/** A minimal fake `fs.Dirent` — just enough for a `readdirSync(withFileTypes)` consumer. */
function fakeDirent(
  name: string,
  kind: "directory" | "file" | "symlink" = "directory",
) {
  return {
    name,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  };
}

/**
 * Stubs `fs.readdirSync` to return the given fake dirents, regardless of the
 * generic `Dirent<T>` overload TS would otherwise pick for `withFileTypes` —
 * mirrors discover.test.ts's `mockReaddirSync` precedent in this same package.
 */
function mockReaddirSync(
  entries: ReadonlyArray<ReturnType<typeof fakeDirent>>,
): void {
  vi.spyOn(fs, "readdirSync").mockImplementation(
    (() => entries) as unknown as typeof fs.readdirSync,
  );
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Mirrors `runDirectoryName`: the ISO-8601 string with every `:` replaced by `-`. */
function dirNameFor(date: Date): string {
  return date.toISOString().replaceAll(":", "-");
}

/** The absolute path `locateRunReport` reads a candidate's report from. */
function reportPathFor(dirName: string): string {
  return join(OUTPUT_DIR, dirName, REPORT_FILE);
}

/**
 * Stubs `fs.readFileSync` to serve `contentByPath` keyed by the exact
 * absolute path, throwing ENOENT for any path not present in the map — the
 * per-candidate "no report file" case.
 */
function mockReadFileSync(contentByPath: ReadonlyMap<string, string>): void {
  vi.spyOn(fs, "readFileSync").mockImplementation((path: unknown) => {
    const key = String(path);
    const content = contentByPath.get(key);
    if (content !== undefined) return content;
    throw errnoError("ENOENT");
  });
}

/** Asserts `fs.readFileSync` is never invoked — used for "never read a candidate" cases. */
function forbidReadFileSync(): void {
  vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    throw new Error("readFileSync should not have been called");
  });
}

/** A minimal, valid report JSON payload — carries only what matching requires. */
function minimalReport(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    script: { name: SCRIPT_NAME, version: "1.0.0" },
    outcome: "success",
    ...overrides,
  };
}

function baseOptions(
  overrides: Partial<M3LCliRunReportLookupOptions> = {},
): M3LCliRunReportLookupOptions {
  return {
    outputDirPath: OUTPUT_DIR,
    scriptName: SCRIPT_NAME,
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    ...overrides,
  };
}

describe("locateRunReport — enumerating the output directory", () => {
  test("returns unavailable/output-directory-missing when readdirSync throws ENOENT", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw errnoError("ENOENT");
    });

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "output-directory-missing",
    });
  });

  test.each(["EACCES", "EPERM", "ENOTDIR"])(
    "returns unavailable/output-directory-unreadable, without throwing, when readdirSync throws %s",
    (code) => {
      vi.spyOn(fs, "readdirSync").mockImplementation(() => {
        throw errnoError(code);
      });

      expect(() => locateRunReport(baseOptions())).not.toThrow();
      expect(locateRunReport(baseOptions())).toEqual({
        status: "unavailable",
        reason: "output-directory-unreadable",
      });
    },
  );

  test("returns unavailable/output-directory-unreadable when readdirSync throws an Error with no .code", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("boom");
    });

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "output-directory-unreadable",
    });
  });

  test("returns unavailable/output-directory-unreadable when readdirSync throws a non-Error value", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error throw, proving the scan tolerates a foreign throw shape without crashing
      throw "not an error";
    });

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "output-directory-unreadable",
    });
  });

  test("invokes readdirSync with withFileTypes: true", () => {
    mockReaddirSync([]);

    locateRunReport(baseOptions());

    expect(fs.readdirSync).toHaveBeenCalledWith(OUTPUT_DIR, {
      withFileTypes: true,
    });
  });

  test("empty output directory yields no-matching-report without ever reading a file", () => {
    mockReaddirSync([]);
    forbidReadFileSync();

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "no-matching-report",
    });
  });
});

describe("locateRunReport — filtering directory entries", () => {
  test("skips a plain file entry, never reading it as a candidate", () => {
    mockReaddirSync([fakeDirent("not-a-dir.txt", "file")]);
    forbidReadFileSync();

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "no-matching-report",
    });
  });

  test("skips a symlink entry without dereferencing it", () => {
    mockReaddirSync([fakeDirent(dirNameFor(STARTED_AT), "symlink")]);
    forbidReadFileSync();

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "no-matching-report",
    });
  });

  test.each([
    "not-a-timestamp",
    "2026-07-24T10-00-00Z",
    "2026-07-24T10-00-00.000",
    "2026-07-24 10-00-00.000Z",
    "2026-07-24T10-00-00.000Zextra",
  ])(
    "skips a directory whose name does not match the timestamp shape: %s",
    (name) => {
      mockReaddirSync([fakeDirent(name)]);
      forbidReadFileSync();

      expect(locateRunReport(baseOptions())).toEqual({
        status: "unavailable",
        reason: "no-matching-report",
      });
    },
  );

  test("skips a directory name matching the shape but parsing to an invalid date (month 13)", () => {
    mockReaddirSync([fakeDirent("2026-13-24T10-00-00.000Z")]);
    forbidReadFileSync();

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "no-matching-report",
    });
  });
});

describe("locateRunReport — filtering by the [startedAt, finishedAt] window", () => {
  test("excludes a directory strictly before startedAt", () => {
    const before = new Date(STARTED_AT.getTime() - 1000);
    mockReaddirSync([fakeDirent(dirNameFor(before))]);
    forbidReadFileSync();

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "no-matching-report",
    });
  });

  test("excludes a directory strictly after finishedAt", () => {
    const after = new Date(FINISHED_AT.getTime() + 1000);
    mockReaddirSync([fakeDirent(dirNameFor(after))]);
    forbidReadFileSync();

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "no-matching-report",
    });
  });

  test("includes a directory exactly equal to startedAt (inclusive lower bound)", () => {
    const dirName = dirNameFor(STARTED_AT);
    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([[reportPathFor(dirName), JSON.stringify(minimalReport())]]),
    );

    expect(locateRunReport(baseOptions())).toMatchObject({ status: "found" });
  });

  test("includes a directory exactly equal to finishedAt (inclusive upper bound)", () => {
    const dirName = dirNameFor(FINISHED_AT);
    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([[reportPathFor(dirName), JSON.stringify(minimalReport())]]),
    );

    expect(locateRunReport(baseOptions())).toMatchObject({ status: "found" });
  });
});

describe("locateRunReport — ordering and multi-candidate selection", () => {
  test("chooses the newest in-window candidate when multiple match the same script, never reading an older one", () => {
    const oldName = dirNameFor(new Date(STARTED_AT.getTime() + 1000));
    const midName = dirNameFor(new Date(STARTED_AT.getTime() + 2000));
    const newName = dirNameFor(new Date(STARTED_AT.getTime() + 3000));

    mockReaddirSync([
      fakeDirent(oldName),
      fakeDirent(midName),
      fakeDirent(newName),
    ]);
    mockReadFileSync(
      new Map([
        [reportPathFor(oldName), JSON.stringify(minimalReport())],
        [reportPathFor(midName), JSON.stringify(minimalReport())],
        [reportPathFor(newName), JSON.stringify(minimalReport())],
      ]),
    );

    const result = locateRunReport(baseOptions());

    expect(result).toMatchObject({
      status: "found",
      reportPath: reportPathFor(newName),
    });
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync).toHaveBeenCalledWith(
      reportPathFor(newName),
      "utf8",
    );
  });

  test("skips a mismatched newer sibling script and finds the target in an older, in-window candidate", () => {
    const targetName = dirNameFor(new Date(STARTED_AT.getTime() + 1000));
    const otherName = dirNameFor(new Date(STARTED_AT.getTime() + 2000));

    mockReaddirSync([fakeDirent(targetName), fakeDirent(otherName)]);
    mockReadFileSync(
      new Map([
        [reportPathFor(targetName), JSON.stringify(minimalReport())],
        [
          reportPathFor(otherName),
          JSON.stringify(
            minimalReport({
              script: { name: "other-script", version: "1.0.0" },
            }),
          ),
        ],
      ]),
    );

    expect(locateRunReport(baseOptions())).toMatchObject({
      status: "found",
      reportPath: reportPathFor(targetName),
    });
  });

  test("skips a mismatched older sibling script and finds the target in a newer, in-window candidate", () => {
    const otherName = dirNameFor(new Date(STARTED_AT.getTime() + 1000));
    const targetName = dirNameFor(new Date(STARTED_AT.getTime() + 2000));

    mockReaddirSync([fakeDirent(otherName), fakeDirent(targetName)]);
    mockReadFileSync(
      new Map([
        [
          reportPathFor(otherName),
          JSON.stringify(
            minimalReport({
              script: { name: "other-script", version: "1.0.0" },
            }),
          ),
        ],
        [reportPathFor(targetName), JSON.stringify(minimalReport())],
      ]),
    );

    expect(locateRunReport(baseOptions())).toMatchObject({
      status: "found",
      reportPath: reportPathFor(targetName),
    });
  });
});

describe("locateRunReport — per-candidate report read", () => {
  test("continues to the next-older candidate when the newest candidate has no report file (ENOENT)", () => {
    const olderName = dirNameFor(new Date(STARTED_AT.getTime() + 1000));
    const newerName = dirNameFor(new Date(STARTED_AT.getTime() + 2000));

    // newer has no run-report.json (e.g. `{ report: false }`); older has one.
    mockReaddirSync([fakeDirent(olderName), fakeDirent(newerName)]);
    mockReadFileSync(
      new Map([[reportPathFor(olderName), JSON.stringify(minimalReport())]]),
    );

    expect(locateRunReport(baseOptions())).toMatchObject({
      status: "found",
      reportPath: reportPathFor(olderName),
    });
  });

  test("continues to an older candidate after a non-ENOENT read error on a newer one, finding its match", () => {
    const olderName = dirNameFor(new Date(STARTED_AT.getTime() + 1000));
    const newerName = dirNameFor(new Date(STARTED_AT.getTime() + 2000));

    mockReaddirSync([fakeDirent(olderName), fakeDirent(newerName)]);
    vi.spyOn(fs, "readFileSync").mockImplementation((path: unknown) => {
      if (String(path) === reportPathFor(newerName)) {
        throw errnoError("EACCES");
      }
      return JSON.stringify(minimalReport());
    });

    expect(locateRunReport(baseOptions())).toMatchObject({
      status: "found",
      reportPath: reportPathFor(olderName),
    });
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  test("continues to an older candidate after malformed JSON on a newer one, finding its match", () => {
    const olderName = dirNameFor(new Date(STARTED_AT.getTime() + 1000));
    const newerName = dirNameFor(new Date(STARTED_AT.getTime() + 2000));

    mockReaddirSync([fakeDirent(olderName), fakeDirent(newerName)]);
    mockReadFileSync(
      new Map([
        [reportPathFor(newerName), "{not json"],
        [reportPathFor(olderName), JSON.stringify(minimalReport())],
      ]),
    );

    expect(locateRunReport(baseOptions())).toMatchObject({
      status: "found",
      reportPath: reportPathFor(olderName),
    });
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  test("returns the first-encountered stop reason when the scan is exhausted with no match (first-stop-wins)", () => {
    const olderName = dirNameFor(new Date(STARTED_AT.getTime() + 1000));
    const newerName = dirNameFor(new Date(STARTED_AT.getTime() + 2000));

    // Newer candidate stops with report-unreadable (processed first, since the
    // scan is newest-first); older candidate stops with report-malformed. The
    // FIRST-encountered stop reason must win — never overwritten by the
    // older candidate's different stop reason.
    mockReaddirSync([fakeDirent(olderName), fakeDirent(newerName)]);
    vi.spyOn(fs, "readFileSync").mockImplementation((path: unknown) => {
      if (String(path) === reportPathFor(newerName)) {
        throw errnoError("EACCES");
      }
      return "{not json";
    });

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "report-unreadable",
    });
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  test("a later found match wins over an earlier remembered stop reason, and enoent/mismatch never permanently poison the scan", () => {
    // Newest -> oldest: mismatch (different script), stop (malformed JSON),
    // enoent (no report file at all), found (the oldest, valid match).
    const oldestName = dirNameFor(new Date(STARTED_AT.getTime() + 1000));
    const enoentName = dirNameFor(new Date(STARTED_AT.getTime() + 2000));
    const malformedName = dirNameFor(new Date(STARTED_AT.getTime() + 3000));
    const mismatchName = dirNameFor(new Date(STARTED_AT.getTime() + 4000));

    mockReaddirSync([
      fakeDirent(oldestName),
      fakeDirent(enoentName),
      fakeDirent(malformedName),
      fakeDirent(mismatchName),
    ]);
    mockReadFileSync(
      new Map([
        [
          reportPathFor(mismatchName),
          JSON.stringify(
            minimalReport({
              script: { name: "other-script", version: "1.0.0" },
            }),
          ),
        ],
        [reportPathFor(malformedName), "{not json"],
        // enoentName intentionally omitted — mockReadFileSync throws ENOENT
        // for any path not present in the map.
        [reportPathFor(oldestName), JSON.stringify(minimalReport())],
      ]),
    );

    expect(locateRunReport(baseOptions())).toMatchObject({
      status: "found",
      reportPath: reportPathFor(oldestName),
    });
  });

  test("a found match on the newest candidate short-circuits immediately without needing to remember any fallback reason", () => {
    const olderName = dirNameFor(new Date(STARTED_AT.getTime() + 1000));
    const newerName = dirNameFor(new Date(STARTED_AT.getTime() + 2000));

    mockReaddirSync([fakeDirent(olderName), fakeDirent(newerName)]);
    vi.spyOn(fs, "readFileSync").mockImplementation((path: unknown) => {
      if (String(path) === reportPathFor(newerName)) {
        return JSON.stringify(minimalReport());
      }
      throw errnoError("EACCES");
    });

    expect(locateRunReport(baseOptions())).toMatchObject({
      status: "found",
      reportPath: reportPathFor(newerName),
    });
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  test("a malformed-JSON syntax error never leaks the file's content into the returned result", () => {
    const dirName = dirNameFor(STARTED_AT);
    const plantedSecret = "sk-PLANTED-1234";

    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([[reportPathFor(dirName), `{"secret":"${plantedSecret}`]]),
    );

    const result = locateRunReport(baseOptions());

    expect(result).toEqual({
      status: "unavailable",
      reason: "report-malformed",
    });
    expect(JSON.stringify(result)).not.toContain(plantedSecret);
  });

  test.each([
    ["a JSON array", "[1,2,3]"],
    ["a JSON number", "42"],
    ["a JSON string", '"just a string"'],
    ["null", "null"],
  ])(
    "returns report-malformed when the parsed report is %s (not a plain object)",
    (_label, json) => {
      const dirName = dirNameFor(STARTED_AT);
      mockReaddirSync([fakeDirent(dirName)]);
      mockReadFileSync(new Map([[reportPathFor(dirName), json]]));

      expect(locateRunReport(baseOptions())).toEqual({
        status: "unavailable",
        reason: "report-malformed",
      });
    },
  );

  test("returns report-malformed when the parsed report lacks a string script.name", () => {
    const dirName = dirNameFor(STARTED_AT);
    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([
        [reportPathFor(dirName), JSON.stringify({ outcome: "success" })],
      ]),
    );

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "report-malformed",
    });
  });

  test("continues to the next-older candidate when script.name does not match (only candidate — exhausted)", () => {
    const dirName = dirNameFor(STARTED_AT);
    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([
        [
          reportPathFor(dirName),
          JSON.stringify(
            minimalReport({
              script: { name: "other-script", version: "1.0.0" },
            }),
          ),
        ],
      ]),
    );

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "no-matching-report",
    });
  });
});

describe("locateRunReport — exhaustion", () => {
  test("returns no-matching-report when every in-window candidate has no report file", () => {
    const a = dirNameFor(new Date(STARTED_AT.getTime() + 1000));
    const b = dirNameFor(new Date(STARTED_AT.getTime() + 2000));
    mockReaddirSync([fakeDirent(a), fakeDirent(b)]);
    mockReadFileSync(new Map());

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "no-matching-report",
    });
  });

  test("returns no-matching-report when every in-window candidate belongs to a different script", () => {
    const a = dirNameFor(new Date(STARTED_AT.getTime() + 1000));
    const b = dirNameFor(new Date(STARTED_AT.getTime() + 2000));
    mockReaddirSync([fakeDirent(a), fakeDirent(b)]);
    mockReadFileSync(
      new Map([
        [
          reportPathFor(a),
          JSON.stringify(
            minimalReport({ script: { name: "other-a", version: "1.0.0" } }),
          ),
        ],
        [
          reportPathFor(b),
          JSON.stringify(
            minimalReport({ script: { name: "other-b", version: "1.0.0" } }),
          ),
        ],
      ]),
    );

    expect(locateRunReport(baseOptions())).toEqual({
      status: "unavailable",
      reason: "no-matching-report",
    });
  });
});

describe("locateRunReport — allowlist projection (summary)", () => {
  test("projects exactly {outcome, timelineCount, timelineSourceCount, recoveryTotal} and never leaks any other report field", () => {
    const dirName = dirNameFor(STARTED_AT);
    const planted = {
      correlationId: "PLANTED-CORRELATION-9f8e",
      environmentValue: "PLANTED-ENVIRONMENT-VALUE",
      archiveValue: "PLANTED-ARCHIVE-VALUE",
      failureMessage: "PLANTED-FAILURE-MESSAGE",
      failureStack: "PLANTED-FAILURE-STACK",
      recoveryItem: "PLANTED-RECOVERY-ITEM",
      recoveryErrorMessage: "PLANTED-RECOVERY-ERROR-MESSAGE",
      breadcrumbEvent: "PLANTED-BREADCRUMB-EVENT",
      breadcrumbPayloadValue: "PLANTED-BREADCRUMB-PAYLOAD-VALUE",
    };

    const sensitiveReport = {
      script: { name: SCRIPT_NAME, version: "1.0.0" },
      correlationId: planted.correlationId,
      startedAt: STARTED_AT.toISOString(),
      finishedAt: FINISHED_AT.toISOString(),
      exitCode: 0,
      environment: { node: planted.environmentValue },
      timeline: [
        {
          timestamp: STARTED_AT.toISOString(),
          source: "loader",
          event: planted.breadcrumbEvent,
          payload: { detail: planted.breadcrumbPayloadValue },
        },
        {
          timestamp: STARTED_AT.toISOString(),
          source: "writer",
          event: "step-2",
          payload: {},
        },
      ],
      archive: { note: planted.archiveValue },
      failure: {
        stage: "mainFn",
        chain: [
          {
            name: "Error",
            message: planted.failureMessage,
            stack: planted.failureStack,
          },
        ],
      },
      recovery: [
        {
          item: planted.recoveryItem,
          error: [{ name: "Error", message: planted.recoveryErrorMessage }],
          recordedAt: STARTED_AT.toISOString(),
        },
      ],
      recoveryTotal: 1,
      outcome: "success",
    };

    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([[reportPathFor(dirName), JSON.stringify(sensitiveReport)]]),
    );

    const result = locateRunReport(baseOptions());

    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("expected a found result");
    expect(Object.keys(result.summary).sort()).toEqual([
      "outcome",
      "recoveryTotal",
      "timelineCount",
      "timelineSourceCount",
    ]);
    // outcome "success" (not "partial") drops recoveryTotal to null, even
    // though the sensitive fixture carries one — proving both the allowlist
    // AND the outcome-gating rule in the same assertion.
    expect(result.summary).toEqual({
      outcome: "success",
      timelineCount: 2,
      timelineSourceCount: 2,
      recoveryTotal: null,
    });

    const serialized = JSON.stringify(result);
    for (const marker of Object.values(planted)) {
      expect(serialized).not.toContain(marker);
    }
  });

  test.each(["success", "failure", "dry-run", "interrupted", "partial"])(
    "copies a recognized outcome literal: %s",
    (outcome) => {
      const dirName = dirNameFor(STARTED_AT);
      mockReaddirSync([fakeDirent(dirName)]);
      mockReadFileSync(
        new Map([
          [reportPathFor(dirName), JSON.stringify(minimalReport({ outcome }))],
        ]),
      );

      const result = locateRunReport(baseOptions());
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.summary.outcome).toBe(outcome);
      }
    },
  );

  test("projects an unrecognized outcome literal to null", () => {
    const dirName = dirNameFor(STARTED_AT);
    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([
        [
          reportPathFor(dirName),
          JSON.stringify(minimalReport({ outcome: "not-a-real-outcome" })),
        ],
      ]),
    );

    const result = locateRunReport(baseOptions());
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.summary.outcome).toBeNull();
    }
  });

  test("timelineCount and timelineSourceCount are null when timeline is not an array", () => {
    const dirName = dirNameFor(STARTED_AT);
    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([
        [
          reportPathFor(dirName),
          JSON.stringify(minimalReport({ timeline: "not-an-array" })),
        ],
      ]),
    );

    const result = locateRunReport(baseOptions());
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.summary.timelineCount).toBeNull();
      expect(result.summary.timelineSourceCount).toBeNull();
    }
  });

  test("timelineSourceCount counts distinct sources, excluding non-object entries and entries whose source is not a string", () => {
    const dirName = dirNameFor(STARTED_AT);
    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([
        [
          reportPathFor(dirName),
          JSON.stringify(
            minimalReport({
              timeline: [
                { source: "loader", event: "a" },
                { source: "loader", event: "b" },
                { source: 42, event: "c" },
                "not-an-object",
                null,
                { event: "d" },
              ],
            }),
          ),
        ],
      ]),
    );

    const result = locateRunReport(baseOptions());
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.summary.timelineCount).toBe(6);
      expect(result.summary.timelineSourceCount).toBe(1);
    }
  });

  test("recoveryTotal survives only when outcome is partial and recoveryTotal is a number", () => {
    const dirName = dirNameFor(STARTED_AT);
    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([
        [
          reportPathFor(dirName),
          JSON.stringify(
            minimalReport({ outcome: "partial", recoveryTotal: 7 }),
          ),
        ],
      ]),
    );

    const result = locateRunReport(baseOptions());
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.summary.recoveryTotal).toBe(7);
    }
  });

  test("recoveryTotal is dropped to null when present under a non-partial outcome", () => {
    const dirName = dirNameFor(STARTED_AT);
    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([
        [
          reportPathFor(dirName),
          JSON.stringify(
            minimalReport({ outcome: "success", recoveryTotal: 7 }),
          ),
        ],
      ]),
    );

    const result = locateRunReport(baseOptions());
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.summary.recoveryTotal).toBeNull();
    }
  });

  test("recoveryTotal is null when outcome is partial but recoveryTotal is not a number", () => {
    const dirName = dirNameFor(STARTED_AT);
    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([
        [
          reportPathFor(dirName),
          JSON.stringify(
            minimalReport({ outcome: "partial", recoveryTotal: "7" }),
          ),
        ],
      ]),
    );

    const result = locateRunReport(baseOptions());
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.summary.recoveryTotal).toBeNull();
    }
  });

  test("a hostile getter on a report field degrades that field to null instead of crashing the whole lookup", () => {
    const dirName = dirNameFor(STARTED_AT);
    const hostileReport: Record<string, unknown> = {
      script: { name: SCRIPT_NAME, version: "1.0.0" },
      outcome: "success",
    };
    Object.defineProperty(hostileReport, "timeline", {
      enumerable: true,
      get(): never {
        throw new Error("hostile timeline getter");
      },
    });

    mockReaddirSync([fakeDirent(dirName)]);
    // The actual file content is irrelevant: JSON.parse is stubbed to hand
    // back the hostile object directly, since a getter cannot be expressed in
    // JSON text at all.
    mockReadFileSync(new Map([[reportPathFor(dirName), "{}"]]));
    vi.spyOn(JSON, "parse").mockReturnValue(hostileReport);

    let result: M3LCliRunReportLookup | undefined;
    expect(() => {
      result = locateRunReport(baseOptions());
    }).not.toThrow();

    expect(result?.status).toBe("found");
    if (result?.status === "found") {
      expect(result.summary.timelineCount).toBeNull();
      expect(result.summary.timelineSourceCount).toBeNull();
    }
  });
});

describe("locateRunReport — found result shape", () => {
  test("reportPath is the exact absolute path of the run-report.json file that matched", () => {
    const dirName = dirNameFor(STARTED_AT);
    mockReaddirSync([fakeDirent(dirName)]);
    mockReadFileSync(
      new Map([[reportPathFor(dirName), JSON.stringify(minimalReport())]]),
    );

    expect(locateRunReport(baseOptions())).toMatchObject({
      status: "found",
      reportPath: reportPathFor(dirName),
    });
  });
});

describe("locateRunReport — type contract", () => {
  test("returns exactly the M3LCliRunReportLookup union", () => {
    expectTypeOf(
      locateRunReport,
    ).returns.toEqualTypeOf<M3LCliRunReportLookup>();
  });

  test("accepts exactly the documented options shape", () => {
    expectTypeOf(locateRunReport)
      .parameter(0)
      .toEqualTypeOf<M3LCliRunReportLookupOptions>();
  });
});
