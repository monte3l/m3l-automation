import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";

import type {
  M3LScriptDetail,
  M3LScriptSummary,
} from "../../src/api/scripts.js";
import type { M3LRunHandle, M3LRunRecord } from "../../src/api/runs.js";

/**
 * `playwright.config.ts` serves the static production bundle via
 * `vite build && vite preview` — no console-server backend and no dev
 * proxy — so every `/api/v1/*` request 404s unless intercepted here.
 * `test.beforeEach` installs two baseline routes every test inherits:
 * `/health` (so `HealthBanner` doesn't churn indefinitely) and a catch-all
 * 404 for any `/api/v1/*` request a given test doesn't explicitly mock —
 * Playwright resolves overlapping `page.route` handlers most-recently-registered-first,
 * so a test's own, more specific routes (registered after this hook runs)
 * win over this fallback for the URLs they cover.
 */
const SCRIPT_NAME = "json-etl";

const SCRIPT_SUMMARY: M3LScriptSummary = {
  name: SCRIPT_NAME,
  description: "Transforms an input JSON file into the warehouse schema",
  hasCommandModule: true,
  executionMode: "sync",
};

const SCRIPT_DETAIL: M3LScriptDetail = {
  ...SCRIPT_SUMMARY,
  operations: [],
  parameters: [
    {
      name: "verbose",
      aliases: [],
      type: "BOOL",
      required: false,
      defaultValue: "false",
      description: "Emit verbose logging",
      secret: false,
      operations: [],
    },
    {
      name: "batchSize",
      aliases: [],
      type: "INT",
      required: false,
      defaultValue: "10",
      description: "Number of records per batch",
      secret: false,
      operations: [],
    },
    {
      name: "inputPath",
      aliases: [],
      type: "STRING",
      required: true,
      defaultValue: null,
      description: "Path to the input JSON file",
      secret: false,
      operations: [],
    },
    {
      name: "apiKey",
      aliases: [],
      type: "STRING",
      required: true,
      defaultValue: "********",
      description: "Warehouse API key",
      secret: true,
      operations: [],
    },
  ],
};

function jsonBody(body: unknown): string {
  return JSON.stringify(body);
}

async function fulfillJson(
  route: Route,
  status: number,
  body: unknown,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: jsonBody(body),
  });
}

/** One SSE frame: `event:`/`data:`/`id:` lines, terminated by a blank line. */
interface SseFrame {
  readonly event: string;
  readonly data: unknown;
  readonly id: string;
}

function buildEventStreamBody(frames: readonly SseFrame[]): string {
  return frames
    .map(
      (frame) =>
        `event: ${frame.event}\ndata: ${jsonBody(frame.data)}\nid: ${frame.id}\n\n`,
    )
    .join("");
}

/** Parses a captured `route.request().postData()` JSON body, or `{}` for none. */
function parseRequestBody(route: Route): Record<string, unknown> {
  const raw = route.request().postData();
  return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

async function mockScriptsList(page: Page): Promise<void> {
  await page.route("**/api/v1/scripts", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, [SCRIPT_SUMMARY]);
  });
}

async function mockScriptDetail(page: Page): Promise<void> {
  await page.route(`**/api/v1/scripts/${SCRIPT_NAME}`, async (route) => {
    await fulfillJson(route, 200, SCRIPT_DETAIL);
  });
}

/**
 * Mocks `POST /api/v1/runs`, capturing every intercepted request body into
 * `captured` (in arrival order) and always resolving with `handle`.
 */
async function mockLaunch(
  page: Page,
  handle: M3LRunHandle,
  captured: Record<string, unknown>[],
): Promise<void> {
  await page.route("**/api/v1/runs", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    captured.push(parseRequestBody(route));
    await fulfillJson(route, 201, handle);
  });
}

async function mockRunRecord(page: Page, run: M3LRunRecord): Promise<void> {
  await page.route(`**/api/v1/runs/${run.id}`, async (route) => {
    await fulfillJson(route, 200, run);
  });
}

async function mockRunStream(
  page: Page,
  runId: string,
  frames: readonly SseFrame[],
): Promise<void> {
  await page.route(`**/api/v1/runs/${runId}/stream`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: buildEventStreamBody(frames),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.route("**/health", async (route) => {
    await fulfillJson(route, 200, { status: "ok", uptimeMs: 1_000 });
  });
  // Catch-all: registered first, so any test-specific route registered
  // afterwards takes priority for the URLs it actually mocks.
  await page.route(
    (url) => url.pathname.startsWith("/api/v1/"),
    async (route) => {
      await fulfillJson(route, 404, {
        error: {
          code: "ERR_CONSOLE_NOT_MOCKED",
          message: `no e2e mock registered for ${route.request().method()} ${route.request().url()}`,
          status: 404,
          correlationId: "e2e-unmocked",
        },
      });
    },
  );
});

test("lists scripts and navigates to a script's detail on activation", async ({
  page,
}) => {
  await mockScriptsList(page);
  await mockScriptDetail(page);

  await page.goto("/#/scripts");

  const row = page.getByRole("button", { name: SCRIPT_NAME });
  await expect(row).toBeVisible();
  await row.click();

  await expect(page).toHaveURL(new RegExp(`#/scripts/${SCRIPT_NAME}$`));
  await expect(
    page.getByRole("heading", { name: SCRIPT_NAME, level: 2 }),
  ).toBeVisible();
});

test("renders one control per parameter type, and a secret parameter as a read-only explanation with no control", async ({
  page,
}) => {
  await mockScriptDetail(page);

  await page.goto(`/#/scripts/${SCRIPT_NAME}`);

  await expect(page.getByRole("checkbox", { name: "verbose" })).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: "batchSize" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "inputPath" })).toBeVisible();

  // secret: true -> explanation text, never an editable control.
  await expect(page.getByText(/apiKey is a secret value/)).toBeVisible();
  await expect(page.locator("#apiKey")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "apiKey" })).toHaveCount(0);
});

test("omits a secret parameter's key from the launch request body while still showing its explanation", async ({
  page,
}) => {
  await mockScriptDetail(page);
  const captured: Record<string, unknown>[] = [];
  const handle: M3LRunHandle = {
    id: "run-launch-secret",
    scriptName: SCRIPT_NAME,
    status: "queued",
    dryRun: true,
    executionMode: "sync",
  };
  await mockLaunch(page, handle, captured);

  await page.goto(`/#/scripts/${SCRIPT_NAME}`);

  await page.getByRole("textbox", { name: "inputPath" }).fill("orders.json");

  // Dry run starts checked, so Launch is enabled without confirming.
  await expect(page.getByRole("checkbox", { name: "Dry run" })).toBeChecked();
  const launchButton = page.getByRole("button", { name: "Launch" });
  await expect(launchButton).toBeEnabled();
  await launchButton.click();

  await expect.poll(() => captured.length).toBe(1);
  const [request] = captured;
  const body = request ?? {};
  expect(body).toMatchObject({
    scriptName: SCRIPT_NAME,
    dryRun: true,
    confirmed: false,
  });
  const parameters = (body["parameters"] ?? {}) as Record<string, unknown>;
  expect(parameters).not.toHaveProperty("apiKey");
  expect(parameters["inputPath"]).toBe("orders.json");

  await expect(page).toHaveURL(new RegExp(`#/runs/${handle.id}$`));
});

test("dry-run gating: unchecking reveals confirm and gates Launch until confirmed", async ({
  page,
}) => {
  await mockScriptDetail(page);
  const captured: Record<string, unknown>[] = [];
  const handle: M3LRunHandle = {
    id: "run-launch-confirmed",
    scriptName: SCRIPT_NAME,
    status: "running",
    dryRun: false,
    executionMode: "sync",
  };
  await mockLaunch(page, handle, captured);

  await page.goto(`/#/scripts/${SCRIPT_NAME}`);
  await page.getByRole("textbox", { name: "inputPath" }).fill("orders.json");

  const dryRunCheckbox = page.getByRole("checkbox", { name: "Dry run" });
  const launchButton = page.getByRole("button", { name: "Launch" });
  const confirmCheckbox = page.getByRole("checkbox", {
    name: "Confirm real run",
  });

  await expect(dryRunCheckbox).toBeChecked();
  await expect(confirmCheckbox).toHaveCount(0);
  await expect(launchButton).toBeEnabled();

  await dryRunCheckbox.uncheck();

  await expect(confirmCheckbox).toBeVisible();
  await expect(confirmCheckbox).not.toBeChecked();
  await expect(launchButton).toBeDisabled();

  await confirmCheckbox.check();
  await expect(launchButton).toBeEnabled();
  await launchButton.click();

  await expect.poll(() => captured.length).toBe(1);
  const [request] = captured;
  expect(request ?? {}).toMatchObject({
    scriptName: SCRIPT_NAME,
    dryRun: false,
    confirmed: true,
  });

  await expect(page).toHaveURL(new RegExp(`#/runs/${handle.id}$`));
});

test("tails run.started/run.line frames via SSE, reports stream end, and renders untrusted stdout as literal text", async ({
  page,
}) => {
  const runId = "run-tail-1";
  const xssPayload = '<img src=x onerror="window.__pwned=true">';
  const run: M3LRunRecord = {
    id: runId,
    script: SCRIPT_NAME,
    status: "running",
    dryRun: false,
    executionMode: "sync",
    parameters: { inputPath: "orders.json" },
    operator: "e2e-operator",
    correlationId: "corr-tail-1",
    queuedAtMs: 1_700_000_000_000,
    startedAtMs: 1_700_000_000_100,
    endedAtMs: null,
    outcome: null,
    exitCode: null,
    failureMessage: null,
  };
  await mockRunRecord(page, run);
  await mockRunStream(page, runId, [
    { event: "run.started", data: {}, id: "1" },
    { event: "run.line", data: { line: "processing batch 1" }, id: "2" },
    { event: "run.line", data: { line: xssPayload }, id: "3" },
    { event: "stream.end", data: { reason: "completed" }, id: "4" },
  ]);

  await page.goto(`/#/runs/${runId}`);

  const tail = page.locator('[data-testid="run-log-tail"]');
  await expect(tail).toContainText("processing batch 1");
  await expect(tail).toContainText(xssPayload);
  await expect(tail).toContainText("Stream ended: completed");

  // The untrusted-stdout guarantee: the payload must render as literal
  // text, never as markup — no `<img>` element, and its onerror must
  // never have fired.
  await expect(page.locator("img")).toHaveCount(0);
  // `tsconfig.e2e.json` type-checks specs as Node, not browser, so this
  // callback (which runs in the page, not this process) is typed against
  // `globalThis` rather than the DOM-only `window` global.
  expect(
    await page.evaluate(() => (globalThis as { __pwned?: boolean }).__pwned),
  ).toBeUndefined();
});
