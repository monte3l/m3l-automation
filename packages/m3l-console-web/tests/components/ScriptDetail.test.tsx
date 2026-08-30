import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { M3LConsoleFetchResult } from "../../src/api/client.js";
import type { M3LRunHandle, M3LRunLaunchRequest } from "../../src/api/runs.js";
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

// A detail whose sole parameter is optional and unscoped, so the launch
// tests below can submit immediately (dryRun defaults on) without first
// filling in any field.
const LAUNCHABLE_DETAIL: M3LScriptDetail = {
  name: "demo-script",
  description: "Runs the demo pipeline",
  hasCommandModule: false,
  executionMode: "spawn",
  parameters: [
    {
      name: "region",
      aliases: [],
      type: "STRING",
      required: false,
      defaultValue: null,
      description: "",
      secret: false,
      operations: [],
    },
  ],
  operations: [],
};

const SAMPLE_HANDLE: M3LRunHandle = {
  id: "run-42",
  scriptName: "demo-script",
  status: "queued",
  dryRun: true,
  executionMode: "spawn",
};

function okLaunchRun(
  handle: M3LRunHandle,
): (
  request: M3LRunLaunchRequest,
) => Promise<M3LConsoleFetchResult<M3LRunHandle>> {
  return () => Promise.resolve({ ok: true, data: handle });
}

function httpErrorLaunchRun(
  status: number,
  code: string,
  message: string,
): (
  request: M3LRunLaunchRequest,
) => Promise<M3LConsoleFetchResult<M3LRunHandle>> {
  return () =>
    Promise.resolve({
      ok: false,
      error: {
        kind: "http",
        status,
        code,
        message,
        correlationId: "corr-1",
      },
    });
}

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

describe("ScriptDetail — launch wiring", () => {
  test("renders ParameterForm below the existing read-only table once loaded", async () => {
    render(
      <ScriptDetail
        name="demo-script"
        fetchScript={okFetchScript(SAMPLE_DETAIL)}
        launchRun={okLaunchRun(SAMPLE_HANDLE)}
      />,
    );

    const detail = await screen.findByTestId("script-detail");
    expect(detail.querySelector("table")).not.toBeNull();
    expect(
      detail.querySelector('[data-testid="parameter-form"]'),
    ).not.toBeNull();
  });

  test("a successful launch invokes onLaunched with the returned run id", async () => {
    const onLaunched = vi.fn();
    render(
      <ScriptDetail
        name="demo-script"
        fetchScript={okFetchScript(LAUNCHABLE_DETAIL)}
        launchRun={okLaunchRun(SAMPLE_HANDLE)}
        onLaunched={onLaunched}
      />,
    );

    await screen.findByTestId("script-detail");
    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    await vi.waitFor(() => {
      expect(onLaunched).toHaveBeenCalledWith("run-42");
    });
  });

  test("maps ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED (409) to operator-legible text, not the raw code", async () => {
    render(
      <ScriptDetail
        name="demo-script"
        fetchScript={okFetchScript(LAUNCHABLE_DETAIL)}
        launchRun={httpErrorLaunchRun(
          409,
          "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED",
          "confirmation is required for a non-dry-run launch",
        )}
      />,
    );

    await screen.findByTestId("script-detail");
    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    const detail = await screen.findByTestId("script-detail");
    await vi.waitFor(() => {
      expect(detail.textContent).not.toContain(
        "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED",
      );
      expect(detail.textContent?.toLowerCase()).toContain("confirmation");
    });
  });

  test("maps ERR_CONSOLE_RUN_CAPACITY_EXCEEDED (429) to operator-legible text, not the raw code", async () => {
    render(
      <ScriptDetail
        name="demo-script"
        fetchScript={okFetchScript(LAUNCHABLE_DETAIL)}
        launchRun={httpErrorLaunchRun(
          429,
          "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED",
          "the run queue is at capacity",
        )}
      />,
    );

    await screen.findByTestId("script-detail");
    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    const detail = await screen.findByTestId("script-detail");
    await vi.waitFor(() => {
      expect(detail.textContent).not.toContain(
        "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED",
      );
      expect(detail.textContent?.toLowerCase()).toContain("queue");
    });
  });

  test("falls back to the envelope's own message for any other failure code", async () => {
    render(
      <ScriptDetail
        name="demo-script"
        fetchScript={okFetchScript(LAUNCHABLE_DETAIL)}
        launchRun={httpErrorLaunchRun(
          400,
          "ERR_CONSOLE_BAD_REQUEST",
          "scriptName must match ^[a-z][a-z0-9-]*$",
        )}
      />,
    );

    await screen.findByTestId("script-detail");
    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    const detail = await screen.findByTestId("script-detail");
    await vi.waitFor(() => {
      expect(detail.textContent).toContain(
        "scriptName must match ^[a-z][a-z0-9-]*$",
      );
    });
  });

  // Only reachable end-to-end submission shape besides the dry-run default:
  // Dry run unchecked, Confirm real run checked. buildLaunchRequest's
  // `submission.confirmed` arm (dryRun: false, confirmed: true) is otherwise
  // never exercised by the sibling tests above, which all launch in dry-run
  // mode.
  test("a confirmed real run (dryRun off, confirmed on) sends { dryRun: false, confirmed: true } to launchRun", async () => {
    const launchRunSpy = vi.fn(okLaunchRun(SAMPLE_HANDLE));
    render(
      <ScriptDetail
        name="demo-script"
        fetchScript={okFetchScript(LAUNCHABLE_DETAIL)}
        launchRun={launchRunSpy}
      />,
    );

    await screen.findByTestId("script-detail");
    fireEvent.click(screen.getByLabelText("Dry run"));
    fireEvent.click(screen.getByLabelText("Confirm real run"));
    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    await vi.waitFor(() => {
      expect(launchRunSpy).toHaveBeenCalledWith({
        scriptName: "demo-script",
        parameters: {},
        dryRun: false,
        confirmed: true,
      });
    });
  });

  test("surfaces the rejection message when launchRun rejects (.catch arm)", async () => {
    render(
      <ScriptDetail
        name="demo-script"
        fetchScript={okFetchScript(LAUNCHABLE_DETAIL)}
        launchRun={() => Promise.reject(new Error("network down"))}
      />,
    );

    await screen.findByTestId("script-detail");
    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    const detail = await screen.findByTestId("script-detail");
    await vi.waitFor(() => {
      expect(detail.textContent).toContain("network down");
    });
  });
});

// X10d CRITICAL security finding, reproduced empirically: App.tsx puts no
// `key` on <ScriptDetail>, this file's useScriptDetailFetchState never
// resets state to "loading" on a `name` change, and ParameterForm's
// values/dryRun/confirmed are per-instance useState with a lazy initializer
// that runs once. Switching #/scripts/alpha -> #/scripts/beta therefore
// reuses the same mounted ParameterForm instance, carrying a stale
// `confirmed: true` (and any typed parameter value) into a launch request
// for a DIFFERENT script the operator never explicitly confirmed.
describe("ScriptDetail — script switch resets launch form state (X10d)", () => {
  function detailFor(name: string): M3LScriptDetail {
    return {
      name,
      description: `${name} description`,
      hasCommandModule: false,
      executionMode: "spawn",
      parameters: [
        {
          name: "region",
          aliases: [],
          type: "STRING",
          required: false,
          defaultValue: null,
          description: "",
          secret: false,
          operations: [],
        },
      ],
      operations: [],
    };
  }

  test("switching to a different script (no remount key) resets values, dryRun, and confirmed rather than carrying the previous script's form state forward", async () => {
    const launches: M3LRunLaunchRequest[] = [];
    const launch = (
      request: M3LRunLaunchRequest,
    ): Promise<M3LConsoleFetchResult<M3LRunHandle>> => {
      launches.push(request);
      return Promise.resolve({ ok: true, data: SAMPLE_HANDLE });
    };
    const fetchScript = (
      name: string,
    ): Promise<M3LConsoleFetchResult<M3LScriptDetail>> =>
      Promise.resolve({ ok: true, data: detailFor(name) });

    const { rerender } = render(
      <ScriptDetail
        name="alpha-script"
        fetchScript={fetchScript}
        launchRun={launch}
      />,
    );
    await screen.findByText("alpha-script description");

    fireEvent.change(screen.getByLabelText("region"), {
      target: { value: "leaked-value" },
    });
    fireEvent.click(screen.getByLabelText("Dry run"));
    fireEvent.click(screen.getByLabelText("Confirm real run"));
    expect(screen.getByRole("button", { name: /launch/i })).not.toBeDisabled();

    rerender(
      <ScriptDetail
        name="beta-script"
        fetchScript={fetchScript}
        launchRun={launch}
      />,
    );
    await screen.findByText("beta-script description");

    // dryRun must default back on for the new script, with no confirm
    // control left dangling from the previous one.
    expect(screen.getByLabelText("Dry run")).toBeChecked();
    expect(screen.queryByLabelText("Confirm real run")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    await vi.waitFor(() => {
      expect(launches).toHaveLength(1);
    });
    const [request] = launches;
    expect(request?.scriptName).toBe("beta-script");
    expect(request?.dryRun).toBe(true);
    expect(request?.confirmed).toBe(false);
    expect(request?.parameters["region"]).not.toBe("leaked-value");
  });

  // Originated as a plaintext-downgrade probe (a secret:true control's typed
  // value survived a switch into a same-named secret:false control). That
  // half of the vector is now structurally impossible: a secret:true
  // parameter renders no editable control at all (see ParameterForm.test.tsx),
  // so there is nothing to type into under alpha in the first place.
  //
  // The residual half is not covered by the sibling "no remount key" test
  // above: that test leaves its same-named field untouched after the
  // switch, so an empty, omitted-on-submit "region" parameter would pass
  // even without a working remount key. This test instead retypes the
  // same-named field under alpha and reads the new script's control value
  // directly (no submit involved), so a stale value surviving the switch
  // cannot hide behind the optional-left-empty omission rule.
  test("switching scripts does not leak a typed non-secret value into a same-named parameter in the next script", async () => {
    const alphaDetail: M3LScriptDetail = {
      name: "alpha-script",
      description: "alpha-script description",
      hasCommandModule: false,
      executionMode: "spawn",
      parameters: [
        {
          name: "apiKey",
          aliases: [],
          type: "STRING",
          required: false,
          defaultValue: null,
          description: "",
          secret: false,
          operations: [],
        },
      ],
      operations: [],
    };
    const betaDetail: M3LScriptDetail = {
      ...alphaDetail,
      name: "beta-script",
      description: "beta-script description",
    };
    const fetchScript = (
      name: string,
    ): Promise<M3LConsoleFetchResult<M3LScriptDetail>> =>
      Promise.resolve({
        ok: true,
        data: name === "alpha-script" ? alphaDetail : betaDetail,
      });

    const { rerender } = render(
      <ScriptDetail name="alpha-script" fetchScript={fetchScript} />,
    );
    await screen.findByText("alpha-script description");

    fireEvent.change(screen.getByLabelText("apiKey"), {
      target: { value: "carried-over-value" },
    });

    rerender(<ScriptDetail name="beta-script" fetchScript={fetchScript} />);
    await screen.findByText("beta-script description");

    const input = screen.getByLabelText<HTMLInputElement>("apiKey");
    expect(input.value).not.toBe("carried-over-value");
  });
});

// The eslint-disable on useScriptDetailFetchState's effect asserts the
// injected fetchScript/launchRun props are "stable" — nothing enforces
// that today. This turns the comment into a contract: a changed fetcher
// identity, with `name` unchanged, must not retrigger a fetch.
describe("ScriptDetail — stable-prop convention (X10d)", () => {
  test("changing the fetchScript prop identity without changing name does not retrigger a fetch", async () => {
    const firstFetch = vi.fn(okFetchScript(SAMPLE_DETAIL));
    const { rerender } = render(
      <ScriptDetail name="demo-script" fetchScript={firstFetch} />,
    );
    await screen.findByTestId("script-detail");
    expect(firstFetch).toHaveBeenCalledTimes(1);

    const secondFetch = vi.fn(okFetchScript(SAMPLE_DETAIL));
    rerender(<ScriptDetail name="demo-script" fetchScript={secondFetch} />);

    // Give any effect a tick to fire, if it were going to.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(secondFetch).not.toHaveBeenCalled();
    expect(firstFetch).toHaveBeenCalledTimes(1);
  });
});
