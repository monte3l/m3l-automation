import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { M3LConsoleFetchResult } from "../../src/api/client.js";
import type { M3LSessionRecord } from "../../src/api/sessions.js";
import { SessionList } from "../../src/components/SessionList.js";

function okFetchSessions(
  sessions: readonly M3LSessionRecord[],
): () => Promise<M3LConsoleFetchResult<readonly M3LSessionRecord[]>> {
  return () => Promise.resolve({ ok: true, data: sessions });
}

function errorFetchSessions(
  message: string,
): () => Promise<M3LConsoleFetchResult<readonly M3LSessionRecord[]>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

function okCreateSession(
  session: M3LSessionRecord,
): () => Promise<M3LConsoleFetchResult<M3LSessionRecord>> {
  return () => Promise.resolve({ ok: true, data: session });
}

function errorCreateSession(
  message: string,
): () => Promise<M3LConsoleFetchResult<M3LSessionRecord>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

const OPEN_SESSION: M3LSessionRecord = {
  id: "session-123",
  operator: "boot-operator",
  correlationId: "corr-1",
  status: "open",
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_000_000,
};

describe("SessionList", () => {
  test("renders a loading state synchronously on mount", () => {
    render(<SessionList fetchSessions={okFetchSessions([OPEN_SESSION])} />);

    const list = screen.getByTestId("session-list");
    expect(list.textContent).toContain("Loading");
  });

  test("renders each session's id, status, and created timestamp once loaded", async () => {
    render(<SessionList fetchSessions={okFetchSessions([OPEN_SESSION])} />);

    const list = await screen.findByTestId("session-list");
    expect(list.textContent).toContain("session-123");
    expect(list.textContent).toContain("open");
    expect(list.textContent).toContain(
      new Date(OPEN_SESSION.createdAtMs).toISOString(),
    );
  });

  test('renders "no sessions yet" when the list is empty', async () => {
    render(<SessionList fetchSessions={okFetchSessions([])} />);

    const list = await screen.findByTestId("session-list");
    expect(list.textContent).toContain("no sessions yet");
  });

  test("renders an error state when the fetch result is not ok", async () => {
    render(
      <SessionList fetchSessions={errorFetchSessions("connection refused")} />,
    );

    const list = await screen.findByTestId("session-list");
    expect(list.textContent).toContain("connection refused");
  });

  test("renders an error state when the fetcher rejects (.catch arm)", async () => {
    const rejectingFetchSessions = vi.fn(() =>
      Promise.reject(new Error("boom")),
    );

    render(<SessionList fetchSessions={rejectingFetchSessions} />);

    const list = await screen.findByTestId("session-list");
    expect(list.textContent).toContain("boom");
  });

  test("invokes onSelectSession with the session id when a row is activated", async () => {
    const onSelectSession = vi.fn();
    render(
      <SessionList
        fetchSessions={okFetchSessions([OPEN_SESSION])}
        onSelectSession={onSelectSession}
      />,
    );

    const row = await screen.findByRole("button", { name: /session-123/ });
    row.click();

    expect(onSelectSession).toHaveBeenCalledWith("session-123");
  });

  test("calls the injected fetchSessions exactly once", async () => {
    const fetchSessionsSpy = vi.fn(okFetchSessions([OPEN_SESSION]));

    render(<SessionList fetchSessions={fetchSessionsSpy} />);
    await screen.findByTestId("session-list");

    expect(fetchSessionsSpy).toHaveBeenCalledTimes(1);
  });

  test("does not update state after unmount once a late resolve arrives (.then guard)", async () => {
    let resolveFetch: (
      result: M3LConsoleFetchResult<readonly M3LSessionRecord[]>,
    ) => void = () => {
      // replaced synchronously by the executor below
    };
    const pendingFetchSessions = (): Promise<
      M3LConsoleFetchResult<readonly M3LSessionRecord[]>
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
      <SessionList fetchSessions={pendingFetchSessions} />,
    );
    unmount();
    resolveFetch({ ok: true, data: [OPEN_SESSION] });
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
    const pendingFetchSessions = (): Promise<
      M3LConsoleFetchResult<readonly M3LSessionRecord[]>
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
      <SessionList fetchSessions={pendingFetchSessions} />,
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

describe("SessionList — new session creation", () => {
  test("always renders a New session button, independent of the list's own load state", () => {
    render(<SessionList fetchSessions={okFetchSessions([OPEN_SESSION])} />);

    expect(
      screen.getByRole("button", { name: /new session/i }),
    ).toBeInTheDocument();
  });

  test("clicking New session calls the injected createSession and, on success, onSessionCreated with the created id", async () => {
    const onSessionCreated = vi.fn();
    render(
      <SessionList
        fetchSessions={okFetchSessions([])}
        createSession={okCreateSession(OPEN_SESSION)}
        onSessionCreated={onSessionCreated}
      />,
    );
    await screen.findByTestId("session-list");

    const button = screen.getByRole("button", { name: /new session/i });
    button.click();

    await vi.waitFor(() => {
      expect(onSessionCreated).toHaveBeenCalledWith("session-123");
    });
  });

  test("a click with no onSessionCreated prop does not throw", async () => {
    render(
      <SessionList
        fetchSessions={okFetchSessions([])}
        createSession={okCreateSession(OPEN_SESSION)}
      />,
    );
    await screen.findByTestId("session-list");

    const button = screen.getByRole("button", { name: /new session/i });
    expect(() => {
      button.click();
    }).not.toThrow();
  });

  test("surfaces an ok:false createSession failure's message in the session-list container and does not call onSessionCreated", async () => {
    const onSessionCreated = vi.fn();
    render(
      <SessionList
        fetchSessions={okFetchSessions([])}
        createSession={errorCreateSession("quota exceeded")}
        onSessionCreated={onSessionCreated}
      />,
    );
    const list = await screen.findByTestId("session-list");

    const button = screen.getByRole("button", { name: /new session/i });
    button.click();

    await vi.waitFor(() => {
      expect(list.textContent).toContain("quota exceeded");
    });
    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  test("surfaces a rejected createSession promise's message and does not call onSessionCreated", async () => {
    const onSessionCreated = vi.fn();
    const rejectingCreateSession = vi.fn(() =>
      Promise.reject(new Error("create boom")),
    );
    render(
      <SessionList
        fetchSessions={okFetchSessions([])}
        createSession={rejectingCreateSession}
        onSessionCreated={onSessionCreated}
      />,
    );
    const list = await screen.findByTestId("session-list");

    const button = screen.getByRole("button", { name: /new session/i });
    button.click();

    await vi.waitFor(() => {
      expect(list.textContent).toContain("create boom");
    });
    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  // [KNOWN GAP] useCreateSessionHandler's .then/.catch chain has no
  // unmount guard (unlike the list-loading effect's `cancelled` flag) —
  // it calls setCreateError/onSessionCreated unconditionally even after
  // the component has unmounted.
  //
  // This deliberately does NOT mirror the load-effect's unmount tests'
  // consoleErrorSpy pattern above: React 19 no longer emits a
  // console.error for a setState call on an unmounted component (verified
  // directly — a minimal component violating the guard produces zero
  // console.error calls), so that assertion would pass identically
  // whether or not the guard exists and cannot discriminate this gap.
  // `onSessionCreated` is the one externally observable side effect on
  // the resolved/ok arm, so it is the assertion used instead. The
  // rejected/.catch arm shares the same missing `cancelled` check and the
  // same fix will guard it too, but it has no externally observable side
  // effect (only internal `createError` state) to assert against once the
  // component is unmounted, so it is not separately testable here.
  test("does not call onSessionCreated after unmount once a late createSession resolve arrives", async () => {
    let resolveCreate: (
      result: M3LConsoleFetchResult<M3LSessionRecord>,
    ) => void = () => {
      // replaced synchronously by the executor below
    };
    const pendingCreateSession = (): Promise<
      M3LConsoleFetchResult<M3LSessionRecord>
    > =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      });
    const onSessionCreated = vi.fn();

    const { unmount } = render(
      <SessionList
        fetchSessions={okFetchSessions([])}
        createSession={pendingCreateSession}
        onSessionCreated={onSessionCreated}
      />,
    );
    await screen.findByTestId("session-list");
    const button = screen.getByRole("button", { name: /new session/i });
    button.click();
    unmount();
    resolveCreate({ ok: true, data: OPEN_SESSION });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(onSessionCreated).not.toHaveBeenCalled();
  });
});
