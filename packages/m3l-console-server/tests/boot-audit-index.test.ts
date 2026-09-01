/**
 * Tests for src/boot/audit-index.ts — `projectHumanActionIndexInput` and
 * `createIndexedHumanActionAuditPort` (m3l-console-server X7c, ADR-0070's
 * dual-store audit).
 *
 * Three things here are contracts rather than incidental behaviour, and each
 * has a test that fails if it is reversed:
 *
 * 1. **Ordering.** The JSONL trail write happens first and stays fatal, so a
 *    failed trail append means NO index row is attempted. Swapping the two
 *    writes in `createIndexedHumanActionAuditPort` makes
 *    "a stream failure attempts no index write" fail.
 * 2. **Asymmetry.** A failed index write is a logged degradation, never a
 *    rejection — the operator's action succeeds.
 * 3. **Vocabulary equality.** `audit/record.ts` and
 *    `store/audit-repository-types.ts` declare the kind/posture/outcome
 *    unions separately (the `store` eslint zone forbids the import), and
 *    nothing but the `expectTypeOf` block below asserts they still match.
 *
 * Uses a recording `Core.M3LLoggerHandler` fake rather than spying on
 * `Core.M3LLogger`'s methods — the same sanctioned pattern as
 * `tests/runs-audit.test.ts` — so the assertions stay on the event a real
 * handler would receive.
 */
import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type { M3LHumanActionAuditPort } from "../src/audit/port.js";
import type {
  M3LHumanActionKind,
  M3LHumanActionOutcome,
  M3LHumanActionPosture,
  M3LHumanActionRecord,
  M3LHumanActionTarget,
} from "../src/audit/record.js";
import {
  createIndexedHumanActionAuditPort,
  projectHumanActionIndexInput,
} from "../src/boot/audit-index.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import type {
  M3LConsoleAuditRepository,
  M3LHumanActionIndexInput,
  M3LHumanActionIndexKind,
  M3LHumanActionIndexOutcome,
  M3LHumanActionIndexPosture,
} from "../src/store/audit-repository.js";

/** A recording `M3LLoggerHandler` fake — mirrors `tests/runs-audit.test.ts`'s pattern. */
class RecordingHandler implements Core.M3LLoggerHandler {
  readonly events: Core.M3LLogEvent[] = [];

  handle(event: Core.M3LLogEvent): void {
    this.events.push(event);
  }

  reset(): void {
    this.events.length = 0;
  }
}

/** Builds a `M3LHumanActionRecord` fixture, defaulting to an allowed script launch. */
function buildRecord(
  overrides: Partial<M3LHumanActionRecord> = {},
): M3LHumanActionRecord {
  return {
    atMs: 1_700_000_000_000,
    operator: "ada",
    operatorEmailDeclared: true,
    correlationId: "corr-1",
    action: "run.launch",
    target: { kind: "script", id: "script-1", scriptName: "sqs-etl" },
    parameterNames: ["queueUrl"],
    parameterRefs: ["artifact://run-1/params"],
    posture: "confirmed",
    outcome: "allowed",
    detail: { attempt: 1 },
    ...overrides,
  };
}

/**
 * A recording {@link M3LConsoleAuditRepository} fake: `insert` records every
 * row (and throws `insertShouldThrow` when supplied); every other method
 * fails loudly, since the dual-write path must only ever call `insert`.
 */
function createRecordingRepository(insertShouldThrow?: Error): {
  readonly repository: M3LConsoleAuditRepository;
  readonly inserted: M3LHumanActionIndexInput[];
} {
  const inserted: M3LHumanActionIndexInput[] = [];
  const unexpected = (): never => {
    throw new Error("unexpected audit-repository call on the dual-write path");
  };
  return {
    inserted,
    repository: {
      insert(input: M3LHumanActionIndexInput): void {
        inserted.push(input);
        if (insertShouldThrow !== undefined) throw insertShouldThrow;
      },
      insertAll: unexpected,
      deleteAll: unexpected,
      list: unexpected,
      count: unexpected,
    },
  };
}

/** Builds an indexed port over a recording inner port, repository and logger. */
function buildPort(
  overrides: {
    innerShouldReject?: Error;
    insertShouldThrow?: Error;
  } = {},
): {
  readonly port: M3LHumanActionAuditPort;
  readonly recorded: M3LHumanActionRecord[];
  readonly inserted: M3LHumanActionIndexInput[];
  readonly handler: RecordingHandler;
} {
  const recorded: M3LHumanActionRecord[] = [];
  const inner: M3LHumanActionAuditPort = {
    record(record: M3LHumanActionRecord): Promise<void> {
      if (overrides.innerShouldReject !== undefined) {
        return Promise.reject(overrides.innerShouldReject);
      }
      recorded.push(record);
      return Promise.resolve();
    },
  };
  const { repository, inserted } = createRecordingRepository(
    overrides.insertShouldThrow,
  );
  const handler = new RecordingHandler();
  return {
    port: createIndexedHumanActionAuditPort({
      inner,
      repository,
      logger: new Core.M3LLogger([handler]),
    }),
    recorded,
    inserted,
    handler,
  };
}

describe("projectHumanActionIndexInput — the target rename and re-discrimination", () => {
  test("a script target carries scriptName through", () => {
    const input = projectHumanActionIndexInput(
      buildRecord({
        target: { kind: "script", id: "script-1", scriptName: "sqs-etl" },
      }),
    );

    expect(input.targetKind).toBe("script");
    expect(input.targetId).toBe("script-1");
    expect(input.scriptName).toBe("sqs-etl");
  });

  test.each([
    ["run", "run-1"],
    ["session", "session-1"],
    ["step", "step-1"],
    ["artifact", "artifact-1"],
  ] as const)("a %s target pins scriptName to undefined", (kind, id) => {
    const input = projectHumanActionIndexInput(
      buildRecord({ target: { kind, id } }),
    );

    expect(input.targetKind).toBe(kind);
    expect(input.targetId).toBe(id);
    expect(input.scriptName).toBeUndefined();
  });

  test("every non-target field is copied verbatim", () => {
    const input = projectHumanActionIndexInput(
      buildRecord({
        atMs: 1_700_000_000_123,
        operator: "grace",
        operatorEmailDeclared: false,
        correlationId: "corr-9",
        action: "session.close",
        target: { kind: "session", id: "session-2" },
        posture: "escalated",
        outcome: "denied",
      }),
    );

    expect(input).toStrictEqual({
      atMs: 1_700_000_000_123,
      operator: "grace",
      operatorEmailDeclared: false,
      correlationId: "corr-9",
      action: "session.close",
      targetKind: "session",
      targetId: "session-2",
      scriptName: undefined,
      posture: "escalated",
      outcome: "denied",
    });
  });

  // The whole reason ADR-0070 calls the JSONL trail the source of truth: the
  // index has no column for these three, so the projection is one-way.
  test("parameterNames, parameterRefs and detail are DROPPED — the index cannot round-trip the trail", () => {
    const input = projectHumanActionIndexInput(buildRecord());

    expect(Object.keys(input).sort()).toStrictEqual([
      "action",
      "atMs",
      "correlationId",
      "operator",
      "operatorEmailDeclared",
      "outcome",
      "posture",
      "scriptName",
      "targetId",
      "targetKind",
    ]);
  });

  test("a target kind outside the declared union throws ERR_CONSOLE_INTERNAL naming it", () => {
    const record = buildRecord({
      target: { kind: "bogus", id: "x" } as unknown as M3LHumanActionTarget,
    });

    expect(() => projectHumanActionIndexInput(record)).toThrow(M3LConsoleError);
    expect(() => projectHumanActionIndexInput(record)).toThrow(/bogus/);
  });
});

describe("createIndexedHumanActionAuditPort — the dual write", () => {
  test("writes the trail entry AND the index row, and logs nothing", async () => {
    const { port, recorded, inserted, handler } = buildPort();
    const record = buildRecord();

    await port.record(record);

    expect(recorded).toStrictEqual([record]);
    expect(inserted).toStrictEqual([projectHumanActionIndexInput(record)]);
    expect(handler.events).toStrictEqual([]);
  });

  test("returns a port satisfying M3LHumanActionAuditPort", () => {
    const { port } = buildPort();

    expectTypeOf(port).toEqualTypeOf<M3LHumanActionAuditPort>();
  });
});

describe("createIndexedHumanActionAuditPort — an index failure is a LOUD degradation", () => {
  test("the action still resolves when the index insert throws", async () => {
    const { port, recorded } = buildPort({
      insertShouldThrow: new Error("database is locked"),
    });
    const record = buildRecord();

    await expect(port.record(record)).resolves.toBeUndefined();
    expect(recorded).toStrictEqual([record]);
  });

  test("the failure is logged at error with the correlation id", async () => {
    const { port, handler } = buildPort({
      insertShouldThrow: new Error("database is locked"),
    });

    await port.record(buildRecord({ correlationId: "corr-42" }));

    expect(handler.events).toHaveLength(1);
    const event = handler.events[0];
    expect(event?.category).toBe("error");
    expect(event?.message).toContain("audit index write failed");
    expect(event?.data?.["correlationId"]).toBe("corr-42");
    expect(event?.data?.["action"]).toBe("run.launch");
    expect(event?.data?.["cause"]).toContain("database is locked");
  });

  test("a typed M3LConsoleError from the repository degrades the same way", async () => {
    const { port, handler } = buildPort({
      insertShouldThrow: new M3LConsoleError(
        "ERR_CONSOLE_STORE_BUSY",
        "console audit repository insert failed",
      ),
    });

    await expect(port.record(buildRecord())).resolves.toBeUndefined();
    expect(handler.events).toHaveLength(1);
  });
});

describe("createIndexedHumanActionAuditPort — the trail write stays fatal, and stays FIRST", () => {
  test("a stream failure rejects with the original error", async () => {
    const cause = new M3LConsoleError(
      "ERR_CONSOLE_AUDIT_WRITE_FAILED",
      "the audit trail could not be appended to",
    );
    const { port } = buildPort({ innerShouldReject: cause });

    await expect(port.record(buildRecord())).rejects.toBe(cause);
  });

  // The ordering lock. Swap the two writes in the implementation and this is
  // the assertion that fails.
  test("a stream failure attempts NO index write", async () => {
    const { port, inserted, handler } = buildPort({
      innerShouldReject: new M3LConsoleError(
        "ERR_CONSOLE_AUDIT_WRITE_FAILED",
        "the audit trail could not be appended to",
      ),
    });

    await expect(port.record(buildRecord())).rejects.toThrow();

    expect(inserted).toStrictEqual([]);
    expect(handler.events).toStrictEqual([]);
  });

  test("a record rejected as invalid by the stream never reaches the index", async () => {
    const repository = createRecordingRepository();
    const insert = vi.spyOn(repository.repository, "insert");
    const port = createIndexedHumanActionAuditPort({
      inner: {
        record: (): Promise<void> =>
          Promise.reject(
            new M3LConsoleError(
              "ERR_CONSOLE_AUDIT_RECORD_INVALID",
              "record is malformed",
            ),
          ),
      },
      repository: repository.repository,
      logger: new Core.M3LLogger([]),
    });

    await expect(port.record(buildRecord())).rejects.toThrow(M3LConsoleError);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("the two separately-declared vocabularies must stay identical", () => {
  // `store/audit-repository-types.ts` cannot import `audit/record.ts` (the
  // `store` eslint zone forbids it, asserted at exact length by
  // `bin/check-eslint-zones.mjs`), so these unions are duplicated by design.
  // Without these three assertions, a kind added to one and not the other
  // compiles here and fails at the SQLite CHECK constraint at runtime.
  test("M3LHumanActionKind equals M3LHumanActionIndexKind", () => {
    expectTypeOf<M3LHumanActionKind>().toEqualTypeOf<M3LHumanActionIndexKind>();
  });

  test("M3LHumanActionPosture equals M3LHumanActionIndexPosture", () => {
    expectTypeOf<M3LHumanActionPosture>().toEqualTypeOf<M3LHumanActionIndexPosture>();
  });

  test("M3LHumanActionOutcome equals M3LHumanActionIndexOutcome", () => {
    expectTypeOf<M3LHumanActionOutcome>().toEqualTypeOf<M3LHumanActionIndexOutcome>();
  });

  test("every M3LHumanActionTarget kind is an index target kind", () => {
    expectTypeOf<M3LHumanActionTarget["kind"]>().toEqualTypeOf<
      M3LHumanActionIndexInput["targetKind"]
    >();
  });
});
