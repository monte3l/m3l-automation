import type { ReactElement } from "react";
import { useState } from "react";

import type {
  M3LSessionFlowExportRequest,
  M3LSessionFlowWriteResult,
} from "../api/session-flow-export.js";
import { exportSessionAsFlow as exportSessionAsFlowDefault } from "../api/session-flow-export.js";

/** Props accepted by {@link SessionFlowExport}. */
export interface SessionFlowExportProps {
  /** Id of the session to export as a flow document. */
  readonly sessionId: string;
  /**
   * Writer used to submit the export. Defaults to the real
   * {@link exportSessionAsFlow}; injectable so tests can supply a fake
   * without mocking a module.
   */
  readonly exportSessionAsFlow?: typeof exportSessionAsFlowDefault;
}

/** Submission state for the currently-entered export form. */
type ExportState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "success"; readonly result: M3LSessionFlowWriteResult }
  | { readonly kind: "error"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Builds the export request from the form's raw field values, omitting
 * `description` entirely (never `undefined`) when blank — matches the
 * server's `parseFlowExportBody` conditional-spread convention so the
 * request shape is identical whether or not a description was typed.
 */
function buildExportRequest(
  name: string,
  description: string,
  overwrite: boolean,
): M3LSessionFlowExportRequest {
  const trimmedDescription = description.trim();
  return {
    name: name.trim(),
    ...(trimmedDescription !== "" && { description: trimmedDescription }),
    overwrite,
  };
}

/**
 * Submits `request` for `sessionId` via `writer`, driving `setState` through
 * the loading/success/error lifecycle. A rejecting `writer` is caught so it
 * surfaces as the same `"error"` state as an `ok: false` result.
 */
function submitExport(args: {
  readonly sessionId: string;
  readonly request: M3LSessionFlowExportRequest;
  readonly writer: typeof exportSessionAsFlowDefault;
  readonly setState: (state: ExportState) => void;
}): void {
  const { sessionId, request, writer, setState } = args;
  setState({ kind: "loading" });
  writer(sessionId, request)
    .then((result) => {
      if (!result.ok) {
        setState({ kind: "error", message: result.error.message });
        return;
      }
      setState({ kind: "success", result: result.data });
    })
    .catch((caught: unknown) => {
      setState({ kind: "error", message: deriveErrorMessage(caught) });
    });
}

/** Renders one non-success step's visible warning indicator. */
function StepWarning({
  step,
}: {
  readonly step: M3LSessionFlowWriteResult["steps"][number];
}): ReactElement {
  return (
    <li data-testid={`session-flow-export-step-warning-${step.flowStepId}`}>
      Step {step.flowStepId} ({step.script}) did not succeed — outcome:{" "}
      {step.outcome ?? "never reached"}
    </li>
  );
}

/** Renders the successful export result: the written path, the yaml, and any warnings. */
function ExportResult({
  result,
}: {
  readonly result: M3LSessionFlowWriteResult;
}): ReactElement {
  const failedSteps = result.steps.filter((step) => step.outcome !== "success");
  return (
    <div data-testid="session-flow-export-result">
      <p>Flow written to {result.path}</p>
      <pre data-testid="session-flow-export-yaml">{result.yaml}</pre>
      {result.decisionsDropped > 0 && (
        <p data-testid="session-flow-export-warning">
          {result.decisionsDropped} decision(s) were dropped from the exported
          flow.
        </p>
      )}
      {failedSteps.length > 0 && (
        <ul>
          {failedSteps.map((step) => (
            <StepWarning key={step.flowStepId} step={step} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Renders the flow-name input and its client-side validation message. */
function NameField({
  name,
  onNameChange,
  nameError,
}: {
  readonly name: string;
  readonly onNameChange: (value: string) => void;
  readonly nameError: boolean;
}): ReactElement {
  return (
    <>
      <label htmlFor="session-flow-export-name-input">Flow name</label>
      <input
        id="session-flow-export-name-input"
        data-testid="session-flow-export-name-input"
        type="text"
        value={name}
        onChange={(event) => {
          onNameChange(event.target.value);
        }}
      />
      {nameError && (
        <p data-testid="session-flow-export-name-error">
          A flow name is required.
        </p>
      )}
    </>
  );
}

/** Renders the description input and the overwrite checkbox. */
function DescriptionAndOverwriteFields({
  description,
  onDescriptionChange,
  overwrite,
  onOverwriteChange,
}: {
  readonly description: string;
  readonly onDescriptionChange: (value: string) => void;
  readonly overwrite: boolean;
  readonly onOverwriteChange: (value: boolean) => void;
}): ReactElement {
  return (
    <>
      <label htmlFor="session-flow-export-description-input">Description</label>
      <input
        id="session-flow-export-description-input"
        data-testid="session-flow-export-description-input"
        type="text"
        value={description}
        onChange={(event) => {
          onDescriptionChange(event.target.value);
        }}
      />
      <label htmlFor="session-flow-export-overwrite-checkbox">Overwrite</label>
      <input
        id="session-flow-export-overwrite-checkbox"
        data-testid="session-flow-export-overwrite-checkbox"
        type="checkbox"
        checked={overwrite}
        onChange={(event) => {
          onOverwriteChange(event.target.checked);
        }}
      />
    </>
  );
}

/**
 * Renders the name/description/overwrite fields and the submit button —
 * extracted, along with {@link NameField} and
 * {@link DescriptionAndOverwriteFields}, to keep {@link SessionFlowExport}
 * itself short.
 */
function SessionFlowExportFields({
  name,
  onNameChange,
  nameError,
  description,
  onDescriptionChange,
  overwrite,
  onOverwriteChange,
  submitting,
  onSubmit,
}: {
  readonly name: string;
  readonly onNameChange: (value: string) => void;
  readonly nameError: boolean;
  readonly description: string;
  readonly onDescriptionChange: (value: string) => void;
  readonly overwrite: boolean;
  readonly onOverwriteChange: (value: boolean) => void;
  readonly submitting: boolean;
  readonly onSubmit: () => void;
}): ReactElement {
  return (
    <>
      <NameField
        name={name}
        onNameChange={onNameChange}
        nameError={nameError}
      />
      <DescriptionAndOverwriteFields
        description={description}
        onDescriptionChange={onDescriptionChange}
        overwrite={overwrite}
        onOverwriteChange={onOverwriteChange}
      />
      <button
        type="button"
        data-testid="session-flow-export-submit"
        disabled={submitting}
        onClick={onSubmit}
      >
        Export
      </button>
    </>
  );
}

/**
 * Lets an operator export a session's recorded steps as a flow document via
 * the injected `exportSessionAsFlow`. Submitting with an empty name never
 * calls the writer at all — a purely client-side validation guard.
 *
 * @example
 * ```tsx
 * import { SessionFlowExport } from "@m3l-automation/m3l-console-web/components/SessionFlowExport.js";
 *
 * <SessionFlowExport sessionId="session-123" />;
 * ```
 */
export function SessionFlowExport(props: SessionFlowExportProps): ReactElement {
  const { sessionId } = props;
  const writer = props.exportSessionAsFlow ?? exportSessionAsFlowDefault;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [state, setState] = useState<ExportState>({ kind: "idle" });

  function handleSubmit(): void {
    if (name.trim() === "") {
      setNameError(true);
      return;
    }
    setNameError(false);
    submitExport({
      sessionId,
      request: buildExportRequest(name, description, overwrite),
      writer,
      setState,
    });
  }

  return (
    <div data-testid="session-flow-export">
      <SessionFlowExportFields
        name={name}
        onNameChange={setName}
        nameError={nameError}
        description={description}
        onDescriptionChange={setDescription}
        overwrite={overwrite}
        onOverwriteChange={setOverwrite}
        submitting={state.kind === "loading"}
        onSubmit={handleSubmit}
      />
      {state.kind === "success" && <ExportResult result={state.result} />}
      {state.kind === "error" && (
        <p data-testid="session-flow-export-error">Error: {state.message}</p>
      )}
    </div>
  );
}
