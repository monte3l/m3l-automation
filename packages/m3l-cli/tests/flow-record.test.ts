/**
 * Tests for src/flow/record.ts — the per-run flow record: a canonical hash of
 * the definition, the nested per-step-execution list, and a LOUD
 * read-validate-write persistence layer
 * (`docs/plans/2026-09-01-orchestration-engine.md` §_Resume semantics —
 * designed here, shipped by U11_).
 *
 * Deliberately unlike `history/store.ts`, which is a capped append-only list of
 * flat entries that must never throw: losing a flow run record breaks U11's
 * resume, so every write and read failure is surfaced as an `M3LCliError`
 * rather than swallowed into a boolean or an empty array. Those opposite
 * failure contracts are asserted here.
 *
 * Filesystem access follows `history-store.test.ts`'s sanctioned pattern: a
 * pass-through `vi.mock("node:fs", … importActual)` plus per-test
 * `vi.spyOn(fs, …)`. No real filesystem mutation anywhere.
 *
 * Stage-B contract revision (stage-C review): `M3LCliFlowRunResult` now carries
 * the RICHER `M3LCliFlowStepOutcome` per execution (the seven persisted fields
 * plus the observed `startedAt`/`finishedAt`/`reportUnavailable`), so
 * `buildFlowRunRecord` PROJECTS each one down to a seven-field
 * `M3LCliFlowStepExecution`. The persisted shape is unchanged and must stay
 * unchanged — it IS the on-disk JSON, and a `Date` written there reads back as
 * a string, which would make the round-trip a type lie. The projection tests
 * below assert the ABSENCE of the three in-memory-only fields, not merely the
 * presence of the seven.
 *
 * RED phase: `M3LCliFlowStepOutcome` does not exist in `src/flow/types.ts` yet
 * and `buildFlowRunRecord` still passes `result.stepExecutions` straight
 * through, so the projection assertions below fail. That is expected.
 */
import * as fs from "node:fs";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  buildFlowRunRecord,
  hashFlowDefinition,
  readFlowRunRecord,
  writeFlowRunRecord,
} from "../src/flow/record.js";
import type {
  M3LCliFlowRunRecord,
  M3LCliFlowRunRecordInput,
} from "../src/flow/record.js";
import type { M3LCliFlowRunResult } from "../src/flow/run.js";
import type {
  M3LCliFlowDefinition,
  M3LCliFlowRunStatus,
  M3LCliFlowStep,
  M3LCliFlowStepExecution,
  M3LCliFlowStepOutcome,
} from "../src/flow/types.js";
import { M3LCliError } from "../src/cli/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const RECORD_PATH = "/workspace/data/cache/m3l-cli/flows/dlq-reconcile.json";

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function buildStep(
  id: string,
  overrides: Partial<M3LCliFlowStep> = {},
): M3LCliFlowStep {
  return {
    id,
    script: "sqs-etl",
    parameters: { command: "dump" },
    execution: "spawn",
    onSuccess: "continue",
    onFailure: "stop",
    onPartial: "stop",
    ...overrides,
  };
}

function buildDefinition(
  overrides: Partial<M3LCliFlowDefinition> = {},
): M3LCliFlowDefinition {
  return {
    name: "dlq-reconcile",
    maxStepExecutions: 12,
    steps: [buildStep("dump"), buildStep("reshape", { script: "json-etl" })],
    ...overrides,
  };
}

/*
 * Three per-execution OUTCOMES, each with its OWN observed window — the loop's
 * in-memory shape. Distinct windows are load-bearing: they are what makes the
 * projection assertions below discriminating, since an implementation that
 * leaked the window into the record would show three different extra values
 * rather than one shared one.
 */
const DUMP_ATTEMPT_1: M3LCliFlowStepOutcome = {
  stepId: "dump",
  script: "sqs-etl",
  attempt: 1,
  exitCode: 0,
  outcome: "success",
  reportPath: "/workspace/data/output/a/run-report.json",
  branch: "continue",
  startedAt: new Date("2026-09-01T09:00:01.000Z"),
  finishedAt: new Date("2026-09-01T09:00:04.000Z"),
  reportUnavailable: null,
};

const RESHAPE_ATTEMPT_1: M3LCliFlowStepOutcome = {
  stepId: "reshape",
  script: "json-etl",
  attempt: 1,
  exitCode: 6,
  outcome: "partial",
  reportPath: null,
  branch: { goto: "dump" },
  startedAt: new Date("2026-09-01T09:03:00.000Z"),
  finishedAt: new Date("2026-09-01T09:05:30.000Z"),
  reportUnavailable: "report-malformed",
};

const DUMP_ATTEMPT_2: M3LCliFlowStepOutcome = {
  stepId: "dump",
  script: "sqs-etl",
  attempt: 2,
  exitCode: 4,
  outcome: null,
  reportPath: "/workspace/data/output/c/run-report.json",
  branch: "stop",
  startedAt: new Date("2026-09-01T09:10:00.000Z"),
  finishedAt: new Date("2026-09-01T09:12:30.000Z"),
  reportUnavailable: null,
};

const STEP_OUTCOMES: readonly M3LCliFlowStepOutcome[] = [
  DUMP_ATTEMPT_1,
  RESHAPE_ATTEMPT_1,
  DUMP_ATTEMPT_2,
];

/** The seven-field projection of {@link STEP_OUTCOMES} the record must hold. */
const PERSISTED_STEP_EXECUTIONS: readonly M3LCliFlowStepExecution[] = [
  {
    stepId: "dump",
    script: "sqs-etl",
    attempt: 1,
    exitCode: 0,
    outcome: "success",
    reportPath: "/workspace/data/output/a/run-report.json",
    branch: "continue",
  },
  {
    stepId: "reshape",
    script: "json-etl",
    attempt: 1,
    exitCode: 6,
    outcome: "partial",
    reportPath: null,
    branch: { goto: "dump" },
  },
  {
    stepId: "dump",
    script: "sqs-etl",
    attempt: 2,
    exitCode: 4,
    outcome: null,
    reportPath: "/workspace/data/output/c/run-report.json",
    branch: "stop",
  },
];

/** The declared key order of a persisted step execution, i.e. its byte order. */
const PERSISTED_STEP_EXECUTION_KEYS: readonly string[] = [
  "stepId",
  "script",
  "attempt",
  "exitCode",
  "outcome",
  "reportPath",
  "branch",
];

function buildResult(
  overrides: Partial<M3LCliFlowRunResult> = {},
): M3LCliFlowRunResult {
  return {
    flowName: "dlq-reconcile",
    status: "failed",
    exitCode: 4,
    startedAt: new Date("2026-09-01T09:00:00.000Z"),
    finishedAt: new Date("2026-09-01T09:12:30.500Z"),
    stepExecutionCount: 3,
    haltingStepId: "dump",
    resumeStepId: "dump",
    stepExecutions: STEP_OUTCOMES,
    ...overrides,
  };
}

function buildInput(
  overrides: Partial<M3LCliFlowRunRecordInput> = {},
): M3LCliFlowRunRecordInput {
  return {
    runId: "2026-09-01T09-00-00-000Z",
    definition: buildDefinition(),
    result: buildResult(),
    ...overrides,
  };
}

describe("hashFlowDefinition — stability", () => {
  test("the same definition hashes to the same value across calls", () => {
    const definition = buildDefinition();

    expect(hashFlowDefinition(definition)).toBe(hashFlowDefinition(definition));
  });

  test("two structurally equal definitions hash identically", () => {
    expect(hashFlowDefinition(buildDefinition())).toBe(
      hashFlowDefinition(buildDefinition()),
    );
  });

  test("the hash is a 64-character lowercase hex digest", () => {
    expect(hashFlowDefinition(buildDefinition())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashFlowDefinition — canonicality", () => {
  /*
   * U11 refuses a resume on hash mismatch, so a mere re-serialization of the
   * SAME semantic definition must not look like a definition change. A naive
   * `JSON.stringify` over the parsed document would make key order — which
   * YAML mapping order controls and which carries no meaning — change the
   * hash, spuriously blocking every resume after an innocuous reformat.
   */
  test("flow-level key order does not change the hash", () => {
    const steps = [buildStep("dump")];
    const inOneOrder: M3LCliFlowDefinition = {
      name: "dlq-reconcile",
      description: "drain and republish",
      maxStepExecutions: 12,
      steps,
    };
    const inAnother: M3LCliFlowDefinition = {
      steps,
      maxStepExecutions: 12,
      description: "drain and republish",
      name: "dlq-reconcile",
    };

    expect(hashFlowDefinition(inOneOrder)).toBe(hashFlowDefinition(inAnother));
  });

  test("step-level key order does not change the hash", () => {
    const first: M3LCliFlowStep = {
      id: "dump",
      script: "sqs-etl",
      parameters: { command: "dump" },
      execution: "spawn",
      onSuccess: "continue",
      onFailure: "stop",
      onPartial: "stop",
    };
    const second: M3LCliFlowStep = {
      onPartial: "stop",
      onFailure: "stop",
      onSuccess: "continue",
      execution: "spawn",
      parameters: { command: "dump" },
      script: "sqs-etl",
      id: "dump",
    };

    expect(hashFlowDefinition(buildDefinition({ steps: [first] }))).toBe(
      hashFlowDefinition(buildDefinition({ steps: [second] })),
    );
  });

  test("parameters key order does not change the hash", () => {
    const a = buildStep("dump", {
      parameters: { command: "dump", output: "o.jsonl" },
    });
    const b = buildStep("dump", {
      parameters: { output: "o.jsonl", command: "dump" },
    });

    expect(hashFlowDefinition(buildDefinition({ steps: [a] }))).toBe(
      hashFlowDefinition(buildDefinition({ steps: [b] })),
    );
  });

  test("an absent optional description does not leak a placeholder into the hash", () => {
    // `exactOptionalPropertyTypes: true` makes `description: undefined`
    // unrepresentable, so the only shape to pin is the absent one: it must
    // hash stably and differ from any concrete description.
    const withoutDescription: M3LCliFlowDefinition = {
      name: "dlq-reconcile",
      maxStepExecutions: 12,
      steps: [buildStep("dump")],
    };

    expect(hashFlowDefinition(withoutDescription)).toBe(
      hashFlowDefinition({
        maxStepExecutions: 12,
        steps: [buildStep("dump")],
        name: "dlq-reconcile",
      }),
    );
    expect(hashFlowDefinition(withoutDescription)).not.toBe(
      hashFlowDefinition({ ...withoutDescription, description: "" }),
    );
  });
});

/**
 * Copies `base` and defines `key` as a genuine own enumerable property.
 * Needed for `__proto__`, which a plain object literal would treat as a
 * prototype assignment rather than an own key — the very shape a step's
 * `parameters` value can carry once it round-trips through `JSON.parse`.
 */
function withOwnKey(
  base: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const record: Record<string, unknown> = { ...base };
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return record;
}

describe("hashFlowDefinition — prototype-pollution canonicalization", () => {
  test("two definitions differing only under a nested __proto__ key hash differently", () => {
    // A plain `{}` accumulator's inherited `__proto__` SETTER would silently
    // swallow `canonical["__proto__"] = …` instead of creating an own
    // property, so `JSON.stringify` would omit it and these two definitions
    // — which differ only in a value nested under a genuine own `__proto__`
    // key — would collapse to the identical digest. `Object.create(null)` is
    // what keeps the assignment a real own property instead.
    const withoutPollution = buildStep("dump", {
      parameters: { command: "dump", output: "o.jsonl" },
    });
    const polluted = buildStep("dump", {
      parameters: withOwnKey(
        { command: "dump", output: "o.jsonl" },
        "__proto__",
        { payload: 1 },
      ),
    });
    expect(Object.hasOwn(polluted.parameters, "__proto__")).toBe(true);

    const first = hashFlowDefinition(
      buildDefinition({ steps: [withoutPollution] }),
    );
    const second = hashFlowDefinition(buildDefinition({ steps: [polluted] }));

    expect(first).not.toBe(second);
  });

  test("a definition with no dangerous key still hashes stably across two calls", () => {
    // Guards against the null-prototype accumulator perturbing ordinary
    // hashing: a ho-hum definition must still be perfectly reproducible.
    const definition = buildDefinition({
      steps: [
        buildStep("dump", {
          parameters: { command: "dump", output: "o.jsonl" },
        }),
      ],
    });

    expect(hashFlowDefinition(definition)).toBe(hashFlowDefinition(definition));
  });
});

describe("hashFlowDefinition — semantic sensitivity", () => {
  const baseline = hashFlowDefinition(buildDefinition());

  test.each([
    ["the flow name", buildDefinition({ name: "other-flow" })],
    ["the description", buildDefinition({ description: "changed" })],
    ["maxStepExecutions", buildDefinition({ maxStepExecutions: 13 })],
    [
      "a step's script",
      buildDefinition({
        steps: [
          buildStep("dump", { script: "dynamodb-crud" }),
          buildStep("reshape", { script: "json-etl" }),
        ],
      }),
    ],
    [
      "a step's id",
      buildDefinition({
        steps: [
          buildStep("drain"),
          buildStep("reshape", { script: "json-etl" }),
        ],
      }),
    ],
    [
      "a step's parameters",
      buildDefinition({
        steps: [
          buildStep("dump", { parameters: { command: "send" } }),
          buildStep("reshape", { script: "json-etl" }),
        ],
      }),
    ],
    [
      "a step's execution mode",
      buildDefinition({
        steps: [
          buildStep("dump", { execution: "in-process" }),
          buildStep("reshape", { script: "json-etl" }),
        ],
      }),
    ],
    [
      "a step's branch target",
      buildDefinition({
        steps: [
          buildStep("dump", { onFailure: { goto: "reshape" } }),
          buildStep("reshape", { script: "json-etl" }),
        ],
      }),
    ],
    [
      "a step's dryRun floor",
      buildDefinition({
        steps: [
          buildStep("dump", { dryRun: true }),
          buildStep("reshape", { script: "json-etl" }),
        ],
      }),
    ],
    [
      "the step ORDER",
      buildDefinition({
        steps: [
          buildStep("reshape", { script: "json-etl" }),
          buildStep("dump"),
        ],
      }),
    ],
    ["the step COUNT", buildDefinition({ steps: [buildStep("dump")] })],
  ])(
    "changing %s changes the hash",
    (_label, changed: M3LCliFlowDefinition) => {
      expect(hashFlowDefinition(changed)).not.toBe(baseline);
    },
  );
});

describe("buildFlowRunRecord", () => {
  test("assembles the full record from a run result and its definition", () => {
    const input = buildInput();

    const record = buildFlowRunRecord(input);

    expect(record).toEqual({
      kind: "m3l.flow.record",
      schemaVersion: 1,
      runId: "2026-09-01T09-00-00-000Z",
      flowName: "dlq-reconcile",
      definitionHash: hashFlowDefinition(input.definition),
      startedAt: "2026-09-01T09:00:00.000Z",
      finishedAt: "2026-09-01T09:12:30.500Z",
      status: "failed",
      exitCode: 4,
      stepExecutionCount: 3,
      haltingStepId: "dump",
      resumeStepId: "dump",
      stepExecutions: PERSISTED_STEP_EXECUTIONS,
    });
  });

  test("preserves the nested per-step-execution shape, including a { goto } branch", () => {
    const record = buildFlowRunRecord(buildInput());

    expect(record.stepExecutions).toHaveLength(3);
    expect(record.stepExecutions[1]).toEqual({
      stepId: "reshape",
      script: "json-etl",
      attempt: 1,
      exitCode: 6,
      outcome: "partial",
      reportPath: null,
      branch: { goto: "dump" },
    });
    expect(record.stepExecutions[2]?.attempt).toBe(2);
  });

  test("keeps the cumulative step-execution count even when it exceeds the recorded executions", () => {
    // A resumed run records only ITS OWN executions but the count stays
    // cumulative — that is what stops U11's resume from resetting the guard.
    const record = buildFlowRunRecord(
      buildInput({
        result: buildResult({
          stepExecutionCount: 9,
          stepExecutions: [DUMP_ATTEMPT_1],
        }),
      }),
    );

    expect(record.stepExecutionCount).toBe(9);
    expect(record.stepExecutions).toHaveLength(1);
  });

  test.each([
    ["completed"],
    ["stopped"],
    ["failed"],
    ["loop-guard-exceeded"],
  ] as const)(
    "carries the '%s' status verbatim",
    (status: M3LCliFlowRunStatus) => {
      const record = buildFlowRunRecord(
        buildInput({ result: buildResult({ status }) }),
      );

      expect(record.status).toBe(status);
    },
  );

  test("carries null halting and resume step ids through unchanged", () => {
    const record = buildFlowRunRecord(
      buildInput({
        result: buildResult({
          status: "completed",
          exitCode: 0,
          haltingStepId: null,
          resumeStepId: null,
        }),
      }),
    );

    expect(record.haltingStepId).toBeNull();
    expect(record.resumeStepId).toBeNull();
  });

  test("performs no filesystem access", () => {
    const writeSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => undefined);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("{}");

    buildFlowRunRecord(buildInput());

    expect(writeSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });
});

describe("buildFlowRunRecord — projects the rich outcome onto the persisted seven fields", () => {
  test("the record's step executions are exactly the seven-field projection", () => {
    // `toEqual` (not `toMatchObject`) is the load-bearing choice: it fails on
    // an EXTRA defined key, so an over-eager implementation that persisted the
    // observed window cannot pass here.
    const record = buildFlowRunRecord(buildInput());

    expect(record.stepExecutions).toEqual(PERSISTED_STEP_EXECUTIONS);
  });

  test("does NOT persist startedAt, finishedAt or reportUnavailable", () => {
    const record = buildFlowRunRecord(buildInput());

    expect(record.stepExecutions).toHaveLength(3);
    for (const entry of record.stepExecutions) {
      expect(entry).not.toHaveProperty("startedAt");
      expect(entry).not.toHaveProperty("finishedAt");
      expect(entry).not.toHaveProperty("reportUnavailable");
    }
  });

  test("each entry's own keys are exactly the seven, in their declared order", () => {
    // Unsorted equality: `JSON.stringify` follows insertion order, so pinning
    // the order here pins the persisted BYTE order too.
    const record = buildFlowRunRecord(buildInput());

    for (const entry of record.stepExecutions) {
      expect(Object.keys(entry)).toEqual(PERSISTED_STEP_EXECUTION_KEYS);
    }
  });

  test("projects a step whose report was unavailable for a SPECIFIC reason without leaking it", () => {
    // `reshape` observed `"report-malformed"`. That reason belongs to the
    // nested `--json` envelope (`flow/envelope.ts` reconstructs its `lookup`
    // from it), never to the resume ledger.
    const record = buildFlowRunRecord(
      buildInput({
        result: buildResult({
          stepExecutionCount: 1,
          stepExecutions: [RESHAPE_ATTEMPT_1],
        }),
      }),
    );

    expect(record.stepExecutions).toEqual([
      {
        stepId: "reshape",
        script: "json-etl",
        attempt: 1,
        exitCode: 6,
        outcome: "partial",
        reportPath: null,
        branch: { goto: "dump" },
      },
    ]);
  });

  test("the projected entries are fresh objects, not the caller's outcomes", () => {
    // A projection that returned the SAME array would let a later mutation of
    // the in-memory result reach an already-built record.
    const result = buildResult();
    const record = buildFlowRunRecord(buildInput({ result }));

    expect(record.stepExecutions).not.toBe(result.stepExecutions);
    expect(record.stepExecutions[0]).not.toBe(DUMP_ATTEMPT_1);
  });

  test("the record stays JSON-safe: no Date survives the projection", () => {
    // The run's OWN window is stringified at the top level; the per-step
    // windows are dropped entirely. Either way nothing nested may be a `Date`.
    const record = buildFlowRunRecord(buildInput());

    expect(typeof record.startedAt).toBe("string");
    expect(typeof record.finishedAt).toBe("string");
    for (const entry of record.stepExecutions) {
      for (const value of Object.values(entry)) {
        expect(value).not.toBeInstanceOf(Date);
      }
    }
  });
});

describe("writeFlowRunRecord — the persisted bytes are unchanged by the split", () => {
  test("the written step executions keep the seven fields in their declared order", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    let written = "";
    vi.spyOn(fs, "writeFileSync").mockImplementation((_path, contents) => {
      written = typeof contents === "string" ? contents : "";
    });

    writeFlowRunRecord(RECORD_PATH, buildFlowRunRecord(buildInput()));

    const parsed = JSON.parse(written) as M3LCliFlowRunRecord;
    expect(parsed.stepExecutions).toEqual(PERSISTED_STEP_EXECUTIONS);
    for (const entry of parsed.stepExecutions) {
      expect(Object.keys(entry)).toEqual(PERSISTED_STEP_EXECUTION_KEYS);
    }
  });

  test("the word 'reportUnavailable' appears nowhere in the written bytes", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    let written = "";
    vi.spyOn(fs, "writeFileSync").mockImplementation((_path, contents) => {
      written = typeof contents === "string" ? contents : "";
    });

    writeFlowRunRecord(RECORD_PATH, buildFlowRunRecord(buildInput()));

    expect(written).not.toContain("reportUnavailable");
  });

  test("'startedAt' and 'finishedAt' each appear exactly once — the RUN's own window", () => {
    // Three executions each leaking a window would make these appear four
    // times. A plain `not.toContain` cannot express this: both keys are
    // legitimately present at the record's top level.
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    let written = "";
    vi.spyOn(fs, "writeFileSync").mockImplementation((_path, contents) => {
      written = typeof contents === "string" ? contents : "";
    });

    writeFlowRunRecord(RECORD_PATH, buildFlowRunRecord(buildInput()));

    expect(written.split('"startedAt"')).toHaveLength(2);
    expect(written.split('"finishedAt"')).toHaveLength(2);
  });

  test("the top-level key order is unchanged, stepExecutions last", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    let written = "";
    vi.spyOn(fs, "writeFileSync").mockImplementation((_path, contents) => {
      written = typeof contents === "string" ? contents : "";
    });

    writeFlowRunRecord(RECORD_PATH, buildFlowRunRecord(buildInput()));

    expect(Object.keys(JSON.parse(written) as M3LCliFlowRunRecord)).toEqual([
      "kind",
      "schemaVersion",
      "runId",
      "flowName",
      "definitionHash",
      "startedAt",
      "finishedAt",
      "status",
      "exitCode",
      "stepExecutionCount",
      "haltingStepId",
      "resumeStepId",
      "stepExecutions",
    ]);
  });
});

describe("writeFlowRunRecord — the happy path", () => {
  test("creates the parent directory and writes pretty-printed JSON", () => {
    const mkdirSpy = vi
      .spyOn(fs, "mkdirSync")
      .mockImplementation(() => undefined);
    const writeSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => undefined);
    const record = buildFlowRunRecord(buildInput());

    writeFlowRunRecord(RECORD_PATH, record);

    expect(mkdirSpy).toHaveBeenCalledWith(
      "/workspace/data/cache/m3l-cli/flows",
      { recursive: true },
    );
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [path, contents, encoding] = writeSpy.mock.calls[0] ?? [];
    expect(path).toBe(RECORD_PATH);
    expect(encoding).toBe("utf8");
    expect(typeof contents).toBe("string");
    const written: unknown = JSON.parse(
      typeof contents === "string" ? contents : "",
    );
    expect(written).toEqual(record);
  });

  test("the written bytes round-trip the nested step executions exactly", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    let written = "";
    vi.spyOn(fs, "writeFileSync").mockImplementation((_path, contents) => {
      written = typeof contents === "string" ? contents : "";
    });
    const record = buildFlowRunRecord(buildInput());

    writeFlowRunRecord(RECORD_PATH, record);

    const parsed: unknown = JSON.parse(written);
    expect(parsed).toMatchObject({
      kind: "m3l.flow.record",
      schemaVersion: 1,
      stepExecutions: PERSISTED_STEP_EXECUTIONS,
    });
  });
});

describe("writeFlowRunRecord — LOUD failures (the opposite of history/store)", () => {
  test("throws ERR_CLI_FLOW_RECORD_WRITE_FAILED when the write fails, chaining the cause", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const cause = errnoError("EACCES");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw cause;
    });
    const record = buildFlowRunRecord(buildInput());

    let thrown: unknown;
    try {
      writeFlowRunRecord(RECORD_PATH, record);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe(
      "ERR_CLI_FLOW_RECORD_WRITE_FAILED",
    );
    expect((thrown as M3LCliError).cause).toBe(cause);
  });

  test("throws ERR_CLI_FLOW_RECORD_WRITE_FAILED when the directory cannot be created", () => {
    const cause = errnoError("EROFS");
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw cause;
    });
    const writeSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => undefined);

    expect(() =>
      writeFlowRunRecord(RECORD_PATH, buildFlowRunRecord(buildInput())),
    ).toThrow(M3LCliError);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("does NOT degrade a write failure to a boolean return", () => {
    // `history/store.ts`'s `recordHistoryEntry` returns `false` on failure
    // because history is a diagnostic convenience. The run record is not: a
    // lost record makes U11's resume impossible, so the failure must reach the
    // caller. Pinned as a type-level guarantee too, below.
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw errnoError("ENOSPC");
    });

    expect(() =>
      writeFlowRunRecord(RECORD_PATH, buildFlowRunRecord(buildInput())),
    ).toThrow(M3LCliError);
  });

  test("returns void on success", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    expect(
      writeFlowRunRecord(RECORD_PATH, buildFlowRunRecord(buildInput())),
    ).toBeUndefined();
  });
});

describe("readFlowRunRecord", () => {
  test("parses a well-formed record file back into the typed record", () => {
    const record = buildFlowRunRecord(buildInput());
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(record));

    expect(readFlowRunRecord(RECORD_PATH)).toEqual(record);
  });

  test("returns undefined when the file does not exist (ENOENT) — a first run has no record", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw errnoError("ENOENT");
    });

    expect(readFlowRunRecord(RECORD_PATH)).toBeUndefined();
  });

  test("throws ERR_CLI_FLOW_RECORD_INVALID for a non-ENOENT read failure, chaining the cause", () => {
    const cause = errnoError("EACCES");
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw cause;
    });

    let thrown: unknown;
    try {
      readFlowRunRecord(RECORD_PATH);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_FLOW_RECORD_INVALID");
    expect((thrown as M3LCliError).cause).toBe(cause);
  });

  test("throws ERR_CLI_FLOW_RECORD_INVALID for malformed JSON", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("{not json");

    expect(() => readFlowRunRecord(RECORD_PATH)).toThrow(M3LCliError);
  });

  test.each([
    ["a JSON array", "[]"],
    ["a JSON scalar", '"nope"'],
    ["null", "null"],
  ])(
    "throws ERR_CLI_FLOW_RECORD_INVALID for %s",
    (_label, contents: string) => {
      vi.spyOn(fs, "readFileSync").mockReturnValue(contents);

      let thrown: unknown;
      try {
        readFlowRunRecord(RECORD_PATH);
      } catch (error) {
        thrown = error;
      }

      expect((thrown as M3LCliError).code).toBe("ERR_CLI_FLOW_RECORD_INVALID");
    },
  );

  test("throws ERR_CLI_FLOW_RECORD_INVALID when a required field is missing", () => {
    const { definitionHash: _dropped, ...withoutHash } =
      buildFlowRunRecord(buildInput());
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(withoutHash));

    expect(() => readFlowRunRecord(RECORD_PATH)).toThrow(M3LCliError);
  });

  test("throws ERR_CLI_FLOW_RECORD_INVALID when a step execution is malformed", () => {
    // One bad nested entry invalidates the whole record: unlike history, this
    // file cannot be partially trusted — a dropped step execution would make
    // the cumulative count and the recorded executions disagree, and U11 would
    // resume from a wrong place.
    const record = buildFlowRunRecord(buildInput());
    const corrupted = {
      ...record,
      stepExecutions: [{ stepId: "dump", script: "sqs-etl" }],
    };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(corrupted));

    expect(() => readFlowRunRecord(RECORD_PATH)).toThrow(M3LCliError);
  });

  test("throws ERR_CLI_FLOW_RECORD_INVALID on an unrecognized schemaVersion", () => {
    const record = buildFlowRunRecord(buildInput());
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ ...record, schemaVersion: 2 }),
    );

    expect(() => readFlowRunRecord(RECORD_PATH)).toThrow(M3LCliError);
  });

  test("does NOT degrade a malformed record to an empty result", () => {
    // `history/store.ts`'s `readHistory` returns `[]` on every failure mode.
    // The run record must not: silently reading "no record" out of a corrupt
    // file would make U11 restart a flow it should have refused to resume.
    vi.spyOn(fs, "readFileSync").mockReturnValue("{}");

    expect(() => readFlowRunRecord(RECORD_PATH)).toThrow(M3LCliError);
  });
});

/*
 * A JSON-text fixture can never carry a literal `NaN`, `-1`, or `1.5` for a
 * field the real writer only ever emits as a valid non-negative integer — but
 * `isNonNegativeInteger` has to defend the READ path against a record that
 * was hand-edited, produced by a future writer bug, or corrupted on disk.
 * `JSON.parse` itself cannot produce `NaN` from any valid JSON text (there is
 * no such token), so these fixtures spy on the global `JSON.parse` to hand
 * `readFlowRunRecord` an already-parsed value carrying the bad number
 * directly — the same seam the module itself reads from, one call deeper.
 */
const VALID_RECORD_FOR_NUMERIC_FIXTURES = buildFlowRunRecord(buildInput());

const VALID_STEP_EXECUTION_FOR_NUMERIC_FIXTURES: M3LCliFlowStepExecution = {
  stepId: "dump",
  script: "sqs-etl",
  attempt: 1,
  exitCode: 0,
  outcome: "success",
  reportPath: null,
  branch: "continue",
};

/** One mutator per numeric field this module validates on read. */
const NUMERIC_FIELD_MUTATIONS: readonly (readonly [
  label: string,
  mutate: (value: number) => unknown,
])[] = [
  [
    "record-level exitCode",
    (value) => ({ ...VALID_RECORD_FOR_NUMERIC_FIXTURES, exitCode: value }),
  ],
  [
    "record-level stepExecutionCount",
    (value) => ({
      ...VALID_RECORD_FOR_NUMERIC_FIXTURES,
      stepExecutionCount: value,
    }),
  ],
  [
    "a step execution's attempt",
    (value) => ({
      ...VALID_RECORD_FOR_NUMERIC_FIXTURES,
      stepExecutions: [
        { ...VALID_STEP_EXECUTION_FOR_NUMERIC_FIXTURES, attempt: value },
      ],
    }),
  ],
  [
    "a step execution's exitCode",
    (value) => ({
      ...VALID_RECORD_FOR_NUMERIC_FIXTURES,
      stepExecutions: [
        { ...VALID_STEP_EXECUTION_FOR_NUMERIC_FIXTURES, exitCode: value },
      ],
    }),
  ],
];

describe("readFlowRunRecord — rejects a negative or fractional numeric field", () => {
  test.each(
    NUMERIC_FIELD_MUTATIONS.flatMap(([label, mutate]) => [
      [`${label} is negative`, mutate(-1)] as const,
      [`${label} is fractional`, mutate(1.5)] as const,
    ]),
  )("rejects when %s", (_label, corrupted) => {
    vi.spyOn(JSON, "parse").mockReturnValueOnce(corrupted);
    vi.spyOn(fs, "readFileSync").mockReturnValue("ignored");

    let thrown: unknown;
    try {
      readFlowRunRecord(RECORD_PATH);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_FLOW_RECORD_INVALID");
  });
});

describe("readFlowRunRecord — rejects NaN specifically", () => {
  // `NaN` gets its own block, not a row in the table above: `typeof NaN ===
  // "number"` is `true`, so a bare `typeof` check lets it through. That is
  // not cosmetic for `stepExecutionCount` — it seeds `run.ts`'s loop guard
  // (`stepExecutionCount >= definition.maxStepExecutions`), and `NaN >= 50`
  // evaluates to `false`, so a record carrying `NaN` there would make the
  // loop guard never trip at all. The other three fields share the same
  // `isNonNegativeInteger` guard, so they are pinned here too.
  test("rejects a record whose stepExecutionCount is NaN — the loop guard would never trip", () => {
    vi.spyOn(JSON, "parse").mockReturnValueOnce({
      ...VALID_RECORD_FOR_NUMERIC_FIXTURES,
      stepExecutionCount: NaN,
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("ignored");

    expect(() => readFlowRunRecord(RECORD_PATH)).toThrow(M3LCliError);
  });

  test("rejects a record whose exitCode is NaN", () => {
    vi.spyOn(JSON, "parse").mockReturnValueOnce({
      ...VALID_RECORD_FOR_NUMERIC_FIXTURES,
      exitCode: NaN,
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("ignored");

    expect(() => readFlowRunRecord(RECORD_PATH)).toThrow(M3LCliError);
  });

  test("rejects a step execution whose attempt is NaN", () => {
    vi.spyOn(JSON, "parse").mockReturnValueOnce({
      ...VALID_RECORD_FOR_NUMERIC_FIXTURES,
      stepExecutions: [
        { ...VALID_STEP_EXECUTION_FOR_NUMERIC_FIXTURES, attempt: NaN },
      ],
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("ignored");

    expect(() => readFlowRunRecord(RECORD_PATH)).toThrow(M3LCliError);
  });

  test("rejects a step execution whose exitCode is NaN", () => {
    vi.spyOn(JSON, "parse").mockReturnValueOnce({
      ...VALID_RECORD_FOR_NUMERIC_FIXTURES,
      stepExecutions: [
        { ...VALID_STEP_EXECUTION_FOR_NUMERIC_FIXTURES, exitCode: NaN },
      ],
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("ignored");

    expect(() => readFlowRunRecord(RECORD_PATH)).toThrow(M3LCliError);
  });
});

describe("readFlowRunRecord — projects an object-form branch onto exactly { goto }", () => {
  test("strips an unrecognized key from a { goto, extra } branch", () => {
    const validRecord = buildFlowRunRecord(
      buildInput({
        result: buildResult({
          stepExecutionCount: 1,
          stepExecutions: [DUMP_ATTEMPT_1],
        }),
      }),
    );
    const stepExecutionWithExtraBranchKey = {
      stepId: "dump",
      script: "sqs-etl",
      attempt: 1,
      exitCode: 0,
      outcome: "success",
      reportPath: "/workspace/data/output/a/run-report.json",
      branch: { goto: "dump", extra: 1 },
    };

    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        ...validRecord,
        stepExecutions: [stepExecutionWithExtraBranchKey],
      }),
    );

    const read = readFlowRunRecord(RECORD_PATH);

    // `toEqual`, not `toMatchObject`: an implementation that persisted the
    // parsed branch object unchanged would carry `extra` along, and
    // `toMatchObject` would pass regardless — this assertion must fail then.
    expect(read?.stepExecutions[0]?.branch).toEqual({ goto: "dump" });
  });

  test.each(["continue", "stop"] as const)(
    "round-trips the '%s' string-form branch unchanged",
    (branch) => {
      const record = buildFlowRunRecord(
        buildInput({
          result: buildResult({
            stepExecutionCount: 1,
            stepExecutions: [{ ...DUMP_ATTEMPT_1, branch }],
          }),
        }),
      );
      vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(record));

      const read = readFlowRunRecord(RECORD_PATH);

      expect(read?.stepExecutions[0]?.branch).toBe(branch);
    },
  );
});

describe("flow/record — types", () => {
  test("the record's declared shape", () => {
    expectTypeOf<M3LCliFlowRunRecord>().toEqualTypeOf<{
      readonly kind: "m3l.flow.record";
      readonly schemaVersion: 1;
      readonly runId: string;
      readonly flowName: string;
      readonly definitionHash: string;
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly status: M3LCliFlowRunStatus;
      readonly exitCode: number;
      readonly stepExecutionCount: number;
      readonly haltingStepId: string | null;
      readonly resumeStepId: string | null;
      readonly stepExecutions: readonly M3LCliFlowStepExecution[];
    }>();
  });

  test("the builder input names the run id, the definition, and the run result", () => {
    expectTypeOf<M3LCliFlowRunRecordInput>().toEqualTypeOf<{
      readonly runId: string;
      readonly definition: M3LCliFlowDefinition;
      readonly result: M3LCliFlowRunResult;
    }>();
  });

  test("hashFlowDefinition is a pure definition -> string function", () => {
    expectTypeOf(hashFlowDefinition).toEqualTypeOf<
      (definition: M3LCliFlowDefinition) => string
    >();
  });

  test("writeFlowRunRecord returns void — never a success boolean", () => {
    expectTypeOf(writeFlowRunRecord).toEqualTypeOf<
      (recordFilePath: string, record: M3LCliFlowRunRecord) => void
    >();
  });

  test("readFlowRunRecord returns the record or undefined — never an empty fallback", () => {
    expectTypeOf(readFlowRunRecord).toEqualTypeOf<
      (recordFilePath: string) => M3LCliFlowRunRecord | undefined
    >();
  });

  test("buildFlowRunRecord is a pure input -> record function", () => {
    expectTypeOf(buildFlowRunRecord).toEqualTypeOf<
      (input: M3LCliFlowRunRecordInput) => M3LCliFlowRunRecord
    >();
  });
});
