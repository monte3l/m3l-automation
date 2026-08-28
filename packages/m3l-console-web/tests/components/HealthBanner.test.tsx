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
});
