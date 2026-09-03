import type { ReactElement } from "react";

import type { BindingSubmitState } from "../internal/session-binding-form.js";

/**
 * Renders the binding-creation form opened after selecting a tree node —
 * submitting it invokes `onSubmit`, which the caller has already bound to
 * the selected step/node so this component stays a pure controlled form.
 * Extracted out of `components/SessionDetail.tsx` verbatim to keep that
 * file under the repo's file-budget ceiling.
 *
 * @example
 * ```tsx
 * import { BindingForm } from "@m3l-automation/m3l-console-web/components/SessionBindingForm.js";
 *
 * <BindingForm
 *   parameterName=""
 *   onParameterNameChange={() => {}}
 *   multiSelect={false}
 *   onMultiSelectChange={() => {}}
 *   bindingState={{ kind: "idle" }}
 *   onSubmit={() => {}}
 * />;
 * ```
 */
export function BindingForm({
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
