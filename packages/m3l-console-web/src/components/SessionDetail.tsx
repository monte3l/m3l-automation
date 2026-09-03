import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import type { M3LConsoleFetchResult } from "../api/client.js";
import { fetchScript as fetchScriptDefault } from "../api/scripts.js";
import type {
  M3LSessionBindingInput,
  M3LSessionBindingRecord,
  M3LSessionDecisionRecord,
  M3LSessionRecord,
  M3LSessionStepSummary,
} from "../api/sessions.js";
import {
  addSessionStep as addSessionStepDefault,
  answerSessionDecision as answerSessionDecisionDefault,
  createSessionBinding as createSessionBindingDefault,
  fetchSession as fetchSessionDefault,
  fetchSessionDecisions as fetchSessionDecisionsDefault,
  fetchSessionStepArtifact as fetchSessionStepArtifactDefault,
  fetchSessionSteps as fetchSessionStepsDefault,
} from "../api/sessions.js";
import type { M3LTreePathSegment } from "../internal/step-reference.js";
import { useBindingForm } from "../internal/session-binding-form.js";
import { formatTimestampMs } from "../internal/timestamps.js";
import { BindingForm } from "./SessionBindingForm.js";
import { DecisionPrompt } from "./DecisionPrompt.js";
import { JsonTreeViewer } from "./JsonTreeViewer.js";
import { SessionStepLauncher } from "./SessionStepLauncher.js";

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
  /**
   * Fetcher used by the embedded {@link SessionStepLauncher} to load a typed
   * operation's script detail. Defaults to the real `fetchScript`;
   * injectable so tests can supply a fake without mocking a module.
   */
  readonly fetchScript?: typeof fetchScriptDefault;
  /**
   * Launcher used by the embedded {@link SessionStepLauncher} to queue a new
   * session step. Defaults to the real `addSessionStep`; injectable so
   * tests can supply a fake without mocking a module.
   */
  readonly addSessionStep?: typeof addSessionStepDefault;
  /**
   * Fetcher used by each rendered {@link DecisionPrompt} to submit an
   * answer. Defaults to the real `answerSessionDecision`; injectable so
   * tests can supply a fake without mocking a module.
   */
  readonly answerSessionDecision?: typeof answerSessionDecisionDefault;
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

/**
 * Merges `key`/`value` into `previous`, built on `Object.create(null)`
 * rather than object-spread — same hazard `ParameterForm.tsx`'s
 * `buildInitialValues` guards against: a caller-supplied `key` literally
 * `"__proto__"` hits `Object.prototype`'s own accessor setter under a
 * plain-object spread-then-bracket-assign and silently changes the
 * object's prototype instead of becoming an own property.
 */
function withKnownValue(
  previous: Readonly<Record<string, unknown>>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const next: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [existingKey, existingValue] of Object.entries(previous)) {
    next[existingKey] = existingValue;
  }
  next[key] = value;
  return next;
}

/** Fetch state for the currently-viewed step's result artifact. */
type ArtifactState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly value: unknown }
  | { readonly kind: "error"; readonly message: string };

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

/** Return shape of {@link useSessionDetailFetchState}. */
interface SessionDetailFetchStateResult {
  readonly state: SessionDetailState;
  /** Re-runs the same fetch sequence on demand, not just on `id` change. */
  readonly reload: () => void;
}

/**
 * Owns the combined session/steps/decisions fetch lifecycle — initial load
 * on mount, re-load whenever `id` changes, and an on-demand {@link
 * SessionDetailFetchStateResult.reload} a caller can trigger after a
 * mutation (a step launch, a decision answer) — extracted to keep
 * {@link SessionDetail} itself short. A monotonic request token (rather than
 * a single `cancelled` flag) guards against a stale in-flight fetch —
 * superseded by unmount, an `id` change, or a later `reload()` call —
 * clobbering a newer one's state.
 */
function useSessionDetailFetchState(
  id: string,
  fetchers: SessionDetailFetchers,
): SessionDetailFetchStateResult {
  const [state, setState] = useState<SessionDetailState>({ kind: "loading" });
  const requestTokenRef = useRef(0);

  function runFetch(): void {
    const token = (requestTokenRef.current += 1);
    setState({ kind: "loading" });

    Promise.all([
      fetchers.fetchSession(id),
      fetchers.fetchSessionSteps(id),
      fetchers.fetchSessionDecisions(id),
    ])
      .then(([sessionResult, stepsResult, decisionsResult]) => {
        if (requestTokenRef.current !== token) {
          return;
        }
        setState(toSettledState(sessionResult, stepsResult, decisionsResult));
      })
      .catch((caught: unknown) => {
        if (requestTokenRef.current !== token) {
          return;
        }
        setState({ kind: "error", message: deriveErrorMessage(caught) });
      });
  }

  useEffect(() => {
    runFetch();
    return () => {
      // Invalidates any fetch still in flight for this `id` — either the
      // component unmounted, or a new `id` is about to start its own fetch.
      requestTokenRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `id` should retrigger the fetch; the fetcher props are treated as stable
  }, [id]);

  return { state, reload: runFetch };
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

/** Renders the `Decisions` section, extracted to keep {@link SessionDetailLoaded} short. */
function SessionDecisions({
  decisions,
  answerSessionDecision,
  onAnswered,
}: {
  readonly decisions: readonly M3LSessionDecisionRecord[];
  readonly answerSessionDecision: typeof answerSessionDecisionDefault;
  readonly onAnswered: () => void;
}): ReactElement {
  return (
    <section>
      <h3>Decisions</h3>
      {decisions.length === 0 ? (
        <p>no decisions yet</p>
      ) : (
        decisions.map((decision) => (
          <DecisionPrompt
            key={decision.id}
            decision={decision}
            answerSessionDecision={answerSessionDecision}
            onAnswered={onAnswered}
          />
        ))
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
  answerSessionDecision,
  onDecisionAnswered,
}: {
  readonly session: M3LSessionRecord;
  readonly steps: readonly M3LSessionStepSummary[];
  readonly decisions: readonly M3LSessionDecisionRecord[];
  readonly onViewOutput: (step: M3LSessionStepSummary) => void;
  readonly answerSessionDecision: typeof answerSessionDecisionDefault;
  readonly onDecisionAnswered: () => void;
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
      <SessionDecisions
        decisions={decisions}
        answerSessionDecision={answerSessionDecision}
        onAnswered={onDecisionAnswered}
      />
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
 * Owns the session's accumulated bindings and the concrete value each bound
 * parameter currently resolves to, fed into the embedded
 * {@link SessionStepLauncher} — extracted to keep {@link SessionDetail}
 * itself short. Both reset whenever `id` changes, mirroring {@link
 * useSessionDetailFetchState}'s own reset.
 */
function useSessionBindingAccumulator(id: string): {
  readonly sessionBindings: readonly M3LSessionBindingRecord[];
  readonly knownValues: Readonly<Record<string, unknown>>;
  readonly onCreated: (record: M3LSessionBindingRecord, value: unknown) => void;
} {
  const [sessionBindings, setSessionBindings] = useState<
    readonly M3LSessionBindingRecord[]
  >([]);
  const [knownValues, setKnownValues] = useState<Record<string, unknown>>(
    () => Object.create(null) as Record<string, unknown>,
  );

  useEffect(() => {
    setSessionBindings([]);
    setKnownValues(Object.create(null) as Record<string, unknown>);
  }, [id]);

  function onCreated(record: M3LSessionBindingRecord, value: unknown): void {
    setSessionBindings((previous) => [...previous, record]);
    if (record.parameterName !== undefined) {
      const parameterName = record.parameterName;
      setKnownValues((previous) =>
        withKnownValue(previous, parameterName, value),
      );
    }
  }

  return { sessionBindings, knownValues, onCreated };
}

/** Every dependency {@link SessionDetail} resolves from its (all-optional) props, defaulted to the real API imports. */
interface SessionDetailDependencies {
  readonly fetchers: SessionDetailFetchers;
  readonly fetchSessionStepArtifact: (
    sessionId: string,
    stepId: string,
  ) => Promise<M3LConsoleFetchResult<unknown>>;
  readonly createSessionBinding: (
    sessionId: string,
    input: M3LSessionBindingInput,
  ) => Promise<M3LConsoleFetchResult<M3LSessionBindingRecord>>;
  readonly answerSessionDecision: typeof answerSessionDecisionDefault;
  readonly fetchScript: typeof fetchScriptDefault;
  readonly addSessionStep: typeof addSessionStepDefault;
}

/**
 * Resolves every injectable dependency {@link SessionDetail} accepts to its
 * real-API default, extracted purely to keep that component's own
 * cyclomatic complexity down (each `??` fallback is its own branch).
 */
function resolveSessionDetailDependencies(
  props: SessionDetailProps,
): SessionDetailDependencies {
  return {
    fetchers: {
      fetchSession: props.fetchSession ?? fetchSessionDefault,
      fetchSessionSteps: props.fetchSessionSteps ?? fetchSessionStepsDefault,
      fetchSessionDecisions:
        props.fetchSessionDecisions ?? fetchSessionDecisionsDefault,
    },
    fetchSessionStepArtifact:
      props.fetchSessionStepArtifact ?? fetchSessionStepArtifactDefault,
    createSessionBinding:
      props.createSessionBinding ?? createSessionBindingDefault,
    answerSessionDecision:
      props.answerSessionDecision ?? answerSessionDecisionDefault,
    fetchScript: props.fetchScript ?? fetchScriptDefault,
    addSessionStep: props.addSessionStep ?? addSessionStepDefault,
  };
}

/**
 * Loads and renders a single session's detail: id, status, operator,
 * timing, its steps, its decisions, a step launcher, and (once a step's
 * output has been requested) that step's result artifact and
 * binding-creation form. Reloads session/steps/decisions whenever `id`
 * changes, or whenever a step is launched or a decision is answered.
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
  const deps = resolveSessionDetailDependencies(props);
  const { state, reload } = useSessionDetailFetchState(id, deps.fetchers);
  const artifact = useStepArtifact(id, deps.fetchSessionStepArtifact);
  const { sessionBindings, knownValues, onCreated } =
    useSessionBindingAccumulator(id);
  const binding = useBindingForm(id, deps.createSessionBinding, onCreated);

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
          answerSessionDecision={deps.answerSessionDecision}
          onDecisionAnswered={reload}
        />
      )}
      {artifact.selectedStep && (
        <StepOutputSection
          selectedStep={artifact.selectedStep}
          artifactState={artifact.artifactState}
          binding={binding}
        />
      )}
      <SessionStepLauncher
        sessionId={id}
        bindings={sessionBindings}
        knownValues={knownValues}
        onStepLaunched={reload}
        fetchScript={deps.fetchScript}
        addSessionStep={deps.addSessionStep}
      />
    </div>
  );
}
