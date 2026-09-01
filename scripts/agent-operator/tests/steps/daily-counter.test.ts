/**
 * Tests for `steps/daily-counter` — the cross-run daily invocation counter
 * that makes `budgets.invocationsPerDay` observable.
 *
 * The subject **is** an on-disk artifact, so nothing here is mocked: every
 * test runs against a real `Core.M3LCheckpointStore` writing into a real
 * `mkdtemp` directory, reached through a real `Core.M3LPaths` with
 * `M3L_DATA_DIR` stubbed. A fake filesystem would prove nothing about the
 * envelope round-trip, the checksum, or the missing-parent-directory case
 * that `writeFileAtomic` explicitly does not handle.
 *
 * Every evaluator assertion runs the **real** `Core.evaluateAgentAction`. It
 * is the only thing that proves the omit-vs-present-`undefined` discipline:
 * the library reads presence with `Object.hasOwn` and throws on a present
 * `undefined`, so a snapshot built with `invocationsToday: undefined` fails
 * here rather than reading as absent.
 */

import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  openDailyInvocationCounter,
  sameUtcDay,
} from "../../src/steps/daily-counter.js";
import { AgentRunLedger } from "../../src/steps/run-ledger.js";
import { budgetPolicy } from "../support/policyFixtures.js";

/** Mid-day on a fixed UTC date — never a boundary, so a test that wants one says so. */
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

/** Milliseconds in a UTC day, spelled out independently of the module under test. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The stored count every fixture below plants. Deliberately **never `0`**: a
 * zero would let a deleted rollover branch pass by luck, since the rolled and
 * the un-rolled answer would coincide.
 */
const STORED = 399;

/** The file the store resolves to, under the stubbed data root. */
const COUNTER_RELATIVE_PATH = path.join(
  "agent-state",
  "daily-invocations.checkpoint.json",
);

let dataDir: string;
let outputDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "agent-operator-data-"));
  outputDir = await mkdtemp(path.join(tmpdir(), "agent-operator-output-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
  await rm(outputDir, { recursive: true, force: true });
});

/**
 * A real `Core.M3LPaths` whose data root and output root are **different**
 * temp directories — so a test can assert which of the two the counter chose.
 */
function makePaths(): Core.M3LPaths {
  vi.stubEnv("M3L_DATA_DIR", dataDir);
  vi.stubEnv("M3L_OUTPUT_DIR", outputDir);
  return new Core.M3LPaths();
}

/** The absolute path the counter file must land at. */
function counterPath(): string {
  return path.join(dataDir, COUNTER_RELATIVE_PATH);
}

/**
 * Plants a genuine counter file by running the module's own writer — never a
 * hand-built envelope, so the checksum and format version cannot drift out of
 * step with the store the tests then read through.
 */
async function plantCounter(
  invocations: number,
  countedAt: number,
): Promise<void> {
  const counter = await openDailyInvocationCounter({
    paths: makePaths(),
    now: countedAt,
  });
  await counter.record(invocations);
}

/** Reads the persisted payload back, without going through the store. */
async function readStoredPayload(): Promise<Record<string, unknown>> {
  const text = await readFile(counterPath(), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("counter file is not a JSON object");
  }
  const payload = (parsed as Record<string, unknown>)["payload"];
  if (typeof payload !== "object" || payload === null) {
    throw new Error("counter envelope carries no payload object");
  }
  return payload as Record<string, unknown>;
}

/** Overwrites the counter file with `text`, leaving the directory in place. */
async function corruptCounter(text: string): Promise<void> {
  await writeFile(counterPath(), text, "utf8");
}

/** The read-only health-check action every evaluator assertion judges. */
function healthCheckAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "health-check",
    kind: "read-only",
    parameterNames: ["command"],
  };
}

/**
 * Evaluates `ledger` against a policy declaring ONLY `invocationsPerDay`, so
 * no other ceiling can mask the rule under test.
 */
function evaluatePerDay(
  ledger: AgentRunLedger,
  ceiling: number,
  now: number,
): Core.M3LAgentDecision {
  ledger.observeDecisionLog(true);
  return Core.evaluateAgentAction({
    action: healthCheckAction(),
    policy: budgetPolicy({ invocationsPerDay: ceiling }),
    run: ledger.snapshot(now),
  });
}

describe("openDailyInvocationCounter — a virgin deployment", () => {
  it("reads a missing file as zero prior invocations and touches no file until record()", async () => {
    const counter = await openDailyInvocationCounter({
      paths: makePaths(),
      now: NOW,
    });

    expect(counter.priorToday).toBe(0);
    // The state directory is created by record(), not by open() — an
    // unloadable policy (which aborts before open()) and a declined verdict
    // (which aborts before record()) must both leave no artefact behind.
    await expect(readdir(path.join(dataDir, "agent-state"))).rejects.toThrow();
  });

  it("record() creates the state directory writeFileAtomic will not create itself", async () => {
    const counter = await openDailyInvocationCounter({
      paths: makePaths(),
      now: NOW,
    });

    await expect(counter.record(3)).resolves.toBeUndefined();

    expect(await readStoredPayload()).toEqual({
      countedAt: NOW,
      invocations: 3,
    });
  });
});

describe("openDailyInvocationCounter — the state lives under the DATA root", () => {
  // Directly mutation-resistant against the regression `.gitignore`'s
  // `data/agent-state/` entry exists to prevent: a counter written under
  // `getOutputDir()` is in the directory an operator clears between runs, so
  // clearing run artifacts would silently reset a policy budget ceiling.
  it("writes under getDataDir()/agent-state and leaves getOutputDir() empty", async () => {
    const counter = await openDailyInvocationCounter({
      paths: makePaths(),
      now: NOW,
    });
    await counter.record(1);

    expect(await readdir(path.join(dataDir, "agent-state"))).toEqual([
      "daily-invocations.checkpoint.json",
    ]);
    expect(await readdir(outputDir)).toEqual([]);
  });

  it("uses a fixed filename, never one derived from an argv-settable value", async () => {
    // `agentName` is settable from argv, so an agentName-derived filename
    // would let `--agentName foo` mint a fresh per-day budget with no policy
    // diff. Two opens against the same data root must therefore collide on
    // one file — which is the whole point of the counter.
    const first = await openDailyInvocationCounter({
      paths: makePaths(),
      now: NOW,
    });
    await first.record(5);
    const second = await openDailyInvocationCounter({
      paths: makePaths(),
      now: NOW,
    });

    expect(second.priorToday).toBe(5);
    expect(await readdir(path.join(dataDir, "agent-state"))).toHaveLength(1);
  });
});

describe("openDailyInvocationCounter — a corrupt file never degrades to zero", () => {
  // The one place this module could silently convert tampering (or a
  // truncated write) into a budget reset. Rejecting is the only safe answer:
  // an unreadable counter is unobservable spend, not zero spend.
  it.each([
    ["unparseable JSON", (): string => "{not json"],
    [
      "a truncated write",
      (): string => '{"__m3lCheckpointFormat":1,"checksum":"ab',
    ],
    [
      "an envelope whose payload is the wrong shape",
      (original: string): string =>
        original.replace(/"payload":\{[^}]*\}/, '"payload":"nope"'),
    ],
    // The sharpest of the four: the file still LOOKS like a valid envelope
    // and still decodes to a well-formed state — only the checksum disagrees.
    // A store that skipped verification would hand back a tampered `0`, which
    // is precisely the silent budget reset this module must never perform.
    [
      "a tampered payload whose checksum no longer matches",
      (original: string): string =>
        original.replace(`"invocations":${String(STORED)}`, '"invocations":0'),
    ],
  ] as ReadonlyArray<
    readonly [label: string, corrupt: (original: string) => string]
  >)(
    "rejects with ERR_AGENT_OPERATOR_BUDGET_STATE on %s",
    async (_label, corrupt) => {
      await plantCounter(STORED, NOW);
      await corruptCounter(corrupt(await readFile(counterPath(), "utf8")));

      let thrown: unknown;
      try {
        await openDailyInvocationCounter({ paths: makePaths(), now: NOW });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_BUDGET_STATE",
      );
      // The store's own failure is chained rather than re-messaged: its
      // message embeds the resolved path, which must not reach ours.
      expect((thrown as M3LAgentOperatorCliError).cause).toBeInstanceOf(
        Core.M3LCheckpointError,
      );
      expect((thrown as M3LAgentOperatorCliError).message).not.toContain(
        dataDir,
      );
    },
  );

  it("keeps rejecting on every subsequent read, never settling on zero", async () => {
    await plantCounter(STORED, NOW);
    await corruptCounter("{not json");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        openDailyInvocationCounter({ paths: makePaths(), now: NOW }),
      ).rejects.toThrow(M3LAgentOperatorCliError);
    }
  });
});

describe("openDailyInvocationCounter — the correlated-pair validator", () => {
  /**
   * Replaces the persisted payload with `payload`, re-checksumming through
   * the store's own writer so the ONLY thing wrong with the file is the
   * payload shape — otherwise a checksum mismatch would fail the test for
   * the wrong reason and the validator would never run.
   */
  async function plantPayload(payload: unknown): Promise<void> {
    await mkdir(path.dirname(counterPath()), { recursive: true });
    const envelope = {
      __m3lCheckpointFormat: 1,
      checksum: Core.canonicalJsonHash(payload),
      payload,
    };
    await writeFile(counterPath(), JSON.stringify(envelope), "utf8");
  }

  // Two tests, not one: each kills a different half of a per-field validator.
  // A validator checking only `invocations` passes the first; one checking
  // only `countedAt` passes the second.
  it.each([
    ["countedAt", { invocations: STORED }],
    ["invocations", { countedAt: NOW }],
  ] as ReadonlyArray<readonly [missing: string, payload: unknown]>)(
    "rejects a payload missing %s",
    async (_missing, payload) => {
      await plantPayload(payload);

      await expect(
        openDailyInvocationCounter({ paths: makePaths(), now: NOW }),
      ).rejects.toMatchObject({ code: "ERR_AGENT_OPERATOR_BUDGET_STATE" });
    },
  );

  it.each([
    ["a negative count", { countedAt: NOW, invocations: -1 }],
    ["a fractional count", { countedAt: NOW, invocations: 1.5 }],
    ["a non-numeric count", { countedAt: NOW, invocations: "7" }],
    ["a negative instant", { countedAt: -1, invocations: STORED }],
  ] as ReadonlyArray<readonly [label: string, payload: unknown]>)(
    "rejects %s",
    async (_label, payload) => {
      await plantPayload(payload);

      await expect(
        openDailyInvocationCounter({ paths: makePaths(), now: NOW }),
      ).rejects.toMatchObject({ code: "ERR_AGENT_OPERATOR_BUDGET_STATE" });
    },
  );
});

describe("openDailyInvocationCounter — the UTC rollover boundary", () => {
  /** The exact first millisecond of the stored instant's UTC day. */
  const DAY_START = Date.UTC(2026, 8, 1, 0, 0, 0, 0);
  /** The exact last millisecond of that same UTC day. */
  const DAY_END = Date.UTC(2026, 8, 1, 23, 59, 59, 999);

  it.each([
    ["the exact lower edge of the stored day", DAY_START, STORED],
    ["the exact upper edge of the stored day", DAY_END, STORED],
    ["one millisecond past the upper edge", DAY_END + 1, 0],
    ["one millisecond before the lower edge", DAY_START - 1, 0],
    ["a full day later", DAY_START + DAY_MS, 0],
    // A clock stepped BACKWARDS must not grant a stale baseline either: the
    // stored instant is then in the future, which is not today.
    ["a stored instant in the future", DAY_START - DAY_MS, 0],
  ] as ReadonlyArray<readonly [label: string, now: number, expected: number]>)(
    "reads %s as %i prior invocations",
    async (_label, now, expected) => {
      await plantCounter(STORED, NOW);

      const counter = await openDailyInvocationCounter({
        paths: makePaths(),
        now,
      });

      expect(counter.priorToday).toBe(expected);
    },
  );

  it("record() after a rollover re-anchors the file to today rather than adding to yesterday", async () => {
    await plantCounter(STORED, NOW);
    const tomorrow = NOW + DAY_MS;

    const counter = await openDailyInvocationCounter({
      paths: makePaths(),
      now: tomorrow,
    });
    await counter.record(2);

    expect(await readStoredPayload()).toEqual({
      countedAt: tomorrow,
      invocations: 2,
    });
  });
});

describe("sameUtcDay — the drift guard", () => {
  // Pins the library's integer-division formula
  // (`internal/agent/budgets.ts`, off-limits under ADR-0029 and therefore
  // re-derived here). A `toDateString()` or local-time rewrite fails the
  // offset rows below regardless of the runner's own TZ, because every
  // instant here is expressed in UTC.
  it.each([
    [
      "midnight and the last millisecond of the same UTC day",
      0,
      DAY_MS - 1,
      true,
    ],
    ["the last millisecond and the next midnight", DAY_MS - 1, DAY_MS, false],
    ["the epoch and a modern instant", 0, NOW, false],
    ["an instant with itself", NOW, NOW, true],
    [
      "two instants 14 hours apart within one UTC day",
      DAY_MS,
      DAY_MS + 14 * 60 * 60 * 1000,
      true,
    ],
  ] as ReadonlyArray<
    readonly [label: string, a: number, b: number, expected: boolean]
  >)("%s -> %s", (_label, a, b, expected) => {
    expect(sameUtcDay(a, b)).toBe(expected);
    // Symmetric by construction; an asymmetric implementation is a bug.
    expect(sameUtcDay(b, a)).toBe(expected);
  });

  it("matches Math.floor(t / 86_400_000) exactly across a swept range", () => {
    for (let offset = -3; offset <= 3; offset += 1) {
      const a = NOW + offset * DAY_MS;
      expect(sameUtcDay(a, NOW)).toBe(
        Math.floor(a / DAY_MS) === Math.floor(NOW / DAY_MS),
      );
    }
  });
});

describe("openDailyInvocationCounter — seeding the ledger", () => {
  it("makes a declared invocationsPerDay observable instead of escalating", async () => {
    await plantCounter(10, NOW);
    const counter = await openDailyInvocationCounter({
      paths: makePaths(),
      now: NOW,
    });
    const ledger = new AgentRunLedger();

    // Before the seed: the honest, unobservable escalation.
    expect(evaluatePerDay(new AgentRunLedger(), 400, NOW).rule).toBe(
      "budget.invocations-per-day.unobservable",
    );

    counter.seed(ledger);

    expect(evaluatePerDay(ledger, 400, NOW).verdict).toBe("auto-approved");
  });

  it("anchors todayCountedAt to the run's own now, not the stored instant", async () => {
    // After a rollover the stored instant belongs to a previous UTC day.
    // Anchoring to it would make the evaluator read the (already-rolled)
    // count as belonging to a day that is not today, which is unobservable
    // all over again.
    await plantCounter(STORED, NOW);
    const tomorrow = NOW + DAY_MS;
    const counter = await openDailyInvocationCounter({
      paths: makePaths(),
      now: tomorrow,
    });
    const ledger = new AgentRunLedger();
    counter.seed(ledger);

    const snapshot = ledger.snapshot(tomorrow);
    expect(snapshot.todayCountedAt).toBe(tomorrow);
    expect(snapshot.invocationsToday).toBe(0);
    expect(evaluatePerDay(ledger, 400, tomorrow).verdict).toBe("auto-approved");
  });

  it("composes the baseline with this run's own invocations on every snapshot", async () => {
    // Kills a snapshot() emitting the bare baseline, which would under-count
    // within a long run and fail OPEN at the ceiling.
    await plantCounter(5, NOW);
    const counter = await openDailyInvocationCounter({
      paths: makePaths(),
      now: NOW,
    });
    const ledger = new AgentRunLedger();
    counter.seed(ledger);

    ledger.recordInvocation();
    ledger.recordInvocation();
    ledger.recordInvocation();

    expect(ledger.snapshot(NOW).invocationsToday).toBe(8);
  });

  it("reports budget.invocations-per-day — not .unobservable — at the reject-AT bound", async () => {
    // Polarity: the ceiling is reject-AT (`observed >= ceiling`), and the
    // rule reported must be the EXHAUSTED one. A seeded-but-wrong baseline
    // would show up here as `.unobservable` or as an auto-approval.
    await plantCounter(399, NOW);
    const counter = await openDailyInvocationCounter({
      paths: makePaths(),
      now: NOW,
    });
    const ledger = new AgentRunLedger();
    counter.seed(ledger);
    ledger.recordInvocation();

    const decision = evaluatePerDay(ledger, 400, NOW);

    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("budget.invocations-per-day");
  });
});

describe("openDailyInvocationCounter — record()", () => {
  it("persists priorToday + invocationsThisRun as the day's absolute total", async () => {
    await plantCounter(7, NOW);
    const counter = await openDailyInvocationCounter({
      paths: makePaths(),
      now: NOW,
    });

    await counter.record(4);

    expect(await readStoredPayload()).toEqual({
      countedAt: NOW,
      invocations: 11,
    });
  });

  it("is idempotent — both operands are fixed, so a repeat rewrites identical bytes", async () => {
    await plantCounter(7, NOW);
    const counter = await openDailyInvocationCounter({
      paths: makePaths(),
      now: NOW,
    });

    await counter.record(4);
    const first = await readFile(counterPath(), "utf8");
    await counter.record(4);

    expect(await readFile(counterPath(), "utf8")).toBe(first);
  });

  it("record(0) is not a no-op: it materialises the rollover so the file reflects today", async () => {
    // Which is why the call is kept in this slice even though no invocation
    // can occur yet — deleting it would leave a stale, previous-day file on
    // disk and defer the whole write path to a slice that never tests it.
    await plantCounter(STORED, NOW);
    const tomorrow = NOW + DAY_MS;
    const counter = await openDailyInvocationCounter({
      paths: makePaths(),
      now: tomorrow,
    });

    await counter.record(0);

    expect(await readStoredPayload()).toEqual({
      countedAt: tomorrow,
      invocations: 0,
    });
  });

  it("round-trips through the real envelope, so a written file re-opens as its own baseline", async () => {
    const counter = await openDailyInvocationCounter({
      paths: makePaths(),
      now: NOW,
    });
    await counter.record(12);

    const reopened = await openDailyInvocationCounter({
      paths: makePaths(),
      now: NOW,
    });

    expect(reopened.priorToday).toBe(12);
  });
});

describe("openDailyInvocationCounter — the caller owns the clock", () => {
  it("never reads Date.now, in any operation", async () => {
    // The rollover, `todayCountedAt`, and both evaluator calls must agree on
    // one instant. A module that sampled its own clock would let a run
    // straddling UTC midnight roll under one `now` and be judged under
    // another.
    const paths = makePaths();
    const nowSpy = vi.spyOn(Date, "now");

    const counter = await openDailyInvocationCounter({ paths, now: NOW });
    counter.seed(new AgentRunLedger());
    await counter.record(1);

    expect(nowSpy).not.toHaveBeenCalled();
  });
});
