import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { M3LConsoleFetchResult } from "../../src/api/client.js";
import type {
  M3LSessionBindingInput,
  M3LSessionBindingRecord,
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

// --- Step-artifact viewer + binding creation -------------------------------
//
// New behavior for this slice: a per-step "View output" affordance that
// fetches the step's result via the injected `fetchSessionStepArtifact`,
// renders it through `JsonTreeViewer`, and lets an operator select a node to
// open a binding-creation form backed by the injected `createSessionBinding`.
// Neither prop nor the two new `M3LSessionBinding*` types exist yet — these
// cases are RED until the sibling implementation slice lands.

function okFetchSessionStepArtifact(
  value: unknown,
): (
  sessionId: string,
  stepId: string,
) => Promise<M3LConsoleFetchResult<unknown>> {
  return () => Promise.resolve({ ok: true, data: value });
}

function errorFetchSessionStepArtifact(
  message: string,
): (
  sessionId: string,
  stepId: string,
) => Promise<M3LConsoleFetchResult<unknown>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

function okCreateSessionBinding(
  record: M3LSessionBindingRecord,
): (
  sessionId: string,
  input: M3LSessionBindingInput,
) => Promise<M3LConsoleFetchResult<M3LSessionBindingRecord>> {
  return () => Promise.resolve({ ok: true, data: record });
}

function errorCreateSessionBinding(
  message: string,
): (
  sessionId: string,
  input: M3LSessionBindingInput,
) => Promise<M3LConsoleFetchResult<M3LSessionBindingRecord>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

const STEP_ARTIFACT_VALUE = {
  Region: "us-east-1",
  Queues: ["q1", "q2"],
};

// TERMINAL_STEP.ordinal is 2 (declared above), so a top-level "Region"
// selection on its output is expected to build the ADR-0068 reference
// "step-2.output.Region" — the reference-building logic itself is covered by
// a sibling `internal/step-reference.ts` suite, this just pins the expected
// string for this fixture's one-level selection.
const EXPECTED_REGION_REFERENCE = "step-2.output.Region";

const BINDING_RECORD: M3LSessionBindingRecord = {
  id: "binding-1",
  sessionId: "session-123",
  reference: EXPECTED_REGION_REFERENCE,
  expectedType: "string",
  multiSelect: true,
  createdAtMs: 1_700_000_010_000,
  parameterName: "myParam",
};

/**
 * Renders a loaded `SessionDetail` with `TERMINAL_STEP` as its only step,
 * clicks that step's "View output" button, and waits for the tree viewer to
 * appear — the common setup every binding-form test below builds on.
 */
async function renderWithArtifactViewerOpen(
  fetchSessionStepArtifact: (
    sessionId: string,
    stepId: string,
  ) => Promise<M3LConsoleFetchResult<unknown>>,
  createSessionBinding?: (
    sessionId: string,
    input: M3LSessionBindingInput,
  ) => Promise<M3LConsoleFetchResult<M3LSessionBindingRecord>>,
): Promise<void> {
  render(
    <SessionDetail
      id="session-123"
      fetchSession={okFetchSession(OPEN_SESSION)}
      fetchSessionSteps={okFetchSessionSteps([TERMINAL_STEP])}
      fetchSessionDecisions={okFetchSessionDecisions([])}
      fetchSessionStepArtifact={fetchSessionStepArtifact}
      createSessionBinding={createSessionBinding}
    />,
  );
  await screen.findByTestId("session-detail");
  fireEvent.click(screen.getByTestId(`view-output-${TERMINAL_STEP.id}`));
  await screen.findByTestId("step-artifact-viewer");
}

describe("SessionDetail step artifact viewer and binding creation", () => {
  test('renders a "View output" button only for steps with hasResult: true', async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([QUEUED_STEP, TERMINAL_STEP])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
      />,
    );

    await screen.findByTestId("session-detail");

    const viewOutputButton = screen.getByTestId(
      `view-output-${TERMINAL_STEP.id}`,
    );
    expect(viewOutputButton).toBeInTheDocument();
    expect(viewOutputButton).toHaveAccessibleName("View output");
    expect(
      screen.queryByTestId(`view-output-${QUEUED_STEP.id}`),
    ).not.toBeInTheDocument();
  });

  test("clicking View output calls fetchSessionStepArtifact with the session and step ids and renders the JSON tree once resolved ok:true", async () => {
    const fetchArtifactSpy = vi.fn(
      okFetchSessionStepArtifact(STEP_ARTIFACT_VALUE),
    );

    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([TERMINAL_STEP])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
        fetchSessionStepArtifact={fetchArtifactSpy}
      />,
    );
    await screen.findByTestId("session-detail");

    fireEvent.click(screen.getByTestId(`view-output-${TERMINAL_STEP.id}`));

    const viewer = await screen.findByTestId("step-artifact-viewer");
    expect(fetchArtifactSpy).toHaveBeenCalledWith(
      "session-123",
      TERMINAL_STEP.id,
    );
    expect(viewer.querySelector('[data-testid="json-tree-viewer"]')).not.toBe(
      null,
    );
  });

  test("renders the fetch error's message inside the artifact viewer panel when fetchSessionStepArtifact resolves ok:false", async () => {
    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([TERMINAL_STEP])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
        fetchSessionStepArtifact={errorFetchSessionStepArtifact(
          "artifact fetch failed",
        )}
      />,
    );
    await screen.findByTestId("session-detail");

    fireEvent.click(screen.getByTestId(`view-output-${TERMINAL_STEP.id}`));

    const viewer = await screen.findByTestId("step-artifact-viewer");
    expect(viewer.textContent).toContain("artifact fetch failed");
  });

  test("selecting a node in the tree opens a binding-creation form with an unchecked multi-select checkbox by default", async () => {
    await renderWithArtifactViewerOpen(
      okFetchSessionStepArtifact(STEP_ARTIFACT_VALUE),
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Region" }));

    const form = await screen.findByTestId("binding-form");
    expect(form.tagName.toLowerCase()).toBe("form");
    expect(
      screen.getByTestId("binding-parameter-name-input"),
    ).toBeInTheDocument();
    const multiSelectCheckbox = screen.getByTestId(
      "binding-multi-select-checkbox",
    );
    expect(multiSelectCheckbox).not.toBeChecked();
    expect(screen.getByTestId("binding-submit")).toBeInTheDocument();
  });

  test("submitting the binding form calls createSessionBinding with the reference, derived expectedType, multiSelect, and typed parameterName", async () => {
    const createBindingSpy = vi.fn(okCreateSessionBinding(BINDING_RECORD));
    await renderWithArtifactViewerOpen(
      okFetchSessionStepArtifact(STEP_ARTIFACT_VALUE),
      createBindingSpy,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select Region" }));
    await screen.findByTestId("binding-form");

    fireEvent.change(screen.getByTestId("binding-parameter-name-input"), {
      target: { value: "myParam" },
    });
    fireEvent.click(screen.getByTestId("binding-multi-select-checkbox"));
    fireEvent.click(screen.getByTestId("binding-submit"));

    await vi.waitFor(() => {
      expect(createBindingSpy).toHaveBeenCalledTimes(1);
    });
    expect(createBindingSpy).toHaveBeenCalledWith("session-123", {
      reference: EXPECTED_REGION_REFERENCE,
      expectedType: "string",
      multiSelect: true,
      parameterName: "myParam",
    });
  });

  test("renders a binding-success confirmation including the parameterName once createSessionBinding resolves ok:true", async () => {
    await renderWithArtifactViewerOpen(
      okFetchSessionStepArtifact(STEP_ARTIFACT_VALUE),
      okCreateSessionBinding(BINDING_RECORD),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select Region" }));
    await screen.findByTestId("binding-form");
    fireEvent.change(screen.getByTestId("binding-parameter-name-input"), {
      target: { value: "myParam" },
    });
    fireEvent.click(screen.getByTestId("binding-submit"));

    const success = await screen.findByTestId("binding-success");
    expect(success.textContent).toContain("myParam");
  });

  test("renders binding-error with the failure message and keeps the form available to retry when createSessionBinding resolves ok:false", async () => {
    await renderWithArtifactViewerOpen(
      okFetchSessionStepArtifact(STEP_ARTIFACT_VALUE),
      errorCreateSessionBinding("binding creation failed"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select Region" }));
    await screen.findByTestId("binding-form");
    fireEvent.change(screen.getByTestId("binding-parameter-name-input"), {
      target: { value: "myParam" },
    });
    fireEvent.click(screen.getByTestId("binding-submit"));

    const bindingError = await screen.findByTestId("binding-error");
    expect(bindingError.textContent).toContain("binding creation failed");
    expect(screen.getByTestId("binding-form")).toBeInTheDocument();
  });
});

// --- Regression tests: throw-guard + stale-response races + id-change reset -
//
// Three findings from the review pass on this file's `useStepArtifact` and
// `useBindingForm` hooks: (1) a thrown `buildStepReference` must surface as
// `binding-error`, never leave the submit handler stuck on `"loading"`; (2) a
// stale artifact fetch resolving after a newer step selection must not
// clobber the newer selection's state; (3) changing the `id` prop must reset
// both hooks so a session switch cannot leave the previous session's output
// panel or binding form visible, or let a submit build a reference against
// the wrong session's step.

// A computed property key creates a real OWN enumerable "__proto__" data
// property (distinct from the special-cased `{ __proto__: ... }` literal
// form, which instead sets the object's prototype) — this is exactly the
// dangerous-key shape `formatStepReference`'s `isDangerousKey` guard rejects.
const DANGEROUS_KEY_ARTIFACT_VALUE: Record<string, unknown> = {
  ["__proto__"]: "polluted",
};

const STEP_A: M3LSessionStepSummary = {
  id: "step-a",
  sessionId: "session-123",
  ordinal: 1,
  operation: "sqs-etl",
  parameters: {},
  runId: "run-a",
  status: "success",
  queuedAtMs: 1_700_000_000_000,
  startedAtMs: 1_700_000_000_100,
  endedAtMs: 1_700_000_000_200,
  outcome: "success",
  failureMessage: null,
  hasResult: true,
};

const STEP_B: M3LSessionStepSummary = {
  ...STEP_A,
  id: "step-b",
  ordinal: 2,
};

describe("SessionDetail race-condition and reset regressions", () => {
  test("a thrown buildStepReference (a __proto__ key path) surfaces binding-error instead of leaving the form stuck loading", async () => {
    const createBindingSpy = vi.fn(okCreateSessionBinding(BINDING_RECORD));
    await renderWithArtifactViewerOpen(
      okFetchSessionStepArtifact(DANGEROUS_KEY_ARTIFACT_VALUE),
      createBindingSpy,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select __proto__" }));
    await screen.findByTestId("binding-form");

    fireEvent.click(screen.getByTestId("binding-submit"));

    const bindingError = await screen.findByTestId("binding-error");
    expect(bindingError.textContent).toContain("__proto__");
    // The malformed reference is caught before ever reaching the network call.
    expect(createBindingSpy).not.toHaveBeenCalled();
  });

  test("selecting a step while a prior step's artifact fetch is still pending does not let the stale fetch clobber the newer selection", async () => {
    const stepAResolvers =
      Promise.withResolvers<M3LConsoleFetchResult<unknown>>();
    const stepBResolvers =
      Promise.withResolvers<M3LConsoleFetchResult<unknown>>();
    const deferredByStepId = new Map<
      string,
      Promise<M3LConsoleFetchResult<unknown>>
    >([
      ["step-a", stepAResolvers.promise],
      ["step-b", stepBResolvers.promise],
    ]);
    const fetchArtifactSpy = vi.fn(
      (
        _sessionId: string,
        stepId: string,
      ): Promise<M3LConsoleFetchResult<unknown>> => {
        const deferred = deferredByStepId.get(stepId);
        if (!deferred) {
          throw new Error(`no deferred fetch registered for step ${stepId}`);
        }
        return deferred;
      },
    );

    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([STEP_A, STEP_B])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
        fetchSessionStepArtifact={fetchArtifactSpy}
      />,
    );
    await screen.findByTestId("session-detail");

    fireEvent.click(screen.getByTestId("view-output-step-a"));
    await screen.findByTestId("step-artifact-viewer");

    fireEvent.click(screen.getByTestId("view-output-step-b"));

    stepAResolvers.resolve({ ok: true, data: { stale: true } });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    const viewerAfterStaleResolve = screen.getByTestId("step-artifact-viewer");
    expect(viewerAfterStaleResolve.textContent).not.toContain("stale");
    expect(viewerAfterStaleResolve.textContent).toContain("Loading output");

    stepBResolvers.resolve({ ok: true, data: { fresh: true } });
    await vi.waitFor(() => {
      expect(screen.getByTestId("step-artifact-viewer").textContent).toContain(
        "fresh",
      );
    });
  });

  test("selecting a step while a prior step's artifact fetch is still pending does not let a stale rejection clobber the newer selection", async () => {
    const stepAResolvers =
      Promise.withResolvers<M3LConsoleFetchResult<unknown>>();
    const stepBResolvers =
      Promise.withResolvers<M3LConsoleFetchResult<unknown>>();
    const deferredByStepId = new Map<
      string,
      Promise<M3LConsoleFetchResult<unknown>>
    >([
      ["step-a", stepAResolvers.promise],
      ["step-b", stepBResolvers.promise],
    ]);
    const fetchArtifactSpy = vi.fn(
      (
        _sessionId: string,
        stepId: string,
      ): Promise<M3LConsoleFetchResult<unknown>> => {
        const deferred = deferredByStepId.get(stepId);
        if (!deferred) {
          throw new Error(`no deferred fetch registered for step ${stepId}`);
        }
        return deferred;
      },
    );

    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([STEP_A, STEP_B])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
        fetchSessionStepArtifact={fetchArtifactSpy}
      />,
    );
    await screen.findByTestId("session-detail");

    fireEvent.click(screen.getByTestId("view-output-step-a"));
    await screen.findByTestId("step-artifact-viewer");

    fireEvent.click(screen.getByTestId("view-output-step-b"));

    stepAResolvers.reject(new Error("stale artifact failure"));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    const viewerAfterStaleReject = screen.getByTestId("step-artifact-viewer");
    expect(viewerAfterStaleReject.textContent).not.toContain(
      "stale artifact failure",
    );
    expect(viewerAfterStaleReject.textContent).toContain("Loading output");

    stepBResolvers.resolve({ ok: true, data: { fresh: true } });
    await vi.waitFor(() => {
      expect(screen.getByTestId("step-artifact-viewer").textContent).toContain(
        "fresh",
      );
    });
  });

  test("changing the id prop resets the step-output panel and binding form so stale session content does not linger", async () => {
    const { rerender } = render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([TERMINAL_STEP])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
        fetchSessionStepArtifact={okFetchSessionStepArtifact(
          STEP_ARTIFACT_VALUE,
        )}
      />,
    );
    await screen.findByTestId("session-detail");
    fireEvent.click(screen.getByTestId(`view-output-${TERMINAL_STEP.id}`));
    await screen.findByTestId("step-artifact-viewer");
    fireEvent.click(screen.getByRole("button", { name: "Select Region" }));
    await screen.findByTestId("binding-form");

    rerender(
      <SessionDetail
        id="session-456"
        fetchSession={okFetchSession(CLOSED_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
        fetchSessionStepArtifact={okFetchSessionStepArtifact(
          STEP_ARTIFACT_VALUE,
        )}
      />,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("session-detail").textContent).toContain(
        "session-456",
      );
    });
    expect(
      screen.queryByTestId("step-artifact-viewer"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("binding-form")).not.toBeInTheDocument();
  });
});

// --- deriveExpectedType coverage: number/boolean/object fields -------------
//
// The happy-path binding-creation test above only ever selects a string
// field ("Region"), so `deriveExpectedType`'s number/boolean/object branches
// are otherwise unexercised.

const TYPED_FIELDS_ARTIFACT_VALUE = {
  Region: "us-east-1",
  RetentionSeconds: 345_600,
  Enabled: true,
  Queues: ["q1"],
};

describe("SessionDetail deriveExpectedType coverage", () => {
  test.each([
    { fieldLabel: "RetentionSeconds", expectedType: "number" },
    { fieldLabel: "Enabled", expectedType: "boolean" },
    { fieldLabel: "Queues", expectedType: "object" },
  ] as const)(
    "submitting a binding for the $fieldLabel field passes expectedType $expectedType",
    async ({ fieldLabel, expectedType }) => {
      const createBindingSpy = vi.fn(okCreateSessionBinding(BINDING_RECORD));
      await renderWithArtifactViewerOpen(
        okFetchSessionStepArtifact(TYPED_FIELDS_ARTIFACT_VALUE),
        createBindingSpy,
      );

      fireEvent.click(
        screen.getByRole("button", { name: `Select ${fieldLabel}` }),
      );
      await screen.findByTestId("binding-form");
      fireEvent.click(screen.getByTestId("binding-submit"));

      await vi.waitFor(() => {
        expect(createBindingSpy).toHaveBeenCalledTimes(1);
      });
      const [, input] = createBindingSpy.mock.calls[0] as [
        string,
        M3LSessionBindingInput,
      ];
      expect(input.expectedType).toBe(expectedType);
    },
  );
});

// --- .catch arms on the artifact-view and binding-submit network calls -----
//
// The happy-path tests above only ever exercise the `.then` resolve path
// (both `ok:true` and `ok:false`); a rejected promise from the injected
// fetcher/submitter is a distinct code path (`useStepArtifact`'s and
// `submitBindingRequest`'s own `.catch` handlers) that is otherwise
// unexercised.

describe("SessionDetail network-rejection (.catch) coverage", () => {
  test("renders the fetch error's message inside the artifact viewer panel when fetchSessionStepArtifact rejects (.catch arm)", async () => {
    const rejectingFetchArtifact = vi.fn(() =>
      Promise.reject(new Error("network exploded")),
    );

    render(
      <SessionDetail
        id="session-123"
        fetchSession={okFetchSession(OPEN_SESSION)}
        fetchSessionSteps={okFetchSessionSteps([TERMINAL_STEP])}
        fetchSessionDecisions={okFetchSessionDecisions([])}
        fetchSessionStepArtifact={rejectingFetchArtifact}
      />,
    );
    await screen.findByTestId("session-detail");

    fireEvent.click(screen.getByTestId(`view-output-${TERMINAL_STEP.id}`));

    const viewer = await screen.findByTestId("step-artifact-viewer");
    await vi.waitFor(() => {
      expect(viewer.textContent).toContain("network exploded");
    });
  });

  test("renders binding-error with the failure message when createSessionBinding rejects (.catch arm)", async () => {
    const rejectingCreateBinding = vi.fn(() =>
      Promise.reject(new Error("connection reset")),
    );
    await renderWithArtifactViewerOpen(
      okFetchSessionStepArtifact(STEP_ARTIFACT_VALUE),
      rejectingCreateBinding,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select Region" }));
    await screen.findByTestId("binding-form");
    fireEvent.click(screen.getByTestId("binding-submit"));

    const bindingError = await screen.findByTestId("binding-error");
    expect(bindingError.textContent).toContain("connection reset");
  });

  test("renders binding-error with the stringified fallback message when createSessionBinding rejects with a non-Error value", async () => {
    const rejectingCreateBinding = vi.fn(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentional non-Error rejection to verify deriveErrorMessage's String(caught) fallback arm
      Promise.reject("plain string failure"),
    );
    await renderWithArtifactViewerOpen(
      okFetchSessionStepArtifact(STEP_ARTIFACT_VALUE),
      rejectingCreateBinding,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select Region" }));
    await screen.findByTestId("binding-form");
    fireEvent.click(screen.getByTestId("binding-submit"));

    const bindingError = await screen.findByTestId("binding-error");
    expect(bindingError.textContent).toContain("plain string failure");
  });
});

// --- Binding-submit stale-response race (the submit-path counterpart to the
// artifact-view race test above) -------------------------------------------
//
// The existing race test above covers the artifact-VIEW path's
// `latestRequestedStepId` guard; `useBindingForm`'s own `currentNodeRef`
// guard inside `submitBindingRequest`'s `.then`/`.catch` is a distinct code
// path and was otherwise only exercised on its "not superseded" (false) arm.

describe("SessionDetail binding-submit stale-response race", () => {
  test("submitting for node A then selecting node B before A's createSessionBinding resolves does not let A's stale success clobber B's fresh binding form", async () => {
    const regionResolvers =
      Promise.withResolvers<M3LConsoleFetchResult<M3LSessionBindingRecord>>();
    const createBindingSpy = vi.fn(() => regionResolvers.promise);

    await renderWithArtifactViewerOpen(
      okFetchSessionStepArtifact(STEP_ARTIFACT_VALUE),
      createBindingSpy,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Region" }));
    await screen.findByTestId("binding-form");
    fireEvent.click(screen.getByTestId("binding-submit"));

    await vi.waitFor(() => {
      expect(createBindingSpy).toHaveBeenCalledTimes(1);
    });

    // Selecting a different node resets the form to idle before A's
    // in-flight submit ever settles.
    fireEvent.click(screen.getByRole("button", { name: "Select Queues" }));
    expect(screen.queryByTestId("binding-success")).not.toBeInTheDocument();
    expect(screen.queryByTestId("binding-error")).not.toBeInTheDocument();

    regionResolvers.resolve({ ok: true, data: BINDING_RECORD });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // A's stale resolve must not clobber B's freshly-reset idle form.
    expect(screen.queryByTestId("binding-success")).not.toBeInTheDocument();
    expect(screen.queryByTestId("binding-error")).not.toBeInTheDocument();
  });

  test("submitting for node A then selecting node B before A's createSessionBinding rejects does not let A's stale error clobber B's fresh binding form", async () => {
    const regionResolvers =
      Promise.withResolvers<M3LConsoleFetchResult<M3LSessionBindingRecord>>();
    const createBindingSpy = vi.fn(() => regionResolvers.promise);

    await renderWithArtifactViewerOpen(
      okFetchSessionStepArtifact(STEP_ARTIFACT_VALUE),
      createBindingSpy,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Region" }));
    await screen.findByTestId("binding-form");
    fireEvent.click(screen.getByTestId("binding-submit"));

    await vi.waitFor(() => {
      expect(createBindingSpy).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Select Queues" }));
    expect(screen.queryByTestId("binding-success")).not.toBeInTheDocument();
    expect(screen.queryByTestId("binding-error")).not.toBeInTheDocument();

    regionResolvers.reject(new Error("stale boom"));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // A's stale rejection must not clobber B's freshly-reset idle form.
    expect(screen.queryByTestId("binding-success")).not.toBeInTheDocument();
    expect(screen.queryByTestId("binding-error")).not.toBeInTheDocument();
  });
});
