import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ErrorBoundary } from "../../src/components/ErrorBoundary.js";

function Bomb(): ReactElement {
  throw new Error("boom");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  test("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div>fine</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText("fine")).toBeInTheDocument();
    expect(screen.queryByTestId("error-boundary-fallback")).toBeNull();
  });

  test("renders the fallback when a descendant throws during render", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    const fallback = screen.getByTestId("error-boundary-fallback");
    expect(fallback.textContent).toContain("Something went wrong.");
  });
});
