import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";

import type { M3LScriptDetail } from "../../src/api/scripts.js";
import type {
  M3LSessionBindingRecord,
  M3LSessionDecisionRecord,
  M3LSessionRecord,
  M3LSessionStepRecord,
  M3LSessionStepSummary,
} from "../../src/api/sessions.js";

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
 *
 * Mirrors `tests/e2e/run-launcher.spec.ts`'s structure (helpers copied and
 * adapted, not imported — each e2e spec file is self-contained).
 */
const SESSION_ID = "session-1";

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

/** Parses a captured `route.request().postData()` JSON body, or `{}` for none. */
function parseRequestBody(route: Route): Record<string, unknown> {
  const raw = route.request().postData();
  return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

const SQS_ETL_SCRIPT: M3LScriptDetail = {
  name: "sqs-etl",
  description: "Drains an SQS queue into the warehouse",
  hasCommandModule: true,
  executionMode: "sync",
  operations: [],
  parameters: [],
};

const DYNAMODB_CRUD_SCRIPT: M3LScriptDetail = {
  name: "dynamodb-crud",
  description: "Reads/writes a DynamoDB table",
  hasCommandModule: true,
  executionMode: "sync",
  operations: [],
  parameters: [
    {
      name: "tableKey",
      aliases: [],
      type: "STRING",
      required: true,
      defaultValue: null,
      description: "The table's partition key",
      secret: false,
      operations: [],
    },
  ],
};

const SQS_ETL_ARTIFACT = {
  messages: [
    { id: "msg-1", body: "hello", queueUrl: "https://sqs.example/q1" },
  ],
};

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

/**
 * Wires every route this scenario needs, backed by in-memory arrays so GET
 * handlers see whatever a prior POST in the same test appended. Returns the
 * arrays purely so the test body can assert on them directly if needed.
 */
async function mockSessionBackend(page: Page): Promise<{
  readonly session: M3LSessionRecord;
  readonly steps: M3LSessionStepSummary[];
  readonly decisions: M3LSessionDecisionRecord[];
  readonly bindings: M3LSessionBindingRecord[];
  readonly bindingRequests: Record<string, unknown>[];
  readonly decisionRequests: Record<string, unknown>[];
}> {
  const session: M3LSessionRecord = {
    id: SESSION_ID,
    operator: "e2e-operator",
    correlationId: "corr-e2e-1",
    status: "open",
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
  };
  const steps: M3LSessionStepSummary[] = [];
  const decisions: M3LSessionDecisionRecord[] = [];
  const bindings: M3LSessionBindingRecord[] = [];
  const bindingRequests: Record<string, unknown>[] = [];
  const decisionRequests: Record<string, unknown>[] = [];
  let nextStepOrdinal = 1;
  let nextBindingId = 1;

  await page.route("**/api/v1/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 201, session);
  });

  await page.route(`**/api/v1/sessions/${SESSION_ID}`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, session);
  });

  await page.route(`**/api/v1/sessions/${SESSION_ID}/steps`, async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await fulfillJson(route, 200, steps);
      return;
    }
    if (method !== "POST") {
      await route.fallback();
      return;
    }
    const body = parseRequestBody(route);
    const operation = String(body["operation"]);
    const ordinal = nextStepOrdinal;
    nextStepOrdinal += 1;
    const stepId = `step-${String(ordinal)}`;
    const queuedAtMs = 1_700_000_000_000 + ordinal * 1000;
    const startedAtMs = 1_700_000_000_100 + ordinal * 1000;
    const endedAtMs = 1_700_000_000_200 + ordinal * 1000;

    // POST /steps' `step` field is M3LSessionStepRecord-shaped — `resultRef`,
    // never `hasResult`. A launch response never has a result yet (it is
    // returned the moment the step is queued/claimed, before completion),
    // even though this mock immediately marks the step terminal below.
    const stepRecord: M3LSessionStepRecord = {
      id: stepId,
      sessionId: SESSION_ID,
      ordinal,
      operation,
      parameters: {},
      runId: `run-${String(ordinal)}`,
      status: "success",
      resultRef: null,
      queuedAtMs,
      startedAtMs,
      endedAtMs,
      outcome: "success",
      failureMessage: null,
    };

    // GET /steps' rows are M3LSessionStepSummary-shaped — `hasResult`, never
    // `resultRef` — a separate representation of the same step, not the POST
    // response's step object re-served verbatim. `hasResult` is `true` here
    // because the step already completed with an outcome; it does not derive
    // from the POST response's always-null `resultRef`.
    const stepSummary: M3LSessionStepSummary = {
      id: stepRecord.id,
      sessionId: stepRecord.sessionId,
      ordinal: stepRecord.ordinal,
      operation: stepRecord.operation,
      parameters: stepRecord.parameters,
      runId: stepRecord.runId,
      status: stepRecord.status,
      queuedAtMs: stepRecord.queuedAtMs,
      startedAtMs: stepRecord.startedAtMs,
      endedAtMs: stepRecord.endedAtMs,
      outcome: stepRecord.outcome,
      failureMessage: stepRecord.failureMessage,
      hasResult: true,
    };
    steps.push(stepSummary);
    // dynamodb-crud's launch raises a follow-up decision, mirroring a
    // step whose operation pauses for operator input mid-run.
    if (operation === "dynamodb-crud") {
      decisions.push({
        id: "decision-1",
        sessionId: SESSION_ID,
        stepId,
        prompt: "Continue?",
        options: ["continue", "stop"],
        createdAtMs: 1_700_000_002_000,
        status: "pending",
      });
    }
    await fulfillJson(route, 201, {
      step: stepRecord,
      handle: {
        id: `run-${String(ordinal)}`,
        scriptName: operation,
        status: "queued",
        dryRun: Boolean(body["dryRun"]),
        executionMode: "sync",
      },
    });
  });

  await page.route(
    `**/api/v1/sessions/${SESSION_ID}/steps/step-1/artifact`,
    async (route) => {
      await fulfillJson(route, 200, SQS_ETL_ARTIFACT);
    },
  );

  await page.route(
    `**/api/v1/sessions/${SESSION_ID}/bindings`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = parseRequestBody(route);
      bindingRequests.push(body);
      const id = `binding-${String(nextBindingId)}`;
      nextBindingId += 1;
      const record: M3LSessionBindingRecord = {
        id,
        sessionId: SESSION_ID,
        reference: String(body["reference"]),
        expectedType: body[
          "expectedType"
        ] as M3LSessionBindingRecord["expectedType"],
        multiSelect: Boolean(body["multiSelect"]),
        createdAtMs: 1_700_000_003_000,
        ...(typeof body["parameterName"] === "string" && {
          parameterName: body["parameterName"],
        }),
      };
      bindings.push(record);
      await fulfillJson(route, 201, record);
    },
  );

  await page.route(
    `**/api/v1/sessions/${SESSION_ID}/decisions`,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, decisions);
    },
  );

  await page.route(
    `**/api/v1/sessions/${SESSION_ID}/decisions/decision-1`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = parseRequestBody(route);
      decisionRequests.push(body);
      const index = decisions.findIndex((d) => d.id === "decision-1");
      const target = index === -1 ? undefined : decisions[index];
      if (target && target.status === "pending") {
        decisions[index] = {
          ...target,
          status: "answered",
          answer: body["answer"],
          answeredAtMs: 1_700_000_004_000,
        };
      }
      await fulfillJson(route, 200, { applied: true });
    },
  );

  await page.route("**/api/v1/scripts/sqs-etl", async (route) => {
    await fulfillJson(route, 200, SQS_ETL_SCRIPT);
  });

  await page.route("**/api/v1/scripts/dynamodb-crud", async (route) => {
    await fulfillJson(route, 200, DYNAMODB_CRUD_SCRIPT);
  });

  return {
    session,
    steps,
    decisions,
    bindings,
    bindingRequests,
    decisionRequests,
  };
}

test("full session drill-down: launch sqs-etl, bind its output, launch dynamodb-crud prefilled, and answer the decision it raises", async ({
  page,
}) => {
  const { bindingRequests, decisionRequests } = await mockSessionBackend(page);

  await page.goto("/#/sessions");
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page).toHaveURL(new RegExp(`#/sessions/${SESSION_ID}$`));

  // --- Step 1: launch sqs-etl (no required parameters, no bindings needed) --
  await page.getByTestId("session-step-operation-input").fill("sqs-etl");
  await page.getByTestId("session-step-load-operation").click();
  await expect(page.getByTestId("parameter-form")).toBeVisible();
  await page.getByRole("button", { name: /launch/i }).click();
  await expect(page.getByTestId("session-step-launch-success")).toBeVisible();

  // --- Step 2: view step 1's output, select a leaf, bind it to tableKey -----
  await expect(page.getByTestId("view-output-step-1")).toBeVisible();
  await page.getByTestId("view-output-step-1").click();
  await expect(page.getByTestId("json-tree-viewer")).toBeVisible();

  await page
    .getByRole("button", { name: "Select messages[0].queueUrl" })
    .click();
  await expect(page.getByTestId("binding-form")).toBeVisible();
  await page.getByTestId("binding-parameter-name-input").fill("tableKey");
  await page.getByTestId("binding-submit").click();
  await expect(page.getByTestId("binding-success")).toBeVisible();

  await expect.poll(() => bindingRequests.length).toBe(1);
  expect(bindingRequests[0]).toEqual({
    reference: "step-1.output.messages[0].queueUrl",
    expectedType: "string",
    multiSelect: false,
    parameterName: "tableKey",
  });

  // --- Step 3: load dynamodb-crud, assert tableKey is prefilled -------------
  await page.getByTestId("session-step-operation-input").fill("dynamodb-crud");
  await page.getByTestId("session-step-load-operation").click();
  const tableKeyInput = page.getByRole("textbox", { name: "tableKey" });
  await expect(tableKeyInput).toHaveValue("https://sqs.example/q1");

  await page.getByRole("button", { name: /launch/i }).click();
  await expect(page.getByTestId("session-step-launch-success")).toBeVisible();

  // --- Step 4: the launch raises a decision; answer it -----------------------
  const decisionPrompt = page.getByTestId("decision-prompt");
  await expect(decisionPrompt).toBeVisible();
  await expect(decisionPrompt).toContainText("Continue?");
  await expect(page.getByTestId("decision-option-continue")).toBeVisible();
  await expect(page.getByTestId("decision-option-stop")).toBeVisible();

  await page.getByTestId("decision-option-continue").click();

  await expect.poll(() => decisionRequests.length).toBe(1);
  expect(decisionRequests[0]).toEqual({ answer: "continue" });
  await expect(page.getByTestId("decision-answered")).toBeVisible();
  await expect(page.getByTestId("decision-answered")).toContainText("continue");
});
