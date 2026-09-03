import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { M3LConsoleFetchResult } from "../../src/api/client.js";
import type { M3LSessionDecisionRecord } from "../../src/api/sessions.js";
import { DecisionPrompt } from "../../src/components/DecisionPrompt.js";

const PENDING_WITH_OPTIONS: M3LSessionDecisionRecord = {
  id: "decision-1",
  sessionId: "session-with-options",
  stepId: "step-1",
  prompt: "Continue to the next queue, or stop here?",
  options: ["continue", "stop"],
  createdAtMs: 1_700_000_000_000,
  status: "pending",
};

const PENDING_WITH_NULL_OPTIONS: M3LSessionDecisionRecord = {
  id: "decision-2",
  sessionId: "session-null-options",
  stepId: "step-1",
  prompt: "Proceed with the DynamoDB query?",
  options: null,
  createdAtMs: 1_700_000_000_000,
  status: "pending",
};

const PENDING_WITH_NON_ARRAY_OPTIONS: M3LSessionDecisionRecord = {
  id: "decision-4",
  sessionId: "session-non-array-options",
  stepId: "step-1",
  prompt: "Proceed with the S3 export?",
  options: 42,
  createdAtMs: 1_700_000_000_000,
  status: "pending",
};

const ANSWERED_DECISION: M3LSessionDecisionRecord = {
  id: "decision-3",
  sessionId: "session-answered",
  stepId: "step-1",
  prompt: "Proceed with the DynamoDB query?",
  options: ["continue", "stop"],
  createdAtMs: 1_700_000_000_000,
  status: "answered",
  answer: "continue",
  answeredAtMs: 1_700_000_001_000,
};

function okAnswerSessionDecision(
  applied: boolean,
): (
  sessionId: string,
  decisionId: string,
  answer: unknown,
) => Promise<M3LConsoleFetchResult<{ readonly applied: boolean }>> {
  return () => Promise.resolve({ ok: true, data: { applied } });
}

function errorAnswerSessionDecision(
  message: string,
): (
  sessionId: string,
  decisionId: string,
  answer: unknown,
) => Promise<M3LConsoleFetchResult<{ readonly applied: boolean }>> {
  return () => Promise.resolve({ ok: false, error: { kind: "http", message } });
}

function rejectingAnswerSessionDecision(
  error: Error,
): (
  sessionId: string,
  decisionId: string,
  answer: unknown,
) => Promise<M3LConsoleFetchResult<{ readonly applied: boolean }>> {
  return () => Promise.reject(error);
}

describe("DecisionPrompt — answered decision", () => {
  test("renders the prompt and the recorded answer, with no interactive controls, and never calls answerSessionDecision", () => {
    const fetcher = vi.fn(okAnswerSessionDecision(true));
    render(
      <DecisionPrompt
        decision={ANSWERED_DECISION}
        answerSessionDecision={fetcher}
      />,
    );

    const root = screen.getByTestId("decision-prompt");
    expect(root.textContent).toContain(ANSWERED_DECISION.prompt);
    const answered = screen.getByTestId("decision-answered");
    expect(answered.textContent).toContain("continue");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("DecisionPrompt — pending decision with a string-array options", () => {
  test("renders one option button per option and no free-text input", () => {
    render(
      <DecisionPrompt
        decision={PENDING_WITH_OPTIONS}
        answerSessionDecision={okAnswerSessionDecision(true)}
      />,
    );

    expect(screen.getByTestId("decision-option-continue")).toBeInTheDocument();
    expect(screen.getByTestId("decision-option-stop")).toBeInTheDocument();
    expect(
      screen.queryByTestId("decision-answer-input"),
    ).not.toBeInTheDocument();
  });

  test("clicking an option calls answerSessionDecision(sessionId, decision.id, option) exactly once", async () => {
    const fetcher = vi.fn(okAnswerSessionDecision(true));
    render(
      <DecisionPrompt
        decision={PENDING_WITH_OPTIONS}
        answerSessionDecision={fetcher}
      />,
    );

    fireEvent.click(screen.getByTestId("decision-option-continue"));

    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    expect(fetcher).toHaveBeenCalledWith(
      PENDING_WITH_OPTIONS.sessionId,
      PENDING_WITH_OPTIONS.id,
      "continue",
    );
  });

  test("on a successful applied: true response, shows decision-success and calls onAnswered with the decision id", async () => {
    const onAnswered = vi.fn();
    render(
      <DecisionPrompt
        decision={PENDING_WITH_OPTIONS}
        answerSessionDecision={okAnswerSessionDecision(true)}
        onAnswered={onAnswered}
      />,
    );

    fireEvent.click(screen.getByTestId("decision-option-stop"));

    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-success")).toBeInTheDocument();
    });
    expect(onAnswered).toHaveBeenCalledWith(PENDING_WITH_OPTIONS.id);
  });

  test("omitting onAnswered and successfully answering does not throw", async () => {
    render(
      <DecisionPrompt
        decision={PENDING_WITH_OPTIONS}
        answerSessionDecision={okAnswerSessionDecision(true)}
      />,
    );

    fireEvent.click(screen.getByTestId("decision-option-continue"));

    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-success")).toBeInTheDocument();
    });
  });
});

describe.each([
  ["null options", PENDING_WITH_NULL_OPTIONS],
  ["non-string-array options (a number)", PENDING_WITH_NON_ARRAY_OPTIONS],
])(
  "DecisionPrompt — pending decision with %s falls back to free text",
  (_label, decision) => {
    test("renders a free-text input and a submit button, no option buttons", () => {
      render(
        <DecisionPrompt
          decision={decision}
          answerSessionDecision={okAnswerSessionDecision(true)}
        />,
      );

      expect(screen.getByTestId("decision-answer-input")).toBeInTheDocument();
      expect(screen.getByTestId("decision-submit")).toBeInTheDocument();
      expect(
        screen.queryByTestId(/^decision-option-/u),
      ).not.toBeInTheDocument();
    });

    test("typing text and submitting calls answerSessionDecision(sessionId, decision.id, typedText)", async () => {
      const fetcher = vi.fn(okAnswerSessionDecision(true));
      render(
        <DecisionPrompt decision={decision} answerSessionDecision={fetcher} />,
      );

      fireEvent.change(screen.getByTestId("decision-answer-input"), {
        target: { value: "proceed" },
      });
      fireEvent.click(screen.getByTestId("decision-submit"));

      await vi.waitFor(() => {
        expect(fetcher).toHaveBeenCalledTimes(1);
      });
      expect(fetcher).toHaveBeenCalledWith(
        decision.sessionId,
        decision.id,
        "proceed",
      );
    });
  },
);

describe("DecisionPrompt — applied: false response", () => {
  test("shows decision-not-applied (not decision-success) and does not call onAnswered", async () => {
    const onAnswered = vi.fn();
    render(
      <DecisionPrompt
        decision={PENDING_WITH_OPTIONS}
        answerSessionDecision={okAnswerSessionDecision(false)}
        onAnswered={onAnswered}
      />,
    );

    fireEvent.click(screen.getByTestId("decision-option-continue"));

    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-not-applied")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("decision-success")).not.toBeInTheDocument();
    expect(onAnswered).not.toHaveBeenCalled();
  });
});

describe("DecisionPrompt — error responses", () => {
  test("an ok: false result surfaces as decision-error showing the message", async () => {
    render(
      <DecisionPrompt
        decision={PENDING_WITH_OPTIONS}
        answerSessionDecision={errorAnswerSessionDecision("boom")}
      />,
    );

    fireEvent.click(screen.getByTestId("decision-option-continue"));

    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-error").textContent).toContain(
        "boom",
      );
    });
  });

  test("a rejecting fetcher also surfaces as decision-error rather than an unhandled rejection", async () => {
    render(
      <DecisionPrompt
        decision={PENDING_WITH_OPTIONS}
        answerSessionDecision={rejectingAnswerSessionDecision(
          new Error("network down"),
        )}
      />,
    );

    fireEvent.click(screen.getByTestId("decision-option-continue"));

    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-error").textContent).toContain(
        "network down",
      );
    });
  });
});

describe("DecisionPrompt — in-flight double-submit guard", () => {
  test("disables the answer control(s) while the fetch is in flight", async () => {
    let resolveAnswer: (
      result: M3LConsoleFetchResult<{ readonly applied: boolean }>,
    ) => void = () => {
      // replaced synchronously by the executor below
    };
    const pendingFetcher = (): Promise<
      M3LConsoleFetchResult<{ readonly applied: boolean }>
    > =>
      new Promise((resolve) => {
        resolveAnswer = resolve;
      });

    render(
      <DecisionPrompt
        decision={PENDING_WITH_OPTIONS}
        answerSessionDecision={pendingFetcher}
      />,
    );

    fireEvent.click(screen.getByTestId("decision-option-continue"));

    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-option-continue")).toBeDisabled();
    });
    expect(screen.getByTestId("decision-option-stop")).toBeDisabled();

    resolveAnswer({ ok: true, data: { applied: true } });
    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-success")).toBeInTheDocument();
    });
  });

  test("disables the free-text input and submit button while the fetch is in flight", async () => {
    let resolveAnswer: (
      result: M3LConsoleFetchResult<{ readonly applied: boolean }>,
    ) => void = () => {
      // replaced synchronously by the executor below
    };
    const pendingFetcher = (): Promise<
      M3LConsoleFetchResult<{ readonly applied: boolean }>
    > =>
      new Promise((resolve) => {
        resolveAnswer = resolve;
      });

    render(
      <DecisionPrompt
        decision={PENDING_WITH_NULL_OPTIONS}
        answerSessionDecision={pendingFetcher}
      />,
    );

    fireEvent.change(screen.getByTestId("decision-answer-input"), {
      target: { value: "proceed" },
    });
    fireEvent.click(screen.getByTestId("decision-submit"));

    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-submit")).toBeDisabled();
    });
    expect(screen.getByTestId("decision-answer-input")).toBeDisabled();

    resolveAnswer({ ok: true, data: { applied: true } });
    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-success")).toBeInTheDocument();
    });
  });
});

// --- Regression tests: stale in-flight submit request-identity guard ------
//
// Mirrors the request-identity-guard hazard SessionDetail's `useStepArtifact`
// and `useBindingForm` already cover (a ref holding the "currently relevant"
// id, checked before every setState in an async `.then`/`.catch`, dropping a
// stale result silently): submitting an answer for decision A, then
// re-rendering with a different decision B before A's fetch settles, must
// not let A's later-resolving (or later-rejecting) promise clobber B's state.
describe("DecisionPrompt — stale in-flight submit request-identity guard", () => {
  const DECISION_A: M3LSessionDecisionRecord = {
    id: "decision-stale-a",
    sessionId: "session-stale-a",
    stepId: "step-1",
    prompt: "Decision A: proceed with the risky step?",
    options: ["continue", "stop"],
    createdAtMs: 1_700_000_002_000,
    status: "pending",
  };

  const DECISION_B: M3LSessionDecisionRecord = {
    id: "decision-stale-b",
    sessionId: "session-stale-b",
    stepId: "step-2",
    prompt: "Decision B: continue the follow-up step?",
    options: ["continue", "stop"],
    createdAtMs: 1_700_000_003_000,
    status: "pending",
  };

  test("a stale success for decision A resolving after a re-render with decision B does not show decision-success for B or call onAnswered with A's id", async () => {
    const resolversA =
      Promise.withResolvers<
        M3LConsoleFetchResult<{ readonly applied: boolean }>
      >();
    const resolversB =
      Promise.withResolvers<
        M3LConsoleFetchResult<{ readonly applied: boolean }>
      >();
    const deferredByDecisionId = new Map<
      string,
      Promise<M3LConsoleFetchResult<{ readonly applied: boolean }>>
    >([
      [DECISION_A.id, resolversA.promise],
      [DECISION_B.id, resolversB.promise],
    ]);
    const fetcher = vi.fn(
      (
        _sessionId: string,
        decisionId: string,
        _answer: unknown,
      ): Promise<M3LConsoleFetchResult<{ readonly applied: boolean }>> => {
        const deferred = deferredByDecisionId.get(decisionId);
        if (!deferred) {
          throw new Error(
            `no deferred fetch registered for decision ${decisionId}`,
          );
        }
        return deferred;
      },
    );
    const onAnswered = vi.fn();

    const { rerender } = render(
      <DecisionPrompt
        decision={DECISION_A}
        answerSessionDecision={fetcher}
        onAnswered={onAnswered}
      />,
    );

    fireEvent.click(screen.getByTestId("decision-option-continue"));
    // The sessionId arg (fetcher.mock.calls[0][0]) is intentionally not
    // asserted here — Fix 1, a separate finding, governs whether it's
    // decision.sessionId or the removed prop. This block isolates the
    // request-identity guard by checking only the decisionId/answer args.
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    const initialCall = fetcher.mock.calls[0];
    if (!initialCall) {
      throw new Error("fetcher was not called");
    }
    expect(initialCall[1]).toBe(DECISION_A.id);
    expect(initialCall[2]).toBe("continue");

    rerender(
      <DecisionPrompt
        decision={DECISION_B}
        answerSessionDecision={fetcher}
        onAnswered={onAnswered}
      />,
    );

    // Decision B renders fresh: no leftover success, controls enabled — the
    // re-render must not leave B's controls stuck disabled by A's loading.
    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-option-continue")).not.toBeDisabled();
    });
    expect(screen.queryByTestId("decision-success")).not.toBeInTheDocument();

    resolversA.resolve({ ok: true, data: { applied: true } });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // A's stale success must not leak into B's UI or fire onAnswered for A.
    expect(screen.queryByTestId("decision-success")).not.toBeInTheDocument();
    expect(onAnswered).not.toHaveBeenCalledWith(DECISION_A.id);

    // Decision B's own interaction still works normally afterward.
    fireEvent.click(screen.getByTestId("decision-option-stop"));
    resolversB.resolve({ ok: true, data: { applied: true } });
    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-success")).toBeInTheDocument();
    });
    expect(onAnswered).toHaveBeenCalledWith(DECISION_B.id);
  });

  test("a stale rejection for decision A settling after a re-render with decision B does not show decision-error for B", async () => {
    const resolversA =
      Promise.withResolvers<
        M3LConsoleFetchResult<{ readonly applied: boolean }>
      >();
    const resolversB =
      Promise.withResolvers<
        M3LConsoleFetchResult<{ readonly applied: boolean }>
      >();
    const deferredByDecisionId = new Map<
      string,
      Promise<M3LConsoleFetchResult<{ readonly applied: boolean }>>
    >([
      [DECISION_A.id, resolversA.promise],
      [DECISION_B.id, resolversB.promise],
    ]);
    const fetcher = vi.fn(
      (
        _sessionId: string,
        decisionId: string,
        _answer: unknown,
      ): Promise<M3LConsoleFetchResult<{ readonly applied: boolean }>> => {
        const deferred = deferredByDecisionId.get(decisionId);
        if (!deferred) {
          throw new Error(
            `no deferred fetch registered for decision ${decisionId}`,
          );
        }
        return deferred;
      },
    );
    const onAnswered = vi.fn();

    const { rerender } = render(
      <DecisionPrompt
        decision={DECISION_A}
        answerSessionDecision={fetcher}
        onAnswered={onAnswered}
      />,
    );

    fireEvent.click(screen.getByTestId("decision-option-continue"));
    // The sessionId arg (fetcher.mock.calls[0][0]) is intentionally not
    // asserted here — Fix 1, a separate finding, governs whether it's
    // decision.sessionId or the removed prop. This block isolates the
    // request-identity guard by checking only the decisionId/answer args.
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    const initialCall = fetcher.mock.calls[0];
    if (!initialCall) {
      throw new Error("fetcher was not called");
    }
    expect(initialCall[1]).toBe(DECISION_A.id);
    expect(initialCall[2]).toBe("continue");

    rerender(
      <DecisionPrompt
        decision={DECISION_B}
        answerSessionDecision={fetcher}
        onAnswered={onAnswered}
      />,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-option-continue")).not.toBeDisabled();
    });
    expect(screen.queryByTestId("decision-error")).not.toBeInTheDocument();

    resolversA.reject(new Error("stale failure from decision A"));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // A's stale rejection must not leak into B's UI either.
    expect(screen.queryByTestId("decision-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("decision-option-continue")).not.toBeDisabled();

    // Decision B's own rejection still surfaces its own decision-error.
    fireEvent.click(screen.getByTestId("decision-option-stop"));
    resolversB.reject(new Error("decision B's own failure"));
    await vi.waitFor(() => {
      expect(screen.getByTestId("decision-error").textContent).toContain(
        "decision B's own failure",
      );
    });
  });
});
