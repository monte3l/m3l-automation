import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import type { M3LConsoleFetchResult } from "../api/client.js";
import type { M3LScriptDetail, M3LScriptParameter } from "../api/scripts.js";
import { fetchScript as fetchScriptDefault } from "../api/scripts.js";

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
}

type ScriptDetailState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly detail: M3LScriptDetail }
  | { readonly kind: "error"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
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
  const [state, setState] = useState<ScriptDetailState>({ kind: "loading" });
  const { name } = props;
  const load = props.fetchScript ?? fetchScriptDefault;

  useEffect(() => {
    let cancelled = false;

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

  return (
    <div data-testid="script-detail">
      {state.kind === "loading" && <p>Loading script…</p>}
      {state.kind === "error" && <p>Error: {state.message}</p>}
      {state.kind === "loaded" && (
        <>
          <h2>{state.detail.name}</h2>
          <p>{state.detail.description}</p>
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
              {state.detail.parameters.map((parameter) => (
                <ScriptParameterRow
                  key={parameter.name}
                  parameter={parameter}
                />
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
