/**
 * Tests for `core/agent`'s V7 slice 2 decision-log writer (RED phase —
 * `M3LAgentDecisionLog` does not exist yet; only V7 slice 1's pure entry
 * schema/projector/serializer are shipped).
 *
 * Contract source: docs/reference/core/agent.md § "Writing the decision log"
 * and § "Escalating when the log is unavailable" plus ADR-0061.
 *
 * Exports under test: `M3LAgentDecisionLog` (class), `M3LAgentDecisionLogOptions`
 * (options bag type), `M3L_AGENT_LOG_MAX_SEGMENT_BYTES` /
 * `M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS` (rotation ceilings),
 * `M3LAgentDecisionLogWriteError` (`ERR_AGENT_DECISION_LOG_WRITE`).
 *
 * Entries are built through V7 slice 1's already-shipped
 * `agentDecisionLogEntry` / `serializeAgentDecisionLogEntry` rather than
 * hand-rolled objects, so this file only exercises the writer's own contract.
 *
 * ASSUMPTION FLAGGED FOR THE IMPLEMENTER: neither the doc nor any existing
 * source fixes the writer's exact method/option names (V7 slice 2 has no
 * source file yet). This file asserts:
 *   - `new M3LAgentDecisionLog(options?: M3LAgentDecisionLogOptions)`
 *   - `write(entry: M3LAgentDecisionLogEntry): Promise<void>`
 *   - `M3LAgentDecisionLogOptions.directory` FULLY overrides the resolved
 *     target directory (the doc's default is `new M3LPaths().getDataDir() +
 *     "agent-log"`; overriding `directory` replaces that whole computation,
 *     matching the barrel's singular "the directory override" phrasing).
 * If the implementer picks different names, this file's call sites need a
 * one-time rename — the behavioral assertions do not otherwise change.
 *
 * Rotation-by-age is driven without real sleeps by BOTH fabricating widely
 * spaced entry `now` values AND controlling the wall clock via
 * `vi.useFakeTimers()` / `vi.setSystemTime()` — the doc states the
 * *evaluator* reads no clock, but is silent on whether the (impure-by-design)
 * writer compares consecutive entries' own timestamps or reads the wall
 * clock via `Date.now()`/`fs.stat()` mtimes; driving both signals the same
 * direction discriminates the ceiling regardless of which the writer uses.
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import * as fsp from "node:fs/promises";

// Make 'node:fs/promises' configurable so vi.spyOn can intercept individual
// functions while everything else still hits the real filesystem — mirrors
// the pattern in tests/checkpoint.test.ts.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});

import { M3LError } from "../src/core/errors/index.js";
import { M3LPaths } from "../src/core/utils/index.js";
import {
  agentDecisionLogEntry,
  serializeAgentDecisionLogEntry,
  M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS,
  M3L_AGENT_LOG_MAX_SEGMENT_BYTES,
  M3LAgentDecisionLog,
  M3LAgentDecisionLogWriteError,
} from "../src/core/agent/index.js";
import type {
  M3LAgentDecision,
  M3LAgentDecisionLogEntry,
  M3LAgentDecisionLogOptions,
  M3LAgentIdentity,
} from "../src/core/agent/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const DEFAULT_IDENTITY: M3LAgentIdentity = { name: "release-bot" };

interface DecisionOverrides {
  readonly verdict?: M3LAgentDecision["verdict"];
  readonly rule?: M3LAgentDecision["rule"];
  readonly reason?: string;
  readonly script?: string;
  readonly parameterNames?: readonly string[];
}

/** Builds a structurally valid `M3LAgentDecision` for a given verdict arm. */
function makeDecision(overrides?: DecisionOverrides): M3LAgentDecision {
  const script = overrides?.script ?? "s3-report";
  const parameterNames = overrides?.parameterNames ?? ["bucket", "prefix"];
  return {
    verdict: overrides?.verdict ?? "auto-approved",
    rule: overrides?.rule ?? "read-only-auto-approved",
    reason: overrides?.reason ?? "read-only action on an allowlisted script",
    action: {
      script,
      operation: undefined,
      kind: "read-only",
      target: undefined,
      parameterNames,
      dryRun: false,
      shapeKey: `${script}:read-only`,
    },
  };
}

/** Builds a real, slice-1-validated entry ready to hand to the writer. */
function makeEntry(
  now: number,
  overrides?: DecisionOverrides & { identity?: M3LAgentIdentity },
): M3LAgentDecisionLogEntry {
  return agentDecisionLogEntry({
    decision: makeDecision(overrides),
    identity: overrides?.identity ?? DEFAULT_IDENTITY,
    now,
  });
}

/** Lists segment file names, sorted so "highest-numbered" ordering holds. */
async function listSegments(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return [...names].sort();
}

/** Reads a segment file and splits it into its non-empty JSONL lines. */
async function readLines(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, "utf8");
  return content.split("\n").filter((line) => line.length > 0);
}

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

const BASE_NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-agent-decision-log-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Type contracts
// ---------------------------------------------------------------------------

describe("type contracts", () => {
  test("M3LAgentDecisionLogOptions is an options bag with an optional directory and both rotation ceilings", () => {
    expectTypeOf<M3LAgentDecisionLogOptions>().toMatchObjectType<{
      readonly directory?: string;
      readonly maxSegmentBytes?: number;
      readonly maxSegmentAgeMs?: number;
    }>();
  });

  test("M3LAgentDecisionLog's constructor takes zero or one options bag", () => {
    // A real constructor's optional parameter is inferred by TS as
    // `T | undefined` (callers may always pass an explicit `undefined` to an
    // optional parameter — that is call-site arity, not the
    // `exactOptionalPropertyTypes` object-property rule), while a
    // hand-authored `[options?: T]` tuple under that flag means "T if
    // present" only. Spelling the expected tuple with the explicit
    // `| undefined` keeps `toEqualTypeOf` both satisfiable and load-bearing
    // (see the mismatch note in `logging.test.ts`'s constructor-parameters
    // assertion for the sibling case).
    expectTypeOf<
      typeof M3LAgentDecisionLog
    >().constructorParameters.toEqualTypeOf<
      [options?: M3LAgentDecisionLogOptions | undefined]
    >();
  });

  test("write() takes one entry and resolves void", () => {
    expectTypeOf<M3LAgentDecisionLog["write"]>().parameters.toEqualTypeOf<
      [M3LAgentDecisionLogEntry]
    >();
    expectTypeOf<M3LAgentDecisionLog["write"]>().returns.toEqualTypeOf<
      Promise<void>
    >();
  });

  test("the rotation ceiling constants are numbers", () => {
    expectTypeOf(M3L_AGENT_LOG_MAX_SEGMENT_BYTES).toBeNumber();
    expectTypeOf(M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS).toBeNumber();
  });

  test("M3LAgentDecisionLogWriteError narrows `code` to its own literal", () => {
    expectTypeOf<
      M3LAgentDecisionLogWriteError["code"]
    >().toEqualTypeOf<"ERR_AGENT_DECISION_LOG_WRITE">();
  });
});

// ---------------------------------------------------------------------------
// 9. Rotation constants — documented values, caller-overridable
// ---------------------------------------------------------------------------

describe("rotation ceiling constants", () => {
  test("M3L_AGENT_LOG_MAX_SEGMENT_BYTES is 8 MiB", () => {
    expect(M3L_AGENT_LOG_MAX_SEGMENT_BYTES).toBe(8_388_608);
  });

  test("M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS is 24 hours", () => {
    expect(M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS).toBe(86_400_000);
  });
});

// ---------------------------------------------------------------------------
// 1. Round-trip: exactly one JSON object per line; names appear, no values do
// ---------------------------------------------------------------------------

describe("round-trip", () => {
  test("appends several entries as one JSON object per line, equal to what was written", async () => {
    const dir = path.join(workDir, "agent-log");
    const log = new M3LAgentDecisionLog({ directory: dir });

    const entryA = makeEntry(BASE_NOW, {
      parameterNames: ["table", "item"],
      script: "dynamodb-crud",
    });
    const entryB = makeEntry(BASE_NOW + 1000, {
      parameterNames: ["bucket"],
      script: "s3-report",
      verdict: "escalate",
      rule: "sensitive-target-escalated",
      reason: "target graded sensitive",
    });

    await log.write(entryA);
    await log.write(entryB);

    const segments = await listSegments(dir);
    expect(segments).toHaveLength(1);
    const segmentPath = path.join(
      dir,
      definedOrThrow(segments[0], "the only segment"),
    );
    const lines = await readLines(segmentPath);
    expect(lines).toHaveLength(2);

    const parsed = lines.map((line) => JSON.parse(line) as unknown);
    expect(parsed[0]).toEqual(
      JSON.parse(serializeAgentDecisionLogEntry(entryA)),
    );
    expect(parsed[1]).toEqual(
      JSON.parse(serializeAgentDecisionLogEntry(entryB)),
    );

    const rawContent = await readFile(segmentPath, "utf8");
    // Parameter NAMES appear verbatim ...
    expect(rawContent).toContain("table");
    expect(rawContent).toContain("bucket");
    // ... but nothing beyond the entry's own declared fields does: the
    // projector never admits a parameter VALUE in the first place, so the
    // written line's parameterNames must equal exactly the given names, not
    // some other string masquerading as a value.
    for (const parsedLine of parsed) {
      expect(Object.keys(parsedLine as Record<string, unknown>).sort()).toEqual(
        Object.keys(
          JSON.parse(serializeAgentDecisionLogEntry(entryA)) as object,
        ).sort(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Creates data/agent-log/ itself when absent
// ---------------------------------------------------------------------------

describe("directory creation", () => {
  test("creates the (nested, absent) target directory on first write", async () => {
    const dir = path.join(workDir, "nested", "agent-log");
    const log = new M3LAgentDecisionLog({ directory: dir });

    await log.write(makeEntry(BASE_NOW));

    const segments = await listSegments(dir);
    expect(segments.length).toBeGreaterThanOrEqual(1);
  });

  test('honours the documented default: new M3LPaths().getDataDir() + "agent-log", via M3L_DATA_DIR', async () => {
    vi.stubEnv("M3L_DATA_DIR", workDir);
    const expectedDir = path.join(new M3LPaths().getDataDir(), "agent-log");

    const log = new M3LAgentDecisionLog();
    await log.write(makeEntry(BASE_NOW));

    const segments = await listSegments(expectedDir);
    expect(segments.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Every verdict is written, denied and escalate included
// ---------------------------------------------------------------------------

describe("every verdict is recorded", () => {
  test.each([
    ["auto-approved", "read-only-auto-approved"],
    ["denied", "script-not-allowlisted"],
    ["escalate", "sensitive-target-escalated"],
  ] as const)(
    "a %s verdict is appended, not filtered",
    async (verdict, rule) => {
      const dir = path.join(workDir, "agent-log");
      const log = new M3LAgentDecisionLog({ directory: dir });

      await log.write(makeEntry(BASE_NOW, { verdict, rule }));

      const segments = await listSegments(dir);
      const lines = await readLines(
        path.join(dir, definedOrThrow(segments[0], "the only segment")),
      );
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(definedOrThrow(lines[0], "the only line")) as {
        verdict: string;
        rule: string;
      };
      expect(parsed.verdict).toBe(verdict);
      expect(parsed.rule).toBe(rule);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Rotation by bytes
// ---------------------------------------------------------------------------

describe("rotation by bytes", () => {
  test("crossing the byte ceiling seals the active segment and opens a new one; the prior segment stays byte-unchanged", async () => {
    const dir = path.join(workDir, "agent-log");

    const entryA = makeEntry(BASE_NOW, { reason: "A".repeat(50) });
    const entryB = makeEntry(BASE_NOW + 1, { reason: "B".repeat(50) });
    const entryC = makeEntry(BASE_NOW + 2, { reason: "C".repeat(50) });

    const lineA = serializeAgentDecisionLogEntry(entryA);
    const byteA = Buffer.byteLength(lineA, "utf8");

    // Ceiling sits just above one line: A alone fits, A+B (plus separating
    // newline) does not, so B is the entry whose write crosses the ceiling.
    const maxSegmentBytes = byteA + 10;
    const log = new M3LAgentDecisionLog({ directory: dir, maxSegmentBytes });

    await log.write(entryA);
    await log.write(entryB);

    const segmentsAfterB = await listSegments(dir);
    expect(segmentsAfterB).toHaveLength(1);
    const firstSegmentPath = path.join(
      dir,
      definedOrThrow(segmentsAfterB[0], "the only segment"),
    );
    const contentAfterB = await readFile(firstSegmentPath, "utf8");

    await log.write(entryC);

    const segmentsAfterC = await listSegments(dir);
    expect(segmentsAfterC).toHaveLength(2);

    // The sealed segment must be byte-for-byte unchanged.
    const contentAfterC = await readFile(firstSegmentPath, "utf8");
    expect(contentAfterC).toBe(contentAfterB);

    // No line was truncated or lost: entryC lives in the new segment.
    const newSegmentPath = segmentsAfterC
      .map((name) => path.join(dir, name))
      .find((candidate) => candidate !== firstSegmentPath);
    expect(newSegmentPath).toBeDefined();
    const newLines = await readLines(
      definedOrThrow(newSegmentPath, "the new segment path"),
    );
    expect(newLines).toHaveLength(1);
    expect(
      JSON.parse(definedOrThrow(newLines[0], "the only new line")),
    ).toEqual(JSON.parse(serializeAgentDecisionLogEntry(entryC)));

    // All three entries are recoverable across the two segments, in order.
    const firstLines = await readLines(firstSegmentPath);
    expect(firstLines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Rotation by age
// ---------------------------------------------------------------------------

describe("rotation by age", () => {
  test("crossing the age ceiling seals the active segment and opens a new one", async () => {
    const dir = path.join(workDir, "agent-log");
    const maxSegmentAgeMs = 1000;
    const log = new M3LAgentDecisionLog({ directory: dir, maxSegmentAgeMs });

    const realStart = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(realStart);

    const entryA = makeEntry(realStart);
    await log.write(entryA);

    const segmentsAfterA = await listSegments(dir);
    expect(segmentsAfterA).toHaveLength(1);
    const firstSegmentPath = path.join(
      dir,
      definedOrThrow(segmentsAfterA[0], "the only segment"),
    );
    const contentAfterA = await readFile(firstSegmentPath, "utf8");

    // Advance well past the ceiling, both in the entry's own caller-sampled
    // `now` and in whatever wall clock the writer might read internally.
    const later = realStart + maxSegmentAgeMs + 60_000;
    vi.setSystemTime(later);
    const entryB = makeEntry(later);
    await log.write(entryB);

    vi.useRealTimers();

    const segmentsAfterB = await listSegments(dir);
    expect(segmentsAfterB).toHaveLength(2);

    const contentAfterB = await readFile(firstSegmentPath, "utf8");
    expect(contentAfterB).toBe(contentAfterA);

    const newSegmentPath = segmentsAfterB
      .map((name) => path.join(dir, name))
      .find((candidate) => candidate !== firstSegmentPath);
    expect(newSegmentPath).toBeDefined();
    const newLines = await readLines(
      definedOrThrow(newSegmentPath, "the new segment path"),
    );
    expect(newLines).toHaveLength(1);
    expect(
      JSON.parse(definedOrThrow(newLines[0], "the only new line")),
    ).toEqual(JSON.parse(serializeAgentDecisionLogEntry(entryB)));
  });
});

// ---------------------------------------------------------------------------
// 6. Cold-start segment discovery — a fresh instance, no index file, no
//    carried in-memory state
// ---------------------------------------------------------------------------

describe("cold-start segment discovery", () => {
  test("a fresh writer instance appends to the existing under-ceiling segment rather than starting a redundant new one", async () => {
    const dir = path.join(workDir, "agent-log");
    const options: M3LAgentDecisionLogOptions = { directory: dir };

    const firstProcess = new M3LAgentDecisionLog(options);
    await firstProcess.write(makeEntry(BASE_NOW));

    const segmentsAfterFirst = await listSegments(dir);
    expect(segmentsAfterFirst).toHaveLength(1);

    // A brand new instance — nothing shared with `firstProcess` — pointed at
    // the same directory, simulating a second, freshly spawned process.
    const secondProcess = new M3LAgentDecisionLog(options);
    await secondProcess.write(makeEntry(BASE_NOW + 1));

    const segmentsAfterSecond = await listSegments(dir);
    expect(segmentsAfterSecond).toHaveLength(1);
    expect(segmentsAfterSecond).toEqual(segmentsAfterFirst);

    const lines = await readLines(
      path.join(
        dir,
        definedOrThrow(segmentsAfterSecond[0], "the only segment"),
      ),
    );
    expect(lines).toHaveLength(2);
  });

  test("a fresh writer instance seals an existing over-ceiling segment and opens a new one instead of appending", async () => {
    const dir = path.join(workDir, "agent-log");
    const entryA = makeEntry(BASE_NOW, { reason: "A".repeat(50) });
    const byteA = Buffer.byteLength(
      serializeAgentDecisionLogEntry(entryA),
      "utf8",
    );
    // A ceiling below even one line's size: the first segment is already
    // "over ceiling" the moment it holds one entry.
    const options: M3LAgentDecisionLogOptions = {
      directory: dir,
      maxSegmentBytes: byteA - 1,
    };

    const firstProcess = new M3LAgentDecisionLog(options);
    await firstProcess.write(entryA);
    const segmentsAfterFirst = await listSegments(dir);
    expect(segmentsAfterFirst).toHaveLength(1);
    const firstSegmentPath = path.join(
      dir,
      definedOrThrow(segmentsAfterFirst[0], "the only segment"),
    );
    const contentAfterFirst = await readFile(firstSegmentPath, "utf8");

    const secondProcess = new M3LAgentDecisionLog(options);
    await secondProcess.write(makeEntry(BASE_NOW + 1));

    const segmentsAfterSecond = await listSegments(dir);
    expect(segmentsAfterSecond).toHaveLength(2);
    const contentStillFirst = await readFile(firstSegmentPath, "utf8");
    expect(contentStillFirst).toBe(contentAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// 7. Loud write failure
// ---------------------------------------------------------------------------

describe("write failure is loud", () => {
  test("a failed append throws M3LAgentDecisionLogWriteError, chaining the cause, never swallowed, and leaks no caller data", async () => {
    const dir = path.join(workDir, "agent-log");
    const log = new M3LAgentDecisionLog({ directory: dir });

    const injectedError = new Error("simulated fs failure");
    // Defensively cover every plausible append primitive: only whichever
    // one the (not-yet-written) implementation actually calls will matter.
    vi.spyOn(fsp, "appendFile").mockRejectedValue(injectedError);
    vi.spyOn(fsp, "writeFile").mockRejectedValue(injectedError);
    vi.spyOn(fsp, "open").mockRejectedValue(injectedError);

    const secretName = "release-bot-secret-identity";
    const secretReason = "a very specific reason string that must not leak";
    const entry = makeEntry(BASE_NOW, {
      identity: { name: secretName },
      reason: secretReason,
    });

    let thrown: unknown;
    try {
      await log.write(entry);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentDecisionLogWriteError);
    expect(thrown).toBeInstanceOf(M3LError);
    const typed = thrown as M3LAgentDecisionLogWriteError;
    expect(typed.code).toBe("ERR_AGENT_DECISION_LOG_WRITE");
    expect(typed.cause).toBe(injectedError);

    const serializedContext = JSON.stringify(typed.context ?? {});
    expect(serializedContext).not.toContain(secretName);
    expect(serializedContext).not.toContain(secretReason);
    expect(typed.message).not.toContain(secretName);
    expect(typed.message).not.toContain(secretReason);
  });
});

// ---------------------------------------------------------------------------
// 8. Entry-size ceiling
// ---------------------------------------------------------------------------

describe("entry-size ceiling", () => {
  test("an entry whose serialized line exceeds M3L_AGENT_MAX_LOG_ENTRY_BYTES throws rather than tearing a write", async () => {
    const dir = path.join(workDir, "agent-log");
    const log = new M3LAgentDecisionLog({ directory: dir });

    // `agentDecisionLogEntry`'s own structural validator enforces no length
    // cap on `reason` (only `M3L_AGENT_MAX_PARAMETER_NAMES` gates the
    // caller's action, one layer up, at `evaluateAgentAction`), so a huge
    // `reason` reaches the writer as a valid entry that is simply oversized.
    const oversizedReason = "x".repeat(200_000);
    const oversizedEntry = makeEntry(BASE_NOW, { reason: oversizedReason });
    expect(
      Buffer.byteLength(serializeAgentDecisionLogEntry(oversizedEntry), "utf8"),
    ).toBeGreaterThan(65_536);

    await expect(log.write(oversizedEntry)).rejects.toBeInstanceOf(
      M3LAgentDecisionLogWriteError,
    );

    let filesAfter: string[];
    try {
      filesAfter = await readdir(dir);
    } catch {
      // ENOENT is fine: nothing was ever created.
      filesAfter = [];
    }
    for (const name of filesAfter) {
      const content = await readFile(path.join(dir, name), "utf8");
      expect(content).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Branch-coverage closures: stray directory entries, an already-typed
//     re-throw, cross-date segment selection, the mtimeMs fallback, and the
//     date-rollover sequence reset.
// ---------------------------------------------------------------------------

describe("stray, non-segment directory entries are ignored", () => {
  test("a directory entry that doesn't match the segment name pattern is skipped, not mis-parsed or thrown on", async () => {
    const dir = path.join(workDir, "agent-log");
    await mkdir(dir, { recursive: true });
    // Neither name matches `<YYYY-MM-DD>-<NNNN>.jsonl`.
    await writeFile(path.join(dir, "README.txt"), "not a segment");
    await writeFile(path.join(dir, ".DS_Store"), "");

    const log = new M3LAgentDecisionLog({ directory: dir });
    const entry = makeEntry(Date.now());
    await log.write(entry);

    const today = new Date().toISOString().slice(0, 10);
    const expectedSegmentName = `${today}-0001.jsonl`;
    const segments = await listSegments(dir);
    // The stray entries are still there, plus exactly one fresh segment —
    // proving cold-start discovery found no valid "best" and started a new
    // segment at sequence 1, rather than choking on the stray names.
    expect(segments).toEqual(
      [".DS_Store", "README.txt", expectedSegmentName].sort(),
    );

    const lines = await readLines(path.join(dir, expectedSegmentName));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(definedOrThrow(lines[0], "the only line"))).toEqual(
      JSON.parse(serializeAgentDecisionLogEntry(entry)),
    );

    // The stray files themselves were never touched.
    expect(await readFile(path.join(dir, "README.txt"), "utf8")).toBe(
      "not a segment",
    );
    expect(await readFile(path.join(dir, ".DS_Store"), "utf8")).toBe("");
  });
});

describe("an already-typed error is re-thrown unchanged", () => {
  test("an M3LError surfacing from inside the write is thrown as the exact same instance, not double-wrapped", async () => {
    const dir = path.join(workDir, "agent-log");
    const log = new M3LAgentDecisionLog({ directory: dir });

    const alreadyTyped = new M3LAgentDecisionLogWriteError(
      "already typed from a lower layer",
      { context: {} },
    );
    vi.spyOn(fsp, "appendFile").mockRejectedValue(alreadyTyped);

    let thrown: unknown;
    try {
      await log.write(makeEntry(BASE_NOW));
    } catch (error) {
      thrown = error;
    }

    // Re-thrown unchanged: the exact instance, not a new wrapper around it.
    expect(thrown).toBe(alreadyTyped);
  });
});

describe("segment selection across dates and out-of-order sequences", () => {
  test("skips a different-date segment (even one with a higher sequence number) and picks today's highest-sequence segment regardless of directory listing order", async () => {
    const dir = path.join(workDir, "agent-log");
    await mkdir(dir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    // Seeded in NON-ascending order for today, plus an older-date segment
    // whose sequence number is higher than every one of today's — proving
    // the date filter (not just the sequence comparison) drives selection.
    await writeFile(path.join(dir, `${yesterday}-9999.jsonl`), "");
    await writeFile(path.join(dir, `${today}-0003.jsonl`), "");
    await writeFile(path.join(dir, `${today}-0001.jsonl`), "");
    await writeFile(path.join(dir, `${today}-0005.jsonl`), "");

    const log = new M3LAgentDecisionLog({ directory: dir });
    const entry = makeEntry(Date.now());
    await log.write(entry);

    // No new segment was created: the writer appended to today's highest
    // (0005), leaving the segment count unchanged at 4.
    const segments = await listSegments(dir);
    expect(segments).toHaveLength(4);

    const chosenPath = path.join(dir, `${today}-0005.jsonl`);
    const lines = await readLines(chosenPath);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(definedOrThrow(lines[0], "the only line"))).toEqual(
      JSON.parse(serializeAgentDecisionLogEntry(entry)),
    );

    // Every other segment — including yesterday's higher-numbered one —
    // stays untouched (still empty).
    for (const name of [
      `${yesterday}-9999.jsonl`,
      `${today}-0001.jsonl`,
      `${today}-0003.jsonl`,
    ]) {
      const content = await readFile(path.join(dir, name), "utf8");
      expect(content).toBe("");
    }
  });
});

describe("segment age falls back to mtimeMs when the filesystem reports no birth time", () => {
  test("a stat() reporting birthtimeMs 0 still drives age-based rotation off mtimeMs", async () => {
    const dir = path.join(workDir, "agent-log");
    await mkdir(dir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const segmentName = `${today}-0001.jsonl`;
    const segmentPath = path.join(dir, segmentName);
    await writeFile(segmentPath, "");

    const realStats = await fsp.stat(segmentPath);
    const maxSegmentAgeMs = 1000;
    // A filesystem that reports no birth time (birthtimeMs === 0), whose
    // mtimeMs is old enough to already be past the age ceiling.
    const staleMtimeMs = Date.now() - maxSegmentAgeMs - 60_000;
    vi.spyOn(fsp, "stat").mockResolvedValue({
      ...realStats,
      size: 0,
      birthtimeMs: 0,
      mtimeMs: staleMtimeMs,
    });

    const log = new M3LAgentDecisionLog({ directory: dir, maxSegmentAgeMs });
    await log.write(makeEntry(Date.now()));

    // Age-based rotation fired off the mtimeMs fallback: a new segment was
    // opened rather than appending to the (empty, but "old" per mtimeMs)
    // existing one.
    const segments = await listSegments(dir);
    expect(segments).toHaveLength(2);
    expect(await readFile(segmentPath, "utf8")).toBe("");
  });
});

describe("a date rollover across a rotation resets the sequence to 1", () => {
  test("the new segment's sequence starts over at 1 under the new date rather than continuing the prior day's sequence", async () => {
    const dir = path.join(workDir, "agent-log");
    const dayOneStart = Date.UTC(2026, 0, 1, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(dayOneStart);

    const entryA = makeEntry(dayOneStart, { reason: "A".repeat(50) });
    const byteA = Buffer.byteLength(
      serializeAgentDecisionLogEntry(entryA),
      "utf8",
    );
    // A ceiling below even one line's size: every single write already
    // crosses it, forcing the very next write to rotate.
    const maxSegmentBytes = byteA - 1;
    const log = new M3LAgentDecisionLog({ directory: dir, maxSegmentBytes });

    await log.write(entryA); // day-one, sequence 1

    vi.setSystemTime(dayOneStart + 1);
    await log.write(makeEntry(dayOneStart + 1, { reason: "B".repeat(50) })); // rotates -> sequence 2, same date

    vi.setSystemTime(dayOneStart + 2);
    await log.write(makeEntry(dayOneStart + 2, { reason: "C".repeat(50) })); // rotates -> sequence 3, same date

    const dayTwoStart = Date.UTC(2026, 0, 2, 1, 0, 0);
    vi.setSystemTime(dayTwoStart);
    // Rotates again, but the date has rolled over — sequence must reset to
    // 1 rather than continuing to 4.
    await log.write(makeEntry(dayTwoStart, { reason: "D".repeat(50) }));

    vi.useRealTimers();

    const dayOnePrefix = new Date(dayOneStart).toISOString().slice(0, 10);
    const dayTwoPrefix = new Date(dayTwoStart).toISOString().slice(0, 10);

    const segments = await listSegments(dir);
    expect(segments).toHaveLength(4);
    expect(segments).toContain(`${dayOnePrefix}-0001.jsonl`);
    expect(segments).toContain(`${dayOnePrefix}-0002.jsonl`);
    expect(segments).toContain(`${dayOnePrefix}-0003.jsonl`);
    expect(segments).toContain(`${dayTwoPrefix}-0001.jsonl`);
    // Never continues the prior day's sequence across the rollover.
    expect(segments).not.toContain(`${dayTwoPrefix}-0004.jsonl`);

    const rolloverLines = await readLines(
      path.join(dir, `${dayTwoPrefix}-0001.jsonl`),
    );
    expect(rolloverLines).toHaveLength(1);
  });
});
