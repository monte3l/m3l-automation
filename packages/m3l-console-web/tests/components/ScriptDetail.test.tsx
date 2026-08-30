import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { M3LConsoleFetchResult } from "../../src/api/client.js";
import type {
  M3LScriptDetail,
  M3LScriptParameter,
} from "../../src/api/scripts.js";
import { ScriptDetail } from "../../src/components/ScriptDetail.js";

function okFetchScript(
  detail: M3LScriptDetail,
): (name: string) => Promise<M3LConsoleFetchResult<M3LScriptDetail>> {
  return () => Promise.resolve({ ok: true, data: detail });
}

function errorFetchScript(
  message: string,
): (name: string) => Promise<M3LConsoleFetchResult<M3LScriptDetail>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

const PLAIN_PARAMETER: M3LScriptParameter = {
  name: "region",
  aliases: [],
  type: "STRING",
  required: true,
  defaultValue: null,
  description: "",
  secret: false,
  operations: [],
};

// The server already masks a secret parameter's default value before it
// reaches the client (`"********"`); the contract requires the client to
// pass this through verbatim rather than reconstructing or re-masking it.
const SECRET_PARAMETER: M3LScriptParameter = {
  name: "apiKey",
  aliases: ["api-key"],
  type: "STRING",
  required: false,
  defaultValue: "********",
  description: "Third-party API credential",
  secret: true,
  operations: [],
};

const SAMPLE_DETAIL: M3LScriptDetail = {
  name: "demo-script",
  description: "Runs the demo pipeline",
  hasCommandModule: false,
  executionMode: "spawn",
  parameters: [PLAIN_PARAMETER, SECRET_PARAMETER],
  operations: [],
};

describe("ScriptDetail", () => {
  test("renders a loading state synchronously on mount", () => {
    render(
      <ScriptDetail
        name="demo-script"
        fetchScript={okFetchScript(SAMPLE_DETAIL)}
      />,
    );

    const detail = screen.getByTestId("script-detail");
    expect(detail.textContent).toContain("Loading");
  });

  test("renders the parameter table once loaded, including name/type/required", async () => {
    render(
      <ScriptDetail
        name="demo-script"
        fetchScript={okFetchScript(SAMPLE_DETAIL)}
      />,
    );

    const detail = await screen.findByTestId("script-detail");
    expect(detail.textContent).toContain("region");
    expect(detail.textContent).toContain("STRING");
  });

  test("renders a secret parameter's defaultValue exactly as received, with no re-masking", async () => {
    render(
      <ScriptDetail
        name="demo-script"
        fetchScript={okFetchScript(SAMPLE_DETAIL)}
      />,
    );

    const detail = await screen.findByTestId("script-detail");
    expect(detail.textContent).toContain("apiKey");
    expect(detail.textContent).toContain("********");
    // No extra masking layered on top of the server's own 8-character mask.
    expect(detail.textContent).not.toMatch(/\*{9,}/);
  });

  test("renders an error state when the fetch result is not ok", async () => {
    render(
      <ScriptDetail
        name="demo-script"
        fetchScript={errorFetchScript("not found")}
      />,
    );

    const detail = await screen.findByTestId("script-detail");
    expect(detail.textContent).toContain("not found");
  });

  test("renders an error state when the fetcher rejects (.catch arm)", async () => {
    const rejectingFetchScript = vi.fn(() => Promise.reject(new Error("boom")));

    render(
      <ScriptDetail name="demo-script" fetchScript={rejectingFetchScript} />,
    );

    const detail = await screen.findByTestId("script-detail");
    expect(detail.textContent).toContain("boom");
  });

  test("calls fetchScript with the name prop", async () => {
    const fetchScriptSpy = vi.fn(okFetchScript(SAMPLE_DETAIL));

    render(<ScriptDetail name="demo-script" fetchScript={fetchScriptSpy} />);
    await screen.findByTestId("script-detail");

    expect(fetchScriptSpy).toHaveBeenCalledWith("demo-script");
  });

  test("does not update state after unmount once a late resolve arrives (.then guard)", async () => {
    let resolveFetch: (
      result: M3LConsoleFetchResult<M3LScriptDetail>,
    ) => void = () => {
      // replaced synchronously by the executor below
    };
    const pendingFetchScript = (): Promise<
      M3LConsoleFetchResult<M3LScriptDetail>
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
      <ScriptDetail name="demo-script" fetchScript={pendingFetchScript} />,
    );
    unmount();
    resolveFetch({ ok: true, data: SAMPLE_DETAIL });
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
    const pendingFetchScript = (): Promise<
      M3LConsoleFetchResult<M3LScriptDetail>
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
      <ScriptDetail name="demo-script" fetchScript={pendingFetchScript} />,
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
