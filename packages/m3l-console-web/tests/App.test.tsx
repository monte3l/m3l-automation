import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { M3LScriptDetail, M3LScriptSummary } from "../src/api/scripts.js";
import type { M3LRunRecord } from "../src/api/runs.js";
import { App } from "../src/App.js";

/**
 * Builds a `Response`-shaped object for a fetch mock, matching the style
 * already used by the outer `beforeEach` below (`as unknown as Response`
 * rather than constructing a real `Response`, since jsdom's `Response` body
 * handling isn't exercised by these tests).
 */
function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(data),
  } as unknown as Response;
}

const UNREACHABLE_RESPONSE = {
  ok: false,
  status: 503,
  statusText: "Service Unavailable",
  json: () => Promise.resolve({}),
} as unknown as Response;

/**
 * Routes to the real `fetchConsoleJson` calls `App`'s (uninjected)
 * `ScriptList`/`ScriptDetail`/`RunList`/`RunDetail` children issue by
 * default. `App` renders those components without a `fetchScripts`/
 * `fetchRuns`/etc. prop, so the only seam available to control what they
 * render is the global `fetch` these tests already stub for the health
 * check — anything not explicitly provided here (including `/health`)
 * falls back to `UNREACHABLE_RESPONSE`, matching the outer `beforeEach`.
 */
/**
 * Narrows fetch's `RequestInfo | URL` first argument down to a plain path
 * string. `fetchConsoleJson` (the only caller these tests exercise) always
 * passes a string, but the mock's signature must satisfy the real `fetch`
 * type — `String(input)` would also accept a `Request`, whose default
 * `toString()` collapses to `"[object Object]"` (`no-base-to-string`).
 */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function mockConsoleFetch(routes: {
  readonly scripts?: readonly M3LScriptSummary[];
  readonly scriptDetail?: M3LScriptDetail;
  readonly runs?: readonly M3LRunRecord[];
  readonly runDetail?: M3LRunRecord;
}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    if (
      routes.scriptDetail &&
      url === `/api/v1/scripts/${encodeURIComponent(routes.scriptDetail.name)}`
    ) {
      return Promise.resolve(jsonResponse(routes.scriptDetail));
    }
    if (routes.scripts && url === "/api/v1/scripts") {
      return Promise.resolve(jsonResponse(routes.scripts));
    }
    if (routes.runDetail && url === `/api/v1/runs/${routes.runDetail.id}`) {
      return Promise.resolve(jsonResponse(routes.runDetail));
    }
    if (routes.runs && url === "/api/v1/runs") {
      return Promise.resolve(jsonResponse(routes.runs));
    }
    return Promise.resolve(UNREACHABLE_RESPONSE);
  });
}

const DEMO_SCRIPT_SUMMARY: M3LScriptSummary = {
  name: "demo-script",
  description: "Runs the demo pipeline",
  hasCommandModule: false,
  executionMode: "spawn",
};

const DEMO_SCRIPT_DETAIL: M3LScriptDetail = {
  ...DEMO_SCRIPT_SUMMARY,
  description: "Full detail for the demo pipeline",
  parameters: [
    {
      name: "region",
      aliases: [],
      type: "STRING",
      required: false,
      defaultValue: null,
      description: "AWS region",
      secret: false,
      operations: [],
    },
  ],
  operations: [],
};

const DEMO_RUN: M3LRunRecord = {
  id: "run-123",
  script: "demo-script",
  status: "queued",
  dryRun: false,
  executionMode: "spawn",
  parameters: { region: "us-east-1" },
  operator: "boot-operator",
  correlationId: "corr-1",
  queuedAtMs: 1_700_000_000_000,
  startedAtMs: null,
  endedAtMs: null,
  outcome: null,
  exitCode: null,
  failureMessage: null,
};

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

  test("propagates a failed health check through to the banner's unreachable state", async () => {
    render(<App />);

    const banner = await screen.findByText(/unreachable/i);

    expect(banner.textContent).toContain("unreachable");
    expect(banner.textContent).toContain("Service Unavailable");
  });
});

describe("App route switching", () => {
  // The outer beforeEach/afterEach above already stub fetch and restore
  // mocks for every test in this file; these hooks additionally reset the
  // hash so route-switching tests don't leak state into one another.
  beforeEach(() => {
    window.location.hash = "";
  });

  afterEach(() => {
    window.location.hash = "";
  });

  test("renders the script list at the default (empty-hash) route", () => {
    render(<App />);

    expect(screen.getByTestId("script-list")).toBeInTheDocument();
  });

  test("renders the script detail view at the #/scripts/:name route", async () => {
    window.location.hash = "#/scripts/demo-script";

    render(<App />);

    expect(await screen.findByTestId("script-detail")).toBeInTheDocument();
  });

  test("renders the run list at the #/runs route", async () => {
    window.location.hash = "#/runs";

    render(<App />);

    expect(await screen.findByTestId("run-list")).toBeInTheDocument();
  });

  test("renders the run detail view at the #/runs/:id route", async () => {
    window.location.hash = "#/runs/run-123";

    render(<App />);

    expect(await screen.findByTestId("run-detail")).toBeInTheDocument();
  });

  test("switches from the script list to the run list when the hash changes after mount", async () => {
    render(<App />);
    expect(screen.getByTestId("script-list")).toBeInTheDocument();

    window.location.hash = "#/runs";
    window.dispatchEvent(new Event("hashchange"));

    expect(await screen.findByTestId("run-list")).toBeInTheDocument();
  });

  test("selecting a script from the rendered ScriptList navigates to and renders that script's detail", async () => {
    mockConsoleFetch({
      scripts: [DEMO_SCRIPT_SUMMARY],
      scriptDetail: DEMO_SCRIPT_DETAIL,
    });

    render(<App />);

    // Drive it through the real rendered ScriptList — the same row its own
    // tests click — to prove App actually wires onSelectScript to navigate
    // rather than merely being able to render both routes independently.
    const row = await screen.findByRole("button", { name: /demo-script/ });
    row.click();

    expect(window.location.hash).toBe("#/scripts/demo-script");
    const detail = await screen.findByTestId("script-detail");
    expect(detail.textContent).toContain("Full detail for the demo pipeline");
  });

  test("selecting a run from the rendered RunList navigates to and renders that run's detail", async () => {
    window.location.hash = "#/runs";
    mockConsoleFetch({
      runs: [DEMO_RUN],
      runDetail: DEMO_RUN,
    });

    render(<App />);

    const row = await screen.findByRole("button", { name: /run-123/ });
    row.click();

    expect(window.location.hash).toBe("#/runs/run-123");
    const detail = await screen.findByTestId("run-detail");
    expect(detail.textContent).toContain("demo-script");
    expect(detail.textContent).toContain("run-123");
  });

  test("navigating to a script's detail and back via the AppShell nav link returns to the script list", async () => {
    mockConsoleFetch({
      scripts: [DEMO_SCRIPT_SUMMARY],
      scriptDetail: DEMO_SCRIPT_DETAIL,
    });

    render(<App />);

    const row = await screen.findByRole("button", { name: /demo-script/ });
    row.click();
    await screen.findByTestId("script-detail");

    screen.getByTestId("nav-scripts").click();

    expect(window.location.hash).toBe("#/scripts");
    expect(await screen.findByTestId("script-list")).toBeInTheDocument();
    expect(screen.queryByTestId("script-detail")).not.toBeInTheDocument();
  });
});
