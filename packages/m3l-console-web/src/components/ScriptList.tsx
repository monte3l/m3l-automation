import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import type { M3LConsoleFetchResult } from "../api/client.js";
import type { M3LScriptSummary } from "../api/scripts.js";
import { fetchScripts as fetchScriptsDefault } from "../api/scripts.js";

/** Props accepted by {@link ScriptList}. */
export interface ScriptListProps {
  /**
   * Fetcher used to load the script list. Defaults to the real
   * {@link fetchScripts}; injectable so tests can supply a fake without
   * mocking a module.
   */
  readonly fetchScripts?: () => Promise<
    M3LConsoleFetchResult<readonly M3LScriptSummary[]>
  >;
  /** Called with a script's name when its row is activated. */
  readonly onSelectScript?: (name: string) => void;
}

type ScriptListState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly scripts: readonly M3LScriptSummary[] }
  | { readonly kind: "error"; readonly message: string };

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Loads and renders the list of discovered scripts, once on mount.
 *
 * @example
 * ```tsx
 * import { ScriptList } from "@m3l-automation/m3l-console-web/components/ScriptList.js";
 *
 * <ScriptList onSelectScript={(name) => console.log(name)} />;
 * ```
 */
export function ScriptList(props: ScriptListProps): ReactElement {
  const [state, setState] = useState<ScriptListState>({ kind: "loading" });
  const load = props.fetchScripts ?? fetchScriptsDefault;

  useEffect(() => {
    let cancelled = false;

    void load()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setState(
          result.ok
            ? { kind: "loaded", scripts: result.data }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch runs once on mount by design
  }, []);

  return (
    <div data-testid="script-list">
      {state.kind === "loading" && <p>Loading scripts…</p>}
      {state.kind === "error" && <p>Error: {state.message}</p>}
      {state.kind === "loaded" &&
        (state.scripts.length === 0 ? (
          <p>no scripts found</p>
        ) : (
          <ul>
            {state.scripts.map((script) => (
              <li key={script.name}>
                <button
                  type="button"
                  onClick={() => {
                    props.onSelectScript?.(script.name);
                  }}
                >
                  {script.name}
                </button>
                <span> — {script.description}</span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
