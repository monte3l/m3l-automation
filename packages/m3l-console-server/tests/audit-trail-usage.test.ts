/**
 * Tests for `src/audit-trail-usage.ts` — `reportAuditTrailUsage`, the
 * X8 audit-trail retention-sweep OBSERVATION driver (ADR-0070). Unlike its
 * three sibling retention drivers (`telemetry-retention.ts`,
 * `run-output-retention.ts`, `session-artifact-retention.ts`), this driver
 * deletes nothing — it only inventories `Core.M3LAppendOnlyStream`'s
 * segments under the resolved audit root and reports a count and a byte
 * total. That "observes, never mutates" property is this suite's defining
 * assertion (the "report-only" test below).
 *
 * Real temporary directories via `node:fs/promises` (named imports, not an
 * `fs.`/`fsp.` namespace object — see `eslint.config.js`'s unit-test
 * fs-mutation ban, which only matches the member-expression form) are used
 * throughout, mirroring `tests/cleanup.test.ts` and `tests/audit-stream.test.ts`.
 *
 * RED: `../src/audit-trail-usage.js` does not exist yet — every import below
 * is expected to fail to resolve until the implementer lands the module.
 *
 * CORRECTION to the assigning task's fixture rationale: it claimed
 * `2026-01-01-00005.jsonl` (5-digit, zero-padded) would be COUNTED as a
 * genuine segment, since Core's regex
 * (`internal/storage/append-only-segments.ts`,
 * `/^(\d{4}-\d{2}-\d{2})-(\d{4,})\.jsonl$/`) accepts four-OR-MORE digits.
 * The regex is only half the parser: `parseSegmentName` re-renders the
 * parsed sequence with `padStart(4, "0")` and declines the name unless that
 * round-trips exactly. `00005` parses to sequence 5, re-renders as
 * `2026-01-01-0005.jsonl`, and is EXCLUDED by that round-trip check, not by
 * the `{4,}` minimum. A genuinely wide sequence such as
 * `2026-01-01-12345.jsonl` DOES round-trip (`padStart(4)` is a no-op above
 * four digits) and IS counted. The "foreign files" describe block below
 * pins all three: `005` excluded (fails `{4,}`), `00005` excluded (fails
 * the round-trip check), `12345` included.
 */
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  reportAuditTrailUsage,
  type M3LAuditTrailUsageOutcome,
  type ReportAuditTrailUsageOptions,
} from "../src/audit-trail-usage.js";

/** The exact naming Core's writer produces: `<YYYY-MM-DD>-<NNNN>.jsonl`
 *  (four-OR-MORE-digit sequence, subject to the round-trip check — see the
 *  header's correction note). */
const SEGMENT_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4,}\.jsonl$/;

/** The temp root each test's audit directories live under. */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "m3l-audit-trail-usage-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Type contract
// ---------------------------------------------------------------------------

describe("M3LAuditTrailUsageOutcome", () => {
  test("has exactly two readonly number fields", () => {
    expectTypeOf<M3LAuditTrailUsageOutcome>().toEqualTypeOf<{
      readonly segments: number;
      readonly totalBytes: number;
    }>();
  });
});

describe("ReportAuditTrailUsageOptions", () => {
  test("accepts exactly { auditRoot: string }", () => {
    expectTypeOf<ReportAuditTrailUsageOptions>().toEqualTypeOf<{
      readonly auditRoot: string;
    }>();
  });
});

// ---------------------------------------------------------------------------
// Never-created / empty root
// ---------------------------------------------------------------------------

describe("reportAuditTrailUsage — root does not exist", () => {
  test("returns zero segments and zero bytes rather than throwing", async () => {
    const auditRoot = join(root, "never-created");

    const outcome = await reportAuditTrailUsage({ auditRoot });

    expect(outcome).toEqual({ segments: 0, totalBytes: 0 });
  });
});

describe("reportAuditTrailUsage — root exists but is empty", () => {
  test("returns zero segments and zero bytes", async () => {
    const auditRoot = join(root, "empty");
    await mkdir(auditRoot, { recursive: true });

    const outcome = await reportAuditTrailUsage({ auditRoot });

    expect(outcome).toEqual({ segments: 0, totalBytes: 0 });
  });
});

// ---------------------------------------------------------------------------
// Real appends — expectations derived from the filesystem, never hard-coded
// ---------------------------------------------------------------------------

describe("reportAuditTrailUsage — real appended segments", () => {
  test("segments and totalBytes match the actual files on disk after rotation", async () => {
    const auditRoot = join(root, "real-appends");
    const stream = new Core.M3LAppendOnlyStream({
      directory: auditRoot,
      // Small enough that a handful of appends forces at least one rotation.
      maxSegmentBytes: 60,
    });

    for (let index = 0; index < 8; index += 1) {
      await stream.append({ index, note: "x".repeat(20) });
    }

    const outcome = await reportAuditTrailUsage({ auditRoot });

    // Ground truth read directly off disk — never a hard-coded number.
    const entries = await readdir(auditRoot);
    const segmentFiles = entries.filter((name) =>
      SEGMENT_FILE_PATTERN.test(name),
    );
    // Sanity: rotation actually happened, or this test proves nothing about
    // multi-segment counting.
    expect(segmentFiles.length).toBeGreaterThan(1);

    let expectedBytes = 0;
    for (const name of segmentFiles) {
      const stats = await stat(join(auditRoot, name));
      expectedBytes += stats.size;
    }

    expect(outcome.segments).toBe(segmentFiles.length);
    expect(outcome.totalBytes).toBe(expectedBytes);
  });
});

// ---------------------------------------------------------------------------
// Report-only — the single most important property in the suite
// ---------------------------------------------------------------------------

describe("reportAuditTrailUsage — deletes nothing, truncates nothing, creates nothing", () => {
  test("the audit directory's contents are byte-for-byte identical before and after", async () => {
    const auditRoot = join(root, "report-only");
    const stream = new Core.M3LAppendOnlyStream({
      directory: auditRoot,
      maxSegmentBytes: 200,
    });
    for (let index = 0; index < 4; index += 1) {
      await stream.append({ index, detail: "seed entry" });
    }

    const beforeNames = (await readdir(auditRoot)).sort();
    const beforeSizes: number[] = [];
    for (const name of beforeNames) {
      const stats = await stat(join(auditRoot, name));
      beforeSizes.push(stats.size);
    }

    await reportAuditTrailUsage({ auditRoot });

    const afterNames = (await readdir(auditRoot)).sort();
    const afterSizes: number[] = [];
    for (const name of afterNames) {
      const stats = await stat(join(auditRoot, name));
      afterSizes.push(stats.size);
    }

    expect(afterNames).toEqual(beforeNames);
    expect(afterSizes).toEqual(beforeSizes);
  });
});

// ---------------------------------------------------------------------------
// Foreign files are not counted
// ---------------------------------------------------------------------------

describe("reportAuditTrailUsage — foreign files beside a real segment", () => {
  test("the real segment and a wide-sequence name round-trip in; notes.txt, a 3-digit, and a lossy-padded name are excluded", async () => {
    const auditRoot = join(root, "foreign");
    const stream = new Core.M3LAppendOnlyStream({ directory: auditRoot });
    await stream.append({ event: "one real entry" });

    // Capture the real segment's name directly off disk, before any foreign
    // file is planted. Ground truth for this test must be independent of
    // `listSegments()` — that is exactly what `reportAuditTrailUsage` itself
    // calls, so comparing its result against `listSegments()`'s own output
    // would pass even if `listSegments()` were the one that was broken (e.g.
    // it wrongly counted `notes.txt`, or its round-trip check silently
    // stopped excluding a lossy-padded name).
    const afterRealAppend = await readdir(auditRoot);
    expect(afterRealAppend.length).toBe(1);
    const [realSegmentName] = afterRealAppend;
    if (realSegmentName === undefined) {
      throw new Error("expected exactly one real segment file on disk");
    }

    // A plainly non-segment file.
    await writeFile(join(auditRoot, "notes.txt"), "not a segment");
    // Fails Core's own sequence-width minimum outright (`\d{4,}` requires at
    // least four digits; this has three).
    await writeFile(join(auditRoot, "2026-01-01-005.jsonl"), '{"x":1}\n');
    // Matches the `{4,}` minimum (five digits) but fails the round-trip
    // check: `00005` parses to sequence 5, re-renders as
    // `2026-01-01-0005.jsonl`, and is declined for not matching the
    // original name — see the header's correction note.
    await writeFile(join(auditRoot, "2026-01-01-00005.jsonl"), '{"y":22}\n');
    // A genuinely wide sequence: round-trips exactly (`padStart(4)` is a
    // no-op above four digits), so this IS a real segment and must be
    // counted, proving the round-trip guard is not simply over-broad.
    const wideSegmentName = "2026-01-01-12345.jsonl";
    await writeFile(join(auditRoot, wideSegmentName), '{"z":333}\n');

    const outcome = await reportAuditTrailUsage({ auditRoot });

    // Ground truth built entirely from the planted fixture plus real `stat`
    // calls — the exact two files expected to count, named explicitly, never
    // derived through the driver's own machinery or `listSegments()`.
    const realSegmentStats = await stat(join(auditRoot, realSegmentName));
    const wideSegmentStats = await stat(join(auditRoot, wideSegmentName));
    const expectedBytes = realSegmentStats.size + wideSegmentStats.size;

    expect(outcome.segments).toBe(2);
    expect(outcome.totalBytes).toBe(expectedBytes);
  });
});

// ---------------------------------------------------------------------------
// Failure is wrapped
// ---------------------------------------------------------------------------

describe("reportAuditTrailUsage — a listing failure is wrapped", () => {
  test("raises M3LConsoleError ERR_CONSOLE_INTERNAL with cause chained and no absolute path in context", async () => {
    // A plain FILE named "blocker" makes readdir(auditRoot) fail ENOTDIR,
    // since auditRoot names a path component underneath a non-directory.
    const blockerPath = join(root, "blocker");
    await writeFile(blockerPath, "not a directory");
    const auditRoot = join(blockerPath, "sub");

    let thrown: unknown;
    try {
      await reportAuditTrailUsage({ auditRoot });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const consoleError = thrown as M3LConsoleError;
    expect(consoleError.code).toBe("ERR_CONSOLE_INTERNAL");
    expect(consoleError.cause).toBeDefined();

    // No absolute path in context — the sibling retention modules all hold
    // this line (session-artifact-retention.ts's header) and this must too.
    const contextJson = JSON.stringify(consoleError.context ?? {});
    expect(contextJson).not.toContain(root);
    expect(contextJson).not.toContain(auditRoot);
  });
});
