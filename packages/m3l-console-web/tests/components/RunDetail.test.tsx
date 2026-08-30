import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { M3LConsoleFetchResult } from "../../src/api/client.js";
import type { M3LRunRecord } from "../../src/api/runs.js";
import { RunDetail } from "../../src/components/RunDetail.js";

function okFetchRun(
  run: M3LRunRecord,
): (id: string) => Promise<M3LConsoleFetchResult<M3LRunRecord>> {
  return () => Promise.resolve({ ok: true, data: run });
}

function errorFetchRun(
  message: string,
): (id: string) => Promise<M3LConsoleFetchResult<M3LRunRecord>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

const SAMPLE_RUN: M3LRunRecord = {
  id: "run-123",
  script: "demo-script",
  status: "success",
  dryRun: false,
  executionMode: "spawn",
  parameters: { region: "us-east-1", retries: 3 },
  operator: "boot-operator",
  correlationId: "corr-1",
  queuedAtMs: 1_700_000_000_000,
  startedAtMs: 1_700_000_001_000,
  endedAtMs: 1_700_000_002_000,
  outcome: "completed",
  exitCode: 0,
  failureMessage: null,
};

describe("RunDetail", () => {
  test("renders a loading state synchronously on mount", () => {
    render(<RunDetail id="run-123" fetchRun={okFetchRun(SAMPLE_RUN)} />);

    const detail = screen.getByTestId("run-detail");
    expect(detail.textContent).toContain("Loading");
  });

  test("renders the run's script, status, and id once loaded", async () => {
    render(<RunDetail id="run-123" fetchRun={okFetchRun(SAMPLE_RUN)} />);

    const detail = await screen.findByTestId("run-detail");
    expect(detail.textContent).toContain("demo-script");
    expect(detail.textContent).toContain("success");
    expect(detail.textContent).toContain("run-123");
  });

  test("renders queuedAtMs as an ISO timestamp string", async () => {
    render(<RunDetail id="run-123" fetchRun={okFetchRun(SAMPLE_RUN)} />);

    const detail = await screen.findByTestId("run-detail");
    expect(detail.textContent).toContain(
      new Date(SAMPLE_RUN.queuedAtMs).toISOString(),
    );
  });

  test("renders parameters as pretty-printed JSON inside a <pre>", async () => {
    // The server documents `parameters` as echoed back verbatim and warns
    // against passing secrets through it; the UI intentionally does not
    // mask any part of this blob, since it has no way to know which
    // fields (if any) are sensitive.
    render(<RunDetail id="run-123" fetchRun={okFetchRun(SAMPLE_RUN)} />);

    const detail = await screen.findByTestId("run-detail");
    const pre = detail.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe(
      JSON.stringify(SAMPLE_RUN.parameters, null, 2),
    );
  });

  test("renders a queued run whose timing/outcome fields are null without throwing", async () => {
    const queuedRun: M3LRunRecord = {
      ...SAMPLE_RUN,
      status: "queued",
      startedAtMs: null,
      endedAtMs: null,
      outcome: null,
      exitCode: null,
      failureMessage: null,
    };

    render(<RunDetail id="run-123" fetchRun={okFetchRun(queuedRun)} />);

    const detail = await screen.findByTestId("run-detail");
    expect(detail.textContent).toContain("queued");
  });

  test("renders a failureMessage containing markup as literal text, not markup", async () => {
    const maliciousFailure = "<img src=x onerror=alert(1)>";
    render(
      <RunDetail
        id="run-123"
        fetchRun={okFetchRun({
          ...SAMPLE_RUN,
          status: "failure",
          outcome: "failed",
          exitCode: 1,
          failureMessage: maliciousFailure,
        })}
      />,
    );

    const detail = await screen.findByTestId("run-detail");
    expect(detail.textContent).toContain(maliciousFailure);
    expect(detail.querySelector("img")).toBeNull();
  });

  test("renders an error state when the fetch result is not ok", async () => {
    render(<RunDetail id="run-123" fetchRun={errorFetchRun("not found")} />);

    const detail = await screen.findByTestId("run-detail");
    expect(detail.textContent).toContain("not found");
  });

  test("renders an error state when the fetcher rejects (.catch arm)", async () => {
    const rejectingFetchRun = vi.fn(() => Promise.reject(new Error("boom")));

    render(<RunDetail id="run-123" fetchRun={rejectingFetchRun} />);

    const detail = await screen.findByTestId("run-detail");
    expect(detail.textContent).toContain("boom");
  });

  test("calls fetchRun with the id prop", async () => {
    const fetchRunSpy = vi.fn(okFetchRun(SAMPLE_RUN));

    render(<RunDetail id="run-123" fetchRun={fetchRunSpy} />);
    await screen.findByTestId("run-detail");

    expect(fetchRunSpy).toHaveBeenCalledWith("run-123");
  });

  test("does not update state after unmount once a late resolve arrives (.then guard)", async () => {
    let resolveFetch: (
      result: M3LConsoleFetchResult<M3LRunRecord>,
    ) => void = () => {
      // replaced synchronously by the executor below
    };
    const pendingFetchRun = (): Promise<M3LConsoleFetchResult<M3LRunRecord>> =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // suppress React's console.error output for this test
      });

    const { unmount } = render(
      <RunDetail id="run-123" fetchRun={pendingFetchRun} />,
    );
    unmount();
    resolveFetch({ ok: true, data: SAMPLE_RUN });
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
    const pendingFetchRun = (): Promise<M3LConsoleFetchResult<M3LRunRecord>> =>
      new Promise((_resolve, reject) => {
        rejectFetch = reject;
      });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // suppress React's console.error output for this test
      });

    const { unmount } = render(
      <RunDetail id="run-123" fetchRun={pendingFetchRun} />,
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
