/**
 * Audit-trail integrity tests for `core/agent`'s decision-log writer
 * (`M3LAgentDecisionLog`, V7 slice 2 / ADR-0061).
 *
 * A sibling of `agent-decision-log-writer.test.ts`, which owns the happy-path
 * and rotation contract; this file owns the security review's findings — the
 * ways the writer can currently forge, corrupt, mis-account, or silently
 * misplace its own audit trail. The split is a file-budget one
 * (`check:file-budget` ceils a test file at 60,000 bytes and the sibling is
 * already at ~49.5 KB), not a contract one.
 *
 * The module's promise is twofold: an action that cannot be audited must not
 * run unaudited, and the library never writes a record that misrepresents
 * what it was handed. Every test below states which of the two it defends.
 *
 * RED expectations at authoring time (2026-08-30, PR #754):
 *   - findings 1-5 and 7 FAIL against the current implementation;
 *   - the two "chain guard" tests and the two "regression lock" tests PASS
 *     today and are locks, not proofs — the chain-guard pair was verified by
 *     mutation (see the comment on that describe block).
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import * as fsp from "node:fs/promises";

// Keep 'node:fs/promises' spy-able (a plain, configurable namespace object)
// while every unmocked function still hits the real filesystem — the same
// pattern the sibling writer test and tests/checkpoint.test.ts use.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});

import { M3LError } from "../src/core/errors/index.js";
import {
  agentDecisionLogEntry,
  serializeAgentDecisionLogEntry,
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
// Fixtures and helpers
// ---------------------------------------------------------------------------

const DEFAULT_IDENTITY: M3LAgentIdentity = { name: "release-bot" };

const BASE_NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

/** A fixed, mid-day UTC instant used whenever a test pins the wall clock. */
const FIXED_CLOCK = Date.UTC(2026, 5, 15, 12, 0, 0);

interface DecisionOverrides {
  readonly verdict?: M3LAgentDecision["verdict"];
  readonly rule?: M3LAgentDecision["rule"];
  readonly reason?: string;
}

/** Builds a structurally valid `M3LAgentDecision` for a given verdict arm. */
function makeDecision(overrides?: DecisionOverrides): M3LAgentDecision {
  return {
    verdict: overrides?.verdict ?? "auto-approved",
    rule: overrides?.rule ?? "read-only-auto-approved",
    reason: overrides?.reason ?? "read-only action on an allowlisted script",
    action: {
      script: "s3-report",
      operation: undefined,
      kind: "read-only",
      target: undefined,
      parameterNames: ["bucket", "prefix"],
      dryRun: false,
      shapeKey: "s3-report:read-only",
    },
  };
}

/** Builds a real, slice-1-validated, frozen entry ready for the writer. */
function makeEntry(
  now: number,
  overrides?: DecisionOverrides,
): M3LAgentDecisionLogEntry {
  return agentDecisionLogEntry({
    decision: makeDecision(overrides),
    identity: DEFAULT_IDENTITY,
    now,
  });
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

/** Runs `run` and returns whatever it threw, or `undefined`. */
function catchThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Asserts a caller-side boundary violation: a BARE {@link M3LError} carrying
 * `code: "ERR_INVALID_ARGUMENT"` — never the write-failure vocabulary, which
 * would tell an operator the filesystem is unhealthy when the argument was.
 */
function expectInvalidArgument(thrown: unknown): M3LError {
  expect(thrown).toBeInstanceOf(M3LError);
  expect(thrown).not.toBeInstanceOf(M3LAgentDecisionLogWriteError);
  const error = thrown as M3LError;
  expect(error.code).toBe("ERR_INVALID_ARGUMENT");
  return error;
}

/** Constructs through an `unknown` seam without weakening the public type. */
function construct(options: unknown): M3LAgentDecisionLog {
  return new M3LAgentDecisionLog(options as M3LAgentDecisionLogOptions);
}

/** Hands an arbitrary value to `write()` through an `unknown` seam. */
async function writeUnchecked(
  log: M3LAgentDecisionLog,
  entry: unknown,
): Promise<void> {
  await log.write(entry as M3LAgentDecisionLogEntry);
}

/** Every non-empty line across every file in `dir` (ENOENT reads as empty). */
async function readAllLines(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const name of [...names].sort()) {
    const content = await readFile(path.join(dir, name), "utf8");
    lines.push(...content.split("\n").filter((line) => line.length > 0));
  }
  return lines;
}

/** Asserts the directory holds no file with any content. */
async function expectNothingWritten(dir: string): Promise<void> {
  expect(await readAllLines(dir)).toEqual([]);
}

/**
 * Asserts every persisted line is a JSON object — i.e. the file is readable
 * JSONL. A line the reader cannot parse is a corrupt audit trail even when
 * `write()` resolved.
 */
async function expectEveryLineParses(dir: string): Promise<void> {
  for (const line of await readAllLines(dir)) {
    const parseError: unknown = catchThrown(() => JSON.parse(line));
    expect(parseError, `unparseable persisted line: ${line}`).toBeUndefined();
  }
}

/**
 * The rotation invariant, asserted instead of any particular mechanism: a
 * segment may overshoot `maxSegmentBytes` by at most the one line that was
 * in flight when the ceiling was crossed. Both sanctioned repairs of the
 * adopt-with-size-0 defect (adopt the existing file with its real size, or
 * skip forward to the next free sequence) satisfy this; today's behaviour —
 * restarting byte accounting from zero on a non-empty file — does not.
 */
async function expectNoSegmentOvershoots(
  dir: string,
  maxSegmentBytes: number,
): Promise<void> {
  for (const name of await readdir(dir)) {
    const content = await readFile(path.join(dir, name), "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    const last = lines.at(-1);
    const lastBytes =
      last === undefined ? 0 : Buffer.byteLength(`${last}\n`, "utf8");
    expect(
      Buffer.byteLength(content, "utf8") - lastBytes,
      `segment ${name} overshoots maxSegmentBytes by more than one line`,
    ).toBeLessThanOrEqual(maxSegmentBytes);
  }
}

/** Pins the wall clock and returns the UTC date prefix the writer derives. */
function pinClock(atMs: number = FIXED_CLOCK): string {
  vi.useFakeTimers();
  vi.setSystemTime(atMs);
  return new Date(atMs).toISOString().slice(0, 10);
}

/** Yields to the macrotask queue so a pending rejection can surface. */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

let workDir: string;
let logDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-agent-log-integrity-"));
  logDir = path.join(workDir, "agent-log");
});

afterEach(async () => {
  // Defence in depth: the prototype-pollution tests below restore
  // `Object.prototype` themselves, but a failed assertion mid-test must not
  // be able to leak a gadget into the rest of this process's suite.
  Reflect.deleteProperty(Object.prototype, "toJSON");
  Reflect.deleteProperty(Object.prototype, "polluted");
  vi.restoreAllMocks();
  vi.useRealTimers();
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. `JSON.stringify` returning `undefined` must not be laundered into a line
// ---------------------------------------------------------------------------

describe("a serialization that produces no JSON at all", () => {
  test("an entry whose toJSON() returns undefined is rejected, not written as the literal text `undefined`", async () => {
    // `JSON.stringify` returns `undefined` (it does not throw) for a value
    // whose `toJSON` returns `undefined`. `renderLogLine` then interpolates
    // it into `${json}\n`, so the ten bytes `undefined\n` pass the line-size
    // check and are appended — and `write()` RESOLVES. The parent commit
    // passed `json` to `Buffer.byteLength` before the try block, which threw
    // loudly and wrote nothing; this is a regression, not a pre-existing gap.
    const log = new M3LAgentDecisionLog({ directory: logDir });
    const valid = makeEntry(BASE_NOW);
    const gadget = { ...valid, toJSON: () => undefined };

    const thrown = await catchRejected(() => writeUnchecked(log, gadget));

    // Assert the BYTES, not just the absence of a throw: the current
    // behaviour persists a line no JSON reader can consume.
    await expectEveryLineParses(logDir);
    expectInvalidArgument(thrown);
    await expectNothingWritten(logDir);
  });
});

// ---------------------------------------------------------------------------
// 2. An inherited `toJSON` must not forge the persisted record
// ---------------------------------------------------------------------------

describe("prototype-pollution forgery of the persisted record", () => {
  test("an inherited Object.prototype.toJSON cannot rewrite what a sanctioned, frozen entry persists as", async () => {
    // `isPlainObject` admits an object whose `toJSON` is INHERITED, and
    // `JSON.stringify` dispatches to it, so a gadget on `Object.prototype`
    // rewrites the record of an entry the sanctioned projector built and
    // deep-froze. `Object.freeze` is no defence: the property is not an own
    // property of the entry.
    const log = new M3LAgentDecisionLog({ directory: logDir });
    const entry = makeEntry(BASE_NOW, {
      verdict: "escalate",
      rule: "sensitive-target-escalated",
      reason: "sensitive target requires human approval",
    });
    expect(Object.isFrozen(entry)).toBe(true);

    const forged = { verdict: "auto-approved", rule: "allOperations" };
    let thrown: unknown;
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        value: () => forged,
        configurable: true,
        writable: true,
      });
      // The polluted window is kept to this single call: while the gadget is
      // installed, every `JSON.stringify` in the process (including any
      // assertion helper's) would see it.
      thrown = await catchRejected(() => log.write(entry));
    } finally {
      Reflect.deleteProperty(Object.prototype, "toJSON");
    }

    const lines = await readAllLines(logDir);
    expect(lines.join("\n")).not.toContain("allOperations");
    if (thrown === undefined) {
      // The audited action was allowed to proceed, so the record it left
      // behind must be the real one.
      expect(lines).toEqual([serializeAgentDecisionLogEntry(entry)]);
    } else {
      // Refusing to write is the other sanctioned outcome — but it must be a
      // typed library error, and nothing may be left behind.
      expect(thrown).toBeInstanceOf(M3LError);
      expect(lines).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. `write(entry)` performs no structural validation
// ---------------------------------------------------------------------------

describe("structural validation of the entry", () => {
  /**
   * A synthetic marker, deliberately NOT a realistic-looking credential: the
   * point is only that a caller-supplied string reaches disk unvalidated.
   */
  const MARKER = "M3L-SYNTHETIC-FIXTURE-MARKER";

  const POISONED_JSON = `{"parameterNames":["password=${MARKER}-A","apiKey=${MARKER}-B"],"__proto__":{"polluted":true}}`;

  test.each([
    ["an empty object", (): unknown => ({})],
    [
      "an object missing required fields",
      (): unknown => {
        const { verdict: _verdict, ...rest } = makeEntry(BASE_NOW);
        return { ...rest };
      },
    ],
    [
      "an object carrying an unknown key",
      (): unknown => ({ ...makeEntry(BASE_NOW), sneakyKey: MARKER }),
    ],
  ] as [label: string, build: () => unknown][])(
    "rejects %s rather than persisting it as an audit record",
    async (_label, build) => {
      const log = new M3LAgentDecisionLog({ directory: logDir });

      const thrown = await catchRejected(() => writeUnchecked(log, build()));

      expectInvalidArgument(thrown);
      await expectNothingWritten(logDir);
    },
  );

  test("rejects a parsed JSON document carrying an own __proto__ key, and never writes its payload", async () => {
    const poisoned: unknown = JSON.parse(POISONED_JSON);
    // Not vacuous: `JSON.parse` really does create `__proto__` as an OWN,
    // enumerable key (unlike an object literal, where it sets the prototype).
    expect(Object.hasOwn(poisoned as object, "__proto__")).toBe(true);

    const log = new M3LAgentDecisionLog({ directory: logDir });
    const thrown = await catchRejected(() => writeUnchecked(log, poisoned));

    expectInvalidArgument(thrown);
    await expectNothingWritten(logDir);
    // REGRESSION LOCK (passes today): `JSON.parse` does not pollute, and
    // neither must anything the writer does with the parsed document.
    expect(
      (Object.prototype as Record<string, unknown>)["polluted"],
    ).toBeUndefined();
    // Nothing resembling caller-supplied secret material reaches disk.
    expect((await readAllLines(logDir)).join("\n")).not.toContain(MARKER);
  });
});

// ---------------------------------------------------------------------------
// 4. Rotation must not restart byte accounting on a non-empty segment
// ---------------------------------------------------------------------------

describe("rotation into an already-existing segment file", () => {
  test("a clock that steps back across UTC midnight does not resume an already-full segment with a zero byte count", async () => {
    const dayOne = pinClock(Date.UTC(2026, 5, 15, 12, 0, 0));
    const entry = makeEntry(BASE_NOW);
    const lineBytes = Buffer.byteLength(
      `${serializeAgentDecisionLogEntry(entry)}\n`,
      "utf8",
    );
    const maxSegmentBytes = lineBytes * 3;
    const log = new M3LAgentDecisionLog({ directory: logDir, maxSegmentBytes });

    // Day one's segment is driven to exactly the ceiling.
    for (let index = 0; index < 3; index++) {
      await log.write(entry);
    }
    const dayOneSegment = path.join(logDir, `${dayOne}-0001.jsonl`);
    expect((await readFile(dayOneSegment, "utf8")).split("\n")).toHaveLength(4);

    // Cross into day two: the date check rotates to `<day2>-0001.jsonl`.
    vi.setSystemTime(Date.UTC(2026, 5, 16, 12, 0, 0));
    await log.write(entry);

    // The clock steps BACK (an NTP correction, a container clock skew). The
    // date check fires again and the computed name is `<day1>-0001.jsonl` —
    // which already holds day one's data, and is adopted with `size: 0`.
    vi.setSystemTime(Date.UTC(2026, 5, 15, 23, 0, 0));
    for (let index = 0; index < 3; index++) {
      await log.write(entry);
    }

    await expectNoSegmentOvershoots(logDir, maxSegmentBytes);
  });

  test("a segment a sibling writer already created and filled is not adopted with a zero byte count", async () => {
    const day = pinClock();
    const entry = makeEntry(BASE_NOW);
    const line = `${serializeAgentDecisionLogEntry(entry)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    const maxSegmentBytes = lineBytes * 3;
    const log = new M3LAgentDecisionLog({ directory: logDir, maxSegmentBytes });

    for (let index = 0; index < 3; index++) {
      await log.write(entry);
    }

    // A sibling process (or an earlier run of this one) has already opened
    // and filled the segment this writer's next rotation will compute.
    const siblingPath = path.join(logDir, `${day}-0002.jsonl`);
    await writeFile(siblingPath, line.repeat(3), "utf8");

    // Three more writes, not one: adopting the sibling with `size: 0` only
    // becomes visible once the writer has spent a whole ceiling's worth of
    // bytes it believes it has not yet written. One write alone lands within
    // the "one line of overshoot" both repairs are allowed.
    for (let index = 0; index < 3; index++) {
      await log.write(entry);
    }

    await expectNoSegmentOvershoots(logDir, maxSegmentBytes);
    // Rotation never truncates: the sibling's three records survive whatever
    // repair is chosen.
    const sibling = await readFile(siblingPath, "utf8");
    expect(
      sibling.split("\n").filter((l) => l.length > 0).length,
    ).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 5. A failed append must not disable the writer permanently
// ---------------------------------------------------------------------------

describe("recovery after a failed append", () => {
  test("a write that fails because the log directory vanished does not wedge every later write on the same instance", async () => {
    // `resolveActiveSegment` caches `this.active` and `mkdir` runs only on
    // the `this.active === undefined` branch, so once the directory is gone
    // a long-lived writer can never recreate it — while a freshly
    // constructed writer would carry on. An audit log that stays down for
    // the rest of the process is the failure mode ADR-0061 exists to avoid.
    pinClock();
    const log = new M3LAgentDecisionLog({ directory: logDir });
    const entry = makeEntry(BASE_NOW);

    await log.write(entry);
    await rm(logDir, { recursive: true, force: true });

    const thrown = await catchRejected(() => log.write(entry));
    expect(thrown).toBeInstanceOf(M3LAgentDecisionLogWriteError);

    // The third write must recreate the directory and succeed.
    await expect(log.write(entry)).resolves.toBeUndefined();
    expect(await readAllLines(logDir)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. The serialization chain's rejection guard
// ---------------------------------------------------------------------------

/**
 * REGRESSION LOCKS, not proofs: both tests pass against the current
 * implementation, because `append`'s `this.tail = appended.then(() =>
 * undefined, () => undefined)` already guards the chain. They exist because
 * the guard was untested — mutating that line to `this.tail = appended`
 * passed the entire pre-existing suite. Verified by mutation while authoring
 * (see the handback report): with `this.tail = appended`, the sequential
 * test fails on `toHaveBeenCalledTimes(2)` / the second write's rejection,
 * and the concurrent test fails on the following write's rejection.
 */
describe("a rejected write does not poison the append chain", () => {
  test("the rejection reaches its own caller and a later write on the same instance still succeeds", async () => {
    const log = new M3LAgentDecisionLog({ directory: logDir });
    const entry = makeEntry(BASE_NOW);
    const injected = new Error("simulated append failure");
    const appendSpy = vi
      .spyOn(fsp, "appendFile")
      .mockRejectedValueOnce(injected);

    const first = await catchRejected(() => log.write(entry));
    expect(first).toBeInstanceOf(M3LAgentDecisionLogWriteError);
    expect((first as M3LError).cause).toBe(injected);

    await expect(log.write(entry)).resolves.toBeUndefined();
    // The discriminator: under a poisoned chain the second write short-
    // circuits on the rejected tail and never reaches the filesystem.
    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(await readAllLines(logDir)).toHaveLength(1);
  });

  test("a concurrently issued write is unaffected, and the failure raises no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const log = new M3LAgentDecisionLog({ directory: logDir });
      const entry = makeEntry(BASE_NOW);
      const injected = new Error("simulated append failure");
      vi.spyOn(fsp, "appendFile").mockRejectedValueOnce(injected);

      // Both issued before either settles, so the second really does chain
      // off the first's tail.
      const failing = catchRejected(() => log.write(entry));
      const following = log.write(entry);

      await expect(following).resolves.toBeUndefined();
      expect(await failing).toBeInstanceOf(M3LAgentDecisionLogWriteError);

      await tick();
      await tick();
      expect(unhandled).toEqual([]);
      expect(await readAllLines(logDir)).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. A segment path planted as a symlink must be refused, not followed
// ---------------------------------------------------------------------------

// `O_NOFOLLOW` is a POSIX flag; Node exposes it as `undefined` on Windows,
// where this defence (and this test) cannot apply.
const noFollowUnavailable =
  process.platform === "win32" || constants.O_NOFOLLOW === undefined;

describe("a symlinked segment path", () => {
  test.skipIf(noFollowUnavailable)(
    "is refused rather than followed, so the audit record cannot be redirected out of the log directory",
    async () => {
      // `appendFile(..., { flag: "a" })` carries no `O_NOFOLLOW`, so anyone
      // who can create a file in the log directory can redirect (or suppress)
      // the audit trail by planting the next segment name as a symlink.
      await mkdir(logDir, { recursive: true });
      const day = pinClock();
      const victim = path.join(workDir, "victim.log");
      await writeFile(victim, "", "utf8");
      await symlink(victim, path.join(logDir, `${day}-0001.jsonl`));

      const log = new M3LAgentDecisionLog({ directory: logDir });
      const thrown = await catchRejected(() => log.write(makeEntry(BASE_NOW)));

      expect(thrown).toBeInstanceOf(M3LAgentDecisionLogWriteError);
      expect(await readFile(victim, "utf8")).toBe("");
    },
  );
});

// ---------------------------------------------------------------------------
// 8. Regression locks the security review found already clean
// ---------------------------------------------------------------------------

describe("regression locks", () => {
  test("an options bag with an own __proto__ key is rejected and pollutes nothing", () => {
    const bag: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(Object.hasOwn(bag as object, "__proto__")).toBe(true);

    expectInvalidArgument(catchThrown(() => construct(bag)));
    expect(
      (Object.prototype as Record<string, unknown>)["polluted"],
    ).toBeUndefined();
  });

  test("a rejected directory value never reaches the error's message, context, or cause chain", () => {
    // A directory path can carry tenant or customer identifiers, so the
    // boundary error names the FIELD and the VIOLATION only.
    const secret = "s3://tenant-42-private/agent-log";
    const error = expectInvalidArgument(
      catchThrown(() => construct({ directory: { path: secret } })),
    );

    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.context ?? {})).not.toContain(secret);
    // The cause chain is checked too: a wrapped raw error is the easy way to
    // reintroduce the leak the message and context are audited for.
    let current: unknown = error.cause;
    while (current !== undefined && current !== null) {
      const rendered =
        current instanceof Error
          ? `${current.name}: ${current.message}`
          : JSON.stringify(current);
      expect(rendered ?? "").not.toContain(secret);
      current = current instanceof Error ? current.cause : undefined;
    }
  });
});

// ---------------------------------------------------------------------------
// 9. The entry projection's optional fields: round-trip, then every rejection
// ---------------------------------------------------------------------------

/**
 * `write()` never serializes the caller's object: it rebuilds the entry as a
 * null-prototype projection first (`internal/agent/decision-log-projection`).
 * The tests above only ever hand it the minimal entry `makeEntry` builds, so
 * `target`, `outcome`, `tokens`, `cost` and the two optional identity fields
 * were validated by code no test entered.
 *
 * Two claims are at stake and both are asserted here:
 *
 *   - the rebuild is FAITHFUL — a fully populated entry persists byte-for-byte
 *     as `serializeAgentDecisionLogEntry(entry)`, so the projection cannot
 *     silently drop a field the caller supplied (the failure mode slice 1's
 *     review hit three times: a field read, copied, and never proven);
 *   - the rebuild is STRICT — every malformed optional is a caller-side
 *     `ERR_INVALID_ARGUMENT` and leaves nothing on disk.
 */

/** The `target` of an entry known to carry one. */
type EntryTarget = NonNullable<M3LAgentDecisionLogEntry["target"]>;

/** Narrows a fixture's `target`; a missing one is a broken fixture, loudly. */
function requireTarget(entry: M3LAgentDecisionLogEntry): EntryTarget {
  const target = entry.target;
  if (target === undefined) {
    throw new Error("fixture invariant: this entry must carry a target");
  }
  return target;
}

interface FullEntryOverrides {
  /** Replaces `decision.action.target`; `undefined` keeps the fixture's. */
  readonly target?: M3LAgentDecision["action"]["target"];
}

/**
 * A "full-fat" entry: every optional field the projection can reach is
 * present — `target` (all three coordinates), `outcome` (all three fields),
 * `tokens`, `cost`, and both optional identity fields. Built through
 * `agentDecisionLogEntry` rather than hand-rolled, so the fixture cannot
 * drift from the shape the library actually produces.
 */
function makeFullEntry(
  overrides?: FullEntryOverrides,
): M3LAgentDecisionLogEntry {
  return agentDecisionLogEntry({
    decision: {
      verdict: "auto-approved",
      rule: "graded-mutation-auto-approved",
      reason: "graded, non-sensitive target on an allowlisted operation",
      action: {
        script: "s3-report",
        operation: "purge-prefix",
        kind: "mutating",
        target: overrides?.target ?? {
          profile: "prod",
          region: "eu-west-1",
          accountId: "123456789012",
        },
        parameterNames: ["bucket", "prefix"],
        dryRun: true,
        shapeKey: "s3-report:purge-prefix",
      },
    },
    identity: {
      name: "release-bot",
      modelId: "claude-opus-5",
      awsPrincipal: "arn:aws:iam::123456789012:role/release-bot",
    },
    now: BASE_NOW,
    outcome: { dryRun: true, exitCode: 0, registryName: "primary" },
    tokens: 1234,
    cost: 0.42,
  });
}

/**
 * Rebuilds an entry with one field replaced by an arbitrary (usually
 * malformed) value. Returns `unknown`: the whole point is a value the public
 * type would reject, handed in through `writeUnchecked`'s seam.
 */
function withField(
  entry: M3LAgentDecisionLogEntry,
  key: string,
  value: unknown,
): unknown {
  return { ...entry, [key]: value };
}

describe("the entry projection's optional fields", () => {
  test("a fully populated entry persists byte-identically to its own serialization", async () => {
    const log = new M3LAgentDecisionLog({ directory: logDir });
    const entry = makeFullEntry();

    await log.write(entry);

    // The projection is a REBUILD, so "no field was lost or reordered" is the
    // claim — and JSON preserves insertion order, which makes the serialized
    // bytes the exact discriminator for it.
    expect(await readAllLines(logDir)).toEqual([
      serializeAgentDecisionLogEntry(entry),
    ]);
  });

  test("a target whose region and accountId are own keys holding undefined round-trips byte-identically", async () => {
    // `M3LAgentActionRecordTarget` types `region` / `accountId` as REQUIRED
    // holding `undefined` — not optional — so the library always emits them
    // as own keys. That shape is deliberate (an own key holding `undefined`
    // cannot be shadowed by `Object.prototype.region`), and the projection
    // reads it with `readRequiredHoldingUndefinedString`. The trap: an
    // own-key-holding-`undefined` is NOT the same input as an absent key, and
    // only the former exercises the arm the library's own entries take.
    const entry = makeFullEntry({
      target: { profile: "prod", region: undefined, accountId: undefined },
    });
    const target = requireTarget(entry);

    // Not vacuous: assert the fixture really is the own-key-holding-undefined
    // shape and not an absent-key approximation of it.
    expect(Object.hasOwn(target, "region")).toBe(true);
    expect(Object.hasOwn(target, "accountId")).toBe(true);
    expect(target.region).toBeUndefined();
    expect(target.accountId).toBeUndefined();

    const log = new M3LAgentDecisionLog({ directory: logDir });
    await log.write(entry);

    expect(await readAllLines(logDir)).toEqual([
      serializeAgentDecisionLogEntry(entry),
    ]);
    // `JSON.stringify` omits a key holding `undefined`, so the persisted
    // target carries `profile` alone — asserted on the bytes, because the
    // equality above would also hold for a projection that emitted `null` on
    // both sides of the comparison.
    expect((await readAllLines(logDir))[0]).toContain(
      '"target":{"profile":"prod"}',
    );
  });

  test("an entry carrying no own target key at all is accepted and persists without one", async () => {
    // A hand-built entry (one that crossed a queue or a JSON boundary) can
    // legitimately omit `target` entirely rather than carry it holding
    // `undefined`. Both must project to the same record.
    const { target: _target, ...withoutTarget } = makeFullEntry();
    expect(Object.hasOwn(withoutTarget, "target")).toBe(false);

    const log = new M3LAgentDecisionLog({ directory: logDir });
    await writeUnchecked(log, withoutTarget);

    const lines = await readAllLines(logDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('"target"');
    // The rest of the record survives the omission intact.
    expect(lines[0]).toContain('"script":"s3-report"');
    expect(lines[0]).toContain(
      '"outcome":{"dryRun":true,"exitCode":0,"registryName":"primary"}',
    );
  });

  test.each([
    // --- outcome ---------------------------------------------------------
    [
      "a non-object outcome",
      (): unknown => withField(makeFullEntry(), "outcome", "succeeded"),
    ],
    [
      "a non-boolean outcome.dryRun",
      (): unknown =>
        withField(makeFullEntry(), "outcome", { dryRun: "yes", exitCode: 0 }),
    ],
    [
      "a non-integer outcome.exitCode",
      (): unknown =>
        withField(makeFullEntry(), "outcome", { dryRun: true, exitCode: 1.5 }),
    ],
    [
      "a blank outcome.registryName",
      (): unknown =>
        withField(makeFullEntry(), "outcome", {
          dryRun: true,
          registryName: "   ",
        }),
    ],
    [
      "an unknown key inside outcome",
      (): unknown =>
        withField(makeFullEntry(), "outcome", { dryRun: true, sneaky: true }),
    ],
    // --- identity --------------------------------------------------------
    [
      "a non-object identity",
      (): unknown => withField(makeFullEntry(), "identity", "release-bot"),
    ],
    [
      "an unknown key inside identity",
      (): unknown =>
        withField(makeFullEntry(), "identity", {
          name: "release-bot",
          sneaky: true,
        }),
    ],
    [
      "a blank identity.modelId",
      (): unknown =>
        withField(makeFullEntry(), "identity", {
          name: "release-bot",
          modelId: "  ",
        }),
    ],
    // --- target ----------------------------------------------------------
    [
      "a non-object target",
      (): unknown => withField(makeFullEntry(), "target", "prod"),
    ],
    [
      "an unknown key inside target",
      (): unknown =>
        withField(makeFullEntry(), "target", {
          profile: "prod",
          region: "eu-west-1",
          accountId: "123456789012",
          sneaky: true,
        }),
    ],
    [
      "a target with a blank profile",
      (): unknown =>
        withField(makeFullEntry(), "target", {
          profile: "   ",
          region: undefined,
          accountId: undefined,
        }),
    ],
    [
      "a target with no profile at all",
      (): unknown =>
        withField(makeFullEntry(), "target", {
          region: "eu-west-1",
          accountId: undefined,
        }),
    ],
    // --- tokens / cost ---------------------------------------------------
    [
      "a negative tokens count",
      (): unknown => withField(makeFullEntry(), "tokens", -1),
    ],
    [
      "a NaN cost",
      (): unknown => withField(makeFullEntry(), "cost", Number.NaN),
    ],
    // --- parameterNames --------------------------------------------------
    [
      "a parameterNames that is not an array",
      (): unknown => withField(makeFullEntry(), "parameterNames", "bucket"),
    ],
    [
      "a parameterNames holding a non-string",
      (): unknown =>
        withField(makeFullEntry(), "parameterNames", ["bucket", 42]),
    ],
  ] as [label: string, build: () => unknown][])(
    "rejects %s as a caller-side ERR_INVALID_ARGUMENT and writes nothing",
    async (_label, build) => {
      const log = new M3LAgentDecisionLog({ directory: logDir });

      const thrown = await catchRejected(() => writeUnchecked(log, build()));

      expectInvalidArgument(thrown);
      await expectNothingWritten(logDir);
    },
  );
});
