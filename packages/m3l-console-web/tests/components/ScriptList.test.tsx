import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { M3LConsoleFetchResult } from "../../src/api/client.js";
import type { M3LScriptSummary } from "../../src/api/scripts.js";
import { ScriptList } from "../../src/components/ScriptList.js";

function okFetchScripts(
  scripts: readonly M3LScriptSummary[],
): () => Promise<M3LConsoleFetchResult<readonly M3LScriptSummary[]>> {
  return () => Promise.resolve({ ok: true, data: scripts });
}

function errorFetchScripts(
  message: string,
): () => Promise<M3LConsoleFetchResult<readonly M3LScriptSummary[]>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

const SAMPLE_SCRIPT: M3LScriptSummary = {
  name: "demo-script",
  description: "Runs the demo pipeline",
  hasCommandModule: false,
  executionMode: "spawn",
};

describe("ScriptList", () => {
  test("renders a loading state synchronously on mount", () => {
    render(<ScriptList fetchScripts={okFetchScripts([SAMPLE_SCRIPT])} />);

    const list = screen.getByTestId("script-list");
    expect(list.textContent).toContain("Loading");
  });

  test("renders each script's name and description once loaded", async () => {
    render(<ScriptList fetchScripts={okFetchScripts([SAMPLE_SCRIPT])} />);

    const list = await screen.findByTestId("script-list");
    expect(list.textContent).toContain("demo-script");
    expect(list.textContent).toContain("Runs the demo pipeline");
  });

  test('renders "no scripts found" when the list is empty', async () => {
    render(<ScriptList fetchScripts={okFetchScripts([])} />);

    const list = await screen.findByTestId("script-list");
    expect(list.textContent).toContain("no scripts found");
  });

  test("renders an error state when the fetch result is not ok", async () => {
    render(
      <ScriptList fetchScripts={errorFetchScripts("connection refused")} />,
    );

    const list = await screen.findByTestId("script-list");
    expect(list.textContent).toContain("connection refused");
  });

  test("renders an error state when the fetcher rejects (.catch arm)", async () => {
    const rejectingFetchScripts = vi.fn(() =>
      Promise.reject(new Error("boom")),
    );

    render(<ScriptList fetchScripts={rejectingFetchScripts} />);

    const list = await screen.findByTestId("script-list");
    expect(list.textContent).toContain("boom");
  });

  test("invokes onSelectScript with the script name when a row is activated", async () => {
    const onSelectScript = vi.fn();
    render(
      <ScriptList
        fetchScripts={okFetchScripts([SAMPLE_SCRIPT])}
        onSelectScript={onSelectScript}
      />,
    );

    const row = await screen.findByRole("button", { name: /demo-script/ });
    row.click();

    expect(onSelectScript).toHaveBeenCalledWith("demo-script");
  });

  test("renders a script description containing markup as literal text, not markup", async () => {
    const maliciousDescription = "<img src=x onerror=alert(1)>";
    render(
      <ScriptList
        fetchScripts={okFetchScripts([
          { ...SAMPLE_SCRIPT, description: maliciousDescription },
        ])}
      />,
    );

    const list = await screen.findByTestId("script-list");
    expect(list.textContent).toContain(maliciousDescription);
    expect(list.querySelector("img")).toBeNull();
  });

  test("calls the injected fetchScripts exactly once", async () => {
    const fetchScriptsSpy = vi.fn(okFetchScripts([SAMPLE_SCRIPT]));

    render(<ScriptList fetchScripts={fetchScriptsSpy} />);
    await screen.findByTestId("script-list");

    expect(fetchScriptsSpy).toHaveBeenCalledTimes(1);
  });

  test("does not update state after unmount once a late resolve arrives (.then guard)", async () => {
    let resolveFetch: (
      result: M3LConsoleFetchResult<readonly M3LScriptSummary[]>,
    ) => void = () => {
      // replaced synchronously by the executor below
    };
    const pendingFetchScripts = (): Promise<
      M3LConsoleFetchResult<readonly M3LScriptSummary[]>
    > =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // suppress React's console.error output for this test
      });

    const { unmount } = render(
      <ScriptList fetchScripts={pendingFetchScripts} />,
    );
    unmount();
    resolveFetch({ ok: true, data: [SAMPLE_SCRIPT] });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  test("does not update state after unmount once a late rejection arrives (.catch guard)", async () => {
    let rejectFetch: (caught: unknown) => void = () => {
      // replaced synchronously by the executor below
    };
    const pendingFetchScripts = (): Promise<
      M3LConsoleFetchResult<readonly M3LScriptSummary[]>
    > =>
      new Promise((_resolve, reject) => {
        rejectFetch = reject;
      });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // suppress React's console.error output for this test
      });

    const { unmount } = render(
      <ScriptList fetchScripts={pendingFetchScripts} />,
    );
    unmount();
    rejectFetch(new Error("boom"));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
