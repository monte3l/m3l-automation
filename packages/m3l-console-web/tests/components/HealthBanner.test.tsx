import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { M3LConsoleFetchResult } from "../../src/api/client.js";
import type { M3LHealthPayload } from "../../src/api/health.js";
import { HealthBanner } from "../../src/components/HealthBanner.js";

function okFetchHealth(
  uptimeMs: number,
): () => Promise<M3LConsoleFetchResult<M3LHealthPayload>> {
  return () => Promise.resolve({ ok: true, data: { status: "ok", uptimeMs } });
}

function errorFetchHealth(
  message: string,
): () => Promise<M3LConsoleFetchResult<M3LHealthPayload>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

describe("HealthBanner", () => {
  test("renders a checking state synchronously on mount", () => {
    render(<HealthBanner fetchHealth={okFetchHealth(42)} />);

    const banner = screen.getByTestId("health-banner");
    expect(banner.textContent).toContain("Checking console health");
  });

  test("renders the ok state with the reported uptime", async () => {
    render(<HealthBanner fetchHealth={okFetchHealth(42)} />);

    const banner = await screen.findByTestId("health-banner");
    expect(banner.textContent).toContain("ok");
    expect(banner.textContent).toContain("42");
  });

  test("renders the unreachable state with the error message", async () => {
    render(
      <HealthBanner fetchHealth={errorFetchHealth("connection refused")} />,
    );

    const banner = await screen.findByTestId("health-banner");
    expect(banner.textContent).toContain("unreachable");
    expect(banner.textContent).toContain("connection refused");
  });

  test("calls the injected fetchHealth exactly once", async () => {
    const fetchHealthSpy = vi.fn(okFetchHealth(42));

    render(<HealthBanner fetchHealth={fetchHealthSpy} />);
    await screen.findByTestId("health-banner");

    expect(fetchHealthSpy).toHaveBeenCalledTimes(1);
  });

  // [KNOWN BUG] HealthBanner's effect never attaches a .catch() to the
  // load().then(...) chain, so a rejecting fetchHealth becomes an
  // unhandled promise rejection and the banner is stuck at "checking"
  // forever instead of reaching the unreachable state.
  test("renders the unreachable state when fetchHealth rejects", async () => {
    const rejectingFetchHealth = vi.fn(() => Promise.reject(new Error("boom")));

    render(<HealthBanner fetchHealth={rejectingFetchHealth} />);

    const banner = await screen.findByTestId("health-banner");
    expect(banner.textContent).toContain("unreachable");
    expect(banner.textContent).toContain("boom");
  });

  test("does not update state after unmount once a late resolve arrives (.then guard)", async () => {
    let resolveFetch: (
      result: M3LConsoleFetchResult<M3LHealthPayload>,
    ) => void = () => {
      // replaced synchronously by the executor below
    };
    const pendingFetchHealth = (): Promise<
      M3LConsoleFetchResult<M3LHealthPayload>
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
      <HealthBanner fetchHealth={pendingFetchHealth} />,
    );
    unmount();
    resolveFetch({ ok: true, data: { status: "ok", uptimeMs: 42 } });
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
    const pendingFetchHealth = (): Promise<
      M3LConsoleFetchResult<M3LHealthPayload>
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
      <HealthBanner fetchHealth={pendingFetchHealth} />,
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
