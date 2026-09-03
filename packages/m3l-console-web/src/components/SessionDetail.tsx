import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import type { M3LConsoleFetchResult } from "../api/client.js";
import type {
  M3LSessionBindingExpectedType,
  M3LSessionBindingInput,
  M3LSessionBindingRecord,
  M3LSessionDecisionRecord,
  M3LSessionRecord,
  M3LSessionStepSummary,
} from "../api/sessions.js";
import {
  createSessionBinding as createSessionBindingDefault,
  fetchSession as fetchSessionDefault,
  fetchSessionDecisions as fetchSessionDecisionsDefault,
  fetchSessionStepArtifact as fetchSessionStepArtifactDefault,
  fetchSessionSteps as fetchSessionStepsDefault,
} from "../api/sessions.js";
import type { M3LTreePathSegment } from "../internal/step-reference.js";
import { buildStepReference } from "../internal/step-reference.js";
import { formatTimestampMs } from "../internal/timestamps.js";
import { JsonTreeViewer } from "./JsonTreeViewer.js";

/** Props accepted by {@link SessionDetail}. */
export interface SessionDetailProps {
  /** Id of the session to load. */
  readonly id: string;
  /**
   * Fetcher used to load the session record. Defaults to the real
   * {@link fetchSession}; injectable so tests can supply a fake without
   * mocking a module.
   */
  readonly fetchSession?: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<M3LSessionRecord>>;
  /**
   * Fetcher used to load the session's steps. Defaults to the real
   * {@link fetchSessionSteps}; injectable so tests can supply a fake without
   * mocking a module.
   */
  readonly fetchSessionSteps?: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<readonly M3LSessionStepSummary[]>>;
  /**
   * Fetcher used to load the session's decisions. Defaults to the real
   * {@link fetchSessionDecisions}; injectable so tests can supply a fake
   * without mocking a module.
   */
  readonly fetchSessionDecisions?: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<readonly M3LSessionDecisionRecord[]>>;
  /**
   * Fetcher used to load one step's result artifact when its "View output"
   * button is clicked. Defaults to the real {@link fetchSessionStepArtifact};
   * injectable so tests can supply a fake without mocking a module.
   */
  readonly fetchSessionStepArtifact?: (
    sessionId: string,
    stepId: string,
  ) => Promise<M3LConsoleFetchResult<unknown>>;
  /**
   * Fetcher used to submit the binding-creation form opened by selecting a
   * node in a step's artifact tree. Defaults to the real
   * {@link createSessionBinding}; injectable so tests can supply a fake
   * without mocking a module.
   */
  readonly createSessionBinding?:
    | ((
        sessionId: string,
        input: M3LSessionBindingInput,
      ) => Promise<M3LConsoleFetchResult<M3LSessionBindingRecord>>)
    | undefined;
}

type SessionDetailState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "loaded";
      readonly session: M3LSessionRecord;
      readonly steps: readonly M3LSessionStepSummary[];
      readonly decisions: readonly M3LSessionDecisionRecord[];
    }
  | { readonly kind: "error"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** Fetch state for the currently-viewed step's result artifact. */
type ArtifactState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly value: unknown }
  | { readonly kind: "error"; readonly message: string };

/** The tree node currently selected for binding creation, if any. */
interface SelectedNode {
  readonly path: readonly M3LTreePathSegment[];
  readonly value: unknown;
}

/** Submission state for the binding-creation form. */
type BindingSubmitState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "success"; readonly parameterName: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * Derives the ADR-0068 `expectedType` tag from a selected value's JS type —
 * every non-string/number/boolean value (arrays, plain objects, `null`)
 * collapses to `"object"`.
 */
function deriveExpectedType(value: unknown): M3LSessionBindingExpectedType {
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  return "object";
}

/**
 * Combines the three parallel fetch results into a single settled state.
 * Error priority — session, then steps, then decisions — matches the order
 * this function checks them in, so a caller reading top-to-bottom sees the
 * same precedence the tests assert.
 */
function toSettledState(
  sessionResult: M3LConsoleFetchResult<M3LSessionRecord>,
  stepsResult: M3LConsoleFetchResult<readonly M3LSessionStepSummary[]>,
  decisionsResult: M3LConsoleFetchResult<readonly M3LSessionDecisionRecord[]>,
): SessionDetailState {
  if (!sessionResult.ok) {
    return { kind: "error", message: sessionResult.error.message };
  }
  if (!stepsResult.ok) {
    return { kind: "error", message: stepsResult.error.message };
  }
  if (!decisionsResult.ok) {
    return { kind: "error", message: decisionsResult.error.message };
  }
  return {
    kind: "loaded",
    session: sessionResult.data,
    steps: stepsResult.data,
    decisions: decisionsResult.data,
  };
}

/** The three fetchers {@link useSessionDetailFetchState} loads in parallel. */
interface SessionDetailFetchers {
  readonly fetchSession: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<M3LSessionRecord>>;
  readonly fetchSessionSteps: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<readonly M3LSessionStepSummary[]>>;
  readonly fetchSessionDecisions: (
    id: string,
  ) => Promise<M3LConsoleFetchResult<readonly M3LSessionDecisionRecord[]>>;
}

/**
 * Owns the combined session/steps/decisions fetch lifecycle — initial load
 * on mount and re-load whenever `id` changes — extracted to keep
 * {@link SessionDetail} itself short. A single `cancelled` flag guards
 * against updating state after unmount or after a newer `id` has superseded
 * this effect run.
 */
function useSessionDetailFetchState(
  id: string,
  fetchers: SessionDetailFetchers,
): SessionDetailState {
  const [state, setState] = useState<SessionDetailState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    Promise.all([
      fetchers.fetchSession(id),
      fetchers.fetchSessionSteps(id),
      fetchers.fetchSessionDecisions(id),
    ])
      .then(([sessionResult, stepsResult, decisionsResult]) => {
        if (cancelled) {
          return;
        }
        setState(toSettledState(sessionResult, stepsResult, decisionsResult));
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        setState({ kind: "error", message: deriveErrorMessage(caught) });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `id` should retrigger the fetch; the fetcher props are treated as stable
  }, [id]);

  return state;
}

/** Renders the `Steps` section, extracted to keep {@link SessionDetailLoaded} short. */
function SessionSteps({
  steps,
  onViewOutput,
}: {
  readonly steps: readonly M3LSessionStepSummary[];
  readonly onViewOutput: (step: M3LSessionStepSummary) => void;
}): ReactElement {
  return (
    <section>
      <h3>Steps</h3>
      {steps.length === 0 ? (
        <p>no steps yet</p>
      ) : (
        <ul>
          {steps.map((step) => (
            // The leading "#" guarantees a non-word character precedes the
            // ordinal regardless of adjacent sibling text — without it, an
            // ordinal immediately following the "Steps" heading's own text
            // node (e.g. "Steps1 — ...") loses its `\b` word boundary.
            <li key={step.id}>
              #{step.ordinal} — {step.operation} — {step.status}
              {step.hasResult && (
                <button
                  type="button"
                  data-testid={`view-output-${step.id}`}
                  onClick={() => {
                    onViewOutput(step);
                  }}
                >
                  View output
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Renders the fetched step artifact (or its loading/error state) inside a JSON tree viewer. */
function StepArtifactPanel({
  artifactState,
  onSelect,
}: {
  readonly artifactState: ArtifactState;
  readonly onSelect: (
    path: readonly M3LTreePathSegment[],
    value: unknown,
  ) => void;
}): ReactElement {
  return (
    <div data-testid="step-artifact-viewer">
      {artifactState.kind === "loading" && <p>Loading output…</p>}
      {artifactState.kind === "error" && <p>Error: {artifactState.message}</p>}
      {artifactState.kind === "loaded" && (
        <JsonTreeViewer value={artifactState.value} onSelect={onSelect} />
      )}
    </div>
  );
}

/**
 * Renders the binding-creation form opened after selecting a tree node —
 * submitting it invokes `onSubmit`, which the caller has already bound to
 * the selected step/node so this component stays a pure controlled form.
 */
function BindingForm({
  parameterName,
  onParameterNameChange,
  multiSelect,
  onMultiSelectChange,
  bindingState,
  onSubmit,
}: {
  readonly parameterName: string;
  readonly onParameterNameChange: (value: string) => void;
  readonly multiSelect: boolean;
  readonly onMultiSelectChange: (value: boolean) => void;
  readonly bindingState: BindingSubmitState;
  readonly onSubmit: () => void;
}): ReactElement {
  return (
    <form
      data-testid="binding-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label>
        Parameter name
        <input
          type="text"
          data-testid="binding-parameter-name-input"
          value={parameterName}
          onChange={(event) => onParameterNameChange(event.target.value)}
        />
      </label>
      <label>
        Multi-select
        <input
          type="checkbox"
          data-testid="binding-multi-select-checkbox"
          checked={multiSelect}
          onChange={(event) => onMultiSelectChange(event.target.checked)}
        />
      </label>
      <button
        type="submit"
        data-testid="binding-submit"
        disabled={bindingState.kind === "loading"}
      >
        Create binding
      </button>
      {bindingState.kind === "success" && (
        <p data-testid="binding-success">
          Binding created for {bindingState.parameterName}
        </p>
      )}
      {bindingState.kind === "error" && (
        <p data-testid="binding-error">Error: {bindingState.message}</p>
      )}
    </form>
  );
}

/** Renders the `Decisions` section, extracted to keep {@link SessionDetailLoaded} short. */
function SessionDecisions({
  decisions,
}: {
  readonly decisions: readonly M3LSessionDecisionRecord[];
}): ReactElement {
  return (
    <section>
      <h3>Decisions</h3>
      {decisions.length === 0 ? (
        <p>no decisions yet</p>
      ) : (
        <ul>
          {decisions.map((decision) => (
            <li key={decision.id}>
              {decision.prompt} — {decision.status}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Renders a loaded session's fields, steps, and decisions, extracted to
 * keep {@link SessionDetail} itself short.
 */
function SessionDetailLoaded({
  session,
  steps,
  decisions,
  onViewOutput,
}: {
  readonly session: M3LSessionRecord;
  readonly steps: readonly M3LSessionStepSummary[];
  readonly decisions: readonly M3LSessionDecisionRecord[];
  readonly onViewOutput: (step: M3LSessionStepSummary) => void;
}): ReactElement {
  return (
    <>
      <h2>{session.id}</h2>
      <p>Status: {session.status}</p>
      <p>Operator: {session.operator}</p>
      <p>Created: {formatTimestampMs(session.createdAtMs)}</p>
      <p>Updated: {formatTimestampMs(session.updatedAtMs)}</p>
      {session.status === "closed" && (
        <p>Closed: {formatTimestampMs(session.closedAtMs)}</p>
      )}
      <SessionSteps steps={steps} onViewOutput={onViewOutput} />
      <SessionDecisions decisions={decisions} />
    </>
  );
}

/**
 * Owns the currently-viewed step and its artifact fetch state — extracted to
 * keep {@link SessionDetail} itself short.
 *
 * Two hazards a naive `fetchStepArtifact(...).then(setArtifactState)` would
 * not guard against: (1) selecting step B while step A's fetch is still
 * pending must not let A's later-resolving result clobber B's — a
 * `latestRequestedStepId` ref, set synchronously before the fetch starts and
 * checked before every `setArtifactState` in the async callbacks, drops a
 * superseded result silently; (2) switching `id` (session) must not leave
 * the previous session's step/artifact visible — the `useEffect` below
 * resets both on every `id` change, mirroring {@link
 * useSessionDetailFetchState}'s own reset.
 */
function useStepArtifact(
  id: string,
  fetchStepArtifact: (
    sessionId: string,
    stepId: string,
  ) => Promise<M3LConsoleFetchResult<unknown>>,
) {
  const [selectedStep, setSelectedStep] =
    useState<M3LSessionStepSummary | null>(null);
  const [artifactState, setArtifactState] = useState<ArtifactState>({
    kind: "idle",
  });
  const latestRequestedStepId = useRef<string | null>(null);

  useEffect(() => {
    latestRequestedStepId.current = null;
    setSelectedStep(null);
    setArtifactState({ kind: "idle" });
  }, [id]);

  function viewOutput(step: M3LSessionStepSummary): void {
    latestRequestedStepId.current = step.id;
    setSelectedStep(step);
    setArtifactState({ kind: "loading" });
    fetchStepArtifact(id, step.id)
      .then((result) => {
        if (latestRequestedStepId.current !== step.id) {
          return;
        }
        setArtifactState(
          result.ok
            ? { kind: "loaded", value: result.data }
            : { kind: "error", message: result.error.message },
        );
      })
      .catch((caught: unknown) => {
        if (latestRequestedStepId.current !== step.id) {
          return;
        }
        setArtifactState({
          kind: "error",
          message: deriveErrorMessage(caught),
        });
      });
  }

  return { selectedStep, artifactState, viewOutput };
}

/**
 * Resets the three ancillary binding-form fields (parameter name,
 * multi-select, submission state) shared by {@link useBindingForm}'s
 * `resetSelection` and `selectNode` — extracted so neither duplicates these
 * three calls inline and `useBindingForm` itself stays short.
 */
function resetBindingFormFields(
  setParameterName: (value: string) => void,
  setMultiSelect: (value: boolean) => void,
  setBindingState: (state: BindingSubmitState) => void,
): void {
  setParameterName("");
  setMultiSelect(false);
  setBindingState({ kind: "idle" });
}

/**
 * Builds the step reference for {@link useBindingForm}'s `submit`, guarding
 * the `buildStepReference` call — which throws `M3LStepReferenceError` for a
 * malformed path (e.g. a `__proto__` key) — so a throw surfaces as a
 * `bindingState` error instead of escaping the event handler and leaving the
 * form stuck on `"loading"`. Returns `undefined` on failure (state has
 * already been set, guarded by the same request-identity check as {@link
 * submitBindingRequest}); extracted to keep `useBindingForm` itself short.
 */
function resolveBindingReference(
  step: M3LSessionStepSummary,
  node: SelectedNode,
  currentNodeRef: { current: SelectedNode | null },
  setBindingState: (state: BindingSubmitState) => void,
): string | undefined {
  try {
    return buildStepReference(step.ordinal, node.path);
  } catch (caught) {
    if (currentNodeRef.current === node) {
      setBindingState({ kind: "error", message: deriveErrorMessage(caught) });
    }
    return undefined;
  }
}

/**
 * Performs the `createBinding` network call on behalf of {@link
 * useBindingForm}'s `submit`, dropping the settled result silently when
 * `currentNodeRef` no longer points at `node` by the time it resolves — the
 * request-identity guard against a stale response clobbering whatever node
 * is now selected. Extracted to keep `useBindingForm` itself short.
 */
function submitBindingRequest(args: {
  readonly sessionId: string;
  readonly node: SelectedNode;
  readonly reference: string;
  readonly expectedType: M3LSessionBindingExpectedType;
  readonly multiSelect: boolean;
  readonly parameterName: string;
  readonly createBinding: (
    sessionId: string,
    input: M3LSessionBindingInput,
  ) => Promise<M3LConsoleFetchResult<M3LSessionBindingRecord>>;
  readonly currentNodeRef: { current: SelectedNode | null };
  readonly setBindingState: (state: BindingSubmitState) => void;
}): void {
  const {
    sessionId,
    node,
    reference,
    expectedType,
    multiSelect,
    parameterName,
    createBinding,
    currentNodeRef,
    setBindingState,
  } = args;

  createBinding(sessionId, {
    reference,
    expectedType,
    multiSelect,
    parameterName,
  })
    .then((result) => {
      if (currentNodeRef.current !== node) {
        return;
      }
      setBindingState(
        result.ok
          ? { kind: "success", parameterName }
          : { kind: "error", message: result.error.message },
      );
    })
    .catch((caught: unknown) => {
      if (currentNodeRef.current !== node) {
        return;
      }
      setBindingState({ kind: "error", message: deriveErrorMessage(caught) });
    });
}

/**
 * Runs {@link useBindingForm}'s whole submit sequence — resolving the
 * reference, then dispatching the network call — extracted (along with
 * {@link resolveBindingReference} and {@link submitBindingRequest}) so the
 * hook itself stays short.
 */
function performBindingSubmit(args: {
  readonly sessionId: string;
  readonly step: M3LSessionStepSummary;
  readonly node: SelectedNode;
  readonly multiSelect: boolean;
  readonly parameterName: string;
  readonly createBinding: (
    sessionId: string,
    input: M3LSessionBindingInput,
  ) => Promise<M3LConsoleFetchResult<M3LSessionBindingRecord>>;
  readonly currentNodeRef: { current: SelectedNode | null };
  readonly setBindingState: (state: BindingSubmitState) => void;
}): void {
  const {
    sessionId,
    step,
    node,
    multiSelect,
    parameterName,
    createBinding,
    currentNodeRef,
    setBindingState,
  } = args;

  setBindingState({ kind: "loading" });
  const reference = resolveBindingReference(
    step,
    node,
    currentNodeRef,
    setBindingState,
  );
  if (reference === undefined) {
    return;
  }

  submitBindingRequest({
    sessionId,
    node,
    reference,
    expectedType: deriveExpectedType(node.value),
    multiSelect,
    parameterName,
    createBinding,
    currentNodeRef,
    setBindingState,
  });
}

/**
 * Owns the "select a tree node, fill in and submit a binding" form state —
 * extracted to keep {@link SessionDetail} itself short. Selecting a new node
 * resets the form fields, so an operator never submits against a stale
 * selection.
 *
 * Three hazards beyond the happy path: (1) `buildStepReference` throws
 * `M3LStepReferenceError` for a malformed path (e.g. a `__proto__` key) —
 * that call is wrapped so a throw surfaces as a `bindingState` error instead
 * of escaping the event handler and leaving the form stuck on `"loading"`;
 * (2) submitting for node A, then selecting/deselecting a different node B
 * before A's request resolves, must not let A's later result clobber B's —
 * `currentNodeRef` tracks the node object identity currently selected
 * (updated by {@link selectNode}/{@link resetSelection}), and the async
 * callbacks drop their result when it no longer matches; (3) switching `id`
 * (session) must reset the whole form, mirroring {@link
 * useSessionDetailFetchState}'s own reset.
 */
function useBindingForm(
  id: string,
  createBinding: (
    sessionId: string,
    input: M3LSessionBindingInput,
  ) => Promise<M3LConsoleFetchResult<M3LSessionBindingRecord>>,
) {
  const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(null);
  const [parameterName, setParameterName] = useState("");
  const [multiSelect, setMultiSelect] = useState(false);
  const [bindingState, setBindingState] = useState<BindingSubmitState>({
    kind: "idle",
  });
  const currentNodeRef = useRef<SelectedNode | null>(null);

  function resetSelection(): void {
    currentNodeRef.current = null;
    setSelectedNode(null);
    resetBindingFormFields(setParameterName, setMultiSelect, setBindingState);
  }

  useEffect(() => {
    resetSelection();
  }, [id]);

  function selectNode(
    path: readonly M3LTreePathSegment[],
    value: unknown,
  ): void {
    const node: SelectedNode = { path, value };
    currentNodeRef.current = node;
    setSelectedNode(node);
    resetBindingFormFields(setParameterName, setMultiSelect, setBindingState);
  }

  function submit(step: M3LSessionStepSummary, node: SelectedNode): void {
    performBindingSubmit({
      sessionId: id,
      step,
      node,
      multiSelect,
      parameterName,
      createBinding,
      currentNodeRef,
      setBindingState,
    });
  }

  return {
    selectedNode,
    parameterName,
    multiSelect,
    bindingState,
    setParameterName,
    setMultiSelect,
    resetSelection,
    selectNode,
    submit,
  };
}

/**
 * Renders the "Output" section shown once a step's output has been
 * requested: the artifact panel, and — once a tree node is selected — the
 * binding-creation form. Extracted to keep {@link SessionDetail} itself
 * short.
 */
function StepOutputSection({
  selectedStep,
  artifactState,
  binding,
}: {
  readonly selectedStep: M3LSessionStepSummary;
  readonly artifactState: ArtifactState;
  readonly binding: ReturnType<typeof useBindingForm>;
}): ReactElement {
  return (
    <section>
      <h3>Output</h3>
      <StepArtifactPanel
        artifactState={artifactState}
        onSelect={binding.selectNode}
      />
      {binding.selectedNode && (
        <BindingForm
          parameterName={binding.parameterName}
          onParameterNameChange={binding.setParameterName}
          multiSelect={binding.multiSelect}
          onMultiSelectChange={binding.setMultiSelect}
          bindingState={binding.bindingState}
          onSubmit={() => {
            if (binding.selectedNode) {
              binding.submit(selectedStep, binding.selectedNode);
            }
          }}
        />
      )}
    </section>
  );
}

/**
 * Loads and renders a single session's detail: id, status, operator,
 * timing, its steps, and its decisions. Reloads all three whenever `id`
 * changes.
 *
 * @example
 * ```tsx
 * import { SessionDetail } from "@m3l-automation/m3l-console-web/components/SessionDetail.js";
 *
 * <SessionDetail id="session-123" />;
 * ```
 */
export function SessionDetail(props: SessionDetailProps): ReactElement {
  const { id } = props;
  const fetchers: SessionDetailFetchers = {
    fetchSession: props.fetchSession ?? fetchSessionDefault,
    fetchSessionSteps: props.fetchSessionSteps ?? fetchSessionStepsDefault,
    fetchSessionDecisions:
      props.fetchSessionDecisions ?? fetchSessionDecisionsDefault,
  };
  const state = useSessionDetailFetchState(id, fetchers);
  const artifact = useStepArtifact(
    id,
    props.fetchSessionStepArtifact ?? fetchSessionStepArtifactDefault,
  );
  const binding = useBindingForm(
    id,
    props.createSessionBinding ?? createSessionBindingDefault,
  );

  function handleViewOutput(step: M3LSessionStepSummary): void {
    binding.resetSelection();
    artifact.viewOutput(step);
  }

  return (
    <div data-testid="session-detail">
      {state.kind === "loading" && <p>Loading session…</p>}
      {state.kind === "error" && <p>Error: {state.message}</p>}
      {state.kind === "loaded" && (
        <SessionDetailLoaded
          session={state.session}
          steps={state.steps}
          decisions={state.decisions}
          onViewOutput={handleViewOutput}
        />
      )}
      {artifact.selectedStep && (
        <StepOutputSection
          selectedStep={artifact.selectedStep}
          artifactState={artifact.artifactState}
          binding={binding}
        />
      )}
    </div>
  );
}
