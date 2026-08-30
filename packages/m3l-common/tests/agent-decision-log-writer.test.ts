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
  M3L_AGENT_MAX_LOG_ENTRY_BYTES,
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

/** A fixed, mid-day UTC instant used whenever a test pins the wall clock. */
const FIXED_CLOCK = Date.UTC(2026, 5, 15, 12, 0, 0);

/**
 * Pins the wall clock and returns the UTC date prefix (`YYYY-MM-DD`) the
 * writer derives from it.
 *
 * Any test that predicts a segment file NAME must sample the date from the
 * same instant the writer does: sampling `new Date()` in the test while the
 * writer samples its own `Date.now()` makes the expected and the produced
 * names disagree on a run that straddles UTC midnight.
 */
function pinClock(atMs: number = FIXED_CLOCK): string {
  vi.useFakeTimers();
  vi.setSystemTime(atMs);
  return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * Asserts a caller-side boundary violation: a BARE {@link M3LError} carrying
 * `code: "ERR_INVALID_ARGUMENT"`, following the house pattern in
 * `aws/s3/uri.ts` and `internal/logging/levels.ts`.
 *
 * The vocabulary split at this boundary is deliberate and asserted here in
 * both directions: bad caller input is `ERR_INVALID_ARGUMENT`, while
 * `M3LAgentDecisionLogWriteError` (`ERR_AGENT_DECISION_LOG_WRITE`) stays
 * reserved for a failure of the append itself.
 */
function expectInvalidArgument(thrown: unknown): M3LError {
  expect(thrown).toBeInstanceOf(M3LError);
  expect(thrown).not.toBeInstanceOf(M3LAgentDecisionLogWriteError);
  const error = thrown as M3LError;
  expect(error.code).toBe("ERR_INVALID_ARGUMENT");
  return error;
}

/** Runs `run` and returns whatever it threw, or `undefined` if it did not. */
function catchThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Awaits `run` and returns whatever it rejected with, or `undefined`. */
async function catchRejected(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Constructs through an `unknown` seam so a structurally invalid options bag
 * can be handed to the constructor without weakening the public type.
 */
function construct(options: unknown): M3LAgentDecisionLog {
  return new M3LAgentDecisionLog(options as M3LAgentDecisionLogOptions);
}

/**
 * Hands an arbitrary value to `write()` through an `unknown` seam, so a
 * structurally invalid entry can be passed without weakening the public type.
 */
async function writeUnchecked(
  log: M3LAgentDecisionLog,
  entry: unknown,
): Promise<void> {
  await log.write(entry as M3LAgentDecisionLogEntry);
}

/** Asserts the directory holds no file with any content. */
async function expectNothingWritten(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // ENOENT is the strongest possible outcome: nothing was ever created.
    return;
  }
  for (const name of names) {
    expect(await readFile(path.join(dir, name), "utf8")).toBe("");
  }
}

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

    const today = pinClock();
    const log = new M3LAgentDecisionLog({ directory: dir });
    const entry = makeEntry(Date.now());
    await log.write(entry);

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

    const today = pinClock();
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

    const today = pinClock();
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

// ---------------------------------------------------------------------------
// 11. Constructor options validation — the caller-input half of the error
//     vocabulary: a bare M3LError with `code: "ERR_INVALID_ARGUMENT"`, never
//     M3LAgentDecisionLogWriteError (which is reserved for a failed append).
// ---------------------------------------------------------------------------

/** The six rejections shared by both numeric rotation ceilings. */
const INVALID_CEILINGS: [label: string, value: unknown][] = [
  ["zero", 0],
  ["a negative number", -1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["a non-integer", 1.5],
  ["a numeric string", "8388608"],
];

type CeilingCase = [
  field: "maxSegmentBytes" | "maxSegmentAgeMs",
  label: string,
  value: unknown,
];

const INVALID_CEILING_CASES: CeilingCase[] = (
  ["maxSegmentBytes", "maxSegmentAgeMs"] as const
).flatMap((field) =>
  INVALID_CEILINGS.map(([label, value]): CeilingCase => [field, label, value]),
);

describe("constructor options validation", () => {
  test.each([
    ["a string", "not-an-options-bag"],
    ["a number", 42],
    ["null", null],
  ] as [label: string, options: unknown][])(
    "rejects an options bag given as %s",
    (_label, options) => {
      expectInvalidArgument(catchThrown(() => construct(options)));
    },
  );

  test.each([
    ["a number", 42],
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
  ] as [label: string, directory: unknown][])(
    "rejects a directory given as %s",
    (_label, directory) => {
      expectInvalidArgument(catchThrown(() => construct({ directory })));
    },
  );

  test.each(INVALID_CEILING_CASES)(
    "rejects %s given as %s",
    (field, _label, value) => {
      expectInvalidArgument(
        catchThrown(() => construct({ directory: workDir, [field]: value })),
      );
    },
  );

  test("rejects an unknown key, following this namespace's allowlist precedent", () => {
    // Precedent: every options bag in `core/agent` is validated with an
    // allowlist — `assertAllowedKeys` against OPTIONS_KEYS / ACTION_KEYS /
    // IDENTITY_KEYS in `internal/agent/action.ts` and
    // `internal/agent/decision-log.ts`, and "any unknown key" in
    // `validateAgentPolicy`'s documented rejections. An unknown key is
    // therefore a violation here too, not something to ignore silently.
    expectInvalidArgument(
      catchThrown(() =>
        construct({ directory: workDir, maxSegmentByte: 1024 }),
      ),
    );
  });

  test("names the field and the violation kind but never echoes the rejected directory", () => {
    // Security rule for this boundary: an error may name WHICH field was bad
    // and HOW, never WHAT the caller passed — a directory can carry tenant or
    // customer identifiers in its path.
    const blankDirectory = " ".repeat(24);
    const blank = expectInvalidArgument(
      catchThrown(() => construct({ directory: blankDirectory })),
    );
    expect(JSON.stringify(blank.context)).toContain("directory");
    expect(blank.message).not.toContain(blankDirectory);
    expect(JSON.stringify(blank.context)).not.toContain(blankDirectory);

    const secret = "s3://tenant-42-private/agent-log";
    const nonString = expectInvalidArgument(
      catchThrown(() => construct({ directory: { path: secret } })),
    );
    expect(nonString.message).not.toContain(secret);
    expect(JSON.stringify(nonString.context)).not.toContain(secret);
  });

  test("accepts an omitted options bag and an empty one", () => {
    vi.stubEnv("M3L_DATA_DIR", workDir);

    expect(() => new M3LAgentDecisionLog()).not.toThrow();
    expect(() => new M3LAgentDecisionLog({})).not.toThrow();
  });

  test("accepts each field supplied with a valid value", () => {
    expect(() => new M3LAgentDecisionLog({ directory: workDir })).not.toThrow();
    expect(
      () =>
        new M3LAgentDecisionLog({ directory: workDir, maxSegmentBytes: 1024 }),
    ).not.toThrow();
    expect(
      () =>
        new M3LAgentDecisionLog({ directory: workDir, maxSegmentAgeMs: 1000 }),
    ).not.toThrow();
    expect(
      () =>
        new M3LAgentDecisionLog({
          directory: workDir,
          maxSegmentBytes: M3L_AGENT_LOG_MAX_SEGMENT_BYTES,
          maxSegmentAgeMs: M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS,
        }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12. write() argument validation and serialization faults — a non-M3LError
//     escaping a public method is the regression being pinned here.
// ---------------------------------------------------------------------------

describe("write() argument validation", () => {
  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "not an object"],
  ] as [label: string, entry: unknown][])(
    "rejects an entry given as %s without creating a file",
    async (_label, entry) => {
      const dir = path.join(workDir, "agent-log");
      const log = new M3LAgentDecisionLog({ directory: dir });

      const thrown = await catchRejected(() => writeUnchecked(log, entry));

      // `undefined` currently reaches Buffer.byteLength(undefined, "utf8")
      // and escapes as a raw Node ERR_INVALID_ARG_TYPE TypeError; `null` and
      // a string currently serialize and are written to disk verbatim.
      expectInvalidArgument(thrown);
      await expectNothingWritten(dir);
    },
  );

  test.each([
    [
      "a circular reference",
      (): unknown => {
        const circular: Record<string, unknown> = { verdict: "auto-approved" };
        circular["self"] = circular;
        return circular;
      },
    ],
    [
      "a BigInt field",
      (): unknown => ({ verdict: "auto-approved", tokens: 1n }),
    ],
  ] as [label: string, build: () => unknown][])(
    "rejects an unserializable entry carrying %s rather than letting a raw TypeError escape",
    async (_label, build) => {
      const dir = path.join(workDir, "agent-log");
      const log = new M3LAgentDecisionLog({ directory: dir });

      const thrown = await catchRejected(() => writeUnchecked(log, build()));

      // JSON.stringify throws outside the writer's try block today, so the
      // raw TypeError escapes the module's error hierarchy entirely.
      expectInvalidArgument(thrown);
      await expectNothingWritten(dir);
    },
  );
});

// ---------------------------------------------------------------------------
// 13. The entry-size ceiling governs the LINE that reaches the filesystem
// ---------------------------------------------------------------------------

describe("entry-size ceiling, both sides of the boundary", () => {
  /**
   * Builds an entry whose serialization is exactly `target` bytes. Every
   * padding character is a JSON-safe ASCII `x`, so one character is one byte.
   */
  function entryOfExactSerializedBytes(
    target: number,
  ): M3LAgentDecisionLogEntry {
    const probeBytes = Buffer.byteLength(
      serializeAgentDecisionLogEntry(makeEntry(BASE_NOW, { reason: "x" })),
      "utf8",
    );
    const entry = makeEntry(BASE_NOW, {
      reason: "x".repeat(1 + target - probeBytes),
    });
    expect(
      Buffer.byteLength(serializeAgentDecisionLogEntry(entry), "utf8"),
    ).toBe(target);
    return entry;
  }

  test("an entry serializing to exactly the ceiling is rejected: the appended line is json + a newline, one byte over", async () => {
    const dir = path.join(workDir, "agent-log");
    const log = new M3LAgentDecisionLog({ directory: dir });
    const entry = entryOfExactSerializedBytes(M3L_AGENT_MAX_LOG_ENTRY_BYTES);

    // The ceiling exists because a single oversized write() is where a
    // line-delimited append tears — so what it governs is the LINE, which is
    // `${json}\n`, not `json` alone. The error stays
    // M3LAgentDecisionLogWriteError here (this is the documented @throws for
    // an oversized entry, not a caller-input validation).
    await expect(log.write(entry)).rejects.toBeInstanceOf(
      M3LAgentDecisionLogWriteError,
    );
    await expectNothingWritten(dir);
  });

  test("an entry one byte under the ceiling is still accepted, and the written line is exactly the ceiling's worth of bytes", async () => {
    const dir = path.join(workDir, "agent-log");
    const log = new M3LAgentDecisionLog({ directory: dir });
    const entry = entryOfExactSerializedBytes(
      M3L_AGENT_MAX_LOG_ENTRY_BYTES - 1,
    );

    await log.write(entry);

    const segments = await listSegments(dir);
    const content = await readFile(
      path.join(dir, definedOrThrow(segments[0], "the only segment")),
      "utf8",
    );
    // Passes against the pre-fix code too: this arm is the regression lock
    // that stops the fix for the sibling test above from being implemented
    // as an off-by-one in the other direction.
    expect(Buffer.byteLength(content, "utf8")).toBe(
      M3L_AGENT_MAX_LOG_ENTRY_BYTES,
    );
  });
});

// ---------------------------------------------------------------------------
// 14. Date rollover with BOTH ceilings slack — the documented "a freshly
//     spawned process and a long-lived one always agree" guarantee
// ---------------------------------------------------------------------------

describe("date rollover under both ceilings", () => {
  test("a long-lived writer crossing UTC midnight opens today's segment instead of appending to yesterday's", async () => {
    const dir = path.join(workDir, "agent-log");
    const dayOneAt = Date.UTC(2026, 5, 15, 23, 59, 0);
    const dayTwoAt = Date.UTC(2026, 5, 16, 0, 1, 0);

    // Both ceilings stay at their generous defaults, so NEITHER can fire
    // across the two minutes below: the date itself is the only thing that
    // may rotate. (The existing rollover test forces a byte rotation first,
    // so it never exercises this path.)
    const dayOnePrefix = pinClock(dayOneAt);
    const log = new M3LAgentDecisionLog({ directory: dir });
    await log.write(makeEntry(dayOneAt, { reason: "written on day one" }));

    const dayTwoPrefix = pinClock(dayTwoAt);
    await log.write(makeEntry(dayTwoAt, { reason: "written on day two" }));

    // Day one's segment is left sealed at the single line it already held.
    expect(
      await readLines(path.join(dir, `${dayOnePrefix}-0001.jsonl`)),
    ).toHaveLength(1);

    const dayTwoPath = path.join(dir, `${dayTwoPrefix}-0001.jsonl`);
    expect(await readLines(dayTwoPath)).toHaveLength(1);

    // ... and a process freshly spawned at the same instant agrees, finding
    // and appending to that same day-two segment rather than a rival one.
    const freshProcess = new M3LAgentDecisionLog({ directory: dir });
    await freshProcess.write(
      makeEntry(dayTwoAt + 1, { reason: "written by a fresh process" }),
    );

    expect(await readLines(dayTwoPath)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 15. Concurrent write() calls on a single instance
// ---------------------------------------------------------------------------

describe("concurrent write() calls on one instance", () => {
  test("every concurrent line lands intact and the byte ceiling still bounds every segment", async () => {
    const dir = path.join(workDir, "agent-log");
    pinClock();

    const reasons = Array.from(
      { length: 8 },
      (_unused, index) => `concurrent-entry-${String(index).padStart(2, "0")}`,
    );
    const entries = reasons.map((reason, index) =>
      makeEntry(FIXED_CLOCK + index, { reason }),
    );
    const lineBytes = Buffer.byteLength(
      `${serializeAgentDecisionLogEntry(definedOrThrow(entries[0], "the first entry"))}\n`,
      "utf8",
    );
    // Equal-length lines are what makes the segment arithmetic below exact.
    for (const entry of entries) {
      expect(
        Buffer.byteLength(`${serializeAgentDecisionLogEntry(entry)}\n`, "utf8"),
      ).toBe(lineBytes);
    }

    const maxSegmentBytes = lineBytes * 2;
    const log = new M3LAgentDecisionLog({ directory: dir, maxSegmentBytes });

    await Promise.all(
      entries.map(async (entry) => {
        await log.write(entry);
      }),
    );

    const segments = await listSegments(dir);
    const seen: string[] = [];
    for (const name of segments) {
      const content = await readFile(path.join(dir, name), "utf8");
      // A segment may overshoot by at most the single line whose append
      // crossed the ceiling — never by a whole batch's worth, which is what
      // happens when concurrent writers each track only their own bytes.
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(
        maxSegmentBytes + lineBytes,
      );
      for (const line of content.split("\n").filter((l) => l.length > 0)) {
        // Every line is individually valid JSON: none was torn by another
        // concurrent append.
        const parsed = JSON.parse(line) as { reason?: unknown };
        expect(typeof parsed.reason).toBe("string");
        seen.push(String(parsed.reason));
      }
    }

    // Nothing lost, nothing duplicated.
    expect([...seen].sort()).toEqual([...reasons].sort());
    // Eight lines at two lines per segment: the ceiling requires at least
    // four segments, whichever exact rotation point the writer picks.
    expect(segments.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// 16. A segment name this writer would not itself produce
// ---------------------------------------------------------------------------

describe("foreign segment names in the target directory", () => {
  test("an over-padded existing segment name does not break write()", async () => {
    const dir = path.join(workDir, "agent-log");
    await mkdir(dir, { recursive: true });
    const today = pinClock();
    // `SEGMENT_NAME_PATTERN` accepts `\d{4,}` while `segmentFileName` re-pads
    // to width four, so "00005" parses to sequence 5 and is rebuilt as
    // "0005" — a path that does not exist, whose stat() ENOENTs and turns
    // EVERY subsequent write() into that directory to a wrapped write error.
    // Zero-padding wider than four is the only lossy case: a genuinely wide
    // sequence such as 10000 round-trips, because padStart(4) is a no-op
    // above four digits.
    await writeFile(path.join(dir, `${today}-00005.jsonl`), "");

    const log = new M3LAgentDecisionLog({ directory: dir });
    const entry = makeEntry(FIXED_CLOCK);

    await expect(log.write(entry)).resolves.toBeUndefined();

    // The entry is recoverable from exactly one segment. WHICH segment is the
    // implementer's choice — skip the foreign name as "not this writer's
    // file", or round-trip it faithfully; failing the append is not.
    const serialized = serializeAgentDecisionLogEntry(entry);
    const holders: string[] = [];
    for (const name of await listSegments(dir)) {
      const lines = await readLines(path.join(dir, name));
      if (lines.includes(serialized)) {
        holders.push(name);
      }
    }
    expect(holders).toHaveLength(1);
  });
});
