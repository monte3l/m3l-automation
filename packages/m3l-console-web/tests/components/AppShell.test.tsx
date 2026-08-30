import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { M3LRoute } from "../../src/routing/useHashRoute.js";
import { AppShell } from "../../src/components/AppShell.js";

describe("AppShell", () => {
  test("renders its children inside the shell", () => {
    render(
      <AppShell route={{ kind: "scripts" }} navigate={vi.fn()}>
        <p>child content</p>
      </AppShell>,
    );

    const shell = screen.getByTestId("app-shell");
    expect(shell.textContent).toContain("child content");
  });

  test("renders nav links for Scripts and Runs", () => {
    render(
      <AppShell route={{ kind: "scripts" }} navigate={vi.fn()}>
        <p>child</p>
      </AppShell>,
    );

    expect(screen.getByTestId("nav-scripts")).toBeInTheDocument();
    expect(screen.getByTestId("nav-runs")).toBeInTheDocument();
  });

  test("navigates to the scripts route when the Scripts nav link is activated", () => {
    const navigate = vi.fn();
    render(
      <AppShell route={{ kind: "runs" }} navigate={navigate}>
        <p>child</p>
      </AppShell>,
    );

    screen.getByTestId("nav-scripts").click();

    expect(navigate).toHaveBeenCalledWith({ kind: "scripts" });
  });

  test("navigates to the runs route when the Runs nav link is activated", () => {
    const navigate = vi.fn();
    render(
      <AppShell route={{ kind: "scripts" }} navigate={navigate}>
        <p>child</p>
      </AppShell>,
    );

    screen.getByTestId("nav-runs").click();

    expect(navigate).toHaveBeenCalledWith({ kind: "runs" });
  });

  test.each<[M3LRoute, string]>([
    [{ kind: "scripts" }, "nav-scripts"],
    [{ kind: "script", name: "demo" }, "nav-scripts"],
    [{ kind: "runs" }, "nav-runs"],
    [{ kind: "run", id: "run-123" }, "nav-runs"],
  ])(
    "marks the nav link for route %o as active (aria-current=page on %s)",
    (route, expectedTestId) => {
      render(
        <AppShell route={route} navigate={vi.fn()}>
          <p>child</p>
        </AppShell>,
      );

      expect(screen.getByTestId(expectedTestId)).toHaveAttribute(
        "aria-current",
        "page",
      );
    },
  );
});
