import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { M3LConsoleFetchResult } from "../../src/api/client.js";
import type {
  M3LSessionDecisionRecord,
  M3LSessionRecord,
  M3LSessionStepSummary,
} from "../../src/api/sessions.js";
import { SessionDetail } from "../../src/components/SessionDetail.js";

function okFetchSession(
  session: M3LSessionRecord,
): (id: string) => Promise<M3LConsoleFetchResult<M3LSessionRecord>> {
  return () => Promise.resolve({ ok: true, data: session });
}

function errorFetchSession(
  message: string,
): (id: string) => Promise<M3LConsoleFetchResult<M3LSessionRecord>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

function okFetchSessionSteps(
  steps: readonly M3LSessionStepSummary[],
): (
  id: string,
) => Promise<M3LConsoleFetchResult<readonly M3LSessionStepSummary[]>> {
  return () => Promise.resolve({ ok: true, data: steps });
}

function errorFetchSessionSteps(
  message: string,
): (
  id: string,
) => Promise<M3LConsoleFetchResult<readonly M3LSessionStepSummary[]>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

function okFetchSessionDecisions(
  decisions: readonly M3LSessionDecisionRecord[],
): (
  id: string,
) => Promise<M3LConsoleFetchResult<readonly M3LSessionDecisionRecord[]>> {
  return () => Promise.resolve({ ok: true, data: decisions });
}

function errorFetchSessionDecisions(
  message: string,
): (
  id: string,
) => Promise<M3LConsoleFetchResult<readonly M3LSessionDecisionRecord[]>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

const OPEN_SESSION: M3LSessionRecord = {
  id: "session-123",
  operator: "boot-operator",
  correlationId: "corr-1",
  status: "open",
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_000_000,
};

const CLOSED_SESSION: M3LSessionRecord = {
  id: "session-456",
  operator: "boot-operator",
  correlationId: "corr-2",
  status: "closed",
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_005_000,
  closedAtMs: 1_700_000_005_000,
};

const QUEUED_STEP: M3LSessionStepSummary = {
  id: "step-1",
  sessionId: "session-123",
  ordinal: 1,
  operation: "sqs-etl",
  parameters: { mode: "batch" },
  runId: null,
  status: "queued",
  queuedAtMs: 1_700_000_000_000,
  startedAtMs: null,
  endedAtMs: null,
  outcome: null,
  failureMessage: null,
  hasResult: false,
};

const TERMINAL_STEP: M3LSessionStepSummary = {
  id: "step-2",
  sessionId: "session-123",
  ordinal: 2,
  operation: "sqs-etl",
  parameters: { mode: "batch" },
  runId: "run-1",
  status: "success",
  queuedAtMs: 1_700_000_000_000,
  startedAtMs: 1_700_000_000_100,
  endedAtMs: 1_700_000_000_200,
  outcome: "success",
  failureMessage: null,
  hasResult: true,
};

const PENDING_DECISION: M3LSessionDecisionRecord = {
  id: "decision-1",
  sessionId: "session-123",
  stepId: "step-1",
  prompt: "Continue?",
  options: ["continue", "stop"],
  createdAtMs: 1_700_000_000_000,
  status: "pending",
};

const ANSWERED_DECISION: M3LSessionDecisionRecord = {
  id: "decision-2",
  sessionId: "session-123",
  stepId: "step-1",
  prompt: "Proceed?",
  options: null,
  createdAtMs: 1_700_000_000_000,
  status: "answered",
  answer: "yes",
  answeredAtMs: 1_700_000_000_500,
};

describe("SessionDetail", () => {
  test("renders a loading state synchronously on mount", () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    const detail = screen.getByTestId("session-detail");
    expect(detail.textContent).toContain("Loading");
  });

  test("renders the session's id, status, operator, and created/updated timestamps once loaded", async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("session-123");
    expect(detail.textContent).toContain("open");
    expect(detail.textContent).toContain("boot-operator");
    expect(detail.textContent).toContain(
      new Date(OPEN_SESSION.createdAtMs).toISOString(),
    );
    expect(detail.textContent).toContain(
      new Date(OPEN_SESSION.updatedAtMs).toISOString(),
    );
  });

  test("renders each step's ordinal, operation, and status once loaded", async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([QUEUED_STEP, TERMINAL_STEP])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    // Standalone-digit boundary avoids false positives from the long
    // millisecond timestamps rendered elsewhere in the same container.
    expect(detail.textContent).toMatch(/\b1\b/);
    expect(detail.textContent).toMatch(/\b2\b/);
    expect(detail.textContent).toContain("sqs-etl");
    expect(detail.textContent).toContain("queued");
    expect(detail.textContent).toContain("success");
  });

  test('renders "no steps yet" when the steps list is empty', async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("no steps yet");
  });

  test("renders each decision's prompt and status once loaded", async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={okFetchSessionDecisions([
          PENDING_DECISION,
          ANSWERED_DECISION,
        ])}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("Continue?");
    expect(detail.textContent).toContain("pending");
    expect(detail.textContent).toContain("Proceed?");
    expect(detail.textContent).toContain("answered");
  });

  test('renders "no decisions yet" when the decisions list is empty', async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("no decisions yet");
  });

  test("a closed session renders a formatted Closed: line", async () => {
    render(
      <SessionDetail
        id="session-456"
        fetchSession={okFetchSession(CLOSED_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("Closed:");
    // CLOSED_SESSION.status === "closed" narrows closedAtMs to number.
    expect(detail.textContent).toContain(
      new Date(CLOSED_SESSION.closedAtMs).toISOString(),
    );
  });

  test("an open session renders no Closed: text at all", async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).not.toContain("Closed:");
  });

  test("renders an error state when fetchSession returns ok:false", async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={errorFetchSession("session not found")}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("session not found");
  });

  test("renders an error state when fetchSessionSteps alone returns ok:false", async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={errorFetchSessionSteps("steps unavailable")}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("steps unavailable");
  });

  test("renders an error state when fetchSessionDecisions alone returns ok:false", async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={errorFetchSessionDecisions(
          "decisions unavailable",
        )}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("decisions unavailable");
  });

  // Both arms are reachable in this test's own setup (session AND steps both
  // fail), so this actually discriminates the documented priority order
  // rather than passing identically under the opposite implementation.
  test("when both fetchSession and fetchSessionSteps fail, the session's message wins (priority: session > steps > decisions)", async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={errorFetchSession("session failed")}
        fetchSessionSteps={errorFetchSessionSteps("steps failed")}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("session failed");
    expect(detail.textContent).not.toContain("steps failed");
  });

  test("when both fetchSessionSteps and fetchSessionDecisions fail, the steps' message wins (priority: steps > decisions)", async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={errorFetchSessionSteps("steps failed")}
        fetchSessionDecisions={errorFetchSessionDecisions("decisions failed")}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("steps failed");
    expect(detail.textContent).not.toContain("decisions failed");
  });

  test("renders an error state when fetchSession rejects (.catch arm)", async () => {
    const rejectingFetchSession = vi.fn(() =>
      Promise.reject(new Error("session boom")),
    );

    render(
      <SessionDetail
        id="session-123"
        fetchSession={rejectingFetchSession}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("session boom");
  });

  test("renders an error state when fetchSessionSteps rejects (.catch arm)", async () => {
    const rejectingFetchSteps = vi.fn(() =>
      Promise.reject(new Error("steps boom")),
    );

    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={rejectingFetchSteps}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("steps boom");
  });

  test("renders an error state when fetchSessionDecisions rejects (.catch arm)", async () => {
    const rejectingFetchDecisions = vi.fn(() =>
      Promise.reject(new Error("decisions boom")),
    );

    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={rejectingFetchDecisions}
      />,
    );

    const detail = await screen.findByTestId("session-detail");
    expect(detail.textContent).toContain("decisions boom");
  });

  test("calls all three fetchers with the id prop", async () => {
    const fetchSessionSpy = vi.fn(okFetchSession(OPEN_SESSION));
    const fetchStepsSpy = vi.fn(okFetchSessionSteps([]));
    const fetchDecisionsSpy = vi.fn(okFetchSessionDecisions([]));

    render(
      <SessionDetail
        id="session-123"
        fetchSession={fetchSessionSpy}
        fetchSessionSteps={fetchStepsSpy}
        fetchSessionDecisions={fetchDecisionsSpy}
      />,
    );
    await screen.findByTestId("session-detail");

    expect(fetchSessionSpy).toHaveBeenCalledWith("session-123");
    expect(fetchStepsSpy).toHaveBeenCalledWith("session-123");
    expect(fetchDecisionsSpy).toHaveBeenCalledWith("session-123");
  });

  test("re-fetches all three fetchers when the id prop changes", async () => {
    const fetchSessionSpy = vi.fn(okFetchSession(OPEN_SESSION));
    const fetchStepsSpy = vi.fn(okFetchSessionSteps([]));
    const fetchDecisionsSpy = vi.fn(okFetchSessionDecisions([]));

    const { rerender } = render(
      <SessionDetail
        id="session-123"
        fetchSession={fetchSessionSpy}
        fetchSessionSteps={fetchStepsSpy}
        fetchSessionDecisions={fetchDecisionsSpy}
      />,
    );
    await screen.findByTestId("session-detail");
    expect(fetchSessionSpy).toHaveBeenCalledWith("session-123");

    rerender(
      <SessionDetail
        id="session-456"
        fetchSession={fetchSessionSpy}
        fetchSessionSteps={fetchStepsSpy}
        fetchSessionDecisions={fetchDecisionsSpy}
      />,
    );

    await vi.waitFor(() => {
      expect(fetchSessionSpy).toHaveBeenCalledWith("session-456");
    });
    expect(fetchStepsSpy).toHaveBeenCalledWith("session-456");
    expect(fetchDecisionsSpy).toHaveBeenCalledWith("session-456");
  });

  test("does not update state after unmount once late resolves arrive (.then guard)", async () => {
    let resolveSession: (
      result: M3LConsoleFetchResult<M3LSessionRecord>,
    ) => void = () => {
      // replaced synchronously by the executor below
    };
    const pendingFetchSession = (): Promise<
      M3LConsoleFetchResult<M3LSessionRecord>
    > =>
      new Promise((resolve) => {
        resolveSession = resolve;
      });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // suppress React's console.error output for this test
      });

    const { unmount } = render(
      <SessionDetail
        id="session-123"
        fetchSession={pendingFetchSession}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );
    unmount();
    resolveSession({ ok: true, data: OPEN_SESSION });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  test("does not update state after unmount once late rejections arrive (.catch guard)", async () => {
    let rejectSession: (caught: unknown) => void = () => {
      // replaced synchronously by the executor below
    };
    const pendingFetchSession = (): Promise<
      M3LConsoleFetchResult<M3LSessionRecord>
    > =>
      new Promise((_resolve, reject) => {
        rejectSession = reject;
      });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // suppress React's console.error output for this test
      });

    const { unmount } = render(
      <SessionDetail
        id="session-123"
        fetchSession={pendingFetchSession}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );
    unmount();
    rejectSession(new Error("boom"));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
