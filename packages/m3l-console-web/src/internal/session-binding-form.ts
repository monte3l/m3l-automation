/**
 * `internal/session-binding-form` — the "select a tree node, fill in and
 * submit a binding" form logic used by `SessionDetail`'s step-output panel.
 * Extracted verbatim out of `components/SessionDetail.tsx` (pure logic plus
 * the `useBindingForm` hook, no JSX) purely to keep that file under the
 * repo's file-budget ceiling. Private to this package: never re-exported
 * from a public entry point.
 *
 * @packageDocumentation
 */
import { useEffect, useRef, useState } from "react";

import type { M3LConsoleFetchResult } from "../api/client.js";
import type {
  M3LSessionBindingExpectedType,
  M3LSessionBindingInput,
  M3LSessionBindingRecord,
  M3LSessionStepSummary,
} from "../api/sessions.js";
import type { M3LTreePathSegment } from "./step-reference.js";
import { buildStepReference } from "./step-reference.js";

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** The tree node currently selected for binding creation, if any. */
interface SelectedNode {
  readonly path: readonly M3LTreePathSegment[];
  readonly value: unknown;
}

/** Submission state for the binding-creation form. */
export type BindingSubmitState =
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
  readonly onCreated?:
    ((record: M3LSessionBindingRecord, value: unknown) => void) | undefined;
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
    onCreated,
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
      if (!result.ok) {
        setBindingState({ kind: "error", message: result.error.message });
        return;
      }
      setBindingState({ kind: "success", parameterName });
      onCreated?.(result.data, node.value);
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
  readonly onCreated?:
    ((record: M3LSessionBindingRecord, value: unknown) => void) | undefined;
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
    onCreated,
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
    onCreated,
  });
}

/**
 * Owns the "select a tree node, fill in and submit a binding" form state —
 * extracted to keep `SessionDetail` itself short. Selecting a new node
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
 * (session) must reset the whole form.
 *
 * @param id - The currently-viewed session id; changing it resets the form.
 * @param createBinding - Submits a binding-creation request.
 * @param onCreated - Optional callback invoked with the newly-created
 *   binding record and the selected node's raw value once a submission
 *   succeeds (after the same request-identity guard `submitBindingRequest`
 *   already applies) — lets a caller (e.g. `SessionDetail`) accumulate
 *   bindings/known values without a second network round trip.
 * @example
 * ```tsx
 * import { useBindingForm } from "@m3l-automation/m3l-console-web/internal/session-binding-form.js";
 * import { createSessionBinding } from "@m3l-automation/m3l-console-web/api/sessions.js";
 *
 * const binding = useBindingForm("session-1", createSessionBinding);
 * ```
 */
export interface UseBindingFormResult {
  readonly selectedNode: SelectedNode | null;
  readonly parameterName: string;
  readonly multiSelect: boolean;
  readonly bindingState: BindingSubmitState;
  readonly setParameterName: (value: string) => void;
  readonly setMultiSelect: (value: boolean) => void;
  readonly resetSelection: () => void;
  readonly selectNode: (
    path: readonly M3LTreePathSegment[],
    value: unknown,
  ) => void;
  readonly submit: (step: M3LSessionStepSummary, node: SelectedNode) => void;
}

export function useBindingForm(
  id: string,
  createBinding: (
    sessionId: string,
    input: M3LSessionBindingInput,
  ) => Promise<M3LConsoleFetchResult<M3LSessionBindingRecord>>,
  onCreated?: (record: M3LSessionBindingRecord, value: unknown) => void,
): UseBindingFormResult {
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
      onCreated,
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
