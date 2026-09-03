import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { M3LConsoleFetchResult } from "../../src/api/client.js";
import { fetchScript as fetchScriptReal } from "../../src/api/scripts.js";
import type { M3LScriptDetail } from "../../src/api/scripts.js";
import type {
  M3LSessionAddStepRequest,
  M3LSessionAddStepResult,
  M3LSessionBindingRecord,
  M3LSessionStepRecord,
} from "../../src/api/sessions.js";
import { addSessionStep as addSessionStepReal } from "../../src/api/sessions.js";
import { SessionStepLauncher } from "../../src/components/SessionStepLauncher.js";

// Mocks the real fetchScript/addSessionStep exports so the "uses the real
// default when the corresponding prop is omitted" case (below) can observe
// SessionStepLauncher reach for its own module-level `fetchScriptDefault` /
// `addSessionStepDefault` fallback, mirroring the named-export vi.mock
// pattern in tests/api/sessions.test.ts. Every OTHER test in this file
// injects both props explicitly, so the mocked module is simply never
// consulted for them.
vi.mock("../../src/api/scripts.js", () => ({
  fetchScript: vi.fn(),
}));
vi.mock("../../src/api/sessions.js", () => ({
  addSessionStep: vi.fn(),
}));

/**
 * `SessionStepLauncher` — new X11e component that lets an operator type an
 * operation name, load its `ParameterForm` (pre-filled from the session's
 * accumulated bindings), and launch it as a session step via
 * `addSessionStep`. Neither the component module nor its exported symbols
 * exist yet — every case in this file is RED until the sibling
 * implementation slice lands.
 */

const SESSION_ID = "session-1";

const SQS_ETL_DETAIL: M3LScriptDetail = {
  name: "sqs-etl",
  description: "Drains an SQS queue into the warehouse",
  hasCommandModule: true,
  executionMode: "sync",
  operations: [],
  parameters: [],
};

const DYNAMODB_CRUD_DETAIL: M3LScriptDetail = {
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
      defaultValue: "unbound-default",
      description: "The table's partition key",
      secret: false,
      operations: [],
    },
  ],
};

const BOUND_VALUE = "https://sqs.example/q1";

const BINDING_WITH_PARAM: M3LSessionBindingRecord = {
  id: "binding-1",
  sessionId: SESSION_ID,
  reference: "step-1.output.messages[0].queueUrl",
  expectedType: "string",
  multiSelect: false,
  createdAtMs: 1_735_689_600_000,
  parameterName: "tableKey",
};

// A binding with no `parameterName` at all (a pre-migration-v10 legacy row,
// or one never mapped to a launch parameter) must never contribute an entry
// to the addSessionStep bindings payload.
const BINDING_WITHOUT_PARAM: M3LSessionBindingRecord = {
  id: "binding-2",
  sessionId: SESSION_ID,
  reference: "step-1.output.messages[0].id",
  expectedType: "string",
  multiSelect: false,
  createdAtMs: 1_735_689_600_100,
};

const KNOWN_VALUES: Readonly<Record<string, unknown>> = {
  tableKey: BOUND_VALUE,
};

// The `step` field of a POST /api/v1/sessions/:id/steps response is
// M3LSessionStepRecord-shaped — NOT M3LSessionStepSummary-shaped. It carries
// `resultRef` (never present on the list-route summary) and has no
// `hasResult` field at all. Verified against
// `sessions/service.ts`'s `M3LSessionAddStepResult.step: M3LSessionStepRecord`
// and `store/sessions-repository-types.ts`'s `M3LSessionStepRecord`.
const LAUNCHED_STEP: M3LSessionStepRecord = {
  id: "step-2",
  sessionId: SESSION_ID,
  ordinal: 2,
  operation: DYNAMODB_CRUD_DETAIL.name,
  parameters: { tableKey: BOUND_VALUE },
  runId: "run-1",
  status: "queued",
  resultRef: null,
  queuedAtMs: 1_735_689_601_000,
  startedAtMs: null,
  endedAtMs: null,
  outcome: null,
  failureMessage: null,
};

function okFetchScript(
  detail: M3LScriptDetail,
): (name: string) => Promise<M3LConsoleFetchResult<M3LScriptDetail>> {
  return () => Promise.resolve({ ok: true, data: detail });
}

function errorFetchScript(
  message: string,
): (name: string) => Promise<M3LConsoleFetchResult<M3LScriptDetail>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

function okAddSessionStep(
  result: M3LSessionAddStepResult,
): (
  sessionId: string,
  input: M3LSessionAddStepRequest,
) => Promise<M3LConsoleFetchResult<M3LSessionAddStepResult>> {
  return () => Promise.resolve({ ok: true, data: result });
}

function errorAddSessionStep(
  message: string,
): (
  sessionId: string,
  input: M3LSessionAddStepRequest,
) => Promise<M3LConsoleFetchResult<M3LSessionAddStepResult>> {
  return () =>
    Promise.resolve({ ok: false, error: { kind: "network", message } });
}

afterEach(() => {
  vi.mocked(fetchScriptReal).mockReset();
  vi.mocked(addSessionStepReal).mockReset();
});

function typeOperationAndLoad(name: string): void {
  fireEvent.change(screen.getByTestId("session-step-operation-input"), {
    target: { value: name },
  });
  fireEvent.click(screen.getByTestId("session-step-load-operation"));
}

describe("SessionStepLauncher — root and operation loading", () => {
  test("renders the session-step-launcher root with an operation input and a load button", () => {
    render(
      <SessionStepLauncher
        sessionId={SESSION_ID}
        bindings={[]}
        knownValues={{}}
        onStepLaunched={vi.fn()}
        fetchScript={okFetchScript(SQS_ETL_DETAIL)}
        addSessionStep={okAddSessionStep({
          step: LAUNCHED_STEP,
          handle: {
            id: "run-1",
            scriptName: SQS_ETL_DETAIL.name,
            status: "queued",
            dryRun: true,
            executionMode: "sync",
          },
        })}
      />,
    );

    expect(screen.getByTestId("session-step-launcher")).toBeInTheDocument();
    expect(
      screen.getByTestId("session-step-operation-input"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("session-step-load-operation"),
    ).toBeInTheDocument();
  });

  test("clicking load calls the injected fetchScript with the typed operation name", async () => {
    const fetchScriptSpy = vi.fn(okFetchScript(SQS_ETL_DETAIL));
    render(
      <SessionStepLauncher
        sessionId={SESSION_ID}
        bindings={[]}
        knownValues={{}}
        onStepLaunched={vi.fn()}
        fetchScript={fetchScriptSpy}
        addSessionStep={vi.fn()}
      />,
    );

    typeOperationAndLoad("sqs-etl");

    await vi.waitFor(() => {
      expect(fetchScriptSpy).toHaveBeenCalledWith("sqs-etl");
    });
  });

  test("shows a loading indicator while fetchScript is pending, then the loaded ParameterForm", async () => {
    const resolvers =
      Promise.withResolvers<M3LConsoleFetchResult<M3LScriptDetail>>();
    const pendingFetchScript = vi.fn(() => resolvers.promise);
    render(
      <SessionStepLauncher
        sessionId={SESSION_ID}
        bindings={[]}
        knownValues={{}}
        onStepLaunched={vi.fn()}
        fetchScript={pendingFetchScript}
        addSessionStep={vi.fn()}
      />,
    );

    typeOperationAndLoad("sqs-etl");

    await screen.findByTestId("session-step-operation-loading");

    resolvers.resolve({ ok: true, data: SQS_ETL_DETAIL });

    await screen.findByTestId("parameter-form");
    expect(
      screen.queryByTestId("session-step-operation-loading"),
    ).not.toBeInTheDocument();
  });

  test("shows an operation-load error when fetchScript resolves ok:false", async () => {
    render(
      <SessionStepLauncher
        sessionId={SESSION_ID}
        bindings={[]}
        knownValues={{}}
        onStepLaunched={vi.fn()}
        fetchScript={errorFetchScript("no such script")}
        addSessionStep={vi.fn()}
      />,
    );

    typeOperationAndLoad("does-not-exist");

    const error = await screen.findByTestId("session-step-operation-error");
    expect(error.textContent).toContain("no such script");
    expect(screen.queryByTestId("parameter-form")).not.toBeInTheDocument();
  });

  test("shows an operation-load error when fetchScript REJECTS (the .catch arm, distinct from an ok:false resolution)", async () => {
    const rejectingFetchScript = vi.fn(() =>
      Promise.reject(new Error("operation fetch exploded")),
    );
    render(
      <SessionStepLauncher
        sessionId={SESSION_ID}
        bindings={[]}
        knownValues={{}}
        onStepLaunched={vi.fn()}
        fetchScript={rejectingFetchScript}
        addSessionStep={vi.fn()}
      />,
    );

    typeOperationAndLoad("does-not-exist");

    const error = await screen.findByTestId("session-step-operation-error");
    expect(error.textContent).toContain("operation fetch exploded");
    expect(screen.queryByTestId("parameter-form")).not.toBeInTheDocument();
  });
});

describe("SessionStepLauncher — binding prefill wiring", () => {
  test("maps bindings-with-parameterName + knownValues into ParameterForm's own prefill, showing the bound value rather than the parameter's defaultValue", async () => {
    render(
      <SessionStepLauncher
        sessionId={SESSION_ID}
        bindings={[BINDING_WITH_PARAM, BINDING_WITHOUT_PARAM]}
        knownValues={KNOWN_VALUES}
        onStepLaunched={vi.fn()}
        fetchScript={okFetchScript(DYNAMODB_CRUD_DETAIL)}
        addSessionStep={vi.fn()}
      />,
    );

    typeOperationAndLoad("dynamodb-crud");
    await screen.findByTestId("parameter-form");

    const input = screen.getByLabelText<HTMLInputElement>("tableKey");
    expect(input.value).toBe(BOUND_VALUE);
    expect(input.value).not.toBe(
      DYNAMODB_CRUD_DETAIL.parameters[0]?.defaultValue,
    );
  });
});

describe("SessionStepLauncher — launch wiring", () => {
  function renderLoadedForDynamoCrud(args: {
    readonly onStepLaunched: (step: M3LSessionStepRecord) => void;
    readonly addSessionStep: (
      sessionId: string,
      input: M3LSessionAddStepRequest,
    ) => Promise<M3LConsoleFetchResult<M3LSessionAddStepResult>>;
  }): void {
    render(
      <SessionStepLauncher
        sessionId={SESSION_ID}
        bindings={[BINDING_WITH_PARAM, BINDING_WITHOUT_PARAM]}
        knownValues={KNOWN_VALUES}
        onStepLaunched={args.onStepLaunched}
        fetchScript={okFetchScript(DYNAMODB_CRUD_DETAIL)}
        addSessionStep={args.addSessionStep}
      />,
    );
  }

  test("launching calls addSessionStep with operation=loaded script name, bindings projected to exactly {reference, expectedType, multiSelect, parameterName} (no extra keys, no parameters key anywhere), and confirmed/dryRun from the submission", async () => {
    const addSessionStepSpy = vi.fn(
      okAddSessionStep({
        step: LAUNCHED_STEP,
        handle: {
          id: "run-1",
          scriptName: DYNAMODB_CRUD_DETAIL.name,
          status: "queued",
          dryRun: true,
          executionMode: "sync",
        },
      }),
    );
    renderLoadedForDynamoCrud({
      onStepLaunched: vi.fn(),
      addSessionStep: addSessionStepSpy,
    });

    typeOperationAndLoad("dynamodb-crud");
    await screen.findByTestId("parameter-form");

    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    await vi.waitFor(() => {
      expect(addSessionStepSpy).toHaveBeenCalledTimes(1);
    });
    const call = addSessionStepSpy.mock.calls[0];
    if (!call) {
      throw new Error("addSessionStep was not called");
    }
    const [sessionId, input] = call;
    expect(sessionId).toBe(SESSION_ID);
    expect(input).toEqual({
      operation: DYNAMODB_CRUD_DETAIL.name,
      bindings: [
        {
          reference: BINDING_WITH_PARAM.reference,
          expectedType: BINDING_WITH_PARAM.expectedType,
          multiSelect: BINDING_WITH_PARAM.multiSelect,
          parameterName: BINDING_WITH_PARAM.parameterName,
        },
      ],
      confirmed: false,
      dryRun: true,
    });
    expect(input).not.toHaveProperty("parameters");
    expect(Object.keys(input).sort()).toEqual(
      ["bindings", "confirmed", "dryRun", "operation"].sort(),
    );
    const [onlyBinding] = input.bindings;
    expect(onlyBinding && Object.keys(onlyBinding).sort()).toEqual(
      ["expectedType", "multiSelect", "parameterName", "reference"].sort(),
    );
  });

  test("turning off dry-run and confirming submits dryRun:false, confirmed:true (the real-run legal branch of buildAddStepRequest)", async () => {
    const addSessionStepSpy = vi.fn(
      okAddSessionStep({
        step: LAUNCHED_STEP,
        handle: {
          id: "run-1",
          scriptName: DYNAMODB_CRUD_DETAIL.name,
          status: "queued",
          dryRun: false,
          executionMode: "sync",
        },
      }),
    );
    renderLoadedForDynamoCrud({
      onStepLaunched: vi.fn(),
      addSessionStep: addSessionStepSpy,
    });

    typeOperationAndLoad("dynamodb-crud");
    await screen.findByTestId("parameter-form");

    fireEvent.click(screen.getByLabelText("Dry run"));
    fireEvent.click(screen.getByLabelText("Confirm real run"));
    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    await vi.waitFor(() => {
      expect(addSessionStepSpy).toHaveBeenCalledTimes(1);
    });
    const call = addSessionStepSpy.mock.calls[0];
    if (!call) {
      throw new Error("addSessionStep was not called");
    }
    const [, input] = call;
    expect(input).toMatchObject({ dryRun: false, confirmed: true });
  });

  test("on success, calls onStepLaunched with the returned step and shows session-step-launch-success", async () => {
    const onStepLaunched = vi.fn();
    renderLoadedForDynamoCrud({
      onStepLaunched,
      addSessionStep: okAddSessionStep({
        step: LAUNCHED_STEP,
        handle: {
          id: "run-1",
          scriptName: DYNAMODB_CRUD_DETAIL.name,
          status: "queued",
          dryRun: true,
          executionMode: "sync",
        },
      }),
    });

    typeOperationAndLoad("dynamodb-crud");
    await screen.findByTestId("parameter-form");
    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    await screen.findByTestId("session-step-launch-success");
    expect(onStepLaunched).toHaveBeenCalledWith(LAUNCHED_STEP);
  });

  test("on an ok:false result, shows session-step-launch-error with the message and never calls onStepLaunched", async () => {
    const onStepLaunched = vi.fn();
    renderLoadedForDynamoCrud({
      onStepLaunched,
      addSessionStep: errorAddSessionStep("step launch rejected"),
    });

    typeOperationAndLoad("dynamodb-crud");
    await screen.findByTestId("parameter-form");
    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    const error = await screen.findByTestId("session-step-launch-error");
    expect(error.textContent).toContain("step launch rejected");
    expect(onStepLaunched).not.toHaveBeenCalled();
  });

  test("a rejecting addSessionStep (.catch arm) also surfaces session-step-launch-error and never calls onStepLaunched", async () => {
    const onStepLaunched = vi.fn();
    const rejectingAddSessionStep = vi.fn(() =>
      Promise.reject(new Error("network exploded")),
    );
    renderLoadedForDynamoCrud({
      onStepLaunched,
      addSessionStep: rejectingAddSessionStep,
    });

    typeOperationAndLoad("dynamodb-crud");
    await screen.findByTestId("parameter-form");
    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    const error = await screen.findByTestId("session-step-launch-error");
    expect(error.textContent).toContain("network exploded");
    expect(onStepLaunched).not.toHaveBeenCalled();
  });
});

describe("SessionStepLauncher — request-identity guard on the operation load", () => {
  test("a stale fetchScript resolution for an earlier-typed operation name does not clobber a newer, still-relevant load", async () => {
    const resolversA =
      Promise.withResolvers<M3LConsoleFetchResult<M3LScriptDetail>>();
    const resolversB =
      Promise.withResolvers<M3LConsoleFetchResult<M3LScriptDetail>>();
    const deferredByName = new Map<
      string,
      Promise<M3LConsoleFetchResult<M3LScriptDetail>>
    >([
      [SQS_ETL_DETAIL.name, resolversA.promise],
      [DYNAMODB_CRUD_DETAIL.name, resolversB.promise],
    ]);
    const fetchScriptSpy = vi.fn(
      (name: string): Promise<M3LConsoleFetchResult<M3LScriptDetail>> => {
        const deferred = deferredByName.get(name);
        if (!deferred) {
          throw new Error(`no deferred fetchScript registered for ${name}`);
        }
        return deferred;
      },
    );

    render(
      <SessionStepLauncher
        sessionId={SESSION_ID}
        bindings={[BINDING_WITH_PARAM]}
        knownValues={KNOWN_VALUES}
        onStepLaunched={vi.fn()}
        fetchScript={fetchScriptSpy}
        addSessionStep={vi.fn()}
      />,
    );

    typeOperationAndLoad(SQS_ETL_DETAIL.name);
    await vi.waitFor(() => {
      expect(fetchScriptSpy).toHaveBeenCalledTimes(1);
    });

    typeOperationAndLoad(DYNAMODB_CRUD_DETAIL.name);
    await vi.waitFor(() => {
      expect(fetchScriptSpy).toHaveBeenCalledTimes(2);
    });

    // The newer (dynamodb-crud) request settles first.
    resolversB.resolve({ ok: true, data: DYNAMODB_CRUD_DETAIL });
    await screen.findByLabelText("tableKey");

    // The stale (sqs-etl, zero parameters) request settles after — it must
    // not replace the still-relevant dynamodb-crud form.
    resolversA.resolve({ ok: true, data: SQS_ETL_DETAIL });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(screen.getByLabelText("tableKey")).toBeInTheDocument();
  });
});

// Mirrors `loadOperation`'s own request-identity guard (see the describe
// block above) and `DecisionPrompt.tsx`'s `submitAnswer` guard: a
// `currentLaunchIdRef`-style ref set before each `addSessionStep` call must
// make a stale, later-resolving launch's result a no-op once a newer launch
// has superseded it — otherwise a slow first launch could clobber a second,
// still-in-flight launch's UI state (or fire `onStepLaunched` with the wrong
// step) the moment it happens to resolve.
describe("SessionStepLauncher — request-identity guard on step launch", () => {
  test("a stale addSessionStep resolution for a superseded launch does not show launch-success or fire onStepLaunched with the stale step", async () => {
    const STALE_LAUNCHED_STEP: M3LSessionStepRecord = {
      ...LAUNCHED_STEP,
      id: "step-stale",
      resultRef: null,
    };
    const CURRENT_LAUNCHED_STEP: M3LSessionStepRecord = {
      ...LAUNCHED_STEP,
      id: "step-current",
      resultRef: null,
    };
    const RUN_HANDLE = {
      id: "run-1",
      scriptName: DYNAMODB_CRUD_DETAIL.name,
      status: "queued" as const,
      dryRun: true,
      executionMode: "sync",
    };

    const resolversFirst =
      Promise.withResolvers<M3LConsoleFetchResult<M3LSessionAddStepResult>>();
    const resolversSecond =
      Promise.withResolvers<M3LConsoleFetchResult<M3LSessionAddStepResult>>();
    const deferredQueue = [resolversFirst.promise, resolversSecond.promise];
    const addSessionStepSpy = vi.fn(
      (): Promise<M3LConsoleFetchResult<M3LSessionAddStepResult>> => {
        const next = deferredQueue.shift();
        if (!next) {
          throw new Error("no more deferred addSessionStep responses queued");
        }
        return next;
      },
    );
    const onStepLaunched = vi.fn();

    render(
      <SessionStepLauncher
        sessionId={SESSION_ID}
        bindings={[BINDING_WITH_PARAM, BINDING_WITHOUT_PARAM]}
        knownValues={KNOWN_VALUES}
        onStepLaunched={onStepLaunched}
        fetchScript={okFetchScript(DYNAMODB_CRUD_DETAIL)}
        addSessionStep={addSessionStepSpy}
      />,
    );

    typeOperationAndLoad(DYNAMODB_CRUD_DETAIL.name);
    await screen.findByTestId("parameter-form");

    // First launch — its addSessionStep call is left pending.
    fireEvent.click(screen.getByRole("button", { name: /launch/i }));
    await vi.waitFor(() => {
      expect(addSessionStepSpy).toHaveBeenCalledTimes(1);
    });

    // Reloading the operation resets launch state to idle and re-renders a
    // fresh ParameterForm, re-enabling the launch button while the first
    // addSessionStep call is still in flight — this is how a second launch
    // supersedes the first without the first ever settling.
    typeOperationAndLoad(DYNAMODB_CRUD_DETAIL.name);
    await screen.findByTestId("parameter-form");

    fireEvent.click(screen.getByRole("button", { name: /launch/i }));
    await vi.waitFor(() => {
      expect(addSessionStepSpy).toHaveBeenCalledTimes(2);
    });

    // The stale FIRST launch resolves late, after the second has started.
    resolversFirst.resolve({
      ok: true,
      data: { step: STALE_LAUNCHED_STEP, handle: RUN_HANDLE },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // Its stale success must not surface as success UI, nor fire
    // onStepLaunched with the stale step.
    expect(
      screen.queryByTestId("session-step-launch-success"),
    ).not.toBeInTheDocument();
    expect(onStepLaunched).not.toHaveBeenCalledWith(STALE_LAUNCHED_STEP);

    // The current (second) launch still resolves normally afterward.
    resolversSecond.resolve({
      ok: true,
      data: { step: CURRENT_LAUNCHED_STEP, handle: RUN_HANDLE },
    });
    await screen.findByTestId("session-step-launch-success");
    expect(onStepLaunched).toHaveBeenCalledWith(CURRENT_LAUNCHED_STEP);
    expect(onStepLaunched).not.toHaveBeenCalledWith(STALE_LAUNCHED_STEP);
  });
});

// `fetchScript`/`addSessionStep` are optional props on
// SessionStepLauncherProps — every other test in this file injects both
// explicitly, so `props.fetchScript ?? fetchScriptDefault` and
// `props.addSessionStep ?? addSessionStepDefault` always take their
// left-hand side. This block omits both props to exercise the right-hand
// (real-module) fallback instead, via the file-level `vi.mock` of
// `../../src/api/scripts.js` / `../../src/api/sessions.js`.
describe("SessionStepLauncher — default prop fallback", () => {
  const RUN_HANDLE = {
    id: "run-1",
    scriptName: DYNAMODB_CRUD_DETAIL.name,
    status: "queued" as const,
    dryRun: true,
    executionMode: "sync",
  };

  test("uses the real fetchScript/addSessionStep exports when fetchScript/addSessionStep props are omitted", async () => {
    vi.mocked(fetchScriptReal).mockResolvedValue({
      ok: true,
      data: DYNAMODB_CRUD_DETAIL,
    });
    vi.mocked(addSessionStepReal).mockResolvedValue({
      ok: true,
      data: { step: LAUNCHED_STEP, handle: RUN_HANDLE },
    });
    const onStepLaunched = vi.fn();

    render(
      <SessionStepLauncher
        sessionId={SESSION_ID}
        bindings={[BINDING_WITH_PARAM, BINDING_WITHOUT_PARAM]}
        knownValues={KNOWN_VALUES}
        onStepLaunched={onStepLaunched}
      />,
    );

    typeOperationAndLoad(DYNAMODB_CRUD_DETAIL.name);
    await screen.findByTestId("parameter-form");
    expect(fetchScriptReal).toHaveBeenCalledWith(DYNAMODB_CRUD_DETAIL.name);

    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    await screen.findByTestId("session-step-launch-success");
    expect(addSessionStepReal).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ operation: DYNAMODB_CRUD_DETAIL.name }),
    );
    expect(onStepLaunched).toHaveBeenCalledWith(LAUNCHED_STEP);
  });
});
