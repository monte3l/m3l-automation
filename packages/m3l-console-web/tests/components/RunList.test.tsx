import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { M3LConsoleFetchResult } from "../../src/api/client.js";
import type { M3LRunRecord } from "../../src/api/runs.js";
import { RunList } from "../../src/components/RunList.js";

function okFetchRuns(
  runs: readonly M3LRunRecord[],
): () => Promise<M3LConsoleFetchResult<readonly M3LRunRecord[]>> {
  return () => Promise.resolve({ ok: true, data: runs });
}

function errorFetchRuns(
  message: string,
): () => Promise<M3LConsoleFetchResult<readonly M3LRunRecord[]>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

const SAMPLE_RUN: M3LRunRecord = {
  id: "run-123",
  script: "demo-script",
  status: "success",
  dryRun: false,
  executionMode: "spawn",
  parameters: { region: "us-east-1" },
  operator: "boot-operator",
  correlationId: "corr-1",
  queuedAtMs: 1_700_000_000_000,
  startedAtMs: 1_700_000_001_000,
  endedAtMs: 1_700_000_002_000,
  outcome: "completed",
  exitCode: 0,
  failureMessage: null,
};

describe("RunList", () => {
  test("renders a loading state synchronously on mount", () => {
    render(<RunList fetchRuns={okFetchRuns([SAMPLE_RUN])} />);

    const list = screen.getByTestId("run-list");
    expect(list.textContent).toContain("Loading");
  });

  test("renders each run's script name, id, and status once loaded", async () => {
    render(<RunList fetchRuns={okFetchRuns([SAMPLE_RUN])} />);

    const list = await screen.findByTestId("run-list");
    expect(list.textContent).toContain("demo-script");
    expect(list.textContent).toContain("run-123");
    expect(list.textContent).toContain("success");
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

    render(<RunList fetchRuns={okFetchRuns([queuedRun])} />);

    const list = await screen.findByTestId("run-list");
    expect(list.textContent).toContain("run-123");
    expect(list.textContent).toContain("queued");
  });

  test('renders "no runs yet" when the list is empty', async () => {
    render(<RunList fetchRuns={okFetchRuns([])} />);

    const list = await screen.findByTestId("run-list");
    expect(list.textContent).toContain("no runs yet");
  });

  test("renders an error state when the fetch result is not ok", async () => {
    render(<RunList fetchRuns={errorFetchRuns("connection refused")} />);

    const list = await screen.findByTestId("run-list");
    expect(list.textContent).toContain("connection refused");
  });

  test("renders an error state when the fetcher rejects (.catch arm)", async () => {
    const rejectingFetchRuns = vi.fn(() => Promise.reject(new Error("boom")));

    render(<RunList fetchRuns={rejectingFetchRuns} />);

    const list = await screen.findByTestId("run-list");
    expect(list.textContent).toContain("boom");
  });

  test("invokes onSelectRun with the run id when a row is activated", async () => {
    const onSelectRun = vi.fn();
    render(
      <RunList
        fetchRuns={okFetchRuns([SAMPLE_RUN])}
        onSelectRun={onSelectRun}
      />,
    );

    const row = await screen.findByRole("button", { name: /run-123/ });
    row.click();

    expect(onSelectRun).toHaveBeenCalledWith("run-123");
  });

  test("calls the injected fetchRuns exactly once", async () => {
    const fetchRunsSpy = vi.fn(okFetchRuns([SAMPLE_RUN]));

    render(<RunList fetchRuns={fetchRunsSpy} />);
    await screen.findByTestId("run-list");

    expect(fetchRunsSpy).toHaveBeenCalledTimes(1);
  });

  test("does not update state after unmount once a late resolve arrives (.then guard)", async () => {
    let resolveFetch: (
      result: M3LConsoleFetchResult<readonly M3LRunRecord[]>,
    ) => void = () => {
      // replaced synchronously by the executor below
    };
    const pendingFetchRuns = (): Promise<
      M3LConsoleFetchResult<readonly M3LRunRecord[]>
    > =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // suppress React's console.error output for this test
      });

    const { unmount } = render(<RunList fetchRuns={pendingFetchRuns} />);
    unmount();
    resolveFetch({ ok: true, data: [SAMPLE_RUN] });
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
    const pendingFetchRuns = (): Promise<
      M3LConsoleFetchResult<readonly M3LRunRecord[]>
    > =>
      new Promise((_resolve, reject) => {
        rejectFetch = reject;
      });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // suppress React's console.error output for this test
      });

    const { unmount } = render(<RunList fetchRuns={pendingFetchRuns} />);
    unmount();
    rejectFetch(new Error("boom"));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
