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

/**
 * Resolves ok on the first call (the initial load), then ok:false on every
 * subsequent call (a gap-triggered resync that fails cleanly).
 */
function okThenErrorFetchRun(
  run: M3LRunRecord,
  errorMessage: string,
): (id: string) => Promise<M3LConsoleFetchResult<M3LRunRecord>> {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve({ ok: true, data: run });
    }
    return Promise.resolve({
      ok: false,
      error: { kind: "network", message: errorMessage },
    });
  };
}

/**
 * Resolves ok on the first call (the initial load), then rejects on every
 * subsequent call (a gap-triggered resync whose fetch itself throws).
 */
function okThenRejectingFetchRun(
  run: M3LRunRecord,
  rejection: Error,
): (id: string) => Promise<M3LConsoleFetchResult<M3LRunRecord>> {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve({ ok: true, data: run });
    }
    return Promise.reject(rejection);
  };
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

/**
 * Minimal stream-state shape RunDetail's injected `useRunStream` seam is
 * expected to return. Deliberately not imported from
 * `src/hooks/useRunStream.js`'s `M3LRunStreamState` — that module (and its
 * own tests) belong to a different, concurrently-in-flight test author;
 * this inline shape only needs to match structurally.
 */
interface FakeRunStreamState {
  readonly lines: readonly string[];
  readonly phase: "connecting" | "open" | "ended";
  readonly endReason: string | null;
  readonly gapCount: number;
}

describe("RunDetail — live tail wiring", () => {
  test("mounts the run log tail for a non-terminal (queued/running) run", async () => {
    const openStream: FakeRunStreamState = {
      lines: ["line one"],
      phase: "open",
      endReason: null,
      gapCount: 0,
    };
    const useRunStreamFake = vi.fn(() => openStream);
    const queuedRun: M3LRunRecord = { ...SAMPLE_RUN, status: "queued" };

    render(
      <RunDetail
        id="run-123"
        fetchRun={okFetchRun(queuedRun)}
        useRunStream={useRunStreamFake}
      />,
    );

    const detail = await screen.findByTestId("run-detail");
    const tail = detail.querySelector('[data-testid="run-log-tail"]');
    expect(tail).not.toBeNull();
    expect(tail?.textContent).toContain("line one");
    expect(useRunStreamFake).toHaveBeenCalledWith(
      "run-123",
      expect.any(Function),
    );
  });

  test("a terminal run still gets the tail (the server replays the ring buffer and closes)", async () => {
    const endedStream: FakeRunStreamState = {
      lines: ["line one", "line two"],
      phase: "ended",
      endReason: "completed",
      gapCount: 0,
    };
    const useRunStreamFake = vi.fn(() => endedStream);

    render(
      <RunDetail
        id="run-123"
        fetchRun={okFetchRun(SAMPLE_RUN)}
        useRunStream={useRunStreamFake}
      />,
    );

    const detail = await screen.findByTestId("run-detail");
    expect(detail.querySelector('[data-testid="run-log-tail"]')).not.toBeNull();
  });

  test("onResync (passed to useRunStream) re-fetches the run record on a gap", async () => {
    let capturedOnResync: (() => void) | undefined;
    const useRunStreamFake = vi.fn((_id: string, onResync: () => void) => {
      capturedOnResync = onResync;
      return {
        lines: [],
        phase: "open",
        endReason: null,
        gapCount: 0,
      } satisfies FakeRunStreamState;
    });
    const fetchRunSpy = vi.fn(okFetchRun(SAMPLE_RUN));

    render(
      <RunDetail
        id="run-123"
        fetchRun={fetchRunSpy}
        useRunStream={useRunStreamFake}
      />,
    );
    await screen.findByTestId("run-detail");

    expect(fetchRunSpy).toHaveBeenCalledTimes(1);
    expect(capturedOnResync).toBeInstanceOf(Function);

    capturedOnResync?.();

    await vi.waitFor(() => {
      expect(fetchRunSpy).toHaveBeenCalledTimes(2);
    });
  });
});

describe("RunDetail — resync failure visibility", () => {
  // [KNOWN BUG] src/components/RunDetail.tsx:118-125's handleResync drops
  // `result.error` and has no `.catch()` — a failed gap-triggered resync
  // silently leaves the operator looking at pre-gap (already-known-stale)
  // status/outcome/exitCode with no indication anything went wrong.
  test("surfaces an error when a gap-triggered resync fetch returns ok:false, instead of silently keeping the stale pre-gap record", async () => {
    let capturedOnResync: (() => void) | undefined;
    const useRunStreamFake = vi.fn((_id: string, onResync: () => void) => {
      capturedOnResync = onResync;
      return {
        lines: [],
        phase: "open",
        endReason: null,
        gapCount: 1,
      } satisfies FakeRunStreamState;
    });
    const fetchRunSpy = vi.fn(okThenErrorFetchRun(SAMPLE_RUN, "resync failed"));

    render(
      <RunDetail
        id="run-123"
        fetchRun={fetchRunSpy}
        useRunStream={useRunStreamFake}
      />,
    );
    await screen.findByTestId("run-detail");
    expect(capturedOnResync).toBeInstanceOf(Function);

    capturedOnResync?.();

    await vi.waitFor(() => {
      expect(fetchRunSpy).toHaveBeenCalledTimes(2);
    });

    const detail = screen.getByTestId("run-detail");
    expect(detail.textContent).toContain("resync failed");
  });

  // [KNOWN BUG] same site as above — handleResync's `.then()` has no
  // `.catch()`, so a rejecting resync fetch becomes an unhandled rejection
  // rather than a surfaced error.
  test("surfaces an error when a gap-triggered resync fetch rejects, instead of becoming an unhandled rejection", async () => {
    let capturedOnResync: (() => void) | undefined;
    const useRunStreamFake = vi.fn((_id: string, onResync: () => void) => {
      capturedOnResync = onResync;
      return {
        lines: [],
        phase: "open",
        endReason: null,
        gapCount: 1,
      } satisfies FakeRunStreamState;
    });
    const fetchRunSpy = vi.fn(
      okThenRejectingFetchRun(SAMPLE_RUN, new Error("resync network failure")),
    );

    render(
      <RunDetail
        id="run-123"
        fetchRun={fetchRunSpy}
        useRunStream={useRunStreamFake}
      />,
    );
    await screen.findByTestId("run-detail");
    expect(capturedOnResync).toBeInstanceOf(Function);

    capturedOnResync?.();

    await vi.waitFor(() => {
      expect(fetchRunSpy).toHaveBeenCalledTimes(2);
    });

    const detail = screen.getByTestId("run-detail");
    expect(detail.textContent).toContain("resync network failure");
  });
});
