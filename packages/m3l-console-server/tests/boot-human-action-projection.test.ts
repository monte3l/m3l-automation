/**
 * Tests for `boot/human-action-audit`'s PER-ROUTE projection (X7b,
 * ADR-0070): what each audited route puts in `action`, `target`,
 * `parameterNames`, `parameterRefs`, `posture` and `detail`.
 *
 * Gate behaviour — ordering, refusal, compensation, the exhaustiveness guard
 * — lives in the sibling `boot-human-action-audit.test.ts`.
 *
 * @packageDocumentation
 */

import { describe, expect, test } from "vitest";

import type { M3LHumanActionAuditPort } from "../src/audit/port.js";
import type { M3LHumanActionRecord } from "../src/audit/record.js";
import { applyHumanActionAudit } from "../src/boot/human-action-audit.js";
import {
  createRequestContext,
  withBody,
  withOperator,
  withParams,
} from "../src/http/context.js";
import type { M3LConsoleResult } from "../src/http/stream-response.js";
import type { M3LRoute } from "../src/http/router.js";

const OK: M3LConsoleResult = { status: 200, headers: {}, body: "ok" };

/** Drives one audited route and returns the single record it wrote. */
async function recordFor(input: {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}): Promise<M3LHumanActionRecord> {
  const records: M3LHumanActionRecord[] = [];
  const port: M3LHumanActionAuditPort = {
    record(record: M3LHumanActionRecord): Promise<void> {
      records.push(record);
      return Promise.resolve();
    },
  };
  const route: M3LRoute = {
    method: input.method,
    path: input.path,
    auth: "required",
    handler: () => OK,
  };
  const [decorated] = applyHumanActionAudit([route], port, () => 1_700_000);

  const base = createRequestContext({
    method: input.method,
    url: input.url,
    headers: { "x-correlation-id": "corr-proj" },
    signal: new AbortController().signal,
  });
  const ctx = withBody(
    withOperator(withParams(base, input.params ?? {}), {
      name: "ada",
      email: undefined,
    }),
    input.body,
  );

  if (decorated === undefined) throw new Error("route was not decorated");
  await decorated.handler(ctx);
  const record = records[0];
  if (record === undefined) throw new Error("no record was written");
  return record;
}

describe("per-route projection", () => {
  // `run.launch` targets the SCRIPT, not the run: `M3LHumanActionTarget`'s
  // `script` arm is the only one carrying a name, and a launch is the one
  // action an operator recognises by name. That is also what makes
  // `phase: "before"` possible — no run id exists yet.
  test("POST /api/v1/runs → run.launch, targeting the script by name", async () => {
    const record = await recordFor({
      method: "POST",
      path: "/api/v1/runs",
      url: "http://127.0.0.1/api/v1/runs",
      body: {
        scriptName: "sqs-etl",
        confirmed: true,
        dryRun: false,
        parameters: { queueUrl: "u", region: "r" },
      },
    });

    expect(record.action).toBe("run.launch");
    expect(record.target).toEqual({
      kind: "script",
      id: "sqs-etl",
      scriptName: "sqs-etl",
    });
    expect(record.parameterNames).toEqual(["queueUrl", "region"]);
    expect(record.posture).toBe("confirmed");
  });

  test.each([
    [{ confirmed: true, dryRun: false }, "confirmed"],
    [{ confirmed: false, dryRun: true }, "auto"],
    [{ confirmed: false, dryRun: false }, "escalated"],
  ] as [Record<string, boolean>, string][])(
    "POST /api/v1/runs posture for %o is %s",
    async (flags, posture) => {
      const record = await recordFor({
        method: "POST",
        path: "/api/v1/runs",
        url: "http://127.0.0.1/api/v1/runs",
        body: { scriptName: "s", ...flags },
      });

      expect(record.posture).toBe(posture);
    },
  );

  // `session.create` has no session id pre-flight, so the correlation id is
  // the honest AND joinable value: `routes/sessions.ts` passes that same id
  // into `createSession`, where it lands in `console_sessions.correlation_id`.
  test("POST /api/v1/sessions → session.create, targeting the correlation id", async () => {
    const record = await recordFor({
      method: "POST",
      path: "/api/v1/sessions",
      url: "http://127.0.0.1/api/v1/sessions",
      body: { title: "a session" },
    });

    expect(record.action).toBe("session.create");
    expect(record.target).toEqual({ kind: "session", id: "corr-proj" });
    expect(record.posture).toBe("confirmed");
  });

  test("POST …/steps → session.step.add, with binding names and references", async () => {
    const record = await recordFor({
      method: "POST",
      path: "/api/v1/sessions/:id/steps",
      url: "http://127.0.0.1/api/v1/sessions/sess-1/steps",
      params: { id: "sess-1" },
      body: {
        scriptName: "s",
        confirmed: true,
        bindings: [
          { parameterName: "input", reference: "step-1.output.path" },
          { parameterName: "region", reference: "step-2.output.region" },
        ],
      },
    });

    expect(record.action).toBe("session.step.add");
    expect(record.target).toEqual({ kind: "session", id: "sess-1" });
    expect(record.parameterNames).toEqual(["input", "region"]);
    // A step reference is recorded BY REFERENCE — it is not a value, and it
    // does not trip the port's inline-ref refusal: `isInlineArtifactRefText`
    // only fires for text that JSON-parses to `{ kind: "inline" }`.
    expect(record.parameterRefs).toEqual([
      "step-1.output.path",
      "step-2.output.region",
    ]);
  });

  test("POST …/steps/:stepId/decision → session.decision.raise, targeting the step", async () => {
    const record = await recordFor({
      method: "POST",
      path: "/api/v1/sessions/:id/steps/:stepId/decision",
      url: "http://127.0.0.1/api/v1/sessions/sess-1/steps/step-9/decision",
      params: { id: "sess-1", stepId: "step-9" },
      body: { prompt: "proceed?" },
    });

    expect(record.action).toBe("session.decision.raise");
    expect(record.target).toEqual({ kind: "step", id: "step-9" });
  });

  // There is no `decision` target kind, and inventing one would force a
  // second CHECK recreate on `target_kind` for no query anyone runs — so the
  // decision id goes in `detail`.
  test("POST …/decisions/:decisionId → session.decision.answer, id in detail", async () => {
    const record = await recordFor({
      method: "POST",
      path: "/api/v1/sessions/:id/decisions/:decisionId",
      url: "http://127.0.0.1/api/v1/sessions/sess-1/decisions/dec-4",
      params: { id: "sess-1", decisionId: "dec-4" },
      body: { choice: "yes" },
    });

    expect(record.action).toBe("session.decision.answer");
    expect(record.target).toEqual({ kind: "session", id: "sess-1" });
    expect(record.detail).toEqual({ decisionId: "dec-4" });
  });

  test.each([
    ["close", "session.close"],
    ["reopen", "session.reopen"],
  ] as const)("POST …/%s → %s", async (segment, action) => {
    const record = await recordFor({
      method: "POST",
      path: `/api/v1/sessions/:id/${segment}`,
      url: `http://127.0.0.1/api/v1/sessions/sess-1/${segment}`,
      params: { id: "sess-1" },
      body: {},
    });

    expect(record.action).toBe(action);
    expect(record.target).toEqual({ kind: "session", id: "sess-1" });
    expect(record.posture).toBe("confirmed");
  });
});

describe("a malformed body", () => {
  // INVARIANT: the gate must read `ctx.body` DEFENSIVELY. A malformed body is
  // the handler's own ERR_CONSOLE_BAD_REQUEST to report; an
  // ERR_CONSOLE_AUDIT_RECORD_INVALID here would misdescribe whose fault it
  // is, and would do so with a 400 that blames the audit layer.
  test.each([
    ["a string body", "not an object"],
    ["an array body", []],
    ["a null body", null],
    ["no body at all", undefined],
  ] as [string, unknown][])("%s still produces a record", async (_l, body) => {
    const record = await recordFor({
      method: "POST",
      path: "/api/v1/runs",
      url: "http://127.0.0.1/api/v1/runs",
      body,
    });

    expect(record.action).toBe("run.launch");
    expect(record.parameterNames).toEqual([]);
    // No confirmation could be read, so the posture is the honest one.
    expect(record.posture).toBe("escalated");
  });

  test("a non-object parameters field yields no names rather than throwing", async () => {
    const record = await recordFor({
      method: "POST",
      path: "/api/v1/runs",
      url: "http://127.0.0.1/api/v1/runs",
      body: { scriptName: "s", confirmed: true, parameters: "nonsense" },
    });

    expect(record.parameterNames).toEqual([]);
  });

  test("a bindings field that is not an array yields no names or refs", async () => {
    const record = await recordFor({
      method: "POST",
      path: "/api/v1/sessions/:id/steps",
      url: "http://127.0.0.1/api/v1/sessions/sess-1/steps",
      params: { id: "sess-1" },
      body: { bindings: "nonsense" },
    });

    expect(record.parameterNames).toEqual([]);
    expect(record.parameterRefs).toEqual([]);
  });
});
