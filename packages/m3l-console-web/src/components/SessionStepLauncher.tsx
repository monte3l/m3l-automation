import type { ReactElement } from "react";
import { useRef, useState } from "react";

import type { M3LConsoleFetchResult } from "../api/client.js";
import type { M3LScriptDetail } from "../api/scripts.js";
import { fetchScript as fetchScriptDefault } from "../api/scripts.js";
import type {
  M3LSessionAddStepRequest,
  M3LSessionAddStepResult,
  M3LSessionBindingInput,
  M3LSessionBindingRecord,
  M3LSessionStepRecord,
} from "../api/sessions.js";
import { addSessionStep as addSessionStepDefault } from "../api/sessions.js";
import type { M3LParameterBinding } from "../internal/parameter-bindings.js";
import type { M3LParameterFormSubmission } from "./ParameterForm.js";
import { ParameterForm } from "./ParameterForm.js";

/** Props accepted by {@link SessionStepLauncher}. */
export interface SessionStepLauncherProps {
  /** Id of the session a launched step is added to. */
  readonly sessionId: string;
  /**
   * The session's bindings accumulated so far — only entries carrying a
   * `parameterName` contribute a `ParameterForm` prefill or an
   * `addSessionStep` bindings entry; a legacy binding with no
   * `parameterName` is a harmless no-op here.
   */
  readonly bindings: readonly M3LSessionBindingRecord[];
  /**
   * The concrete value each bound parameter currently resolves to (keyed by
   * `parameterName`), captured client-side when each binding was created —
   * lets the loaded `ParameterForm` prefill without a second network round
   * trip back to the step artifact.
   */
  readonly knownValues: Readonly<Record<string, unknown>>;
  /** Called with the newly-queued step once a launch succeeds. */
  readonly onStepLaunched: (step: M3LSessionStepRecord) => void;
  /**
   * Fetcher used to load the typed operation's script detail. Defaults to
   * the real {@link fetchScript}; injectable so tests can supply a fake
   * without mocking a module.
   */
  readonly fetchScript?: (
    name: string,
  ) => Promise<M3LConsoleFetchResult<M3LScriptDetail>>;
  /**
   * Launcher used to submit the session step. Defaults to the real
   * {@link addSessionStep}; injectable so tests can supply a fake without
   * mocking a module.
   */
  readonly addSessionStep?: (
    sessionId: string,
    input: M3LSessionAddStepRequest,
  ) => Promise<M3LConsoleFetchResult<M3LSessionAddStepResult>>;
}

/** Fetch state for the typed operation's loaded script detail. */
type OperationLoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly detail: M3LScriptDetail }
  | { readonly kind: "error"; readonly message: string };

/** Submission state for the step-launch request. */
type LaunchState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "success" }
  | { readonly kind: "error"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Message shown when {@link buildAddStepRequest} returns `undefined` — the
 * server's own text for `ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED`, reused here
 * since `POST /api/v1/sessions/:id/steps` enforces the identical
 * confirm-a-real-run invariant as `POST /api/v1/runs`.
 */
const CONFIRMATION_REQUIRED_MESSAGE =
  "Confirmation is required for a non-dry-run launch.";

/**
 * Builds the add-step request's `dryRun`/`confirmed` discriminant from a
 * form submission's two independent booleans — mirrors `ScriptDetail.tsx`'s
 * `buildLaunchRequest`. `undefined` signals the illegal combination
 * (`dryRun: false, confirmed: false`), which `ParameterForm`'s own
 * `canSubmit` gate already keeps off the launch button — this is a
 * defensive fallback, not a path any test drives through the UI.
 */
function buildAddStepRequest(
  operation: string,
  bindings: readonly M3LSessionBindingInput[],
  submission: Pick<M3LParameterFormSubmission, "confirmed" | "dryRun">,
): M3LSessionAddStepRequest | undefined {
  if (submission.dryRun) {
    return {
      operation,
      bindings,
      dryRun: true,
      // Always the literal `false` here, never `submission.confirmed` — the
      // union's dry-run member only accepts `confirmed?: false`.
      confirmed: false,
    };
  }
  if (submission.confirmed) {
    return { operation, bindings, dryRun: false, confirmed: true };
  }
  return undefined;
}

/**
 * Projects the bindings carrying a `parameterName` into the
 * {@link M3LParameterBinding} shape `ParameterForm` prefills its controls
 * from, resolving each binding's current value out of `knownValues` rather
 * than re-fetching it. A binding with no `parameterName` (a legacy row, or
 * one never mapped to a launch parameter) contributes nothing.
 */
function buildParameterBindings(
  bindings: readonly M3LSessionBindingRecord[],
  knownValues: Readonly<Record<string, unknown>>,
): M3LParameterBinding[] {
  const result: M3LParameterBinding[] = [];
  for (const binding of bindings) {
    if (binding.parameterName === undefined) {
      continue;
    }
    result.push({
      parameterName: binding.parameterName,
      value: knownValues[binding.parameterName],
      multiSelect: binding.multiSelect,
    });
  }
  return result;
}

/**
 * Projects the bindings carrying a `parameterName` into the
 * {@link M3LSessionBindingInput} shape `addSessionStep` accepts — exactly
 * `{reference, expectedType, multiSelect, parameterName}`, dropping the
 * record-only `id`/`sessionId`/`createdAtMs` fields. A binding with no
 * `parameterName` is dropped rather than sent with an undefined one.
 */
function buildStepBindingsInput(
  bindings: readonly M3LSessionBindingRecord[],
): M3LSessionBindingInput[] {
  const result: M3LSessionBindingInput[] = [];
  for (const binding of bindings) {
    if (binding.parameterName === undefined) {
      continue;
    }
    result.push({
      reference: binding.reference,
      expectedType: binding.expectedType,
      multiSelect: binding.multiSelect,
      parameterName: binding.parameterName,
    });
  }
  return result;
}

/**
 * Loads a typed operation name's script detail, guarding against a stale
 * resolution: `currentRequestNameRef` is set to the requested name before
 * the fetch starts, and both the `.then` and `.catch` callbacks drop their
 * result once a newer load has superseded it, mirroring
 * `SessionDetail.tsx`'s `useStepArtifact`/`useBindingForm` request-identity
 * guards.
 */
function loadOperation(args: {
  readonly name: string;
  readonly fetchScript: (
    name: string,
  ) => Promise<M3LConsoleFetchResult<M3LScriptDetail>>;
  readonly currentRequestNameRef: { current: string | null };
  readonly setOperationState: (state: OperationLoadState) => void;
}): void {
  const { name, fetchScript, currentRequestNameRef, setOperationState } = args;
  currentRequestNameRef.current = name;
  setOperationState({ kind: "loading" });
  fetchScript(name)
    .then((result) => {
      if (currentRequestNameRef.current !== name) {
        return;
      }
      setOperationState(
        result.ok
          ? { kind: "loaded", detail: result.data }
          : { kind: "error", message: result.error.message },
      );
    })
    .catch((caught: unknown) => {
      if (currentRequestNameRef.current !== name) {
        return;
      }
      setOperationState({
        kind: "error",
        message: deriveErrorMessage(caught),
      });
    });
}

/**
 * Submits the loaded operation as a new session step, ignoring
 * `submission.parameters` entirely — a session step takes no free-form
 * parameters (per the server's `POST /api/v1/sessions/:id/steps` route,
 * which accepts only `operation`/`bindings`/`confirmed`/`dryRun`) — and
 * projecting `bindings` into the request's `bindings` field instead.
 *
 * Guards against a stale response clobbering a newer launch's state:
 * `currentLaunchIdRef` is incremented before the request starts, and both
 * the `.then` and `.catch` callbacks drop their result once a later launch
 * has superseded it — mirrors {@link loadOperation}'s own request-identity
 * guard and `DecisionPrompt.tsx`'s `submitAnswer`.
 */
function launchStep(args: {
  readonly sessionId: string;
  readonly operationName: string;
  readonly bindings: readonly M3LSessionBindingRecord[];
  readonly submission: Pick<M3LParameterFormSubmission, "confirmed" | "dryRun">;
  readonly addSessionStep: (
    sessionId: string,
    input: M3LSessionAddStepRequest,
  ) => Promise<M3LConsoleFetchResult<M3LSessionAddStepResult>>;
  readonly onStepLaunched: (step: M3LSessionStepRecord) => void;
  readonly setLaunchState: (state: LaunchState) => void;
  readonly currentLaunchIdRef: { current: number };
}): void {
  const {
    sessionId,
    operationName,
    bindings,
    submission,
    addSessionStep,
    onStepLaunched,
    setLaunchState,
    currentLaunchIdRef,
  } = args;

  const request = buildAddStepRequest(
    operationName,
    buildStepBindingsInput(bindings),
    submission,
  );
  if (request === undefined) {
    setLaunchState({ kind: "error", message: CONFIRMATION_REQUIRED_MESSAGE });
    return;
  }

  const launchId = (currentLaunchIdRef.current += 1);
  setLaunchState({ kind: "loading" });
  addSessionStep(sessionId, request)
    .then((result) => {
      if (currentLaunchIdRef.current !== launchId) {
        return;
      }
      if (!result.ok) {
        setLaunchState({ kind: "error", message: result.error.message });
        return;
      }
      setLaunchState({ kind: "success" });
      onStepLaunched(result.data.step);
    })
    .catch((caught: unknown) => {
      if (currentLaunchIdRef.current !== launchId) {
        return;
      }
      setLaunchState({ kind: "error", message: deriveErrorMessage(caught) });
    });
}

/**
 * Renders the operation-name input, its load button, and the loaded
 * operation's loading/error feedback — extracted to keep
 * {@link SessionStepLauncher} itself short.
 */
function OperationLoader({
  operationName,
  onOperationNameChange,
  operationState,
  onLoad,
}: {
  readonly operationName: string;
  readonly onOperationNameChange: (value: string) => void;
  readonly operationState: OperationLoadState;
  readonly onLoad: () => void;
}): ReactElement {
  return (
    <>
      <label htmlFor="session-step-operation-input">Operation</label>
      <input
        id="session-step-operation-input"
        data-testid="session-step-operation-input"
        type="text"
        value={operationName}
        onChange={(event) => {
          onOperationNameChange(event.target.value);
        }}
      />
      <button
        type="button"
        data-testid="session-step-load-operation"
        onClick={onLoad}
      >
        Load
      </button>
      {operationState.kind === "loading" && (
        <p data-testid="session-step-operation-loading">Loading operation…</p>
      )}
      {operationState.kind === "error" && (
        <p data-testid="session-step-operation-error">
          Error: {operationState.message}
        </p>
      )}
    </>
  );
}

/** Return shape of {@link useSessionStepLauncherState}. */
interface SessionStepLauncherState {
  readonly operationName: string;
  readonly setOperationName: (value: string) => void;
  readonly operationState: OperationLoadState;
  readonly launchState: LaunchState;
  readonly handleLoad: () => void;
  readonly handleLaunch: (
    submission: Pick<M3LParameterFormSubmission, "confirmed" | "dryRun">,
  ) => void;
}

/**
 * Owns every stateful piece of {@link SessionStepLauncher} — the typed
 * operation name, its load state, and the launch submission state —
 * extracted to keep that component itself short.
 */
function useSessionStepLauncherState(
  props: SessionStepLauncherProps,
): SessionStepLauncherState {
  const fetchScript = props.fetchScript ?? fetchScriptDefault;
  const addSessionStep = props.addSessionStep ?? addSessionStepDefault;
  const [operationName, setOperationName] = useState("");
  const [operationState, setOperationState] = useState<OperationLoadState>({
    kind: "idle",
  });
  const [launchState, setLaunchState] = useState<LaunchState>({
    kind: "idle",
  });
  const currentRequestNameRef = useRef<string | null>(null);
  const currentLaunchIdRef = useRef(0);

  function handleLoad(): void {
    setLaunchState({ kind: "idle" });
    loadOperation({
      name: operationName,
      fetchScript,
      currentRequestNameRef,
      setOperationState,
    });
  }

  function handleLaunch(
    submission: Pick<M3LParameterFormSubmission, "confirmed" | "dryRun">,
  ): void {
    if (operationState.kind !== "loaded") {
      return;
    }
    launchStep({
      sessionId: props.sessionId,
      operationName: operationState.detail.name,
      bindings: props.bindings,
      submission,
      addSessionStep,
      onStepLaunched: props.onStepLaunched,
      setLaunchState,
      currentLaunchIdRef,
    });
  }

  return {
    operationName,
    setOperationName,
    operationState,
    launchState,
    handleLoad,
    handleLaunch,
  };
}

/**
 * Lets an operator type an operation name, load its script detail, fill in
 * (or accept the accumulated bindings' prefill of) its parameter form, and
 * launch it as a new step on session `sessionId`.
 *
 * @example
 * ```tsx
 * import { SessionStepLauncher } from "@m3l-automation/m3l-console-web/components/SessionStepLauncher.js";
 *
 * <SessionStepLauncher
 *   sessionId="session-123"
 *   bindings={[]}
 *   knownValues={{}}
 *   onStepLaunched={(step) => console.log(step.id)}
 * />;
 * ```
 */
export function SessionStepLauncher(
  props: SessionStepLauncherProps,
): ReactElement {
  const {
    operationName,
    setOperationName,
    operationState,
    launchState,
    handleLoad,
    handleLaunch,
  } = useSessionStepLauncherState(props);

  return (
    <div data-testid="session-step-launcher">
      <OperationLoader
        operationName={operationName}
        onOperationNameChange={setOperationName}
        operationState={operationState}
        onLoad={handleLoad}
      />
      {operationState.kind === "loaded" && (
        <ParameterForm
          detail={operationState.detail}
          submitting={launchState.kind === "loading"}
          onLaunch={handleLaunch}
          bindings={buildParameterBindings(props.bindings, props.knownValues)}
        />
      )}
      {launchState.kind === "success" && (
        <p data-testid="session-step-launch-success">Step launched.</p>
      )}
      {launchState.kind === "error" && (
        <p data-testid="session-step-launch-error">
          Error: {launchState.message}
        </p>
      )}
    </div>
  );
}
