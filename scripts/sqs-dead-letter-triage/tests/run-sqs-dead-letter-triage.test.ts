import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type * as ValidateRunbooksModule from "../src/steps/validate-runbooks.js";
import type * as ExplainRunbookModule from "../src/steps/explain-runbook.js";
import type * as ConvertRunbookModule from "../src/steps/convert-runbook.js";
import type * as TriageQueueModule from "../src/steps/triage-queue.js";
import type * as LookupEntityModule from "../src/steps/lookup-entity.js";
import type * as ReportModule from "../src/steps/report.js";
import type * as WriteArtifactModule from "../src/steps/write-artifact.js";
import type * as LoadRunbookModule from "../src/steps/load-runbook.js";

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
  loadRunbookMock,
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
  loadRunbookMock: vi.fn(),
}));

// Every factory below preserves the module's real (non-mocked) exports via
// `importOriginal` rather than a plain object literal. `explain-runbook.js`
// is the concrete case that bit: `dispatchExecute` picked up a *second*,
// unmocked static import (`presetPathFor`) from a module this file already
// mocks for `explainRunbook`, and a plain-literal factory silently resolved
// it to `undefined` at module-load time, dying before a single test could
// register. The same latent gap exists on every module below that exports
// more than the one function each test stubs (`convertMarkdown`,
// `TRIAGE_CODE`, `PRESET_EXTENSION`/`parseTriagePreset`/`listRunbooks`, etc.)
// — none of it is imported by production code today, but the
// `importOriginal` form means the next added static import can't repeat
// this failure mode silently.
vi.mock("../src/steps/validate-runbooks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ValidateRunbooksModule>()),
  validateRunbooks: validateRunbooksMock,
  reportValidation: reportValidationMock,
}));
vi.mock("../src/steps/explain-runbook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ExplainRunbookModule>()),
  explainRunbook: explainRunbookMock,
}));
vi.mock("../src/steps/convert-runbook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConvertRunbookModule>()),
  convertRunbook: convertRunbookMock,
}));
vi.mock("../src/steps/triage-queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TriageQueueModule>()),
  triageQueue: triageQueueMock,
}));
vi.mock("../src/steps/lookup-entity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LookupEntityModule>()),
  createDynamoDBLookup: createDynamoDBLookupMock,
}));
vi.mock("../src/steps/report.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ReportModule>()),
  buildTriageReport: buildTriageReportMock,
  logTriageReport: logTriageReportMock,
}));
vi.mock("../src/steps/write-artifact.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WriteArtifactModule>()),
  writeJsonArtifact: writeJsonArtifactMock,
}));
// PR 3b's `execute` dispatch needs a `TriagePreset` (fifo/groupIdPath/
// orderBy/sourceQueue) that `TriageQueueResult` does not carry — mocked
// pre-emptively in case `dispatchExecute` re-loads it via `loadRunbook`,
// same as `triage-queue.ts` itself does. Harmless if the real
// implementation threads the preset through some other seam instead: an
// unused mock, never asserted on directly.
vi.mock("../src/steps/load-runbook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LoadRunbookModule>()),
  loadRunbook: loadRunbookMock,
}));
// `execute-actions.js` (buildExecutePlan/logExecutePlan/applyActions) is
// DELIBERATELY left un-mocked in this file: the "zero SQS mutations" gate
// tests below need the REAL `applyActions` running against the injected
// fake `AWS.M3LSQSOperations`, so that an implementation which mutates
// despite `apply: false`/a declined gate is actually caught at the fake's
// `sendBatch`/`deleteBatch` call sites — a mocked `applyActions` would make
// that assertion vacuously true regardless of the gate's correctness.

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { runSqsDeadLetterTriage } from "../src/steps/run-sqs-dead-letter-triage.js";
import {
  createFakeDynamoDBOperations,
  createFakeSqsOperations,
} from "./support/aws-fakes.js";
import {
  baseReportRow,
  baseTriageReport,
  basePreset,
} from "./support/preset-fixtures.js";

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
    readonly prompt?: Core.M3LPrompt;
    /**
     * The resolved AWS identity, mirroring `script.awsTarget`
     * (`core/script/M3LScript.ts`) — `undefined` unless a PR 3b 'execute'
     * gate test overrides it, matching every other operation's legitimate
     * no-target state.
     */
    readonly awsTarget?: Core.M3LDestructiveTarget;
    /**
     * The `M3LScript.reportRecovery` stand-in — a plain `vi.fn()` by
     * default so a test asserting on it (the `reportRecovery` describe
     * block below) can pass its own and inspect calls after the run.
     */
    readonly reportRecovery?: (entry: Core.M3LRunRecoveryEntry) => void;
  } = {},
): Parameters<typeof runSqsDeadLetterTriage>[0] {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(configValues)) {
    config.set(key, value);
  }
  return {
    config,
    logger: new Core.M3LLogger([]),
    prompt: overrides.prompt ?? new Core.M3LPrompt(),
    paths,
    reader: new Core.M3LInputFileReader({ paths, code: PRESET_CODE }),
    sqs: overrides.sqs,
    dynamo: overrides.dynamo,
    signal: undefined,
    awsTarget: overrides.awsTarget,
    reportRecovery: overrides.reportRecovery ?? vi.fn(),
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
  loadRunbookMock.mockReset();
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

describe("runSqsDeadLetterTriage — 'execute' dispatch: plan vs. apply, and the destructive gate (PR 3b)", () => {
  const EXECUTE_MESSAGE_ID = "msg-1";
  const EXECUTE_CODE = "ERR_DLQ_TRIAGE_EXECUTE";

  /**
   * A report with exactly one 'remove'-verdict row — a real, un-mocked
   * `buildExecutePlan` turns this into one 'drop' action, and a real
   * `applyActions` turns that into one `deleteBatch` call IF (and only if)
   * the gate actually let execution proceed. This is what makes the
   * "zero mutations" assertions below meaningful rather than vacuous.
   */
  function setupTriageMocks(): void {
    triageQueueMock.mockResolvedValue({
      queue: "orders-dlq",
      title: "Orders DLQ triage",
      depth: 1,
      archivePath: "orders-dlq/drain-2026-08-23T12-00-00.000Z.json",
      drained: 1,
      outcomes: [],
      messages: [{ messageId: EXECUTE_MESSAGE_ID, body: "body" }],
      escalateTo: "orders-team",
      followUps: [],
      preset: basePreset(),
    });
    buildTriageReportMock.mockReturnValue(
      baseTriageReport({
        queue: "orders-dlq",
        rows: [
          baseReportRow({ messageId: EXECUTE_MESSAGE_ID, verdict: "remove" }),
        ],
      }),
    );
    loadRunbookMock.mockResolvedValue(basePreset({ fifo: false }));
  }

  /** A fake SQS whose `receive` re-serves `EXECUTE_MESSAGE_ID` exactly once, then empties out. */
  function buildExecuteSqs(): {
    readonly sqs: AWS.M3LSQSOperations;
    readonly deleteBatch: ReturnType<typeof vi.fn>;
    readonly sendBatch: ReturnType<typeof vi.fn>;
  } {
    const receive = vi
      .fn()
      .mockResolvedValueOnce([
        { messageId: EXECUTE_MESSAGE_ID, receiptHandle: "rh-1", body: "body" },
      ])
      .mockResolvedValue([]);
    const deleteBatch = vi.fn().mockResolvedValue({
      successful: [{ id: EXECUTE_MESSAGE_ID }],
      failed: [],
    });
    const sendBatch = vi.fn().mockResolvedValue({ successful: [], failed: [] });
    const sqs = createFakeSqsOperations({ receive, sendBatch, deleteBatch });
    return { sqs, deleteBatch, sendBatch };
  }

  function buildExecuteDeps(
    configValues: Record<string, unknown>,
    overrides: {
      readonly sqs: AWS.M3LSQSOperations;
      readonly prompt?: Core.M3LPrompt;
      readonly awsTarget?: Core.M3LDestructiveTarget;
      readonly reportRecovery?: (entry: Core.M3LRunRecoveryEntry) => void;
    },
  ): Parameters<typeof runSqsDeadLetterTriage>[0] {
    return buildDeps(
      {
        operation: "execute",
        queue: "orders-dlq",
        queueUrl: "https://sqs.example/orders-dlq",
        ...configValues,
      },
      {
        sqs: overrides.sqs,
        dynamo: createFakeDynamoDBOperations(),
        ...(overrides.prompt !== undefined && { prompt: overrides.prompt }),
        ...(overrides.awsTarget !== undefined && {
          awsTarget: overrides.awsTarget,
        }),
        ...(overrides.reportRecovery !== undefined && {
          reportRecovery: overrides.reportRecovery,
        }),
      },
    );
  }

  test("apply: false prints the plan and performs zero SQS mutations", async () => {
    setupTriageMocks();
    const { sqs, deleteBatch, sendBatch } = buildExecuteSqs();
    const deps = buildExecuteDeps({ apply: false }, { sqs });

    await runSqsDeadLetterTriage(deps);

    expect(triageQueueMock).toHaveBeenCalled();
    expect(buildTriageReportMock).toHaveBeenCalled();
    expect(deleteBatch).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
  });

  // Review round 2, MUST-FIX 6: without a resolved AWS identity,
  // `confirmDestructive` would take its ungraded no-`target` path, and
  // `--yes` alone would delete production messages with no prompt at all.
  // This guard must fire BEFORE the triage pass even runs.
  test("'execute --apply' throws ERR_DLQ_TRIAGE_EXECUTE naming aws.profile when awsTarget is undefined, before any triage pass or mutation", async () => {
    setupTriageMocks();
    const { sqs, deleteBatch, sendBatch } = buildExecuteSqs();
    const deps = buildExecuteDeps(
      { apply: true, yes: true, yesSensitive: true },
      { sqs }, // no awsTarget override — stays undefined
    );

    let thrown: unknown;
    try {
      await runSqsDeadLetterTriage(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(EXECUTE_CODE);
    expect(triageQueueMock).not.toHaveBeenCalled();
    expect(deleteBatch).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
  });

  // Every resolved target is now unconditionally treated as sensitive
  // (review round 2, MUST-FIX 7 — the library never populates
  // `M3LDestructiveTarget.accountId`, so an account-keyed allow-list could
  // never fire). Declining is therefore always the escalated typed-echo
  // path (`prompt.text`), never the plain yes/no `confirm`.
  test("declining the escalated typed-echo prompt aborts (ERR_DLQ_TRIAGE_EXECUTE) and performs zero mutations", async () => {
    setupTriageMocks();
    const { sqs, deleteBatch, sendBatch } = buildExecuteSqs();
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm");
    vi.spyOn(prompt, "text").mockResolvedValue("not-the-right-profile");
    const deps = buildExecuteDeps(
      { apply: true },
      { sqs, prompt, awsTarget: { profile: "dev" } },
    );

    await expect(runSqsDeadLetterTriage(deps)).rejects.toMatchObject({
      code: EXECUTE_CODE,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(triageQueueMock).toHaveBeenCalled();
    expect(deleteBatch).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
  });

  test("yes: true alone still escalates to the typed-echo prompt (every target is sensitive) and applies once confirmed", async () => {
    setupTriageMocks();
    const { sqs, deleteBatch } = buildExecuteSqs();
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm");
    const text = vi.spyOn(prompt, "text").mockResolvedValue("dev");
    const deps = buildExecuteDeps(
      { apply: true, yes: true },
      { sqs, prompt, awsTarget: { profile: "dev" } },
    );

    await runSqsDeadLetterTriage(deps);

    expect(text).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteBatch).toHaveBeenCalled();
  });

  test("a target with no region/accountId at all is still treated as sensitive and escalates", async () => {
    setupTriageMocks();
    const { sqs, deleteBatch } = buildExecuteSqs();
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm");
    const text = vi.spyOn(prompt, "text").mockResolvedValue("prod");
    const deps = buildExecuteDeps(
      { apply: true, yes: true },
      // No `region`/`accountId` on the target at all.
      { sqs, prompt, awsTarget: { profile: "prod" } },
    );

    await runSqsDeadLetterTriage(deps);

    expect(text).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteBatch).toHaveBeenCalled();
  });

  test("yesSensitive: true (with yes: true) bypasses the escalated prompt entirely — no prompt call at all", async () => {
    setupTriageMocks();
    const { sqs, deleteBatch } = buildExecuteSqs();
    const prompt = new Core.M3LPrompt();
    const confirm = vi.spyOn(prompt, "confirm");
    const text = vi.spyOn(prompt, "text");
    const deps = buildExecuteDeps(
      { apply: true, yes: true, yesSensitive: true },
      { sqs, prompt, awsTarget: { profile: "prod" } },
    );

    await runSqsDeadLetterTriage(deps);

    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(deleteBatch).toHaveBeenCalled();
  });
});

describe("runSqsDeadLetterTriage — 'execute' cancellation (mid-drain abort during the triage pass)", () => {
  const CANCEL_MESSAGE_ID = "msg-1";

  /** Sets up a triage pass whose last outcome is `"aborted"` — the operator cancelled mid-drain. */
  function setupAbortedTriageMocks(): void {
    triageQueueMock.mockResolvedValue({
      queue: "orders-dlq",
      title: "Orders DLQ triage",
      depth: 2,
      archivePath: "orders-dlq/drain-2026-08-23T12-00-00.000Z.json",
      drained: 2,
      outcomes: [
        { messageId: CANCEL_MESSAGE_ID, status: "matched", conclusion: {} },
        { messageId: "msg-2", status: "aborted", failure: "cancelled" },
      ],
      messages: [{ messageId: CANCEL_MESSAGE_ID, body: "body" }],
      escalateTo: "orders-team",
      followUps: [],
      preset: basePreset(),
    });
    buildTriageReportMock.mockReturnValue(
      baseTriageReport({
        queue: "orders-dlq",
        rows: [
          baseReportRow({ messageId: CANCEL_MESSAGE_ID, verdict: "remove" }),
        ],
      }),
    );
  }

  test("plan-only (apply: false): rejects with M3LOperationAbortedError rather than printing a plan built on partial evidence", async () => {
    setupAbortedTriageMocks();
    const deps = buildDeps(
      {
        operation: "execute",
        queue: "orders-dlq",
        queueUrl: "https://sqs.example/orders-dlq",
        apply: false,
      },
      {
        sqs: createFakeSqsOperations(),
        dynamo: createFakeDynamoDBOperations(),
      },
    );

    await expect(runSqsDeadLetterTriage(deps)).rejects.toBeInstanceOf(
      Core.M3LOperationAbortedError,
    );
  });

  // The half that matters: not just that `--apply` also throws, but that a
  // cancelled triage pass never reaches the destructive gate or any SQS
  // mutation — asserting only the throw would miss a build that mutated on
  // partial, cancelled evidence before rejecting.
  test("--apply: rejects with M3LOperationAbortedError AND performs zero SQS mutations", async () => {
    setupAbortedTriageMocks();
    const deleteBatch = vi.fn().mockResolvedValue({
      successful: [{ id: CANCEL_MESSAGE_ID }],
      failed: [],
    });
    const sendBatch = vi.fn().mockResolvedValue({ successful: [], failed: [] });
    const sqs = createFakeSqsOperations({
      receive: vi
        .fn()
        .mockResolvedValueOnce([
          { messageId: CANCEL_MESSAGE_ID, receiptHandle: "rh-1", body: "body" },
        ])
        .mockResolvedValue([]),
      sendBatch,
      deleteBatch,
    });
    const deps = buildDeps(
      {
        operation: "execute",
        queue: "orders-dlq",
        queueUrl: "https://sqs.example/orders-dlq",
        apply: true,
        yes: true,
        yesSensitive: true,
      },
      {
        sqs,
        dynamo: createFakeDynamoDBOperations(),
        awsTarget: { profile: "dev" },
      },
    );

    let thrown: unknown;
    try {
      await runSqsDeadLetterTriage(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LOperationAbortedError);
    expect(deleteBatch).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
  });
});

describe("runSqsDeadLetterTriage — 'execute --apply' sourceQueueUrl guard (review round 2, MUST-FIX 10)", () => {
  const REINSERT_MESSAGE_ID = "msg-r1";
  const EXECUTE_CODE = "ERR_DLQ_TRIAGE_EXECUTE";
  const DLQ_URL = "https://sqs.us-east-1.amazonaws.com/111111111111/orders-dlq";

  /** A triage pass yielding exactly one 'reinsert'-verdict row, carrying `preset`. */
  function setupReinsertTriageMocks(
    preset: ReturnType<typeof basePreset>,
  ): void {
    triageQueueMock.mockResolvedValue({
      queue: "orders-dlq",
      title: "Orders DLQ triage",
      depth: 1,
      archivePath: "orders-dlq/drain-2026-08-23T12-00-00.000Z.json",
      drained: 1,
      outcomes: [],
      messages: [{ messageId: REINSERT_MESSAGE_ID, body: "body" }],
      escalateTo: "orders-team",
      followUps: [],
      preset,
    });
    buildTriageReportMock.mockReturnValue(
      baseTriageReport({
        queue: "orders-dlq",
        rows: [
          baseReportRow({
            messageId: REINSERT_MESSAGE_ID,
            verdict: "reinsert",
          }),
        ],
      }),
    );
  }

  /**
   * `yes`/`yesSensitive` both `true` bypasses the destructive gate with no
   * prompt call at all (state 3), isolating these tests to the
   * `resolveSourceQueueUrl` guard that runs immediately after it.
   */
  function buildGuardDeps(
    configValues: Record<string, unknown>,
  ): Parameters<typeof runSqsDeadLetterTriage>[0] {
    return buildDeps(
      {
        operation: "execute",
        queue: "orders-dlq",
        queueUrl: DLQ_URL,
        apply: true,
        yes: true,
        yesSensitive: true,
        ...configValues,
      },
      {
        sqs: createFakeSqsOperations(),
        dynamo: createFakeDynamoDBOperations(),
        awsTarget: { profile: "dev" },
      },
    );
  }

  test("throws EXECUTE_CODE when the plan needs a reinsert but no sourceQueueUrl was supplied", async () => {
    setupReinsertTriageMocks(basePreset({ sourceQueue: "orders-inbound" }));
    const deps = buildGuardDeps({});

    await expect(runSqsDeadLetterTriage(deps)).rejects.toMatchObject({
      code: EXECUTE_CODE,
    });
  });

  test("throws EXECUTE_CODE when the supplied URL's queue name does not match preset.sourceQueue", async () => {
    setupReinsertTriageMocks(basePreset({ sourceQueue: "orders-inbound" }));
    const deps = buildGuardDeps({
      sourceQueueUrl:
        "https://sqs.us-east-1.amazonaws.com/111111111111/wrong-queue",
    });

    await expect(runSqsDeadLetterTriage(deps)).rejects.toMatchObject({
      code: EXECUTE_CODE,
    });
  });

  test("throws EXECUTE_CODE when the supplied URL resolves to a different AWS account than the dead-letter queue", async () => {
    setupReinsertTriageMocks(basePreset({ sourceQueue: "orders-inbound" }));
    const deps = buildGuardDeps({
      sourceQueueUrl:
        "https://sqs.us-east-1.amazonaws.com/222222222222/orders-inbound",
    });

    await expect(runSqsDeadLetterTriage(deps)).rejects.toMatchObject({
      code: EXECUTE_CODE,
    });
  });

  test("throws EXECUTE_CODE when the supplied URL resolves to a different AWS region than the dead-letter queue", async () => {
    setupReinsertTriageMocks(basePreset({ sourceQueue: "orders-inbound" }));
    const deps = buildGuardDeps({
      sourceQueueUrl:
        "https://sqs.eu-west-1.amazonaws.com/111111111111/orders-inbound",
    });

    await expect(runSqsDeadLetterTriage(deps)).rejects.toMatchObject({
      code: EXECUTE_CODE,
    });
  });

  // The vacuous half of decision 1's contract: a plan that never needs
  // `sourceQueueUrl` (no 'reinsert' planned) must resolve normally even
  // when `preset.sourceQueue` is undefined too — an operator triaging a
  // queue that yields no reinserts must never be forced to declare one.
  test("[vacuous] a plan with no reinsert never requires sourceQueueUrl, even when preset.sourceQueue is undefined", async () => {
    triageQueueMock.mockResolvedValue({
      queue: "orders-dlq",
      title: "Orders DLQ triage",
      depth: 1,
      archivePath: "orders-dlq/drain-2026-08-23T12-00-00.000Z.json",
      drained: 1,
      outcomes: [],
      messages: [{ messageId: "msg-1", body: "body" }],
      escalateTo: "orders-team",
      followUps: [],
      preset: basePreset({ sourceQueue: undefined }),
    });
    buildTriageReportMock.mockReturnValue(
      baseTriageReport({
        queue: "orders-dlq",
        rows: [baseReportRow({ messageId: "msg-1", verdict: "remove" })],
      }),
    );
    const deleteBatch = vi.fn().mockResolvedValue({
      successful: [{ id: "msg-1" }],
      failed: [],
    });
    const sqs = createFakeSqsOperations({
      receive: vi
        .fn()
        .mockResolvedValueOnce([
          { messageId: "msg-1", receiptHandle: "rh-1", body: "body" },
        ])
        .mockResolvedValue([]),
      deleteBatch,
    });
    const deps = buildDeps(
      {
        operation: "execute",
        queue: "orders-dlq",
        queueUrl: DLQ_URL,
        apply: true,
        yes: true,
        yesSensitive: true,
      },
      {
        sqs,
        dynamo: createFakeDynamoDBOperations(),
        awsTarget: { profile: "dev" },
      },
    );

    await runSqsDeadLetterTriage(deps);

    expect(deleteBatch).toHaveBeenCalled();
  });
});

describe("runSqsDeadLetterTriage — 'execute --apply' reportRecovery (review round 2, MUST-FIX 2)", () => {
  const FAIL_MESSAGE_ID = "msg-1";

  function setupRemovePlanTriageMocks(): void {
    triageQueueMock.mockResolvedValue({
      queue: "orders-dlq",
      title: "Orders DLQ triage",
      depth: 1,
      archivePath: "orders-dlq/drain-2026-08-23T12-00-00.000Z.json",
      drained: 1,
      outcomes: [],
      messages: [{ messageId: FAIL_MESSAGE_ID, body: "body" }],
      escalateTo: "orders-team",
      followUps: [],
      preset: basePreset(),
    });
    buildTriageReportMock.mockReturnValue(
      baseTriageReport({
        queue: "orders-dlq",
        rows: [
          baseReportRow({ messageId: FAIL_MESSAGE_ID, verdict: "remove" }),
        ],
      }),
    );
  }

  test("reports one recovery entry per ApplyResult.failed element (demotes the run to 'partial')", async () => {
    setupRemovePlanTriageMocks();
    const deleteBatch = vi.fn().mockResolvedValue({
      successful: [],
      failed: [
        {
          entry: { id: FAIL_MESSAGE_ID, receiptHandle: "rh-1" },
          code: "ReceiptHandleIsInvalid",
          senderFault: true,
          message: "handle expired",
        },
      ],
    });
    const sqs = createFakeSqsOperations({
      receive: vi
        .fn()
        .mockResolvedValueOnce([
          { messageId: FAIL_MESSAGE_ID, receiptHandle: "rh-1", body: "body" },
        ])
        .mockResolvedValue([]),
      deleteBatch,
    });
    const reportRecovery = vi.fn();
    const deps = buildDeps(
      {
        operation: "execute",
        queue: "orders-dlq",
        queueUrl: "https://sqs.example/orders-dlq",
        apply: true,
        yes: true,
        yesSensitive: true,
      },
      {
        sqs,
        dynamo: createFakeDynamoDBOperations(),
        awsTarget: { profile: "dev" },
        reportRecovery,
      },
    );

    await runSqsDeadLetterTriage(deps);

    expect(reportRecovery).toHaveBeenCalledTimes(1);
    expect(reportRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ item: FAIL_MESSAGE_ID }),
    );
  });

  test("reports nothing when ApplyResult.failed is empty", async () => {
    setupRemovePlanTriageMocks();
    const deleteBatch = vi.fn().mockResolvedValue({
      successful: [{ id: FAIL_MESSAGE_ID }],
      failed: [],
    });
    const sqs = createFakeSqsOperations({
      receive: vi
        .fn()
        .mockResolvedValueOnce([
          { messageId: FAIL_MESSAGE_ID, receiptHandle: "rh-1", body: "body" },
        ])
        .mockResolvedValue([]),
      deleteBatch,
    });
    const reportRecovery = vi.fn();
    const deps = buildDeps(
      {
        operation: "execute",
        queue: "orders-dlq",
        queueUrl: "https://sqs.example/orders-dlq",
        apply: true,
        yes: true,
        yesSensitive: true,
      },
      {
        sqs,
        dynamo: createFakeDynamoDBOperations(),
        awsTarget: { profile: "dev" },
        reportRecovery,
      },
    );

    await runSqsDeadLetterTriage(deps);

    expect(reportRecovery).not.toHaveBeenCalled();
  });

  test("reports one recovery entry per failed AND per skipped ApplyResult entry in the same run", async () => {
    // With handle reuse (`ApplyActionsDeps.messages`), a `skipped` entry is
    // structurally near-impossible in production — every planned messageId
    // comes from the very drain that produced `messages`. This fixture
    // still produces one, the same way every other test in this describe
    // block already decouples the drain's `messages` from the report's
    // `rows` (two independent mocks, `triageQueueMock` and
    // `buildTriageReportMock`, never tied together for real): `msg-2` is
    // planned by the mocked report but absent from the mocked drain's
    // `messages`, so `applyActions` cannot find a held message for it.
    const SKIPPED_MESSAGE_ID = "msg-2";
    triageQueueMock.mockResolvedValue({
      queue: "orders-dlq",
      title: "Orders DLQ triage",
      depth: 1,
      archivePath: "orders-dlq/drain-2026-08-23T12-00-00.000Z.json",
      drained: 1,
      outcomes: [],
      messages: [{ messageId: FAIL_MESSAGE_ID, body: "body" }],
      escalateTo: "orders-team",
      followUps: [],
      preset: basePreset(),
    });
    buildTriageReportMock.mockReturnValue(
      baseTriageReport({
        queue: "orders-dlq",
        rows: [
          baseReportRow({ messageId: FAIL_MESSAGE_ID, verdict: "remove" }),
          baseReportRow({ messageId: SKIPPED_MESSAGE_ID, verdict: "remove" }),
        ],
      }),
    );
    const deleteBatch = vi.fn().mockResolvedValue({
      successful: [],
      failed: [
        {
          entry: { id: FAIL_MESSAGE_ID, receiptHandle: "rh-1" },
          code: "ReceiptHandleIsInvalid",
          senderFault: true,
          message: "handle expired",
        },
      ],
    });
    const sqs = createFakeSqsOperations({ deleteBatch });
    const reportRecovery = vi.fn();
    const deps = buildDeps(
      {
        operation: "execute",
        queue: "orders-dlq",
        queueUrl: "https://sqs.example/orders-dlq",
        apply: true,
        yes: true,
        yesSensitive: true,
      },
      {
        sqs,
        dynamo: createFakeDynamoDBOperations(),
        awsTarget: { profile: "dev" },
        reportRecovery,
      },
    );

    await runSqsDeadLetterTriage(deps);

    expect(reportRecovery).toHaveBeenCalledTimes(2);
    expect(reportRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ item: FAIL_MESSAGE_ID }),
    );
    expect(reportRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ item: SKIPPED_MESSAGE_ID }),
    );
  });
});

describe("type contract", () => {
  test("runSqsDeadLetterTriage resolves void", () => {
    expectTypeOf(runSqsDeadLetterTriage).returns.toEqualTypeOf<Promise<void>>();
  });
});
