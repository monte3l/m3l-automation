import type { FormEvent, ReactElement } from "react";
import { useState } from "react";

import type { M3LScriptDetail, M3LScriptParameter } from "../api/scripts.js";

/**
 * Payload {@link ParameterForm} hands to its `onLaunch` callback. Not the
 * same shape as `M3LRunLaunchRequest` from `src/api/runs.js` — that request
 * also carries `scriptName`, which this form has no knowledge of; its
 * parent (`ScriptDetail`) adds it before calling `launchRun`.
 */
export interface M3LParameterFormSubmission {
  /**
   * String-valued parameters gathered from the currently-visible controls.
   * An optional parameter left empty is omitted entirely rather than sent
   * as `""`. A `secret: true` parameter's key never appears here at all —
   * see {@link ParameterControl}'s TSDoc.
   */
  readonly parameters: Readonly<Record<string, string>>;
  readonly dryRun: boolean;
  readonly confirmed: boolean;
}

/** Props accepted by {@link ParameterForm}. */
export interface ParameterFormProps {
  /** The loaded script detail whose parameters/operations drive the form. */
  readonly detail: M3LScriptDetail;
  /** Called with the gathered submission when the launch control is activated. */
  readonly onLaunch: (submission: M3LParameterFormSubmission) => void;
  /** `true` while a previously-submitted launch is in flight; disables submit. */
  readonly submitting: boolean;
}

/** Sentinel meaning "no operation selected" in the operation `<select>`. */
const NO_OPERATION_SELECTED = "";

function isBoolType(type: string): boolean {
  return type === "BOOL";
}

function isNumericType(type: string): boolean {
  return type === "INT" || type === "DOUBLE";
}

/**
 * Builds the initial value map for every parameter: non-secret parameters
 * prefill from `defaultValue`, `BOOL` parameters normalise to the
 * `"true"`/`"false"` strings the server expects, and a `secret: true`
 * parameter is always left blank — the server already sends the mask
 * (`"********"`) as that field's `defaultValue`, and prefilling it would
 * round-trip the mask back as if it were a real secret value.
 */
function buildInitialValues(
  parameters: readonly M3LScriptParameter[],
): Record<string, string> {
  // Object.create(null) rather than `{}` — a parameter literally named
  // `__proto__` hits Object.prototype's own `__proto__` accessor setter
  // under plain-object bracket assignment, silently dropping the value
  // (the assigned string is not an object/null, so the setter no-ops)
  // rather than creating an own `__proto__` property.
  const values: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const parameter of parameters) {
    if (parameter.secret) {
      // No control is ever rendered for a secret parameter (see
      // ParameterControl's TSDoc), so it has no value to prefill.
      continue;
    }
    if (isBoolType(parameter.type)) {
      values[parameter.name] =
        parameter.defaultValue === "true" ? "true" : "false";
      continue;
    }
    values[parameter.name] = parameter.defaultValue ?? "";
  }
  return values;
}

/**
 * Resolves the operation the given `name` refers to, or `undefined` when no
 * operation is selected (or the name no longer matches one, e.g. the detail
 * changed underneath a stale selection).
 */
function resolveSelectedOperation(
  detail: M3LScriptDetail,
  selectedOperationName: string,
): M3LScriptDetail["operations"][number] | undefined {
  return detail.operations.find((op) => op.name === selectedOperationName);
}

/**
 * Whether `parameter` should be shown given the currently-selected
 * operation, mirroring U8's shipped wizard rule:
 * - `required: true` -\> always shown.
 * - an empty `operations` array -\> always shown (unscoped).
 * - scoped to the selected operation -\> shown.
 * - listed in the selected operation's `requiredParameters` -\> shown, even
 *   when scoped to a *different* operation or not scoped at all.
 */
function isParameterVisible(
  parameter: M3LScriptParameter,
  selectedOperation: M3LScriptDetail["operations"][number] | undefined,
): boolean {
  if (parameter.required || parameter.operations.length === 0) {
    return true;
  }
  if (selectedOperation === undefined) {
    return false;
  }
  if (selectedOperation.requiredParameters.includes(parameter.name)) {
    return true;
  }
  return parameter.operations.some((op) => op.name === selectedOperation.name);
}

/**
 * Whether `parameter` is enforced-required given the currently-selected
 * operation: its own `required` flag, or cross-listed in the selected
 * operation's `requiredParameters` (which overrides the parameter's own
 * `required: false`, regardless of its own `operations` scoping).
 */
function isParameterEnforcedRequired(
  parameter: M3LScriptParameter,
  selectedOperation: M3LScriptDetail["operations"][number] | undefined,
): boolean {
  return (
    parameter.required ||
    (selectedOperation?.requiredParameters.includes(parameter.name) ?? false)
  );
}

function resolveInputType(
  parameter: M3LScriptParameter,
): "checkbox" | "number" | "text" {
  if (isBoolType(parameter.type)) {
    return "checkbox";
  }
  if (isNumericType(parameter.type)) {
    return "number";
  }
  return "text";
}

/**
 * Renders a `secret: true` parameter's row: a read-only explanation, no
 * editable control of any kind, regardless of the parameter's declared
 * `type`.
 *
 * Maintainer decision (X10d security review): this REPLACES an earlier
 * `type="password"` requirement. The console server persists a run's
 * `parameters` verbatim and echoes them back in cleartext — `RunDetail`
 * renders that echo as-is — so a password control would signal the
 * opposite of the truth: there is no safe way for this form to collect a
 * secret value at all. The real value must come from the script's own
 * environment/secret resolution at execution time, never from a run
 * parameter.
 */
function SecretParameterExplanation({
  parameter,
}: {
  readonly parameter: M3LScriptParameter;
}): ReactElement {
  return (
    <p>
      {parameter.name} is a secret value — provide it via the script&apos;s own
      environment or secret resolution, not through this form.
    </p>
  );
}

/**
 * Renders one parameter's control (checkbox/number/text), extracted to
 * keep {@link ParameterForm} itself short. Never called for a
 * `secret: true` parameter — see {@link SecretParameterExplanation}.
 */
function ParameterControl({
  parameter,
  value,
  required,
  onChange,
}: {
  readonly parameter: M3LScriptParameter;
  readonly value: string;
  readonly required: boolean;
  readonly onChange: (name: string, value: string) => void;
}): ReactElement {
  const inputType = resolveInputType(parameter);
  if (inputType === "checkbox") {
    return (
      <input
        id={parameter.name}
        type="checkbox"
        checked={value === "true"}
        onChange={(event) => {
          onChange(parameter.name, event.target.checked ? "true" : "false");
        }}
      />
    );
  }
  return (
    <input
      id={parameter.name}
      type={inputType}
      value={value}
      required={required}
      onChange={(event) => {
        onChange(parameter.name, event.target.value);
      }}
    />
  );
}

/**
 * Gathers submission parameters from the currently-visible controls:
 * `BOOL` values always submit as `"true"`/`"false"`; every other type omits
 * an optional-and-empty value rather than sending it as `""`.
 */
function buildSubmissionParameters(
  detail: M3LScriptDetail,
  values: Record<string, string>,
  selectedOperation: M3LScriptDetail["operations"][number] | undefined,
): Record<string, string> {
  // Object.create(null) rather than `{}` — see buildInitialValues's TSDoc
  // for why a parameter literally named `__proto__` needs this to survive.
  const parameters: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const parameter of detail.parameters) {
    if (parameter.secret) {
      // A secret parameter has no control (see SecretParameterExplanation)
      // and its key must never appear in the submitted parameters — the
      // server persists and echoes parameters verbatim, and there is no
      // value collected here to submit anyway.
      continue;
    }
    if (!isParameterVisible(parameter, selectedOperation)) {
      continue;
    }
    const value = values[parameter.name] ?? "";
    if (isBoolType(parameter.type)) {
      parameters[parameter.name] = value === "true" ? "true" : "false";
      continue;
    }
    const enforcedRequired = isParameterEnforcedRequired(
      parameter,
      selectedOperation,
    );
    if (value === "" && !enforcedRequired) {
      // An optional parameter left empty is omitted rather than sent as
      // "" — the server distinguishes "not provided" from "empty string".
      continue;
    }
    parameters[parameter.name] = value;
  }
  return parameters;
}

/**
 * Renders the operation `<select>`, extracted to keep {@link ParameterForm}
 * itself short.
 */
function OperationSelect({
  operations,
  selectedOperationName,
  onChange,
}: {
  readonly operations: M3LScriptDetail["operations"];
  readonly selectedOperationName: string;
  readonly onChange: (name: string) => void;
}): ReactElement {
  return (
    <div>
      <label htmlFor="parameter-form-operation">Operation</label>
      <select
        id="parameter-form-operation"
        value={selectedOperationName}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value={NO_OPERATION_SELECTED}>—</option>
        {operations.map((operation) => (
          <option key={operation.name} value={operation.name}>
            {operation.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Renders one labelled control per currently-visible parameter, extracted
 * to keep {@link ParameterForm} itself short.
 */
function ParameterFields({
  parameters,
  selectedOperation,
  values,
  onChange,
}: {
  readonly parameters: readonly M3LScriptParameter[];
  readonly selectedOperation: M3LScriptDetail["operations"][number] | undefined;
  readonly values: Record<string, string>;
  readonly onChange: (name: string, value: string) => void;
}): ReactElement {
  return (
    <>
      {parameters
        .filter((parameter) => isParameterVisible(parameter, selectedOperation))
        .map((parameter) =>
          parameter.secret ? (
            <div key={parameter.name}>
              <SecretParameterExplanation parameter={parameter} />
            </div>
          ) : (
            <div key={parameter.name}>
              <label htmlFor={parameter.name}>{parameter.name}</label>
              <ParameterControl
                parameter={parameter}
                value={values[parameter.name] ?? ""}
                required={isParameterEnforcedRequired(
                  parameter,
                  selectedOperation,
                )}
                onChange={onChange}
              />
            </div>
          ),
        )}
    </>
  );
}

/**
 * Renders the `dryRun` toggle plus (only when `dryRun` is off) the explicit
 * confirm-real-run gate, extracted to keep {@link ParameterForm} itself
 * short.
 */
function LaunchGateControls({
  dryRun,
  confirmed,
  onDryRunChange,
  onConfirmChange,
}: {
  readonly dryRun: boolean;
  readonly confirmed: boolean;
  readonly onDryRunChange: (checked: boolean) => void;
  readonly onConfirmChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <>
      <div>
        <label htmlFor="parameter-form-dry-run">Dry run</label>
        <input
          id="parameter-form-dry-run"
          type="checkbox"
          checked={dryRun}
          onChange={(event) => {
            onDryRunChange(event.target.checked);
          }}
        />
      </div>
      {!dryRun && (
        <div>
          <label htmlFor="parameter-form-confirm">Confirm real run</label>
          <input
            id="parameter-form-confirm"
            type="checkbox"
            checked={confirmed}
            onChange={(event) => {
              onConfirmChange(event.target.checked);
            }}
          />
        </div>
      )}
    </>
  );
}

/**
 * No-op `onSubmit` handler that only suppresses the browser's native form
 * submission (and its navigation/reload side effect) — launch is driven
 * entirely by the `<button type="button">`'s `onClick`, not native form
 * validation, so parameter `required` attributes never block a submit.
 */
function preventFormSubmit(event: FormEvent<HTMLFormElement>): void {
  event.preventDefault();
}

/**
 * Presentational launch form for a script's parameters: renders one control
 * per visible parameter (operation-scoping applied), a `dryRun` toggle that
 * defaults on, and a confirm gate for a real (non-dry-run) launch. Purely
 * local form state — it never fetches; the parent (`ScriptDetail`) owns the
 * actual `launchRun` call via the `onLaunch` callback.
 *
 * @example
 * ```tsx
 * import { ParameterForm } from "@m3l-automation/m3l-console-web/components/ParameterForm.js";
 *
 * <ParameterForm
 *   detail={scriptDetail}
 *   submitting={false}
 *   onLaunch={(submission) => {
 *     console.log(submission.parameters, submission.dryRun, submission.confirmed);
 *   }}
 * />;
 * ```
 */
export function ParameterForm(props: ParameterFormProps): ReactElement {
  const { detail, onLaunch, submitting } = props;
  const [values, setValues] = useState<Record<string, string>>(() =>
    buildInitialValues(detail.parameters),
  );
  const [selectedOperationName, setSelectedOperationName] = useState(
    NO_OPERATION_SELECTED,
  );
  const [dryRun, setDryRun] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const selectedOperation = resolveSelectedOperation(
    detail,
    selectedOperationName,
  );

  function handleValueChange(name: string, value: string): void {
    setValues((previous) => ({ ...previous, [name]: value }));
  }

  function handleLaunch(): void {
    onLaunch({
      parameters: buildSubmissionParameters(detail, values, selectedOperation),
      dryRun,
      confirmed,
    });
  }

  const canSubmit = !submitting && (dryRun || confirmed);

  return (
    <form data-testid="parameter-form" onSubmit={preventFormSubmit}>
      {detail.operations.length > 0 && (
        <OperationSelect
          operations={detail.operations}
          selectedOperationName={selectedOperationName}
          onChange={setSelectedOperationName}
        />
      )}
      <ParameterFields
        parameters={detail.parameters}
        selectedOperation={selectedOperation}
        values={values}
        onChange={handleValueChange}
      />
      <LaunchGateControls
        dryRun={dryRun}
        confirmed={confirmed}
        onDryRunChange={(checked) => {
          // Any dryRun toggle — either direction — invalidates a prior
          // confirmation; a stale `confirmed: true` must never survive a
          // round-trip through the toggle.
          setDryRun(checked);
          setConfirmed(false);
        }}
        onConfirmChange={setConfirmed}
      />
      <button type="button" disabled={!canSubmit} onClick={handleLaunch}>
        Launch
      </button>
    </form>
  );
}
