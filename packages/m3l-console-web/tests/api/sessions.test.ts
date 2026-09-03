import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  M3LConsoleFetchError,
  M3LConsoleFetchResult,
} from "../../src/api/client.js";
import { fetchConsoleJson } from "../../src/api/client.js";
import type {
  M3LSessionBindingInput,
  M3LSessionBindingRecord,
  M3LSessionDecisionRecord,
  M3LSessionRecord,
  M3LSessionStepSummary,
} from "../../src/api/sessions.js";
import {
  answerSessionDecision,
  createSession,
  createSessionBinding,
  fetchSession,
  fetchSessionDecisions,
  fetchSessions,
  fetchSessionStepArtifact,
  fetchSessionSteps,
} from "../../src/api/sessions.js";

vi.mock("../../src/api/client.js", () => ({
  fetchConsoleJson: vi.fn(),
}));

const mockedFetchConsoleJson = vi.mocked(fetchConsoleJson);

afterEach(() => {
  mockedFetchConsoleJson.mockReset();
});

// Nullable fields serialise as `null`, never as an absent key — every
// fixture below spells them out rather than omitting them, per
// Core.safeJsonStringify's documented never-omit behaviour.
const openSession: M3LSessionRecord = {
  id: "session-1",
  operator: "alice",
  correlationId: "corr-open-1",
  status: "open",
  createdAtMs: 1_735_689_600_000,
  updatedAtMs: 1_735_689_600_000,
};

const closedSession: M3LSessionRecord = {
  id: "session-2",
  operator: "bob",
  correlationId: "corr-closed-1",
  status: "closed",
  createdAtMs: 1_735_689_600_000,
  updatedAtMs: 1_735_689_601_000,
  closedAtMs: 1_735_689_602_000,
};

describe("fetchSessions", () => {
  test("calls fetchConsoleJson with exactly /api/v1/sessions", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: [] });

    await fetchSessions();

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith("/api/v1/sessions");
  });

  test("resolves to the ok result with well-formed open and closed records, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<readonly M3LSessionRecord[]> = {
      ok: true,
      data: [openSession, closedSession],
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchSessions()).resolves.toEqual(okResult);
  });

  test("resolves to an empty list unchanged — no sessions yet is not malformed", async () => {
    const okResult: M3LConsoleFetchResult<readonly M3LSessionRecord[]> = {
      ok: true,
      data: [],
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchSessions()).resolves.toEqual(okResult);
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "network",
      message: "connection refused",
    };
    const errorResult: M3LConsoleFetchResult<readonly M3LSessionRecord[]> = {
      ok: false,
      error,
    };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(fetchSessions()).resolves.toEqual(errorResult);
  });

  test("downgrades a non-array ok body to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: {} });

    await expect(fetchSessions()).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades an array with a malformed element (unrecognised status) to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: [openSession, { ...closedSession, status: "bogus" }],
    });

    await expect(fetchSessions()).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  // [KNOWN GAP] isM3LSessionRecord returns true unconditionally once
  // status !== "closed", never checking closedAtMs is actually ABSENT on
  // an "open" record — even though the type declares `closedAtMs?: never`
  // on that branch. An open record impossibly carrying a numeric
  // closedAtMs (which the store's own CHECK constraint forbids) must be
  // rejected, not silently accepted.
  test("downgrades an array containing an open record that also carries a numeric closedAtMs to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: [{ ...openSession, closedAtMs: 123 }],
    });

    await expect(fetchSessions()).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });
});

describe("fetchSession", () => {
  test("calls fetchConsoleJson with the id encoded into the path", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: openSession });

    await fetchSession("has/slash");

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/sessions/${encodeURIComponent("has/slash")}`,
    );
  });

  test("resolves to the ok result with a well-formed record, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<M3LSessionRecord> = {
      ok: true,
      data: closedSession,
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchSession(closedSession.id)).resolves.toEqual(okResult);
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "http",
      message: "not found",
      status: 404,
    };
    const errorResult: M3LConsoleFetchResult<M3LSessionRecord> = {
      ok: false,
      error,
    };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(fetchSession("missing-id")).resolves.toEqual(errorResult);
  });

  test("downgrades a non-object ok body to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: null });

    await expect(fetchSession(openSession.id)).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a record missing a required field to a malformed-body error", async () => {
    const { operator: _operator, ...withoutOperator } = openSession;
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: withoutOperator,
    });

    await expect(fetchSession(openSession.id)).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a closed record missing closedAtMs to a malformed-body error", async () => {
    const { closedAtMs: _closedAtMs, ...withoutClosedAtMs } = closedSession;
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: withoutClosedAtMs,
    });

    await expect(fetchSession(closedSession.id)).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  // [KNOWN GAP] isM3LSessionRecord returns true unconditionally once
  // status !== "closed", never checking closedAtMs is actually ABSENT on
  // an "open" record — even though the type declares `closedAtMs?: never`
  // on that branch. An open record impossibly carrying a numeric
  // closedAtMs (which the store's own CHECK constraint forbids) must be
  // rejected, not silently accepted.
  test("downgrades an open record that also carries a numeric closedAtMs to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { ...openSession, closedAtMs: 123 },
    });

    await expect(fetchSession(openSession.id)).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });
});

describe("createSession", () => {
  test("calls fetchConsoleJson with POST and no body key", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: openSession });

    await createSession();

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith("/api/v1/sessions", {
      method: "POST",
    });
    const [, init] = mockedFetchConsoleJson.mock.calls[0] ?? [];
    expect(init).toBeDefined();
    expect(init && "body" in init).toBe(false);
  });

  test("resolves to the ok result with the created (open) record, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<M3LSessionRecord> = {
      ok: true,
      data: openSession,
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(createSession()).resolves.toEqual(okResult);
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "http",
      message: "the open-session cap is reached",
      status: 429,
      code: "ERR_CONSOLE_SESSION_LIMIT_EXCEEDED",
    };
    const errorResult: M3LConsoleFetchResult<M3LSessionRecord> = {
      ok: false,
      error,
    };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(createSession()).resolves.toEqual(errorResult);
  });

  test("downgrades a 201 body missing operator to a malformed-body error", async () => {
    const { operator: _operator, ...withoutOperator } = openSession;
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: withoutOperator,
    });

    await expect(createSession()).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });
});

const queuedStep: M3LSessionStepSummary = {
  id: "step-1",
  sessionId: "session-1",
  ordinal: 1,
  operation: "sqs-etl",
  parameters: { mode: "batch" },
  runId: null,
  status: "queued",
  queuedAtMs: 1_735_689_600_000,
  startedAtMs: null,
  endedAtMs: null,
  outcome: null,
  failureMessage: null,
  hasResult: false,
};

const terminalStep: M3LSessionStepSummary = {
  id: "step-2",
  sessionId: "session-1",
  ordinal: 2,
  operation: "sqs-etl",
  parameters: { mode: "batch" },
  runId: "run-1",
  status: "success",
  queuedAtMs: 1_735_689_600_000,
  startedAtMs: 1_735_689_600_100,
  endedAtMs: 1_735_689_600_200,
  outcome: "success",
  failureMessage: null,
  hasResult: true,
};

describe("fetchSessionSteps", () => {
  test("calls fetchConsoleJson with the sessionId encoded into the path", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: [] });

    await fetchSessionSteps("has/slash");

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/sessions/${encodeURIComponent("has/slash")}/steps`,
    );
  });

  test("resolves to the ok result with a queued step (all nullable fields null) and a terminal step, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<readonly M3LSessionStepSummary[]> = {
      ok: true,
      data: [queuedStep, terminalStep],
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    const result = await fetchSessionSteps("session-1");

    expect(result).toEqual(okResult);
    // hasResult must be read as a plain boolean on both steps.
    if (result.ok) {
      expect(result.data[0]?.hasResult).toBe(false);
      expect(result.data[1]?.hasResult).toBe(true);
      // The contract's step summary type carries no resultRef field at all.
      expect(
        result.data.every(
          (step: M3LSessionStepSummary) => !("resultRef" in step),
        ),
      ).toBe(true);
    }
  });

  test("resolves to an empty list unchanged — no steps yet is not malformed", async () => {
    const okResult: M3LConsoleFetchResult<readonly M3LSessionStepSummary[]> = {
      ok: true,
      data: [],
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchSessionSteps("session-1")).resolves.toEqual(okResult);
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "http",
      message: "not found",
      status: 404,
      code: "ERR_CONSOLE_SESSION_NOT_FOUND",
    };
    const errorResult: M3LConsoleFetchResult<readonly M3LSessionStepSummary[]> =
      {
        ok: false,
        error,
      };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(fetchSessionSteps("missing-id")).resolves.toEqual(errorResult);
  });

  test("downgrades an array with a malformed element (unrecognised status) to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: [{ ...queuedStep, status: "bogus" }],
    });

    await expect(fetchSessionSteps("session-1")).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  // The guard is permissive about extra keys, mirroring isM3LRunRecord's
  // pattern of only checking required fields — a step still carrying a
  // (now-redacted-server-side, but hypothetically present) resultRef key
  // alongside hasResult is accepted rather than rejected.
  test("accepts a step carrying an extra resultRef key alongside hasResult", async () => {
    const stepWithExtraKey = {
      ...terminalStep,
      resultRef: { kind: "inline", value: 42 },
    };
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: [stepWithExtraKey],
    });

    await expect(fetchSessionSteps("session-1")).resolves.toEqual({
      ok: true,
      data: [stepWithExtraKey],
    });
  });
});

const pendingDecisionWithOptions: M3LSessionDecisionRecord = {
  id: "decision-1",
  sessionId: "session-1",
  stepId: "step-1",
  prompt: "Continue to the next queue, or stop here?",
  options: ["continue", "stop"],
  createdAtMs: 1_735_689_600_000,
  status: "pending",
};

const pendingDecisionWithNullOptions: M3LSessionDecisionRecord = {
  id: "decision-2",
  sessionId: "session-1",
  stepId: "step-1",
  prompt: "Proceed with the DynamoDB query?",
  options: null,
  createdAtMs: 1_735_689_600_000,
  status: "pending",
};

const answeredDecision: M3LSessionDecisionRecord = {
  id: "decision-3",
  sessionId: "session-1",
  stepId: "step-1",
  prompt: "Proceed with the DynamoDB query?",
  options: ["continue", "stop"],
  createdAtMs: 1_735_689_600_000,
  status: "answered",
  answer: "continue",
  answeredAtMs: 1_735_689_601_000,
};

describe("fetchSessionDecisions", () => {
  test("calls fetchConsoleJson with the sessionId encoded into the path", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: [] });

    await fetchSessionDecisions("has/slash");

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/sessions/${encodeURIComponent("has/slash")}/decisions`,
    );
  });

  test("resolves to the ok result with a pending decision (array options) and an answered decision, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<readonly M3LSessionDecisionRecord[]> =
      {
        ok: true,
        data: [pendingDecisionWithOptions, answeredDecision],
      };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchSessionDecisions("session-1")).resolves.toEqual(okResult);
  });

  test("resolves to the ok result with a pending decision whose options is null, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<readonly M3LSessionDecisionRecord[]> =
      {
        ok: true,
        data: [pendingDecisionWithNullOptions],
      };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchSessionDecisions("session-1")).resolves.toEqual(okResult);
  });

  test("resolves to an empty list unchanged — no decisions yet is not malformed", async () => {
    const okResult: M3LConsoleFetchResult<readonly M3LSessionDecisionRecord[]> =
      {
        ok: true,
        data: [],
      };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(fetchSessionDecisions("session-1")).resolves.toEqual(okResult);
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "http",
      message: "not found",
      status: 404,
      code: "ERR_CONSOLE_SESSION_NOT_FOUND",
    };
    const errorResult: M3LConsoleFetchResult<
      readonly M3LSessionDecisionRecord[]
    > = {
      ok: false,
      error,
    };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(fetchSessionDecisions("missing-id")).resolves.toEqual(
      errorResult,
    );
  });

  test("downgrades an array with an element missing prompt to a malformed-body error", async () => {
    const { prompt: _prompt, ...withoutPrompt } = pendingDecisionWithOptions;
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: [withoutPrompt],
    });

    await expect(fetchSessionDecisions("session-1")).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  // [KNOWN GAP] isM3LSessionDecisionRecord returns true unconditionally
  // once status !== "answered", never checking answer/answeredAtMs are
  // actually ABSENT on a "pending" decision — even though the type
  // declares both `?: never` on that branch. A pending decision
  // impossibly carrying an answer must be rejected, not silently accepted.
  test("downgrades an array with a pending decision that also carries an answer field to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: [{ ...pendingDecisionWithOptions, answer: "continue" }],
    });

    await expect(fetchSessionDecisions("session-1")).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });
});

describe("fetchSessionStepArtifact", () => {
  test("calls fetchConsoleJson with the sessionId and stepId encoded into the path", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: 42 });

    await fetchSessionStepArtifact("has/slash", "also/slash");

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/sessions/${encodeURIComponent("has/slash")}/steps/${encodeURIComponent("also/slash")}/artifact`,
    );
  });

  test("resolves to the ok result with a primitive value, unchanged and unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<unknown> = { ok: true, data: 42 };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(
      fetchSessionStepArtifact("session-1", "step-1"),
    ).resolves.toEqual(okResult);
  });

  test("resolves to the ok result with an array value, unchanged and unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<unknown> = {
      ok: true,
      data: [1, 2, 3],
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(
      fetchSessionStepArtifact("session-1", "step-1"),
    ).resolves.toEqual(okResult);
  });

  test("resolves to the ok result with a null value, unchanged and unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<unknown> = { ok: true, data: null };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(
      fetchSessionStepArtifact("session-1", "step-1"),
    ).resolves.toEqual(okResult);
  });

  test("resolves to the ok result with a deeply nested object value, unchanged and unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<unknown> = {
      ok: true,
      data: { level1: { level2: { level3: ["deep", "value"] } } },
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(
      fetchSessionStepArtifact("session-1", "step-1"),
    ).resolves.toEqual(okResult);
  });

  // This function performs NO shape validation — unlike every other fetcher
  // in this file, which downgrades an unrecognised shape to a
  // malformed-body error. An arbitrary shape that would fail every other
  // guard here (no `id`, `status`, `operator`, etc.) must still round-trip
  // unchanged, because the artifact's shape depends entirely on the
  // operation that produced it and this function cannot (and must not
  // pretend to) know it.
  test("resolves an arbitrary shape unchanged with no shape validation applied", async () => {
    const okResult: M3LConsoleFetchResult<unknown> = {
      ok: true,
      data: { arbitrary: "shape" },
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(
      fetchSessionStepArtifact("session-1", "step-1"),
    ).resolves.toEqual({ ok: true, data: { arbitrary: "shape" } });
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "http",
      message: "not found",
      status: 404,
      code: "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
    };
    const errorResult: M3LConsoleFetchResult<unknown> = { ok: false, error };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(
      fetchSessionStepArtifact("session-1", "missing-step"),
    ).resolves.toEqual(errorResult);
  });
});

const fullBindingInput: M3LSessionBindingInput = {
  reference: "input.orderId",
  expectedType: "string",
  multiSelect: false,
  parameterName: "orderId",
};

const fullBindingRecord: M3LSessionBindingRecord = {
  id: "binding-1",
  sessionId: "session-1",
  reference: "input.orderId",
  expectedType: "string",
  multiSelect: false,
  createdAtMs: 1_735_689_600_000,
  parameterName: "orderId",
};

describe("createSessionBinding", () => {
  test("calls fetchConsoleJson with the sessionId encoded into the path, POST, and the input as the body unchanged", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: fullBindingRecord,
    });

    await createSessionBinding("has/slash", fullBindingInput);

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/sessions/${encodeURIComponent("has/slash")}/bindings`,
      { method: "POST", body: fullBindingInput },
    );
  });

  test("resolves to the ok result with a well-formed binding record (parameterName present), unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<M3LSessionBindingRecord> = {
      ok: true,
      data: fullBindingRecord,
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(
      createSessionBinding("session-1", fullBindingInput),
    ).resolves.toEqual(okResult);
  });

  // A pre-migration-v10 legacy row omits `parameterName` entirely — the key
  // is MISSING from the body, not present-and-null, per
  // JSON.stringify's undefined-valued-key-drop behaviour. This must still
  // validate successfully.
  test("validates a legacy record with parameterName entirely absent, resolving data.parameterName as undefined", async () => {
    const { parameterName: _parameterName, ...legacyBindingRecord } =
      fullBindingRecord;
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: legacyBindingRecord,
    });

    const result = await createSessionBinding("session-1", fullBindingInput);

    expect(result).toEqual({ ok: true, data: legacyBindingRecord });
    if (result.ok) {
      expect(result.data.parameterName).toBeUndefined();
    }
  });

  test("downgrades a record missing expectedType to a malformed-body error", async () => {
    const { expectedType: _expectedType, ...withoutExpectedType } =
      fullBindingRecord;
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: withoutExpectedType,
    });

    await expect(
      createSessionBinding("session-1", fullBindingInput),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a record with an expectedType outside the closed vocabulary to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { ...fullBindingRecord, expectedType: "not-a-real-type" },
    });

    await expect(
      createSessionBinding("session-1", fullBindingInput),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a record with multiSelect as a string instead of a boolean to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { ...fullBindingRecord, multiSelect: "false" },
    });

    await expect(
      createSessionBinding("session-1", fullBindingInput),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "http",
      message: "not found",
      status: 404,
      code: "ERR_CONSOLE_SESSION_NOT_FOUND",
    };
    const errorResult: M3LConsoleFetchResult<M3LSessionBindingRecord> = {
      ok: false,
      error,
    };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(
      createSessionBinding("missing-id", fullBindingInput),
    ).resolves.toEqual(errorResult);
  });
});

describe("answerSessionDecision", () => {
  test("calls fetchConsoleJson with both ids encoded into the path, POST, and { answer } as the body", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { applied: true },
    });

    await answerSessionDecision("has/slash", "also/slash", "continue");

    expect(mockedFetchConsoleJson).toHaveBeenCalledWith(
      `/api/v1/sessions/${encodeURIComponent("has/slash")}/decisions/${encodeURIComponent("also/slash")}`,
      { method: "POST", body: { answer: "continue" } },
    );
  });

  test("resolves to the ok result with applied: true, unwrapped", async () => {
    const okResult: M3LConsoleFetchResult<{ readonly applied: boolean }> = {
      ok: true,
      data: { applied: true },
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(
      answerSessionDecision("session-1", "decision-1", "continue"),
    ).resolves.toEqual(okResult);
  });

  // applied: false is a valid response shape (the decision was already
  // answered by an earlier call, so this submission's answer was not
  // recorded), not an error — it must pass through unchanged rather than
  // being downgraded.
  test("resolves to the ok result with applied: false, unwrapped (a valid shape, not an error)", async () => {
    const okResult: M3LConsoleFetchResult<{ readonly applied: boolean }> = {
      ok: true,
      data: { applied: false },
    };
    mockedFetchConsoleJson.mockResolvedValue(okResult);

    await expect(
      answerSessionDecision("session-1", "decision-1", "stop"),
    ).resolves.toEqual(okResult);
  });

  test("downgrades a body missing applied to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({ ok: true, data: {} });

    await expect(
      answerSessionDecision("session-1", "decision-1", "continue"),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("downgrades a body with applied as a non-boolean to a malformed-body error", async () => {
    mockedFetchConsoleJson.mockResolvedValue({
      ok: true,
      data: { applied: "true" },
    });

    await expect(
      answerSessionDecision("session-1", "decision-1", "continue"),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "malformed-body", message: expect.any(String) as string },
    });
  });

  test("resolves to the error result the mock returns, unwrapped", async () => {
    const error: M3LConsoleFetchError = {
      kind: "http",
      message: "not found",
      status: 404,
      code: "ERR_CONSOLE_SESSION_DECISION_NOT_FOUND",
    };
    const errorResult: M3LConsoleFetchResult<{ readonly applied: boolean }> = {
      ok: false,
      error,
    };
    mockedFetchConsoleJson.mockResolvedValue(errorResult);

    await expect(
      answerSessionDecision("session-1", "missing-decision", "continue"),
    ).resolves.toEqual(errorResult);
  });
});
