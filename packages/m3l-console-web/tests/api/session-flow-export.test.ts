import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  M3LConsoleFetchError,
  M3LConsoleFetchResult,
} from "../../src/api/client.js";
import { fetchConsoleJson } from "../../src/api/client.js";
import type {
  M3LSessionFlowExportRequest,
  M3LSessionFlowStepResult,
  M3LSessionFlowWriteResult,
} from "../../src/api/session-flow-export.js";
import { exportSessionAsFlow } from "../../src/api/session-flow-export.js";

// `exportSessionAsFlow` — X13 PR 6/6 (issue #561), the web client for
// `POST /api/v1/sessions/:id/flow-export`.

vi.mock("../../src/api/client.js", () => ({
  fetchConsoleJson: vi.fn(),
}));

const mockedFetchConsoleJson = vi.mocked(fetchConsoleJson);

afterEach(() => {
  mockedFetchConsoleJson.mockReset();
});

const fullRequest: M3LSessionFlowExportRequest = {
  name: "dlq-reconcile",
  description: "Reconciles the DLQ backlog",
  overwrite: false,
};

const fullResultStep: M3LSessionFlowStepResult = {
  stepId: "step-record-1",
  ordinal: 1,
  flowStepId: "step-1",
  script: "sqs-etl",
  outcome: "success",
  parameterReferences: { queueName: "step-1.output.Queues[0]" },
};

const fullResult: M3LSessionFlowWriteResult = {
  name: "dlq-reconcile",
  yaml: "name: dlq-reconcile\nsteps: []\n",
  steps: [fullResultStep],
  decisionsDropped: 0,
  path: "/data/config/flows/dlq-reconcile.yaml",
};

describe("exportSessionAsFlow", () => {
  test("calls fetchConsoleJson with the sessionId encoded into the path, POST, and the request as the body unchanged", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: fullResult });

    await exportSessionAsFlow("has/slash", fullRequest);

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/sessions/${encodeURIComponent("has/slash")}/flow-export`,
      { method: "POST", body: fullRequest },
    );
  });

  test("resolves to the ok result with a well-formed write result, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<M3LSessionFlowWriteResult> = {
      ok: true,
      data: fullResult,
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(
      exportSessionAsFlow("session-1", fullRequest),
    ).resolves.toEqual(okResult);
  });

  test("resolves to the ok result unchanged when steps is an empty array and decisionsDropped is 0", async () => {
    const emptyStepsResult: M3LSessionFlowWriteResult = {
      ...fullResult,
      steps: [],
      decisionsDropped: 0,
    };
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: emptyStepsResult,
    });

    await expect(
      exportSessionAsFlow("session-1", fullRequest),
    ).resolves.toEqual({ ok: true, data: emptyStepsResult });
  });

  test("downgrades a body missing path to a malformed-body error", async () => {
    const { path: _path, ...withoutPath } = fullResult;
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: withoutPath });

    await expect(
      exportSessionAsFlow("session-1", fullRequest),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a body missing yaml to a malformed-body error", async () => {
    const { yaml: _yaml, ...withoutYaml } = fullResult;
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: withoutYaml });

    await expect(
      exportSessionAsFlow("session-1", fullRequest),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a body whose steps array contains an element missing flowStepId to a malformed-body error", async () => {
    const { flowStepId: _flowStepId, ...stepWithoutFlowStepId } =
      fullResultStep;
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { ...fullResult, steps: [stepWithoutFlowStepId] },
    });

    await expect(
      exportSessionAsFlow("session-1", fullRequest),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a body with decisionsDropped as a non-number to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { ...fullResult, decisionsDropped: "0" },
    });

    await expect(
      exportSessionAsFlow("session-1", fullRequest),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "http",
      message: "a flow file already exists",
      status: 409,
      code: "ERR_CONSOLE_SESSION_FLOW_EXPORT_EXISTS",
    };
    const errorResult: M3LConsoleFetchResult<M3LSessionFlowWriteResult> = {
      ok: false,
      error,
    };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(
      exportSessionAsFlow("session-1", fullRequest),
    ).resolves.toEqual(errorResult);
  });

  test("a sessionId containing a character needing URL-encoding is correctly escaped in the request path", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: fullResult });

    await exportSessionAsFlow("also/slash?query", fullRequest);

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/sessions/${encodeURIComponent("also/slash?query")}/flow-export`,
      { method: "POST", body: fullRequest },
    );
  });
});
