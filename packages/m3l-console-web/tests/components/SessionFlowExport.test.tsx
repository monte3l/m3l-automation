import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { M3LConsoleFetchResult } from "../../src/api/client.js";
import type {
  M3LSessionFlowExportRequest,
  M3LSessionFlowWriteResult,
} from "../../src/api/session-flow-export.js";
import { SessionFlowExport } from "../../src/components/SessionFlowExport.js";

/**
 * `SessionFlowExport` — new X13 component (issue #561, PR 6/6) letting an
 * operator export a session's recorded steps as a flow document via the
 * injected `exportSessionAsFlow`. Neither the component module nor its
 * exported symbols exist yet — every case in this file is RED until the
 * sibling implementation slice lands.
 */

const SESSION_ID = "session-1";

function okExportSessionAsFlow(
  result: M3LSessionFlowWriteResult,
): (
  sessionId: string,
  request: M3LSessionFlowExportRequest,
) => Promise<M3LConsoleFetchResult<M3LSessionFlowWriteResult>> {
  return () => Promise.resolve({ ok: true, data: result });
}

function errorExportSessionAsFlow(
  message: string,
): (
  sessionId: string,
  request: M3LSessionFlowExportRequest,
) => Promise<M3LConsoleFetchResult<M3LSessionFlowWriteResult>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

const SUCCESS_STEP: M3LSessionFlowWriteResult["steps"][number] = {
  stepId: "step-record-1",
  ordinal: 1,
  flowStepId: "step-1",
  script: "sqs-etl",
  outcome: "success",
  parameterReferences: { queueName: "step-1.output.Queues[0]" },
};

const FULL_RESULT: M3LSessionFlowWriteResult = {
  name: "dlq-reconcile",
  yaml: "name: dlq-reconcile\nsteps:\n  - id: step-1\n    script: sqs-etl\n",
  steps: [SUCCESS_STEP],
  decisionsDropped: 0,
  path: "/data/config/flows/dlq-reconcile.yaml",
};

function fillName(name: string): void {
  fireEvent.change(screen.getByTestId("session-flow-export-name-input"), {
    target: { value: name },
  });
}

function clickExport(): void {
  fireEvent.click(screen.getByTestId("session-flow-export-submit"));
}

describe("SessionFlowExport — rendering the form", () => {
  test("renders the name/description inputs, the overwrite checkbox, and an Export button", () => {
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={okExportSessionAsFlow(FULL_RESULT)}
      />,
    );

    expect(screen.getByTestId("session-flow-export")).toBeInTheDocument();
    expect(
      screen.getByTestId("session-flow-export-name-input"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("session-flow-export-description-input"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("session-flow-export-overwrite-checkbox"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("session-flow-export-overwrite-checkbox"),
    ).not.toBeChecked();
    expect(
      screen.getByTestId("session-flow-export-submit"),
    ).toBeInTheDocument();
  });
});

describe("SessionFlowExport — client-side name validation", () => {
  test("submitting with an empty name never calls exportSessionAsFlow and shows a visible validation message", () => {
    const exportSpy = vi.fn(okExportSessionAsFlow(FULL_RESULT));
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={exportSpy}
      />,
    );

    clickExport();

    expect(exportSpy).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("session-flow-export-name-error"),
    ).toBeInTheDocument();
  });
});

describe("SessionFlowExport — happy path", () => {
  test("fills the name, clicks Export, and renders the returned path and yaml", async () => {
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={okExportSessionAsFlow(FULL_RESULT)}
      />,
    );

    fillName("dlq-reconcile");
    clickExport();

    const result = await screen.findByTestId("session-flow-export-result");
    expect(result.textContent).toContain(FULL_RESULT.path);
    const yamlElement = screen.getByTestId("session-flow-export-yaml");
    expect(yamlElement.tagName.toLowerCase()).toBe("pre");
    expect(yamlElement.textContent).toContain(FULL_RESULT.yaml);
  });

  test("submitting with only the name filled calls exportSessionAsFlow with description omitted and overwrite: false, matching the server route's own optional-field convention", async () => {
    const exportSpy = vi.fn(okExportSessionAsFlow(FULL_RESULT));
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={exportSpy}
      />,
    );

    fillName("dlq-reconcile");
    clickExport();

    await screen.findByTestId("session-flow-export-result");
    expect(exportSpy).toHaveBeenCalledTimes(1);
    const call = exportSpy.mock.calls[0];
    if (!call) {
      throw new Error("exportSessionAsFlow was not called");
    }
    const [sessionId, request] = call;
    expect(sessionId).toBe(SESSION_ID);
    // Mirrors sessions/flow-export.ts's parseFlowExportBody: `description` is
    // an absent key (never `undefined`-valued) when not supplied, and
    // `overwrite` is always present as a boolean.
    expect(Object.hasOwn(request, "description")).toBe(false);
    expect(request).toEqual({ name: "dlq-reconcile", overwrite: false });
  });

  test("checking the overwrite checkbox before submit calls exportSessionAsFlow with overwrite: true", async () => {
    const exportSpy = vi.fn(okExportSessionAsFlow(FULL_RESULT));
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={exportSpy}
      />,
    );

    fillName("dlq-reconcile");
    fireEvent.click(
      screen.getByTestId("session-flow-export-overwrite-checkbox"),
    );
    clickExport();

    await screen.findByTestId("session-flow-export-result");
    expect(exportSpy).toHaveBeenCalledTimes(1);
    const call = exportSpy.mock.calls[0];
    if (!call) {
      throw new Error("exportSessionAsFlow was not called");
    }
    const [, request] = call;
    expect(request).toMatchObject({ overwrite: true });
  });

  test("filling the description includes it in the request", async () => {
    const exportSpy = vi.fn(okExportSessionAsFlow(FULL_RESULT));
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={exportSpy}
      />,
    );

    fillName("dlq-reconcile");
    fireEvent.change(
      screen.getByTestId("session-flow-export-description-input"),
      { target: { value: "Reconciles the DLQ backlog" } },
    );
    clickExport();

    await screen.findByTestId("session-flow-export-result");
    const call = exportSpy.mock.calls[0];
    if (!call) {
      throw new Error("exportSessionAsFlow was not called");
    }
    const [, request] = call;
    expect(request).toMatchObject({
      description: "Reconciles the DLQ backlog",
    });
  });
});

describe("SessionFlowExport — decisionsDropped warning", () => {
  test("decisionsDropped > 0 renders a warning banner without crashing or leaking undefined/[object Object] artifacts", async () => {
    const droppedResult: M3LSessionFlowWriteResult = {
      ...FULL_RESULT,
      decisionsDropped: 2,
    };
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={okExportSessionAsFlow(droppedResult)}
      />,
    );

    fillName("dlq-reconcile");
    clickExport();

    const result = await screen.findByTestId("session-flow-export-result");
    const warning = screen.getByTestId("session-flow-export-warning");
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toMatch(/decision/i);
    expect(result.textContent).not.toContain("undefined");
    expect(result.textContent).not.toContain("[object Object]");
  });

  test("decisionsDropped === 0 renders no warning banner", async () => {
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={okExportSessionAsFlow(FULL_RESULT)}
      />,
    );

    fillName("dlq-reconcile");
    clickExport();

    await screen.findByTestId("session-flow-export-result");
    expect(
      screen.queryByTestId("session-flow-export-warning"),
    ).not.toBeInTheDocument();
  });
});

describe("SessionFlowExport — non-success step outcome warning", () => {
  test("a step whose outcome is not success renders a visible warning indicator near that step's identifier", async () => {
    const failedStep: M3LSessionFlowWriteResult["steps"][number] = {
      ...SUCCESS_STEP,
      outcome: "failure",
    };
    const failedStepResult: M3LSessionFlowWriteResult = {
      ...FULL_RESULT,
      steps: [failedStep],
    };
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={okExportSessionAsFlow(failedStepResult)}
      />,
    );

    fillName("dlq-reconcile");
    clickExport();

    await screen.findByTestId("session-flow-export-result");
    const stepWarning = screen.getByTestId(
      `session-flow-export-step-warning-${failedStep.flowStepId}`,
    );
    expect(stepWarning).toBeInTheDocument();
  });

  test("a step whose outcome is null (never reached) also renders a visible warning indicator", async () => {
    const neverRanStep: M3LSessionFlowWriteResult["steps"][number] = {
      ...SUCCESS_STEP,
      outcome: null,
    };
    const neverRanStepResult: M3LSessionFlowWriteResult = {
      ...FULL_RESULT,
      steps: [neverRanStep],
    };
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={okExportSessionAsFlow(neverRanStepResult)}
      />,
    );

    fillName("dlq-reconcile");
    clickExport();

    await screen.findByTestId("session-flow-export-result");
    const stepWarning = screen.getByTestId(
      `session-flow-export-step-warning-${neverRanStep.flowStepId}`,
    );
    expect(stepWarning).toBeInTheDocument();
  });

  test("every step succeeding renders no per-step warning indicators", async () => {
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={okExportSessionAsFlow(FULL_RESULT)}
      />,
    );

    fillName("dlq-reconcile");
    clickExport();

    await screen.findByTestId("session-flow-export-result");
    expect(
      screen.queryByTestId(
        `session-flow-export-step-warning-${SUCCESS_STEP.flowStepId}`,
      ),
    ).not.toBeInTheDocument();
  });
});

describe("SessionFlowExport — failure surfaces", () => {
  test("an ok:false result on a first submission shows the error message and no crash", async () => {
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={errorExportSessionAsFlow("flow name is invalid")}
      />,
    );

    fillName("dlq-reconcile");
    clickExport();

    const error = await screen.findByTestId("session-flow-export-error");
    expect(error.textContent).toContain("flow name is invalid");
    expect(
      screen.queryByTestId("session-flow-export-result"),
    ).not.toBeInTheDocument();
  });

  test("an ok:false result shows the error message and clears any previous success result", async () => {
    const exportSpy = vi
      .fn<
        (
          sessionId: string,
          request: M3LSessionFlowExportRequest,
        ) => Promise<M3LConsoleFetchResult<M3LSessionFlowWriteResult>>
      >()
      .mockResolvedValueOnce({ ok: true, data: FULL_RESULT })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "http", message: "a flow file already exists" },
      });
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={exportSpy}
      />,
    );

    fillName("dlq-reconcile");
    clickExport();
    await screen.findByTestId("session-flow-export-result");

    fillName("dlq-reconcile-2");
    clickExport();

    const error = await screen.findByTestId("session-flow-export-error");
    expect(error.textContent).toContain("a flow file already exists");
    expect(
      screen.queryByTestId("session-flow-export-result"),
    ).not.toBeInTheDocument();
  });

  test("a rejecting exportSessionAsFlow (.catch arm) shows the error message and clears any previous success result", async () => {
    const exportSpy = vi
      .fn<
        (
          sessionId: string,
          request: M3LSessionFlowExportRequest,
        ) => Promise<M3LConsoleFetchResult<M3LSessionFlowWriteResult>>
      >()
      .mockResolvedValueOnce({ ok: true, data: FULL_RESULT })
      .mockRejectedValueOnce(new Error("network exploded"));
    render(
      <SessionFlowExport
        sessionId={SESSION_ID}
        exportSessionAsFlow={exportSpy}
      />,
    );

    fillName("dlq-reconcile");
    clickExport();
    await screen.findByTestId("session-flow-export-result");

    fillName("dlq-reconcile-2");
    clickExport();

    const error = await screen.findByTestId("session-flow-export-error");
    expect(error.textContent).toContain("network exploded");
    expect(
      screen.queryByTestId("session-flow-export-result"),
    ).not.toBeInTheDocument();
  });
});

// --- Regression test: a second submit cannot overlap a pending one --------
//
// A code-review Should-fix asked for a test proving `submitExport`'s
// `currentRequestIdRef` guard (both `.then` and `.catch` returning early
// once a later submit is current) by forcing two submissions to be in
// flight at once and resolving the OLDER one second, mirroring
// DecisionPrompt.test.tsx's own "stale in-flight submit request-identity
// guard" describe block.
//
// That literal recipe — fill the name, click Export, change the name, click
// Export again before the first settles — was traced against the real
// component and does NOT reach the guard: `SessionFlowExportFields` disables
// the Export button whenever `state.kind === "loading"`, and that state
// transition happens synchronously inside the SAME click's React flush,
// before `writer(...)` is even invoked. React's own event delegation
// (`getListener` in react-dom-client.development.js, the `onClick` case)
// explicitly withholds the click listener from a `button`/`input`/`select`/
// `textarea` whose `disabled` prop is true — confirmed both by reading that
// source and by an isolated repro (a bare disabled `<button>` whose second
// `fireEvent.click` never re-invoked `onClick`). So a second click while a
// submission is pending is not a race that resolves in the guard's favor —
// it never reaches `handleSubmit`, and therefore never reaches `writer`, at
// all. `submitExport`'s per-request-id discard is consequently unreachable
// dead code from this component's own UI: no sequence of DOM interactions
// on one mounted instance can ever create two overlapping in-flight
// submissions for it to discriminate between (flagged to the hub — see the
// spoke's final report for the two remediation options this implies).
//
// What IS real, and worth locking down, is the mechanism that makes the
// race impossible in the first place: the disabled-during-loading gate.
// This test proves that mechanism directly — a second submit attempt while
// the first is still unresolved calls `exportSessionAsFlow` zero additional
// times, and the pending submission still completes normally once its own
// promise settles.
describe("SessionFlowExport — a submit while one is already pending is a no-op", () => {
  test("clicking Export again while the first submission is still unresolved does not call exportSessionAsFlow a second time, and the pending submission still renders once it resolves", async () => {
    const deferred =
      Promise.withResolvers<M3LConsoleFetchResult<M3LSessionFlowWriteResult>>();
    const writer = vi.fn(
      (
        _sessionId: string,
        _request: M3LSessionFlowExportRequest,
      ): Promise<M3LConsoleFetchResult<M3LSessionFlowWriteResult>> =>
        deferred.promise,
    );

    render(
      <SessionFlowExport sessionId={SESSION_ID} exportSessionAsFlow={writer} />,
    );

    fillName("dlq-reconcile-a");
    clickExport();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("session-flow-export-submit")).toBeDisabled();

    // Changing the name and clicking again while the first submission is
    // still pending must not start a second one — the button is disabled,
    // so the click never reaches `handleSubmit`.
    fillName("dlq-reconcile-b");
    clickExport();
    expect(writer).toHaveBeenCalledTimes(1);

    const resultA: M3LSessionFlowWriteResult = {
      ...FULL_RESULT,
      path: "/data/config/flows/a.yaml",
    };
    deferred.resolve({ ok: true, data: resultA });

    const result = await screen.findByTestId("session-flow-export-result");
    expect(result.textContent).toContain(resultA.path);
    expect(screen.getByTestId("session-flow-export-submit")).not.toBeDisabled();
  });
});
