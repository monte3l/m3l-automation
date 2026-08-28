import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "../src/App.js";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: false,
    status: 503,
    statusText: "Service Unavailable",
    json: () => Promise.resolve({}),
  } as unknown as Response);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App", () => {
  test("renders the console heading and a health banner", () => {
    render(<App />);

    expect(screen.getByText(/m3l console/i)).toBeInTheDocument();
    expect(screen.getByTestId("health-banner")).toBeInTheDocument();
  });
});
