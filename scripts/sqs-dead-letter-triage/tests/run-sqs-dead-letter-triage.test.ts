import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

/**
 * Contract: `docs/reference/scripts/sqs-dead-letter-triage.md`'s
 * orchestrator/dispatcher, `runSqsDeadLetterTriage`
 * (`src/steps/run-sqs-dead-letter-triage.ts`) — the whole
 * `Core.M3LOperationPipeline` wiring for this slice: resolves settings from
 * config, guards each operation's required fields, and dispatches to
 * `validateRunbooks`/`explainRunbook`/`convertRunbook`. This file asserts
 * ONLY that wiring — never a step's internal logic, which is each step's
 * own test file's job (`validate-runbooks.test.ts`, `explain-runbook.test.ts`,
 * `convert-runbook.test.ts`).
 *
 * Unlike `scripts/ecs-ops`'s dispatcher (which dynamic-imports its step
 * modules inside the dispatch function), `run-sqs-dead-letter-triage.ts`
 * imports `validate-runbooks.js`/`explain-runbook.js`/`convert-runbook.js`
 * **statically** at the top of the file. Per the static-import mocking
 * gotcha, a plain top-level `const stepMock = vi.fn()` referenced from a
 * `vi.mock()` factory would throw "Cannot access before initialization" —
 * the factory runs eagerly, before the file's own top-level statements, the
 * moment the module graph is evaluated. The mocks below are built via
 * `vi.hoisted()` for exactly this reason.
 */

const {
  validateRunbooksMock,
  reportValidationMock,
  explainRunbookMock,
  convertRunbookMock,
  triageQueueMock,
  createDynamoDBLookupMock,
  buildTriageReportMock,
  logTriageReportMock,
  writeJsonArtifactMock,
} = vi.hoisted(() => ({
  validateRunbooksMock: vi.fn(),
  reportValidationMock: vi.fn(),
  explainRunbookMock: vi.fn(),
  convertRunbookMock: vi.fn(),
  triageQueueMock: vi.fn(),
  createDynamoDBLookupMock: vi.fn(),
  buildTriageReportMock: vi.fn(),
  logTriageReportMock: vi.fn(),
  writeJsonArtifactMock: vi.fn(),
}));

vi.mock("../src/steps/validate-runbooks.js", () => ({
  validateRunbooks: validateRunbooksMock,
  reportValidation: reportValidationMock,
}));
vi.mock("../src/steps/explain-runbook.js", () => ({
  explainRunbook: explainRunbookMock,
}));
vi.mock("../src/steps/convert-runbook.js", () => ({
  convertRunbook: convertRunbookMock,
}));
vi.mock("../src/steps/triage-queue.js", () => ({
  triageQueue: triageQueueMock,
}));
vi.mock("../src/steps/lookup-entity.js", () => ({
  createDynamoDBLookup: createDynamoDBLookupMock,
}));
vi.mock("../src/steps/report.js", () => ({
  buildTriageReport: buildTriageReportMock,
  logTriageReport: logTriageReportMock,
}));
vi.mock("../src/steps/write-artifact.js", () => ({
  writeJsonArtifact: writeJsonArtifactMock,
}));

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { runSqsDeadLetterTriage } from "../src/steps/run-sqs-dead-letter-triage.js";
import {
  createFakeDynamoDBOperations,
  createFakeSqsOperations,
} from "./support/aws-fakes.js";

const paths = new Core.M3LPaths();
const PRESET_CODE = "ERR_DLQ_TRIAGE_PRESET";

/**
 * Builds the full `RunTriageDeps` bag from a flat config-values record.
 * `sqs`/`dynamo` default to `undefined` — the legitimate no-credentials
 * state (`aws.profile` is declared but not `required: true`) — and a
 * caller exercising the `triage` dispatch path overrides them with fakes.
 */
function buildDeps(
  configValues: Record<string, unknown>,
  overrides: {
    readonly sqs?: AWS.M3LSQSOperations;
    readonly dynamo?: AWS.M3LDynamoDBOperations;
  } = {},
): Parameters<typeof runSqsDeadLetterTriage>[0] {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(configValues)) {
    config.set(key, value);
  }
  return {
    config,
    logger: new Core.M3LLogger([]),
    prompt: new Core.M3LPrompt(),
    paths,
    reader: new Core.M3LInputFileReader({ paths, code: PRESET_CODE }),
    sqs: overrides.sqs,
    dynamo: overrides.dynamo,
    signal: undefined,
  };
}

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies; it does not clear the
  // vi.hoisted() vi.fn()s above, whose call history/mockImplementation would
  // otherwise leak into the next test.
  vi.restoreAllMocks();
  validateRunbooksMock.mockReset();
  reportValidationMock.mockReset();
  explainRunbookMock.mockReset();
  convertRunbookMock.mockReset();
  triageQueueMock.mockReset();
  createDynamoDBLookupMock.mockReset();
  buildTriageReportMock.mockReset();
  logTriageReportMock.mockReset();
  writeJsonArtifactMock.mockReset();
});

describe("runSqsDeadLetterTriage — per-operation dispatch wiring", () => {
  test("dispatches 'validate' to validateRunbooks, then reportValidation with its summary", async () => {
    const summary = { checked: 2, problems: [] };
    validateRunbooksMock.mockResolvedValue(summary);
    const deps = buildDeps({ operation: "validate" });

    await runSqsDeadLetterTriage(deps);

    expect(validateRunbooksMock).toHaveBeenCalledWith({
      paths: deps.paths,
      reader: deps.reader,
      logger: deps.logger,
      runbookDir: "runbooks",
    });
    expect(reportValidationMock).toHaveBeenCalledWith(deps.logger, summary);
    expect(explainRunbookMock).not.toHaveBeenCalled();
    expect(convertRunbookMock).not.toHaveBeenCalled();
  });

  test("honours a non-default 'runbookDir' when dispatching 'validate'", async () => {
    validateRunbooksMock.mockResolvedValue({ checked: 0, problems: [] });
    const deps = buildDeps({ operation: "validate", runbookDir: "custom" });

    await runSqsDeadLetterTriage(deps);

    expect(validateRunbooksMock).toHaveBeenCalledWith(
      expect.objectContaining({ runbookDir: "custom" }),
    );
  });

  test("dispatches 'explain' to explainRunbook with the resolved runbookDir/queue", async () => {
    explainRunbookMock.mockResolvedValue({
      name: "sqs-dead-letter-triage:orders-dlq",
      revision: undefined,
      steps: [],
      cases: [],
      fallback: { description: "", prose: "" },
      parameters: [],
    });
    const deps = buildDeps({
      operation: "explain",
      queue: "orders-dlq",
      runbookDir: "custom-runbooks",
    });

    await runSqsDeadLetterTriage(deps);

    expect(explainRunbookMock).toHaveBeenCalledWith({
      reader: deps.reader,
      logger: deps.logger,
      runbookDir: "custom-runbooks",
      queue: "orders-dlq",
    });
    expect(validateRunbooksMock).not.toHaveBeenCalled();
    expect(convertRunbookMock).not.toHaveBeenCalled();
  });

  test("dispatches 'convert' to convertRunbook with source/queue/output settings", async () => {
    convertRunbookMock.mockResolvedValue({
      preset: {},
      todos: [],
      output: "custom.json",
    });
    const deps = buildDeps({
      operation: "convert",
      source: "runbooks/orders-dlq.md",
      queue: "orders-dlq",
      output: "custom.json",
    });

    await runSqsDeadLetterTriage(deps);

    expect(convertRunbookMock).toHaveBeenCalledWith({
      reader: deps.reader,
      paths: deps.paths,
      logger: deps.logger,
      source: "runbooks/orders-dlq.md",
      queue: "orders-dlq",
      output: "custom.json",
    });
    expect(validateRunbooksMock).not.toHaveBeenCalled();
    expect(explainRunbookMock).not.toHaveBeenCalled();
  });

  test("'convert' passes queue/output through as undefined when the config omits them", async () => {
    convertRunbookMock.mockResolvedValue({
      preset: {},
      todos: [],
      output: "orders-dlq.json",
    });
    const deps = buildDeps({
      operation: "convert",
      source: "runbooks/orders-dlq.md",
    });

    await runSqsDeadLetterTriage(deps);

    expect(convertRunbookMock).toHaveBeenCalledWith(
      expect.objectContaining({ queue: undefined, output: undefined }),
    );
  });
});

describe("runSqsDeadLetterTriage — unknown operation", () => {
  test("rejects an operation outside the declared set with ERR_DLQ_TRIAGE_CONFIG, dispatching nothing", async () => {
    const deps = buildDeps({ operation: "frobnicate" });

    await expect(runSqsDeadLetterTriage(deps)).rejects.toMatchObject({
      code: "ERR_DLQ_TRIAGE_CONFIG",
    });
    expect(validateRunbooksMock).not.toHaveBeenCalled();
    expect(explainRunbookMock).not.toHaveBeenCalled();
    expect(convertRunbookMock).not.toHaveBeenCalled();
  });
});

describe("runSqsDeadLetterTriage — per-operation required-field guards (reachable through normal config)", () => {
  test("throws ERR_DLQ_TRIAGE_CONFIG when 'explain' is missing 'queue', before dispatch", async () => {
    const deps = buildDeps({ operation: "explain" });

    await expect(runSqsDeadLetterTriage(deps)).rejects.toMatchObject({
      code: "ERR_DLQ_TRIAGE_CONFIG",
    });
    expect(explainRunbookMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DLQ_TRIAGE_CONFIG when 'convert' is missing 'source', before dispatch", async () => {
    const deps = buildDeps({ operation: "convert" });

    await expect(runSqsDeadLetterTriage(deps)).rejects.toMatchObject({
      code: "ERR_DLQ_TRIAGE_CONFIG",
    });
    expect(convertRunbookMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DLQ_TRIAGE_CONFIG when 'triage' is missing 'queueUrl', before dispatch", async () => {
    const deps = buildDeps(
      { operation: "triage", queue: "orders-dlq" },
      {
        sqs: createFakeSqsOperations(),
        dynamo: createFakeDynamoDBOperations(),
      },
    );

    await expect(runSqsDeadLetterTriage(deps)).rejects.toMatchObject({
      code: "ERR_DLQ_TRIAGE_CONFIG",
    });
    expect(triageQueueMock).not.toHaveBeenCalled();
  });
});

describe("runSqsDeadLetterTriage — 'triage' dispatch (drains, reports, writes the artifact)", () => {
  test("drains via triageQueue, builds/logs the report, and writes triage-<timestamp>.json", async () => {
    const sqs = createFakeSqsOperations();
    const dynamo = createFakeDynamoDBOperations();
    const lookup = { get: vi.fn() };
    createDynamoDBLookupMock.mockReturnValue(lookup);
    const triageResult = {
      queue: "orders-dlq",
      title: "Orders DLQ triage",
      depth: 1,
      archivePath: "orders-dlq/drain-2026-08-23T12-00-00.000Z.json",
      drained: 1,
      outcomes: [],
      messages: [{ messageId: "msg-1", body: "body" }],
      escalateTo: "orders-team",
      followUps: ["fu1"],
    };
    triageQueueMock.mockResolvedValue(triageResult);
    const report = {
      queue: "orders-dlq",
      generatedAt: "2026-08-23T12:00:00.000Z",
    };
    buildTriageReportMock.mockReturnValue(report);

    const deps = buildDeps(
      {
        operation: "triage",
        queue: "orders-dlq",
        queueUrl: "https://sqs.example/orders-dlq",
      },
      { sqs, dynamo },
    );

    await runSqsDeadLetterTriage(deps);

    expect(createDynamoDBLookupMock).toHaveBeenCalledWith({
      operations: dynamo,
      signal: undefined,
    });
    expect(triageQueueMock).toHaveBeenCalledWith({
      sqs,
      lookup,
      reader: deps.reader,
      paths: deps.paths,
      logger: deps.logger,
      runbookDir: "runbooks",
      queue: "orders-dlq",
      queueUrl: "https://sqs.example/orders-dlq",
      maxMessages: 100,
      visibilityTimeout: 1800,
      signal: undefined,
    });
    expect(buildTriageReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: triageResult,
        queueUrl: "https://sqs.example/orders-dlq",
        messages: triageResult.messages,
        escalateTo: triageResult.escalateTo,
        followUps: triageResult.followUps,
      }),
    );
    expect(logTriageReportMock).toHaveBeenCalledWith(deps.logger, report);
    expect(writeJsonArtifactMock).toHaveBeenCalledWith(
      deps.paths,
      "orders-dlq/triage-2026-08-23T12-00-00.000Z.json",
      report,
    );
  });
});

describe("runSqsDeadLetterTriage — 'triage' cancelled mid-drain", () => {
  // A trailing "aborted" outcome must still yield a written, logged report
  // for however many messages WERE triaged (partial evidence must survive
  // cancellation) — and only THEN throw M3LOperationAbortedError. An
  // orchestrator would otherwise see a resolved 'triage' as fully complete
  // even though the queue was only half-drained. Both halves are asserted:
  // the artifact write, and the throw.
  test("still builds/logs/writes the report, then throws M3LOperationAbortedError", async () => {
    const sqs = createFakeSqsOperations();
    const dynamo = createFakeDynamoDBOperations();
    const lookup = { get: vi.fn() };
    createDynamoDBLookupMock.mockReturnValue(lookup);
    const triageResult = {
      queue: "orders-dlq",
      title: "Orders DLQ triage",
      depth: 2,
      archivePath: "orders-dlq/drain-2026-08-23T12-00-00.000Z.json",
      drained: 2,
      outcomes: [
        { messageId: "msg-1", status: "matched", conclusion: {} },
        { messageId: "msg-2", status: "aborted", failure: "cancelled" },
      ],
      messages: [{ messageId: "msg-1", body: "body" }],
      escalateTo: "orders-team",
      followUps: [],
    };
    triageQueueMock.mockResolvedValue(triageResult);
    const report = {
      queue: "orders-dlq",
      generatedAt: "2026-08-23T12:00:00.000Z",
    };
    buildTriageReportMock.mockReturnValue(report);

    const deps = buildDeps(
      {
        operation: "triage",
        queue: "orders-dlq",
        queueUrl: "https://sqs.example/orders-dlq",
      },
      { sqs, dynamo },
    );

    await expect(runSqsDeadLetterTriage(deps)).rejects.toBeInstanceOf(
      Core.M3LOperationAbortedError,
    );

    expect(buildTriageReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ result: triageResult }),
    );
    expect(logTriageReportMock).toHaveBeenCalledWith(deps.logger, report);
    expect(writeJsonArtifactMock).toHaveBeenCalledWith(
      deps.paths,
      "orders-dlq/triage-2026-08-23T12-00-00.000Z.json",
      report,
    );
  });
});

describe("runSqsDeadLetterTriage — 'triage' with no AWS credentials configured", () => {
  // This is the whole reason `aws.profile` is declared without
  // `required: true` (`config.ts`): `sqs`/`dynamo` arrive `undefined`
  // exactly when `script.aws` was never provisioned, and `dispatchTriage`
  // must fail loud naming the parameter rather than crash on a missing
  // client.
  test("throws ERR_DLQ_TRIAGE_CONFIG naming aws.profile when sqs/dynamo are undefined", async () => {
    const deps = buildDeps({
      operation: "triage",
      queue: "orders-dlq",
      queueUrl: "https://sqs.example/orders-dlq",
    }); // sqs/dynamo default to undefined — the legitimate no-credentials state

    let thrown: unknown;
    try {
      await runSqsDeadLetterTriage(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DLQ_TRIAGE_CONFIG");
    expect((thrown as Core.M3LError).message).toContain(
      Core.AWS_PROFILE_PARAM_NAME,
    );
    expect(triageQueueMock).not.toHaveBeenCalled();
    expect(buildTriageReportMock).not.toHaveBeenCalled();
    expect(writeJsonArtifactMock).not.toHaveBeenCalled();
  });
});

describe("runSqsDeadLetterTriage — requireDefined defensive backstop", () => {
  // The pipeline's own Guards phase (`accessor.requiredFor`, driven by
  // REQUIRED_FIELDS) already rejects a missing 'queue' for 'explain' before
  // dispatch — see the "reachable through normal config" describe block
  // above — so dispatchExplain's own `requireDefined(settings.queue, ...)`
  // call is normally unreachable through the public entry point; its own
  // doc comment calls it "a type-narrowing safety net, not an expected
  // path." To exercise that backstop directly (per the review finding),
  // this test constructs the otherwise-unreachable state by stubbing
  // `Core.M3LConfigAccessor.prototype.requiredFor` to pass its value
  // through unchecked, silencing the Guards phase for this one call so
  // `settings.queue` can still be `undefined` when dispatchExplain runs.
  // requireDefined must then fail loud with the script's own config error
  // code, not a bare TypeError from reading `undefined` as a queue name.
  test("dispatchExplain's requireDefined throws ERR_DLQ_TRIAGE_CONFIG (not a TypeError) if the pipeline's own guard were ever bypassed", async () => {
    vi.spyOn(
      Core.M3LConfigAccessor.prototype,
      "requiredFor",
    ).mockImplementation((value: unknown) => value);
    const deps = buildDeps({ operation: "explain" }); // no 'queue' set

    let thrown: unknown;
    try {
      await runSqsDeadLetterTriage(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DLQ_TRIAGE_CONFIG");
    expect((thrown as Core.M3LError).message).toContain("queue");
    expect(explainRunbookMock).not.toHaveBeenCalled();
  });
});

describe("runSqsDeadLetterTriage — 'validate' problem propagation", () => {
  test("propagates reportValidation's throw when validate finds a problem (non-zero exit code)", async () => {
    validateRunbooksMock.mockResolvedValue({
      checked: 1,
      problems: [
        { preset: "runbooks/orders-dlq.json", code: "X", message: "bad" },
      ],
    });
    const thrownError = new Core.M3LError(
      "1 of 1 preset(s) failed validation",
      { code: "ERR_DLQ_TRIAGE_VALIDATE" },
    );
    reportValidationMock.mockImplementation(() => {
      throw thrownError;
    });
    const deps = buildDeps({ operation: "validate" });

    await expect(runSqsDeadLetterTriage(deps)).rejects.toBe(thrownError);
  });
});

describe("type contract", () => {
  test("runSqsDeadLetterTriage resolves void", () => {
    expectTypeOf(runSqsDeadLetterTriage).returns.toEqualTypeOf<Promise<void>>();
  });
});
