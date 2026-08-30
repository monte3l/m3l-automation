import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import type { M3LConsoleFetchResult } from "../api/client.js";
import type { M3LRunHandle, M3LRunLaunchRequest } from "../api/runs.js";
import { launchRun as launchRunDefault } from "../api/runs.js";
import type { M3LScriptDetail, M3LScriptParameter } from "../api/scripts.js";
import { fetchScript as fetchScriptDefault } from "../api/scripts.js";
import type { M3LParameterFormSubmission } from "./ParameterForm.js";
import { ParameterForm } from "./ParameterForm.js";

/**
 * Console error codes a launch attempt can surface, mapped to
 * operator-legible text rather than the raw code. Any other code falls
 * back to the envelope's own `message`.
 */
// These codes are raw string literals duplicated from the console server's
// own raw-literal error codes (console-web deliberately does not depend on
// console-server, so there is no shared enum/type to bind them at compile
// time). A server-side rename silently degrades this mapping to the raw
// `message` fallback below rather than failing to build — accepted per
// X10d review; a future shared-codes package is where this would be
// resolved.
const LAUNCH_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED:
    "Confirmation is required for a non-dry-run launch.",
  ERR_CONSOLE_RUN_CAPACITY_EXCEEDED: "The run queue is full — retry later.",
};

/**
 * Maps a launch failure to operator-legible text. A recognised code (queue
 * capacity, missing confirmation) gets fixed, friendly wording; anything
 * else falls back to the envelope's own `message` rather than a raw code.
 */
function describeLaunchError(error: {
  readonly code?: string;
  readonly message: string;
}): string {
  const mapped =
    error.code !== undefined ? LAUNCH_ERROR_MESSAGES[error.code] : undefined;
  return mapped ?? error.message;
}

/** Props accepted by {@link ScriptDetail}. */
export interface ScriptDetailProps {
  /** Name of the script to load. */
  readonly name: string;
  /**
   * Fetcher used to load the script's detail. Defaults to the real
   * {@link fetchScript}; injectable so tests can supply a fake without
   * mocking a module.
   */
  readonly fetchScript?: (
    name: string,
  ) => Promise<M3LConsoleFetchResult<M3LScriptDetail>>;
  /**
   * Launcher used to submit a run. Defaults to the real {@link launchRun};
   * injectable so tests can supply a fake without mocking a module.
   */
  readonly launchRun?: (
    request: M3LRunLaunchRequest,
  ) => Promise<M3LConsoleFetchResult<M3LRunHandle>>;
  /** Called with the new run's id once a launch succeeds (a 201 response). */
  readonly onLaunched?: (runId: string) => void;
}

type ScriptDetailState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly detail: M3LScriptDetail }
  | { readonly kind: "error"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Owns the script-detail fetch lifecycle, extracted to keep
 * {@link ScriptDetail} itself short.
 */
function useScriptDetailFetchState(
  name: string,
  load: (name: string) => Promise<M3LConsoleFetchResult<M3LScriptDetail>>,
): ScriptDetailState {
  const [state, setState] = useState<ScriptDetailState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    // A route change (e.g. #/scripts/alpha -> #/scripts/beta) re-runs this
    // effect with a new `name` but does not remount the component, so
    // `state` would otherwise keep showing the previous script's detail
    // (and, worse, let its still-mounted ParameterForm carry stale
    // values/dryRun/confirmed forward) until the new fetch resolves.
    setState({ kind: "loading" });

    void load(name)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setState(
          result.ok
            ? { kind: "loaded", detail: result.data }
            : { kind: "error", message: result.error.message },
        );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `name` should retrigger the fetch; the fetcher prop is treated as stable
  }, [name]);

  return state;
}

/** Return shape of {@link useScriptLaunch}. */
interface ScriptLaunchState {
  readonly submitting: boolean;
  readonly launchError: string | null;
  readonly handleLaunch: (submission: M3LParameterFormSubmission) => void;
}

/**
 * Owns the launch-submission lifecycle (submitting flag, error mapping,
 * the `onLaunched` callback on success), extracted to keep
 * {@link ScriptDetail} itself short.
 */
/**
 * Builds the launch request's `dryRun`/`confirmed` discriminant from a
 * form submission's two independent booleans — this is the one branch
 * where the runtime check the union type now enforces at compile time
 * actually happens. `undefined` signals the illegal combination
 * (`dryRun: false, confirmed: false`), which `ParameterForm`'s own
 * `canSubmit` gate (`!submitting && (dryRun || confirmed)`) already keeps
 * off the launch button — this is a defensive fallback, not a path any
 * test drives through the UI.
 */
function buildLaunchRequest(
  scriptName: string,
  submission: M3LParameterFormSubmission,
): M3LRunLaunchRequest | undefined {
  if (submission.dryRun) {
    return {
      scriptName,
      parameters: submission.parameters,
      dryRun: true,
      // Always the literal `false` here, never `submission.confirmed`
      // (typed as plain `boolean`) — the union's dry-run member only
      // accepts `confirmed?: false`, and a dry run is exempt from
      // confirmation regardless of what the form's local toggle happened
      // to hold.
      confirmed: false,
    };
  }
  if (submission.confirmed) {
    return {
      scriptName,
      parameters: submission.parameters,
      dryRun: false,
      confirmed: true,
    };
  }
  return undefined;
}

function useScriptLaunch(
  name: string,
  launch: (
    request: M3LRunLaunchRequest,
  ) => Promise<M3LConsoleFetchResult<M3LRunHandle>>,
  onLaunched: ((runId: string) => void) | undefined,
): ScriptLaunchState {
  const [submitting, setSubmitting] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  function handleLaunch(submission: M3LParameterFormSubmission): void {
    const request = buildLaunchRequest(name, submission);
    if (request === undefined) {
      // Confirmation is required for a non-dry-run launch, and this
      // submission carries neither — surface the same message the server
      // would return for ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED rather than
      // silently dropping the launch attempt.
      setLaunchError(
        LAUNCH_ERROR_MESSAGES["ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED"] ??
          "Confirmation is required for a non-dry-run launch.",
      );
      return;
    }
    setLaunchError(null);
    setSubmitting(true);
    void launch(request)
      .then((result) => {
        if (result.ok) {
          onLaunched?.(result.data.id);
          return;
        }
        setLaunchError(describeLaunchError(result.error));
      })
      .catch((caught: unknown) => {
        setLaunchError(deriveErrorMessage(caught));
      })
      .finally(() => {
        setSubmitting(false);
      });
  }

  return { submitting, launchError, handleLaunch };
}

/** One row of the parameter table, extracted to keep {@link ScriptDetail} short. */
function ScriptParameterRow({
  parameter,
}: {
  readonly parameter: M3LScriptParameter;
}): ReactElement {
  return (
    <tr>
      <td>{parameter.name}</td>
      <td>{parameter.type}</td>
      <td>{parameter.required ? "yes" : "no"}</td>
      {/* The server already masks a secret default (`"********"`) before it
          reaches the client — render it verbatim, never re-mask or
          reconstruct it. */}
      <td>{parameter.defaultValue ?? ""}</td>
      <td>{parameter.secret ? "yes" : "no"}</td>
      <td>{parameter.description}</td>
    </tr>
  );
}

/**
 * Renders a loaded script's read-only parameter table plus its launch
 * form, extracted to keep {@link ScriptDetail} itself short.
 */
function ScriptDetailLoaded({
  detail,
  submitting,
  launchError,
  onLaunch,
}: {
  readonly detail: M3LScriptDetail;
  readonly submitting: boolean;
  readonly launchError: string | null;
  readonly onLaunch: (submission: M3LParameterFormSubmission) => void;
}): ReactElement {
  return (
    <>
      <h2>{detail.name}</h2>
      <p>{detail.description}</p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Required</th>
            <th>Default</th>
            <th>Secret</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {detail.parameters.map((parameter) => (
            <ScriptParameterRow key={parameter.name} parameter={parameter} />
          ))}
        </tbody>
      </table>
      <ParameterForm
        detail={detail}
        submitting={submitting}
        onLaunch={onLaunch}
      />
      {launchError !== null && <p>{launchError}</p>}
    </>
  );
}

/**
 * Loads and renders a single script's detail: description plus a read-only
 * parameter table (name, type, required, default, secret, description).
 *
 * A `secret: true` parameter's `defaultValue` is rendered exactly as
 * received — the console server already masks it (`"********"`) before it
 * reaches the client, so this component never re-masks, truncates, or
 * reconstructs it; doing so would duplicate masking logic that belongs
 * solely at the descriptor source.
 *
 * @example
 * ```tsx
 * import { ScriptDetail } from "@m3l-automation/m3l-console-web/components/ScriptDetail.js";
 *
 * <ScriptDetail name="demo-script" />;
 * ```
 */
export function ScriptDetail(props: ScriptDetailProps): ReactElement {
  const { name, onLaunched } = props;
  const load = props.fetchScript ?? fetchScriptDefault;
  const launch = props.launchRun ?? launchRunDefault;
  const state = useScriptDetailFetchState(name, load);
  const { submitting, launchError, handleLaunch } = useScriptLaunch(
    name,
    launch,
    onLaunched,
  );

  return (
    <div data-testid="script-detail">
      {state.kind === "loading" && <p>Loading script…</p>}
      {state.kind === "error" && <p>Error: {state.message}</p>}
      {state.kind === "loaded" && (
        <ScriptDetailLoaded
          detail={state.detail}
          submitting={submitting}
          launchError={launchError}
          onLaunch={handleLaunch}
        />
      )}
    </div>
  );
}
