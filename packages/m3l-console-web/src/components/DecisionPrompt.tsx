import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import type { M3LSessionDecisionRecord } from "../api/sessions.js";
import { answerSessionDecision as answerSessionDecisionDefault } from "../api/sessions.js";

/** Props accepted by {@link DecisionPrompt}. */
export interface DecisionPromptProps {
  /** The decision record to prompt for (or display the recorded answer of). */
  readonly decision: M3LSessionDecisionRecord;
  /** Called with the decision's id once an answer has been successfully applied. */
  readonly onAnswered?: (decisionId: string) => void;
  /**
   * Fetcher used to submit an answer. Defaults to the real
   * {@link answerSessionDecision}; injectable so tests can supply a fake
   * without mocking a module.
   */
  readonly answerSessionDecision?: typeof answerSessionDecisionDefault;
}

/** Submission state for the currently-pending decision's answer. */
type SubmitState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "success" }
  | { readonly kind: "not-applied" }
  | { readonly kind: "error"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Whether `value` is a non-empty array of strings — the shape that renders
 * one option button per element. Any other shape (`null`, a non-array, an
 * array containing a non-string, or an empty array) falls back to the
 * free-text input.
 */
function isStringOptionList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((option) => typeof option === "string")
  );
}

/**
 * Submits `answer` for `decision`, driving `setState` through the
 * loading/success/not-applied/error lifecycle. A rejecting `fetcher` is
 * caught so it surfaces as the same `"error"` state as an `ok: false`
 * result, rather than an unhandled rejection.
 *
 * Guards against a stale result the same way `SessionDetail.tsx`'s
 * `useStepArtifact` does: `currentDecisionIdRef` is set to `decision.id`
 * before the fetch starts, and every `setState`/`onAnswered` call in the
 * `.then`/`.catch` callbacks first checks the ref still matches the
 * `decisionId` captured when THIS submit began — if a re-render has since
 * moved the component on to a different decision, the stale result is
 * dropped silently instead of clobbering the new decision's state.
 */
function submitAnswer(args: {
  readonly decision: M3LSessionDecisionRecord;
  readonly answer: unknown;
  readonly fetcher: typeof answerSessionDecisionDefault;
  readonly onAnswered: ((decisionId: string) => void) | undefined;
  readonly setState: (state: SubmitState) => void;
  readonly currentDecisionIdRef: { current: string };
}): void {
  const {
    decision,
    answer,
    fetcher,
    onAnswered,
    setState,
    currentDecisionIdRef,
  } = args;
  const decisionId = decision.id;
  currentDecisionIdRef.current = decisionId;
  setState({ kind: "loading" });
  fetcher(decision.sessionId, decisionId, answer)
    .then((result) => {
      if (currentDecisionIdRef.current !== decisionId) {
        return;
      }
      if (!result.ok) {
        setState({ kind: "error", message: result.error.message });
        return;
      }
      if (result.data.applied) {
        setState({ kind: "success" });
        onAnswered?.(decisionId);
        return;
      }
      setState({ kind: "not-applied" });
    })
    .catch((caught: unknown) => {
      if (currentDecisionIdRef.current !== decisionId) {
        return;
      }
      setState({ kind: "error", message: deriveErrorMessage(caught) });
    });
}

/** Renders the submission state's feedback markup, shared by both answer-control branches. */
function SubmitFeedback({
  state,
}: {
  readonly state: SubmitState;
}): ReactElement | null {
  if (state.kind === "success") {
    return <p data-testid="decision-success">Answer applied.</p>;
  }
  if (state.kind === "not-applied") {
    return (
      <p data-testid="decision-not-applied">Answer recorded, not applied.</p>
    );
  }
  if (state.kind === "error") {
    return <p data-testid="decision-error">Error: {state.message}</p>;
  }
  return null;
}

/**
 * Renders one `<button>` per option, disabled while `submitting`; clicking
 * an option immediately submits it as the answer.
 */
function OptionButtons({
  options,
  submitting,
  onSelect,
}: {
  readonly options: readonly string[];
  readonly submitting: boolean;
  readonly onSelect: (option: string) => void;
}): ReactElement {
  return (
    <>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          data-testid={`decision-option-${option}`}
          disabled={submitting}
          onClick={() => {
            onSelect(option);
          }}
        >
          {option}
        </button>
      ))}
    </>
  );
}

/**
 * Renders the free-text answer input plus its submit button, disabled while
 * `submitting`.
 */
function FreeTextAnswer({
  submitting,
  onSubmit,
}: {
  readonly submitting: boolean;
  readonly onSubmit: (text: string) => void;
}): ReactElement {
  const [text, setText] = useState("");
  return (
    <>
      <input
        data-testid="decision-answer-input"
        type="text"
        value={text}
        disabled={submitting}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <button
        type="button"
        data-testid="decision-submit"
        disabled={submitting}
        onClick={() => {
          onSubmit(text);
        }}
      >
        Answer
      </button>
    </>
  );
}

/**
 * Prompts an operator to answer a session decision — presentational form
 * that submits directly via `answerSessionDecision`. An already-answered
 * decision renders read-only (its recorded answer, no controls); a pending
 * decision with a non-empty string-array `options` renders one option
 * button per option; any other `options` shape falls back to a free-text
 * input.
 *
 * Re-rendering with a different `decision` (a different `decision.id`)
 * resets the local submit state back to idle immediately — the controls for
 * the new decision become interactive right away, rather than staying
 * disabled/loading until a previous decision's still-in-flight submit
 * settles. See {@link submitAnswer} for the matching guard on the async
 * side.
 *
 * @example
 * ```tsx
 * import { DecisionPrompt } from "@m3l-automation/m3l-console-web/components/DecisionPrompt.js";
 *
 * <DecisionPrompt
 *   decision={decision}
 *   onAnswered={(decisionId) => console.log(`answered ${decisionId}`)}
 * />;
 * ```
 */
export function DecisionPrompt(props: DecisionPromptProps): ReactElement {
  const { decision, onAnswered } = props;
  const fetcher = props.answerSessionDecision ?? answerSessionDecisionDefault;
  const [state, setState] = useState<SubmitState>({ kind: "idle" });
  const currentDecisionIdRef = useRef(decision.id);

  useEffect(() => {
    currentDecisionIdRef.current = decision.id;
    setState({ kind: "idle" });
  }, [decision.id]);

  const submitting = state.kind === "loading";

  function handleAnswer(answer: unknown): void {
    submitAnswer({
      decision,
      answer,
      fetcher,
      onAnswered,
      setState,
      currentDecisionIdRef,
    });
  }

  return (
    <div data-testid="decision-prompt">
      <p>{decision.prompt}</p>
      {decision.status === "answered" ? (
        <p data-testid="decision-answered">
          Answered: {String(decision.answer)}
        </p>
      ) : (
        <>
          {isStringOptionList(decision.options) ? (
            <OptionButtons
              options={decision.options}
              submitting={submitting}
              onSelect={handleAnswer}
            />
          ) : (
            <FreeTextAnswer submitting={submitting} onSubmit={handleAnswer} />
          )}
          <SubmitFeedback state={state} />
        </>
      )}
    </div>
  );
}
